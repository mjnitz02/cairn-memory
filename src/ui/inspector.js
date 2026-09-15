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
        renderWorldInfo(worldInfo, snapshot.worldInfoOrdering),
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

function renderWorldInfo(worldInfo, ordering) {
    if (!worldInfo?.length) return '';

    const items = worldInfo
        .map((e) => `<li>${escapeHtml(e.comment || `uid ${e.uid}`)} <span class="dim">${escapeHtml(e.world)}</span></li>`)
        .join('');

    return renderOrderWarning(ordering) + `
        <details class="${SLUG}-details">
            <summary>Lorebook entries activated (${worldInfo.length})</summary>
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
