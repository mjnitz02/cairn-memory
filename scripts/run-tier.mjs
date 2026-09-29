#!/usr/bin/env node
/**
 * P5 stage 0d — the fixture, re-run by the model class that will actually run it
 * (docs/p5-plan.md, D-0080). The one step `calibrate-tier.mjs` and `pick-gate.mjs` leave
 * to a human — answering the prompts — done against an OpenAI-compatible API instead.
 *
 *   node scripts/run-tier.mjs <model...> [--runs N] [--slots N] [--dir corpusDir]
 *   node scripts/run-tier.mjs <model...> --smoke  one index batch each, parsed, nothing assembled
 *
 * Each run writes a fresh `0d/<model>/run-N/` under the corpus and **refuses one that
 * exists** (CLAUDE.md §3.14). The prompts come from the shipped `build`s, and the replies go
 * through the shipped `assemble`, `measure` and `score` unchanged — so a 0d run differs from
 * the reference in exactly one thing, the model. The yardstick verdict stays a human read.
 *
 * NANOGPT_API_KEY is read from the environment or the repo's gitignored `.env`, and never
 * written; NANOGPT_BASE_URL overrides the endpoint. Local only: CI has neither a corpus nor a key.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { REPO, complete, freshDir, loadKey, log, outsideRepo, pad, say, slugOf } from './tier-client.mjs';
import { indexBatch, parseIndexReply, MAX_BATCH } from '../src/memory/index-strategy.js';
import { canonPick } from '../src/memory/canon-strategy.js';
import { DEFAULT_SLOTS } from '../src/memory/canon.js';

const DEFAULT_DIR = path.join(homedir(), 'workspaces', 'cairn-corpus', 'p5-stage0');
const RECORDS = 'records-0d.json';

function parseArgs(argv) {
    const args = { models: [], runs: 1, slots: DEFAULT_SLOTS, dir: DEFAULT_DIR, smoke: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--runs') args.runs = Number(argv[++i]);
        else if (a === '--slots') args.slots = Number(argv[++i]);
        else if (a === '--dir') args.dir = path.resolve(argv[++i]);
        else if (a === '--smoke') args.smoke = true;
        else if (!a.startsWith('--')) args.models.push(a);
        else throw new Error(`unknown argument: ${a}`);
    }
    if (!args.models.length) throw new Error('usage: run-tier.mjs <model...> [--runs N] [--slots N] [--dir corpusDir] [--smoke]');
    if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs takes a positive integer');
    outsideRepo(args.dir);
    return args;
}

function node(script, ...args) {
    execFileSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], { stdio: 'inherit' });
}

async function smoke(args, key, summaries) {
    const dir = freshDir(path.join(args.dir, '0d', slugOf(args.model), `smoke-${Date.now()}`));
    const batch = summaries.slice(0, MAX_BATCH);
    const request = indexBatch.build({ summaries: batch.map((s) => ({ text: s.text })) });
    const reply = await complete(args.model, request, key);
    writeFileSync(path.join(dir, 'index-reply-01.json'), reply.content);
    log(dir, { kind: 'index', batch: 1, model: args.model, ...reply });
    say('index', 'batch 01', reply);

    const parsed = parseIndexReply(reply.content, { count: batch.length });
    if (!parsed.ok) console.log(`  the shipped parser REJECTED it: ${parsed.reason}`);
    else {
        console.log(`  parsed ${parsed.records.length} of ${batch.length} records, ${parsed.dropped.length} slots dropped`);
        for (const drop of parsed.dropped) console.log(`    dropped ${drop.slot} (${drop.reason})`);
    }
    console.log(`  written to ${dir}`);
}

async function run(args, key, summaries, n) {
    const dir = freshDir(path.join(args.dir, '0d', slugOf(args.model), `run-${n}`));
    // assemble and measure read summaries.json from the directory they are given.
    copyFileSync(path.join(args.dir, 'summaries.json'), path.join(dir, 'summaries.json'));
    console.log(`\n${args.model} — run ${n} → ${dir}`);

    for (let start = 0, b = 1; start < summaries.length; start += MAX_BATCH, b++) {
        const batch = summaries.slice(start, start + MAX_BATCH);
        const request = indexBatch.build({ summaries: batch.map((s) => ({ text: s.text })) });
        const reply = await complete(args.model, request, key);
        writeFileSync(path.join(dir, `index-reply-${pad(b)}.json`), reply.content);
        log(dir, { kind: 'index', batch: b, model: args.model, ...reply });
        say('index', `batch ${pad(b)}`, reply);
    }

    node('calibrate-tier.mjs', 'assemble', dir, RECORDS);
    node('calibrate-tier.mjs', 'measure', dir, RECORDS);

    const records = JSON.parse(readFileSync(path.join(dir, RECORDS), 'utf8'));
    if (!records.length) {
        console.log('  no records survived the parser — nothing to pick from');
        return;
    }
    const request = canonPick.build({ records: records.map((entry) => entry.record), slots: args.slots });
    writeFileSync(path.join(dir, 'pick-prompt-0d.md'), request.messages[0].content + '\n');
    const reply = await complete(args.model, request, key);
    writeFileSync(path.join(dir, 'pick-reply.json'), reply.content);
    log(dir, { kind: 'pick', model: args.model, ...reply });
    say('pick ', `${args.slots} slots`, reply);

    try {
        node('pick-gate.mjs', 'score', dir, 'pick-reply.json', RECORDS, String(args.slots));
    } catch {
        console.log('  the pick did not score — see pick-reply.json');
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const key = loadKey();
    const summaries = JSON.parse(readFileSync(path.join(args.dir, 'summaries.json'), 'utf8'));

    // One model failing (a bad id, a refusal to route) does not stop the others.
    const failed = [];
    for (const model of args.models) {
        const one = { ...args, model };
        try {
            if (args.smoke) {
                console.log(`\n${model} — smoke`);
                await smoke(one, key, summaries);
                continue;
            }
            for (let n = 1; n <= args.runs; n++) {
                let next = n;
                while (existsSync(path.join(args.dir, '0d', slugOf(model), `run-${next}`))) next++;
                await run(one, key, summaries, next);
            }
        } catch (err) {
            console.log(`  ${model} FAILED: ${err.message}`);
            failed.push(model);
        }
    }
    if (failed.length) throw new Error(`failed: ${failed.join(', ')}`);
}

main().catch((err) => {
    console.error(`run-tier: ${err.message}`);
    process.exit(1);
});
