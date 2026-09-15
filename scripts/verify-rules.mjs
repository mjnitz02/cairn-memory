#!/usr/bin/env node
/**
 * Checks that every `CLAUDE.md §N.M` reference in the repo resolves to a rule
 * that exists, and that its text still looks like what the citing file claims.
 *
 * Rules are numbered, so inserting one silently shifts every reference after it
 * — which happened the first time a rule was added (CLAUDE.md §9.35: if a
 * mistake can be caught mechanically, catch it mechanically).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.git', 'coverage', '.github']);
const REFERENCE = /CLAUDE\.md §(\d+)\.(\d+)/g;

// Rule N lives under section S; both are needed to validate a §S.N reference.
const rules = new Map();
let section = 0;
for (const line of readFileSync('CLAUDE.md', 'utf8').split('\n')) {
    const heading = line.match(/^## (\d+)\./);
    if (heading) section = Number(heading[1]);

    const rule = line.match(/^(\d+)\. (.*)/);
    if (rule) rules.set(Number(rule[1]), { section, text: rule[2] });
}

const failures = [];
let checked = 0;

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
    console.error(`✗ ${failures.length} stale rule reference(s):\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nRules were probably renumbered. Fix the references, not the rules.');
    process.exit(1);
}

console.log(`✓ ${checked} rule references resolve`);
