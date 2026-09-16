/**
 * Who is writing into the prompt, and how much.
 *
 * ST parks every injection in `extension_prompts`, keyed by whoever set it
 * (public/scripts/st-context.js:152). Reading that tells us what Cairn will
 * eventually have to take over — and, today, who else is already writing
 * (DESIGN.md §10). Pure: give it the prompts object, get an accounting back.
 */
import { SLUG } from '../constants.js';
import { estimateTokens } from '../util/tokens.js';

/** public/script.js:484 */
export const POSITION_NAMES = {
    '-1': 'parked',      // NONE — placed by macro, not automatically
    0: 'in-prompt',      // IN_PROMPT
    1: 'in-chat',        // IN_CHAT
    2: 'before-prompt',  // BEFORE_PROMPT
};

/**
 * Identify an injection from its key. Patterns come from ST's own
 * `inject_ids` (public/scripts/constants.js:48) plus the extensions we
 * knowingly share a prompt with.
 */
export function classifySource(key) {
    if (key.startsWith(`${SLUG}_`) || key === SLUG) {
        return { owner: 'cairn', label: 'Cairn' };
    }
    if (key.startsWith('customWIOutlet_')) {
        return { owner: 'wi-outlet', label: `Lorebook outlet: ${key.slice('customWIOutlet_'.length)}` };
    }
    if (key.startsWith('customDepthWI')) {
        return { owner: 'wi-depth', label: 'Lorebook @ depth' };
    }
    if (key.startsWith('qvink_memory')) {
        return { owner: 'qvink', label: `Qvink Memory (${key.replace('qvink_memory_', '')})` };
    }
    if (key.startsWith('1_memory')) {
        return { owner: 'st-summary', label: 'ST Summarize' };
    }
    if (key === '2_floating_prompt') {
        return { owner: 'authors-note', label: "Author's Note" };
    }
    if (key.startsWith('DEPTH_PROMPT')) {
        return { owner: 'depth-prompt', label: 'Character depth prompt' };
    }
    if (key === '__STORY_STRING__') {
        return { owner: 'story-string', label: 'Story string' };
    }
    if (key === 'QUIET_PROMPT') {
        return { owner: 'quiet', label: 'Quiet prompt' };
    }
    return { owner: 'other', label: key };
}

/**
 * Accounting for every non-empty injection, ordered the way they reach the
 * prompt: earliest position first, then deepest first within in-chat (depth 0
 * is nearest the end).
 *
 * `countTokens` defaults to the cheap estimate. Pass ST's tokenizer to get
 * numbers that can be compared against the prompt total — chars/4 overstates
 * prose by roughly a third, which is enough to make an injection look like it
 * has blown a budget it is actually inside.
 *
 * @param {Record<string, {value: string, position: number, depth: number, role: number}>} extensionPrompts
 * @param {{countTokens?: (text: string) => number | Promise<number>}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function buildInventory(extensionPrompts, { countTokens = estimateTokens } = {}) {
    const entries = [];

    for (const [key, prompt] of Object.entries(extensionPrompts ?? {})) {
        const value = prompt?.value ?? '';
        if (!value) continue; // A cleared injection is not a writer.

        const { owner, label } = classifySource(key);
        entries.push({
            tokens: await countTokens(value),
            estimated: countTokens === estimateTokens,
            key,
            owner,
            label,
            position: prompt.position,
            positionName: POSITION_NAMES[String(prompt.position)] ?? `unknown(${prompt.position})`,
            // ST collects by position (public/script.js:3312); NONE reaches the
            // prompt only through a macro, so it is listed but is not a writer.
            placed: Number(prompt.position) >= 0,
            depth: prompt.depth,
            role: prompt.role,
            chars: value.length,
        });
    }

    return entries.sort(compareByPromptOrder);
}

/** Totals, plus a per-owner breakdown — the "who is in here" answer. `writers` counts placed owners only. */
export function summarizeInventory(entries) {
    const byOwner = {};
    const writers = new Set();
    let tokens = 0;

    for (const entry of entries) {
        tokens += entry.tokens;
        byOwner[entry.owner] ??= { owner: entry.owner, count: 0, tokens: 0 };
        byOwner[entry.owner].count++;
        byOwner[entry.owner].tokens += entry.tokens;
        if (entry.placed) writers.add(entry.owner);
    }

    return {
        count: entries.length,
        tokens,
        writers: writers.size,
        byOwner: Object.values(byOwner).sort((a, b) => b.tokens - a.tokens),
    };
}

function compareByPromptOrder(a, b) {
    if (a.position !== b.position) return a.position - b.position;
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.key.localeCompare(b.key);
}
