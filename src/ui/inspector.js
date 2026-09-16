/**
 * The inspector — phase P0 (DESIGN.md §10).
 *
 * Prompt tuning happens in real play, not in tests, so these numbers have to be
 * on screen while you play. The stability meter is the one that matters: it is
 * the number that would have caught the interceptor regression in a turn instead
 * of in a forensic afternoon.
 */
import { SLUG } from '../constants.js';

const STABILITY_BANDS = [
    { min: 95, className: 'good', note: 'prefix holding' },
    { min: 75, className: 'fair', note: 'prefix moving' },
    { min: 0, className: 'poor', note: 'prefix broken — something volatile is sitting too high' },
];

/**
 * @param {HTMLElement} host Element to render into.
 */
export function createInspector(host) {
    return {
        render(snapshot) {
            host.innerHTML = snapshot ? renderSnapshot(snapshot) : renderEmpty();
        },
    };
}

function renderEmpty() {
    return `<div class="${SLUG}-inspector-empty">No generation observed yet. Send a message.</div>`;
}

function renderSnapshot(snapshot) {
    const { stability, summary, inventory, worldInfo } = snapshot;

    return [
        renderStability(stability),
        renderTotals(snapshot, summary),
        renderWriters(summary),
        renderInventory(inventory),
        renderWorldInfo(worldInfo, snapshot.worldInfoOrdering, snapshot.worldInfoHeld),
        renderMemory(snapshot.memory),
        renderDivergence(stability, snapshot.divergenceIn),
    ].join('');
}

function renderStability(stability) {
    const percent = stability.stabilityPercent;

    if (percent == null) {
        return row('Prefix stability', '— <span class="dim">(first turn — no baseline)</span>');
    }

    const band = STABILITY_BANDS.find((b) => percent >= b.min);
    return `
        <div class="${SLUG}-meter">
            <div class="${SLUG}-meter-head">
                <span>Prefix stability</span>
                <b class="${SLUG}-${band.className}">${percent}%</b>
            </div>
            <div class="${SLUG}-meter-track">
                <div class="${SLUG}-meter-fill ${SLUG}-${band.className}" style="width: ${percent}%"></div>
            </div>
            <div class="${SLUG}-hint">${band.note} — ${fmt(stability.commonPrefix)} of ${fmt(stability.currentLength)} chars reused</div>
        </div>`;
}

function renderTotals(snapshot, summary) {
    const context = snapshot.contextPercent == null
        ? `${fmt(snapshot.promptTokens)} tokens`
        : `${fmt(snapshot.promptTokens)} / ${fmt(snapshot.maxContext)} tokens (${snapshot.contextPercent}%)`;

    return row('Prompt', context)
        + row('API', snapshot.api)
        + row('Injected', `${fmt(summary.tokens)} tokens across ${summary.count} injection(s)`);
}

function renderWriters(summary) {
    if (!summary.count) return '';

    // More than one writer is the condition the whole design exists to remove.
    const warning = summary.writers > 1
        ? `<div class="${SLUG}-warn">${summary.writers} extensions are writing into this prompt.</div>`
        : '';

    const items = summary.byOwner
        .map((o) => `<li><span>${escapeHtml(o.owner)}</span><b>${fmt(o.tokens)}</b></li>`)
        .join('');

    return `${warning}<ul class="${SLUG}-list">${items}</ul>`;
}

function renderInventory(inventory) {
    if (!inventory.length) return '';

    const rows = inventory.map((entry) => `
        <tr>
            <td>${escapeHtml(entry.label)}</td>
            <td>${escapeHtml(entry.positionName)}</td>
            <td>${entry.position === 1 ? entry.depth : '—'}</td>
            <td>${fmt(entry.tokens)}</td>
        </tr>`).join('');

    return `
        <details class="${SLUG}-details">
            <summary>Injections in prompt order</summary>
            <table class="${SLUG}-table">
                <thead><tr><th>Source</th><th>Position</th><th>Depth</th><th>Tokens</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </details>`;
}

function renderWorldInfo(worldInfo, ordering, held) {
    if (!worldInfo?.length) return '';

    const items = worldInfo
        .map((e) => `<li>${escapeHtml(e.comment || `uid ${e.uid}`)} <span class="dim">${escapeHtml(e.world)}</span></li>`)
        .join('');

    // Says which of the two regimes produced this block, so a stability number
    // read off the panel is never ambiguous about it (docs/decisions.md D-0024).
    const holding = Number.isFinite(held)
        ? ` <span class="dim">— ${held} held</span>`
        : ' <span class="dim">— not held</span>';

    return renderOrderWarning(ordering) + `
        <details class="${SLUG}-details">
            <summary>Lorebook entries activated (${worldInfo.length})${holding}</summary>
            <ul class="${SLUG}-list">${items}</ul>
        </details>`;
}

/**
 * Entries tied on `order` keep whatever order they activated in, which changes
 * with the chat text — so the block rewrites itself every turn and everything
 * below it is re-read. Invisible in play, and it cost an afternoon to find by
 * hand once (docs/decisions.md D-0022). Now it says so.
 */
function renderOrderWarning(ordering) {
    if (!ordering || ordering.stable) return '';

    const { tiedEntries, activated } = ordering;
    return `<div class="${SLUG}-warn">${tiedEntries} of ${activated} lorebook entries share an
        <code>order</code> value, so their order in the prompt is decided by which keyword matched
        first and changes every turn. Give them distinct <code>order</code> values.</div>`;
}

