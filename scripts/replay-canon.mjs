#!/usr/bin/env node
/**
 * Canon at the pace of the story (docs/decisions.md D-0090): the stage 0 fixture replayed
 * in order instead of read whole. Every `--every` summaries it indexes the new ones and
 * re-picks canon with the canon so far carried forward, as "Adopt this chat" does in
 * play. 0d asked one pick over all 85 summaries; this asks the same question N times,
 * each over the story so far and starting from the last answer.
 *
 *   node scripts/replay-canon.mjs [model] [--every N] [--slots N] [--dir corpusDir]
 *
 * Writes a fresh `replay/<model>/run-N/` under the corpus and refuses one that exists
 * (CLAUDE.md §3.14): every step's prompt, reply and canon, `evolution.md` showing how the
 * canon moved, and the final pick in the shape `pick-gate.mjs score` reads, so it is
 * scored exactly as 0d was. The verdict against `yardstick.md` stays a human read.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { REPO, complete, freshDir, loadKey, log, outsideRepo, pad, say, slugOf } from './tier-client.mjs';
import { indexBatch, parseIndexReply } from '../src/memory/index-strategy.js';
import { canonPick, parseCanonReply } from '../src/memory/canon-strategy.js';
import { DEFAULT_SLOTS } from '../src/memory/canon.js';
import { applyPick } from '../src/pipeline/compactor.js';

const DEFAULT_DIR = path.join(homedir(), 'workspaces', 'cairn-corpus', 'p5-stage0');
const RECORDS = 'records-replay.json';

function parseArgs(argv) {
    const args = { model: 'z-ai/glm-5.3', every: 8, slots: DEFAULT_SLOTS, dir: DEFAULT_DIR };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--every') args.every = Number(argv[++i]);
        else if (a === '--slots') args.slots = Number(argv[++i]);
        else if (a === '--dir') args.dir = path.resolve(argv[++i]);
        else if (!a.startsWith('--')) args.model = a;
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!Number.isInteger(args.every) || args.every < 1) throw new Error('--every takes a positive integer');
    outsideRepo(args.dir);
    return args;
}

/** The previous canon, cited by row in the index as it stands now. */
function carried(facts, records) {
    const rowOf = new Map(records.map((entry, at) => [entry.n, at + 1]));
    return facts.map((fact) => ({ text: fact.text, rows: fact.from.map((n) => rowOf.get(n)).filter(Boolean) }));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const key = loadKey();
    const summaries = JSON.parse(readFileSync(path.join(args.dir, 'summaries.json'), 'utf8'));

    let n = 1;
    while (existsSync(path.join(args.dir, 'replay', slugOf(args.model), `run-${n}`))) n++;
    const dir = freshDir(path.join(args.dir, 'replay', slugOf(args.model), `run-${n}`));
    copyFileSync(path.join(args.dir, 'summaries.json'), path.join(dir, 'summaries.json'));
    console.log(`${args.model} — replay every ${args.every}, ${args.slots} slots → ${dir}`);

    const records = [];
    let facts = [];
    const evolution = ['# Canon at the pace of the story', '', `${args.model}, a pick every ${args.every} summaries, ${args.slots} slots.`, ''];
    let lastReply = null;

    for (let start = 0, step = 1; start < summaries.length; start += args.every, step++) {
        const batch = summaries.slice(start, start + args.every);
        const indexRequest = indexBatch.build({ summaries: batch.map((s) => ({ text: s.text })) });
        const indexReply = await complete(args.model, indexRequest, key);
        writeFileSync(path.join(dir, `index-reply-${pad(step)}.json`), indexReply.content);
        log(dir, { kind: 'index', step, model: args.model, ...indexReply });
        say('index', `step ${pad(step)}`, indexReply);
        const parsed = parseIndexReply(indexReply.content, { count: batch.length });
        if (parsed.ok) {
            for (const { n: within, ...record } of parsed.records) records.push({ n: batch[within - 1].n, record });
            records.sort((a, b) => a.n - b.n);
        } else {
            console.log(`  index step ${step} rejected (${parsed.reason}); those summaries have no records`);
        }

        const through = batch[batch.length - 1].n;
        if (!records.length) continue;
        const previous = carried(facts, records);
        const pickRequest = canonPick.build({ records: records.map((entry) => entry.record), slots: args.slots, previous });
        writeFileSync(path.join(dir, `pick-prompt-${pad(step)}.md`), pickRequest.messages[0].content + '\n');
        const pickReply = await complete(args.model, pickRequest, key);
        writeFileSync(path.join(dir, `pick-reply-${pad(step)}.json`), pickReply.content);
        log(dir, { kind: 'pick', step, through, records: records.length, carried: previous.length, model: args.model, ...pickReply });
        say('pick ', `step ${pad(step)} over ${records.length} rows`, pickReply);

        const pick = parseCanonReply(pickReply.content, { slots: args.slots, records: records.length });
        if (!pick.ok) {
            console.log(`  pick step ${step} rejected (${pick.reason}); the canon so far stands`);
            evolution.push(`## Through summary ${through} — pick rejected (${pick.reason})`, '');
            continue;
        }
        const applied = applyPick({
            picked: pick.picked, dropped: pick.dropped,
            records: records.map((entry) => ({ index: entry.n })),
            covers: [records[0].n, records[records.length - 1].n],
            slots: args.slots, prompt: 'h:replay', at: new Date(0).toISOString(),
        });
        const before = new Set(facts.map((fact) => fact.text));
        facts = applied.batch.facts;
        lastReply = pickReply.content;
        writeFileSync(path.join(dir, `canon-${pad(step)}.json`), JSON.stringify(facts, null, 2) + '\n');
        evolution.push(`## Through summary ${through} — ${records.length} rows, ${facts.length} facts`, '');
        for (const fact of facts) evolution.push(`- ${before.has(fact.text) ? '' : '**new** '}${fact.text} *(summaries ${fact.from.join(', ')})*`);
        evolution.push('');
    }

    writeFileSync(path.join(dir, RECORDS), JSON.stringify(records, null, 2) + '\n');
    writeFileSync(path.join(dir, 'evolution.md'), evolution.join('\n') + '\n');
    if (!lastReply) throw new Error('no pick survived the parser');
    writeFileSync(path.join(dir, 'pick-reply.json'), lastReply);
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'pick-gate.mjs'), 'score', dir, 'pick-reply.json', RECORDS, String(args.slots)], { stdio: 'inherit' });
    console.log(`  evolution in ${path.join(dir, 'evolution.md')}`);
}

main().catch((err) => {
    console.error(`replay-canon: ${err.message}`);
    process.exit(1);
});
