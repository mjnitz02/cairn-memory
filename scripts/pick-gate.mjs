#!/usr/bin/env node
/**
 * P5 stage 3's gate, offline — the canon pick over a real index (docs/p5-plan.md).
 *
 * **It is a fixture, not a run** (docs/decisions.md D-0061): the summaries are on disk,
 * the index is on disk, and the question is whether a forced-budget pick over a correct
 * index contains the story's spine. Zero generations in SillyTavern, and the only model
 * call is the pick itself — made by hand, offline, against the prompt this repo ships.
 *
 *   prompt  records.json → the exact prompt `canonPick.build` sends, and what it costs
 *   score   a reply → what the shipped parser makes of it, and the canon the block gets
 *
 * **The yardstick is not in here and must not be** (CLAUDE.md §3.13, §5's "the teacher
 * must not also be the examiner"). `score` prints the canon so it can be read against
 * `yardstick.md`, which was frozen in the corpus before any of this ran; whether a spine
 * line is present is a judgment made against that file and written into the decision log.
 *
 * Local only, like `make verify-st`: CI has no corpus.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonPick, parseCanonReply } from '../src/memory/canon-strategy.js';
import { applyPick } from '../src/pipeline/compactor.js';
import { DEFAULT_SLOTS } from '../src/memory/canon.js';
import { renderBlock, CANON_RENDERING } from '../src/prompt/assembler.js';
import { estimateTokens } from '../src/util/tokens.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(homedir(), 'workspaces', 'cairn-corpus', 'p5-stage0');

function outDir(given) {
    const dir = path.resolve(given ?? DEFAULT_OUT);
    if (dir === REPO || dir.startsWith(REPO + path.sep)) {
        throw new Error(`refusing to write corpus content inside the repo: ${dir} (CLAUDE.md §3.13)`);
    }
    mkdirSync(dir, { recursive: true });
    return dir;
}

const stemOf = (name) => name.replace(/\.json$/, '').replace(/^records-?/, '') || 'reference';

function load(dir, name) {
    const file = path.join(dir, name);
    if (!existsSync(file)) throw new Error(`no ${name} in ${dir}`);
    return JSON.parse(readFileSync(file, 'utf8'));
}

function prompt(given, name = 'records.json', slots = DEFAULT_SLOTS) {
    const dir = outDir(given);
    const records = load(dir, name);
    const request = canonPick.build({
        records: records.map((entry) => entry.record),
        slots: Number(slots),
    });
    const content = request.messages[0].content;
    const file = path.join(dir, `pick-prompt-${stemOf(name)}.md`);
    writeFileSync(file, content + '\n');

    console.log(`${records.length} records, ${slots} slots`);
    console.log(`  prompt      ${estimateTokens(content)} tokens, ${content.length} chars`);
    console.log(`  written to  ${file}`);
}

function score(given, reply = 'pick-reply.json', name = 'records.json', slots = DEFAULT_SLOTS) {
    const dir = outDir(given);
    const records = load(dir, name);
    const raw = readFileSync(path.join(dir, reply), 'utf8');
    const summaries = load(dir, 'summaries.json');

    const parsed = parseCanonReply(raw, { slots: Number(slots), records: records.length });
    if (!parsed.ok) throw new Error(`the shipped parser rejected the reply: ${parsed.reason}`);

    // The rows map to chat indexes exactly as the job maps them, so what is scored is
    // what would have been stored.
    const applied = applyPick({
        picked: parsed.picked,
        dropped: parsed.dropped,
        records: records.map((entry) => ({ index: entry.n })),
        covers: [records[0].n, records[records.length - 1].n],
        slots: Number(slots),
        prompt: 'h:offline',
        at: new Date(0).toISOString(),
    });

    const text = renderBlock(applied.batch.facts, CANON_RENDERING);
    const kinds = {};
    for (const fact of applied.batch.facts) {
        for (const row of fact.from) {
            const kind = records.find((entry) => entry.n === row)?.record.kind ?? '?';
            kinds[kind] = (kinds[kind] ?? 0) + 1;
        }
    }

    const lines = [
        `# Stage 3 — the pick, scored mechanically`,
        ``,
        `\`scripts/pick-gate.mjs score\` over \`${name}\`. The verdict against the frozen`,
        `\`yardstick.md\` is a judgment made by reading the canon below, not by this script.`,
        ``,
        `| | |`,
        `|---|---|`,
        `| records in the index | ${records.length} |`,
        `| facts picked | ${applied.picked} |`,
        `| slots unfilled | ${parsed.short} |`,
        `| refused by the parser | ${applied.dropped} |`,
        `| uncitable, so dropped | ${applied.uncited} |`,
        `| repeated inside the pick | ${applied.duplicates} |`,
        `| canon rendered | ${estimateTokens(text)} tokens, ${text.length} chars |`,
        `| rows cited, by kind | ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')} |`,
        ``,
        `## The canon, as the block would carry it`,
        ``,
        '```',
        text.trimEnd(),
        '```',
        ``,
        `## Each fact against the rows it cites`,
        ``,
        ...applied.batch.facts.flatMap((fact) => [
            `**${fact.text}**`,
            ``,
            ...fact.from.map((row) => {
                const record = records.find((entry) => entry.n === row)?.record;
                const summary = summaries.find((entry) => entry.n === row);
                return `- row ${row} (${record?.kind}) — ${record?.what}`
                    + (record?.background ? ` · background: ${record.background}` : '')
                    + (summary ? `\n  <br>*summary ${row}: ${summary.text.slice(0, 200)}…*` : '');
            }),
            ``,
        ]),
    ].join('\n');

    const file = path.join(dir, `pick-score-${stemOf(name)}.md`);
    writeFileSync(file, lines + '\n');

    console.log(`${applied.picked} facts picked, ${parsed.short} slots unfilled, `
        + `${applied.dropped + applied.uncited} refused, ${estimateTokens(text)} tokens rendered`);
    console.log(`  rows by kind  ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  written to    ${file}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
    if (command === 'prompt') prompt(rest[0], rest[1], rest[2]);
    else if (command === 'score') score(rest[0], rest[1], rest[2], rest[3]);
    else {
        console.error('usage: pick-gate.mjs prompt [dir] [records.json] [slots] | score [dir] [reply.json] [records.json] [slots]');
        process.exit(2);
    }
} catch (err) {
    console.error(`pick-gate: ${err.message}`);
    process.exit(1);
}
