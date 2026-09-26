#!/usr/bin/env node
/**
 * The compact tier's calibration harness — P5 stage 0c (docs/p5-plan.md, D-0075).
 *
 * Two subcommands, because the middle step is a model and not a script:
 *
 *   extract   a chat file's real summaries → the corpus, numbered for a labelling pass
 *   batches   those summaries → the index prompts a labelling pass answers, 15 at a time
 *   assemble  a pass's replies → a records file, read by the parser this repo ships
 *   measure   those summaries + the records written for them → `r`, the share, the horizon
 *
 * `measure` takes the records file to read, because a pass is re-run whenever the record's
 * shape changes and **nothing already in the corpus may be overwritten** (CLAUDE.md §3.14).
 * Its report and chain are named after that file, so each pass's outputs sit beside the last
 * one's and the two can be diffed — which is what stage 0d does with a modest model's records.
 *
 * **Nothing it writes may land in this repo** (CLAUDE.md §3.13). The output directory
 * defaults into `~/workspaces/cairn-corpus` and a path inside the repo is refused, because
 * the one mistake here is unrecoverable: the chats are not reproducible (§3.14) and the repo
 * is public. It never writes to the chat file either — it opens it read-only.
 *
 * It imports the shipped `renderRecord` and `estimateTokens` rather than reimplementing
 * them, so the number it reports is the number the block would actually cost.
 *
 * Local only, like `make verify-st`: CI has neither a corpus nor a chat.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRecord, renderIndex, validRecord } from '../src/memory/index-record.js';
import { indexBatch, parseIndexReply, MAX_BATCH } from '../src/memory/index-strategy.js';
import { estimateTokens } from '../src/util/tokens.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(homedir(), 'workspaces', 'cairn-corpus', 'p5-stage0');

/** Messages 1–85 are the real story; past ~85 is filler generated to pad tokens. */
const REAL_THROUGH = 85;

/** The post-reclaim scene budget the horizon is priced against (docs/p5-plan.md §1). */
const SCENE_CAP = 6362;

function outDir(given) {
    const dir = path.resolve(given ?? DEFAULT_OUT);
    if (dir === REPO || dir.startsWith(REPO + path.sep)) {
        throw new Error(`refusing to write corpus content inside the repo: ${dir} (CLAUDE.md §3.13)`);
    }
    mkdirSync(dir, { recursive: true });
    return dir;
}

function readChat(file) {
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
}

/** The same two sources `memory/scenes.js` reads, in the same order of preference. */
function summaryOf(message) {
    const cairn = message?.extra?.cairn?.scene?.text;
    if (typeof cairn === 'string' && cairn !== '') return { source: 'cairn', text: cairn };
    const qvink = message?.extra?.qvink_memory?.memory;
    if (typeof qvink === 'string' && qvink !== '') return { source: 'qvink', text: qvink };
    return null;
}

function extract(file, given) {
    const dir = outDir(given);
    const lines = readChat(file);
    // Line 0 is chat metadata, so message n is line n. The window is over messages.
    const summaries = [];
    for (let i = 1; i < lines.length && i <= REAL_THROUGH; i++) {
        const found = summaryOf(lines[i]);
        if (!found) continue;
        summaries.push({
            n: summaries.length + 1,
            index: i,
            source: found.source,
            chars: found.text.length,
            estTokens: estimateTokens(found.text),
            text: found.text,
        });
    }
    if (!summaries.length) throw new Error(`no summaries in messages 1–${REAL_THROUGH} of ${file}`);

    writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify(summaries, null, 2) + '\n');
    writeFileSync(
        path.join(dir, 'summaries.md'),
        summaries.map((s) => `## ${s.n} (message ${s.index}, ${s.source}, ~${s.estTokens}t)\n\n${s.text}`).join('\n\n'),
    );

    const tokens = summaries.map((s) => s.estTokens);
    console.log(`extracted ${summaries.length} summaries from messages 1–${REAL_THROUGH}`);
    console.log(`  sources     ${[...new Set(summaries.map((s) => s.source))].join(', ')}`);
    console.log(`  tokens      total ${sum(tokens)}, mean ${mean(tokens).toFixed(1)}, median ${median(tokens)}`);
    console.log(`  written to  ${dir}`);
}

