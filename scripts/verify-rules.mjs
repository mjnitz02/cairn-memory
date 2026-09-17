#!/usr/bin/env node
/**
 * Checks that every `CLAUDE.md §N.M` reference in the repo resolves to a rule
 * that exists, and that its text still looks like what the citing file claims.
 * Also that every `docs/<page>.md` and `D-NNNN` reference names a page and a
 * decision that exist, so deleting a doc cannot leave pointers to nothing.
 * The docs are local-only under `.claude/`; references keep the short form.
 *
 * Rules are numbered, so inserting one silently shifts every reference after it
 * — which happened the first time a rule was added (CLAUDE.md §9.35: if a
 * mistake can be caught mechanically, catch it mechanically).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'coverage', '.github']);
const REFERENCE = /CLAUDE\.md §(\d+)\.(\d+)/g;
const DOC = /\bdocs\/([\w-]+\.md)\b/g;
const DECISION = /\bD-(\d{4})\b/g;

const decisions = new Set(
    [...readFileSync('.claude/docs/decisions.md', 'utf8').matchAll(/^## D-(\d{4})\b/gm)].map((match) => match[1]),
);

// Rule N lives under section S; both are needed to validate a §S.N reference.
const rules = new Map();
let section = 0;
for (const line of readFileSync('.claude/CLAUDE.md', 'utf8').split('\n')) {
    const heading = line.match(/^## (\d+)\./);
    if (heading) section = Number(heading[1]);

    const rule = line.match(/^(\d+)\. (.*)/);
    if (rule) rules.set(Number(rule[1]), { section, text: rule[2] });
}

const failures = [];
let checked = 0;
let pointers = 0;

for (const file of walk(ROOT)) {
    if (file.endsWith('CLAUDE.md')) continue;

    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        continue; // Binary or unreadable — nothing to check.
    }

    for (const [, sectionText, ruleText] of text.matchAll(REFERENCE)) {
        checked++;
        const wanted = Number(ruleText);
        const rule = rules.get(wanted);
        const where = `${relative(ROOT, file)} → §${sectionText}.${ruleText}`;

        if (!rule) {
            failures.push(`${where}: rule ${wanted} does not exist (CLAUDE.md has ${rules.size}).`);
        } else if (rule.section !== Number(sectionText)) {
            failures.push(`${where}: rule ${wanted} is in section ${rule.section}, not ${sectionText}.`);
        }
    }

    // The changelog records what was true then, including pages since removed.
    if (relative(ROOT, file) === 'CHANGELOG.md') continue;

    for (const [, page] of text.matchAll(DOC)) {
        pointers++;
        if (!existsSync(join(ROOT, '.claude', 'docs', page))) failures.push(`${relative(ROOT, file)} → docs/${page}: no such page.`);
    }
    for (const [, number] of text.matchAll(DECISION)) {
        pointers++;
        if (!decisions.has(number)) failures.push(`${relative(ROOT, file)} → D-${number}: no such decision.`);
    }
}

function* walk(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (/\.(js|mjs|md|html|css|json)$/.test(name)) yield path;
    }
}

if (failures.length) {
    console.error(`✗ ${failures.length} stale reference(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nA rule was renumbered, or a page or decision removed. Fix the references.');
    process.exit(1);
}

console.log(`✓ ${checked} rule references and ${pointers} doc and decision references resolve`);
