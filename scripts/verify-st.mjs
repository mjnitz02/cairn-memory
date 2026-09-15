#!/usr/bin/env node
/**
 * Re-checks docs/st-api-surface.md against a local SillyTavern checkout.
 *
 * An uncited claim about an ST API is an unverified claim (CLAUDE.md §2.6), and
 * a citation that has silently rotted is worse than none. This is a local gate
 * only — CI has no SillyTavern checkout.
 *
 *   ST_PATH=~/workspaces/SillyTavern node scripts/verify-st.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ST_PATH = (process.env.ST_PATH || join(process.env.HOME, 'workspaces/SillyTavern'))
    .replace(/^~/, process.env.HOME);
const DOC = 'docs/st-api-surface.md';

const ROW = /^\|\s*`([^`]+)`\s*\|[^|]*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|/;
const PINNED = /\*\*Pinned: ST ([\d.]+) \(`([0-9a-f]+)`\)\*\*/;

const doc = readFileSync(DOC, 'utf8');
const fileCache = new Map();
const failures = [];
let checked = 0;

function lines(relPath) {
    if (!fileCache.has(relPath)) {
        fileCache.set(relPath, readFileSync(join(ST_PATH, relPath), 'utf8').split('\n'));
    }
    return fileCache.get(relPath);
}

// The pinned version is part of the claim: citations verified against a
// different ST than the one on disk prove nothing.
const pinned = doc.match(PINNED);
let stVersion = 'unknown';
try {
    stVersion = JSON.parse(readFileSync(join(ST_PATH, 'package.json'), 'utf8')).version;
} catch {
    console.error(`✗ No SillyTavern checkout at ${ST_PATH} (set ST_PATH).`);
    process.exit(1);
}
if (!pinned) {
    failures.push(`${DOC} has no "**Pinned: ST <version> (<commit>)**" line.`);
} else if (pinned[1] !== stVersion) {
    failures.push(`Pinned ST ${pinned[1]} but ${ST_PATH} is ${stVersion}. Re-verify, then update the pin.`);
}

for (const line of doc.split('\n')) {
    const row = line.match(ROW);
    if (!row) continue;

    const [, symbol, relPath, lineNoText] = row;
    const lineNo = Number(lineNoText);
    let source;
    try {
        source = lines(relPath);
    } catch {
        failures.push(`${symbol}: ${relPath} does not exist in the checkout.`);
        continue;
    }

    checked++;
    const cited = source[lineNo - 1];
    if (cited?.includes(symbol)) continue;

    // Moved, not gone? Say where, so the fix is a one-line edit.
    const found = source
        .map((text, i) => (text.includes(symbol) ? i + 1 : null))
        .filter(Boolean);
    failures.push(found.length
        ? `${symbol}: not at ${relPath}:${lineNo} — now at ${found.slice(0, 5).join(', ')}${found.length > 5 ? ', …' : ''}`
        : `${symbol}: gone from ${relPath}. The design may rest on something that no longer exists.`);
}

if (failures.length) {
    console.error(`✗ ${failures.length} problem(s) against ST ${stVersion} at ${ST_PATH}:\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`✓ ${checked} citations verified against ST ${stVersion} (${ST_PATH})`);