/**
 * The labelling pass's prompts, batched exactly as the shipped queue batches them:
 * `MAX_BATCH` summaries, numbered from 1 within the batch, no overlap (D-0078 choice 5).
 *
 * This is what makes stage 0d mechanical — answer each file, drop the replies beside
 * them, `assemble`, `measure`. The prompt is `indexBatch.build`'s, not a copy of it.
 */
function batches(given) {
    const dir = outDir(given);
    const summaries = JSON.parse(readFileSync(path.join(dir, 'summaries.json'), 'utf8'));
    const written = [];

    for (let start = 0; start < summaries.length; start += MAX_BATCH) {
        const batch = summaries.slice(start, start + MAX_BATCH);
        const request = indexBatch.build({ summaries: batch.map((s) => ({ text: s.text })) });
        const file = path.join(dir, `index-prompt-${String(written.length + 1).padStart(2, '0')}.md`);
        writeFileSync(file, request.messages[0].content + '\n');
        written.push({ file, from: batch[0].n, to: batch[batch.length - 1].n, tokens: estimateTokens(request.messages[0].content) });
    }

    console.log(`${written.length} batches over ${summaries.length} summaries, ${MAX_BATCH} at a time`);
    for (const batch of written) {
        console.log(`  ${path.basename(batch.file)}  summaries ${batch.from}\u2013${batch.to}, ~${batch.tokens}t`);
    }
    console.log(`  answer each into index-reply-NN.json beside it, then: assemble ${dir} <records-name.json>`);
}

/**
 * The replies → a records file, read by the shipped parser so that what lands in the
 * corpus is exactly what the queue would have stored. A batch numbers its records 1..N,
 * so they are shifted back to the summary numbers here — the same mapping the caller
 * owns in play (memory/index-strategy.js).
 */
function assemble(given, name = 'records.json') {
    const dir = outDir(given);
    if (existsSync(path.join(dir, name))) {
        throw new Error(`${name} already exists in ${dir} — nothing in the corpus is overwritten (CLAUDE.md §3.14)`);
    }
    const summaries = JSON.parse(readFileSync(path.join(dir, 'summaries.json'), 'utf8'));
    const out = [];
    const problems = [];

    for (let start = 0, n = 1; start < summaries.length; start += MAX_BATCH, n++) {
        const batch = summaries.slice(start, start + MAX_BATCH);
        const file = path.join(dir, `index-reply-${String(n).padStart(2, '0')}.json`);
        if (!existsSync(file)) {
            problems.push(`batch ${n} (summaries ${batch[0].n}\u2013${batch[batch.length - 1].n}): no reply`);
            continue;
        }
        const parsed = parseIndexReply(readFileSync(file, 'utf8'), { count: batch.length });
        if (!parsed.ok) {
            problems.push(`batch ${n}: the parser rejected it (${parsed.reason})`);
            continue;
        }
        for (const drop of parsed.dropped) problems.push(`batch ${n}: dropped ${drop.slot} (${drop.reason})`);
        for (const { n: within, ...record } of parsed.records) out.push({ n: batch[within - 1].n, record });
    }

    out.sort((a, b) => a.n - b.n);
    const invalid = out.filter((entry) => !validRecord(entry.record));
    writeFileSync(path.join(dir, name), JSON.stringify(out, null, 2) + '\n');

    console.log(`${out.length} of ${summaries.length} summaries have records, ${invalid.length} invalid`);
    for (const problem of problems) console.log(`  ${problem}`);
    console.log(`  written to ${path.join(dir, name)}`);
}