/**
 * The assembler's plan, and the one number it exists to move.
 *
 * A see-saw step has to change the block's *tail*, not its head
 * (docs/decisions.md D-0019). "changed at 98% of the block" is that working;
 * "changed at 0%" on a step turn is it not, and the difference is invisible in
 * play — which is why it is on the panel rather than only in the log.
 */
function renderMemory(memory) {
    if (!memory) return '';

    const where = memory.change?.divergencePercent;
    const change = memory.change?.stabilityPercent == null
        ? 'first turn — no baseline'
        : (where == null
            ? 'unchanged since last turn'
            : `changed ${where}% of the way into the block`);

    const step = memory.stepped ? `stepped (${escapeHtml(memory.stepReason)})` : 'held';
    const evicted = memory.evicted
        ? `<span class="${SLUG}-poor">evicted ${memory.evicted}</span>`
        : 'no eviction';

    const title = memory.writing
        ? `Memory block Cairn is injecting (${fmt(memory.tokens)} tokens)`
        : `Memory block Cairn would inject (${fmt(memory.tokens)} tokens)`;
    const budget = memory.capEstimated
        ? `${fmt(memory.tokens)} / ${fmt(memory.cap)} tokens (estimated until the first prompt is measured)`
        : `${fmt(memory.tokens)} / ${fmt(memory.cap)} tokens, floor ${fmt(memory.floor)} \u2014 ${evicted}`;

    return renderRecoupled(memory) + `
        <details class="${SLUG}-details">
            <summary>${title}${renderFidelity(memory.fidelity)}</summary>
            ${row('Writing', renderHandover(memory))}
            ${row('Scenes', `${fmt(memory.included)} in the block, of ${fmt(memory.scenes)} summarised (messages ${memory.oldest ?? '—'}\u2013${memory.newest ?? '—'})`)}
            ${row('See-saw', `${step} at message ${memory.summarisedThrough}, ${memory.rawWindow} kept raw`)}
            ${row('Budget', budget)}
            ${row('Block change', change)}
        </details>`;
}

/**
 * Whether Cairn is the prompt's writer this turn, and if not, which switch would
 * make it one (src/prompt/handover.js). A gate that closes silently would look
 * exactly like a gate that is open and working.
 */
function renderHandover(memory) {
    if (memory.writing) {
        return `yes \u2014 ${fmt(memory.blanked)} summarised messages held out of the history`;
    }
    return `<span class="${SLUG}-fair">no \u2014 ${escapeHtml(memory.handoverDetail ?? '')}</span>`;
}

/**
 * The split between growing the block and evicting from it is conditional:
 * rebuilds are spaced by the slack a rebuild buys divided by what a step costs.
 * A context too tight to hold more than a step or two puts eviction back on every
 * step — and the block still looks entirely correct while that happens, so it
 * takes a sentence to notice (docs/decisions.md D-0026).
 */
function renderRecoupled(memory) {
    if (!memory.recoupled) return '';

    return `<div class="${SLUG}-warn">The memory block has ${fmt(memory.slack)} tokens of room before
        it must evict, but a see-saw step adds about ${fmt(memory.stepTokens)} — so every step also
        rebuilds the block. There is not enough context here to keep the two apart.</div>`;
}

/**
 * Whether our render of qvink's own selection is qvink's block byte for byte.
 * Taking over the injection before this is true would move the block and change
 * its contents in one go, and no later measurement could separate the two.
 */
function renderFidelity(fidelity) {
    if (!fidelity?.compared) return '';
    if (fidelity.match) return ` <span class="dim">— matches qvink byte for byte</span>`;

    const caveat = fidelity.resolved
        ? ' (compared after resolving the template\'s macros)'
        : '';
    return ` <span class="${SLUG}-poor">— diverges from qvink at ${fmt(fidelity.divergeAt)}${caveat}</span>`;
}

function renderDivergence(stability, divergenceIn) {
    if (!stability.divergence) return '';

    return `
        <details class="${SLUG}-details">
            <summary>What changed since last turn</summary>
            <div class="${SLUG}-hint">Prompts diverge at character ${fmt(stability.divergence.index)}${describeBreak(divergenceIn)}.</div>
            <pre class="${SLUG}-diff"><span class="${SLUG}-was">- ${escapeHtml(stability.divergence.previous)}</span>
<span class="${SLUG}-now">+ ${escapeHtml(stability.divergence.current)}</span></pre>
        </details>`;
}

/**
 * Name the block the break fell in. Hedged exactly as far as the match was:
 * an approximate location reported as a certain one is worse than none, because
 * it sends tuning after the wrong block.
 */
function describeBreak(divergenceIn) {
    if (!divergenceIn) return '';

    const where = escapeHtml(divergenceIn.label);
    switch (divergenceIn.precision) {
        case 'inside':
            return `, ${fmt(divergenceIn.offsetInEntry)} chars into ${where}`;
        case 'after':
            return `, after the end of ${where}`;
        case 'probe':
            return `, at or after the start of ${where} <span class="dim">(approximate)</span>`;
        default:
            return ', above every injection';
    }
}

function row(label, value) {
    return `<div class="${SLUG}-row"><span>${label}</span><b>${value}</b></div>`;
}

function fmt(n) {
    return Number(n ?? 0).toLocaleString();
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]
    ));
}