function measure(given, name = 'records.json', { sceneCap = SCENE_CAP } = {}) {
    const dir = outDir(given);
    const summaries = JSON.parse(readFileSync(path.join(dir, 'summaries.json'), 'utf8'));
    const recordsFile = path.join(dir, name);
    if (!existsSync(recordsFile)) throw new Error(`no ${name} in ${dir} — the labelling pass writes it`);
    const records = JSON.parse(readFileSync(recordsFile, 'utf8'));

    const byN = new Map(records.map((r) => [r.n, r]));
    const invalid = records.filter((r) => !validRecord(r.record));
    const missing = summaries.filter((s) => !byN.has(s.n));

    const rows = summaries.filter((s) => byN.has(s.n)).map((s) => {
        const record = byN.get(s.n).record;
        const rendered = renderRecord(record, s.n);
        return {
            n: s.n,
            kind: record.kind,
            fullTokens: s.estTokens,
            rendered,
            compactTokens: estimateTokens(rendered),
        };
    });

    // The compact tier's real cost. `record.line` is where a pass writes it now that the
    // slot exists (D-0076); `prose` is the 0c reference pass, which predates the slot.
    const lineOf = (x) => (typeof x.record?.line === 'string' && x.record.line !== '' ? x.record.line
        : (typeof x.prose === 'string' && x.prose !== '' ? x.prose : null));
    const prose = records.filter((x) => lineOf(x)).map((x) => ({ n: x.n, tokens: estimateTokens(lineOf(x)) }));

    const full = rows.map((r) => r.fullTokens);
    const record = rows.map((r) => r.compactTokens);
    // The share follows the artifact the block actually holds, which is the prose line
    // (D-0076). The rendered record is still measured, as the alternative it beat.
    const lined = prose.length === rows.length;
    const compact = lined ? prose.map((p) => p.tokens) : record;
    const r = mean(full) / mean(compact);
    const share = 1 / (1 + r);

    const kinds = {};
    for (const row of rows) kinds[row.kind] = (kinds[row.kind] ?? 0) + 1;

    const horizon = (s) => {
        const fullCap = Math.floor(sceneCap * (1 - s));
        const compactCap = sceneCap - fullCap;
        const fullHeld = Math.floor(fullCap / mean(full));
        const compactHeld = Math.floor(compactCap / mean(compact));
        return { s, fullCap, compactCap, fullHeld, compactHeld, held: fullHeld + compactHeld };
    };
    const shares = [0, share, 0.2, 0.25, 0.3].map(horizon);
    const base = shares[0].held;

    const report = [
        `# Stage 0c — the compact tier, measured`,
        ``,
        `Generated by \`scripts/calibrate-tier.mjs measure\`. ${rows.length} summaries with records`,
        `${missing.length ? `(${missing.length} unlabelled)` : '(all labelled)'}; ` +
            `${invalid.length} records fail \`validRecord\`.`,
        ``,
        `## The ratio`,
        ``,
        `| | mean | median | min | max | total |`,
        `|---|---|---|---|---|---|`,
        `| full summary | ${mean(full).toFixed(1)} | ${median(full)} | ${Math.min(...full)} | ${Math.max(...full)} | ${sum(full)} |`,
        `| rendered record | ${mean(record).toFixed(1)} | ${median(record)} | ${Math.min(...record)} | ${Math.max(...record)} | ${sum(record)} |`,
        prose.length
            ? `| prose line (n=${prose.length}) | ${mean(prose.map((p) => p.tokens)).toFixed(1)} | ${median(prose.map((p) => p.tokens))} | ${Math.min(...prose.map((p) => p.tokens))} | ${Math.max(...prose.map((p) => p.tokens))} | ${sum(prose.map((p) => p.tokens))} |`
            : `| prose line | — | — | — | — | — |`,
        ``,
        `**r = ${r.toFixed(2)}** against the ${lined ? 'prose line' : 'rendered record'}, so the derived`,
        `share is **1/(1+r) = ${(share * 100).toFixed(1)}%**.`,
        ``,
        `The whole index renders to **${estimateTokens(renderIndex(rows.map((row) => byN.get(row.n).record)))} tokens**`,
        `for ${rows.length} records — D-0070's one-call claim (per-record cost is the stage 0 gate:`,
        `~20 tokens expected).`,
        ``,
        `Kinds: ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
        ``,
        `## The horizon, against sceneCap ${sceneCap} (docs/p5-plan.md §1)`,
        ``,
        `| compact share | fullCap | compactCap | full held | compact held | horizon | vs no tier |`,
        `|---|---|---|---|---|---|---|`,
        ...shares.map((h) => `| ${(h.s * 100).toFixed(1)}% | ${h.fullCap} | ${h.compactCap} | ${h.fullHeld} | ` +
            `${h.compactHeld} | **${h.held}** | ${h.held === base ? '—' : `+${(((h.held / base) - 1) * 100).toFixed(0)}%`} |`),
        ``,
        `## Every rendered record, in order — read this as block text (option B)`,
        ``,
        '```',
        ...rows.map((row) => row.rendered),
        '```',
        ``,
    ].join('\n');

    const stem = name.replace(/\.json$/, '').replace(/^records-?/, '');
    const named = (kind) => path.join(dir, stem ? `${kind}-${stem}.md` : `${kind}.md`);
    writeFileSync(named('report'), report + '\n');

    // The chain: the newest `fullHeld` summaries in full, the `compactHeld` before them compact.
    const at = horizon(share);
    const tail = rows.slice(-at.fullHeld);
    const head = rows.slice(Math.max(0, rows.length - at.fullHeld - at.compactHeld), rows.length - at.fullHeld);
    const chain = [
        `# The chain as the model would read it (share ${(share * 100).toFixed(1)}%)`,
        ``,
        `${head.length} compact, then ${tail.length} full. Does the join read, or is it two documents?`,
        ``,
        ...head.map((row) => lineOf(byN.get(row.n)) ?? row.rendered),
        ``,
        ...tail.map((row) => summaries.find((s) => s.n === row.n).text),
        ``,
    ].join('\n');
    writeFileSync(named('chain'), chain);

    console.log(`r = ${r.toFixed(2)}, share = ${(share * 100).toFixed(1)}%, ` +
        `horizon ${base} → ${horizon(share).held}`);
    console.log(`  full ${mean(full).toFixed(1)}t mean, record ${mean(record).toFixed(1)}t mean` +
        (prose.length ? `, prose ${mean(prose.map((p) => p.tokens)).toFixed(1)}t mean (n=${prose.length})` : ''));
    if (missing.length) console.log(`  unlabelled: ${missing.map((s) => s.n).join(', ')}`);
    if (invalid.length) console.log(`  invalid records: ${invalid.map((x) => x.n).join(', ')}`);
    console.log(`  written to ${named('report')} and ${named('chain')}`);
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const [command, ...rest] = process.argv.slice(2);
try {
    if (command === 'extract') {
        if (!rest[0]) throw new Error('usage: calibrate-tier.mjs extract <chat.jsonl> [outDir]');
        extract(rest[0], rest[1]);
    } else if (command === 'batches') {
        batches(rest[0]);
    } else if (command === 'assemble') {
        assemble(rest[0], rest[1]);
    } else if (command === 'measure') {
        measure(rest[0], rest[1]);
    } else {
        console.error('usage: calibrate-tier.mjs extract <chat.jsonl> [outDir] | batches [outDir]'
            + ' | assemble [outDir] [records.json] | measure [outDir] [records.json]');
        process.exit(2);
    }
} catch (err) {
    console.error(`calibrate-tier: ${err.message}`);
    process.exit(1);
}
