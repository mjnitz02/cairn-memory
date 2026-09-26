/**
 * The inspector — phase P0 (DESIGN.md §10).
 *
 * Prompt tuning happens in real play, not in tests, so these numbers have to be
 * on screen while you play. The stability meter is the one that matters: it is
 * the number that would have caught the interceptor regression in a turn instead
 * of in a forensic afternoon.
 */
import { SLUG } from '../constants.js';
import { nearPromptLimit } from '../util/context-size.js';
import { GATES, escapeHtml, fmt, row } from './html.js';
import { renderStateSection } from './state-section.js';

const STABILITY_BANDS = [
    { min: 95, className: 'good', note: 'prefix holding' },
    { min: 75, className: 'fair', note: 'prefix moving' },
    { min: 0, className: 'poor', note: 'prefix broken — something volatile is sitting too high' },
];

/**
 * @param {HTMLElement} host Element to render into.
 */
export function createInspector(host) {
    // Drawn apart: summaries and states land between generations, and redrawing the
    // snapshot for each would close whatever details the reader has open.
    host.innerHTML = `<div class="${SLUG}-snapshot"></div><div class="${SLUG}-summaries"></div><div class="${SLUG}-state"></div>`;
    const [snapshotPart, summariesPart, statePart] = host.children;
    // The state section joins the queue, which moves between generations, to the
    // placement, which only a generation changes.
    let stateStatus = null;
    let placement = null;
    const drawState = () => {
        statePart.innerHTML = renderStateSection(stateStatus, placement);
    };

    return {
        render(snapshot) {
            snapshotPart.innerHTML = snapshot ? renderSnapshot(snapshot) : renderEmpty();
            placement = snapshot?.state ?? null;
            drawState();
        },

        /** @param {object|null} status The summarizer's `status`. */
        summaries(status) {
            summariesPart.innerHTML = renderSummaries(status);
            stateStatus = status?.state ?? null;
            drawState();
        },
    };
}

function renderEmpty() {
    return `<div class="${SLUG}-inspector-empty">No generation observed yet. Send a message.</div>`;
}

/**
 * Exported for tests, which run without a DOM (CLAUDE.md §1.3): `createInspector` is the
 * part that touches one, and these two are the string-building the rows are worth
 * checking in — the same split `state-section.js` and `canon-section.js` already sit on.
 */
export function renderSnapshot(snapshot) {
    const { stability, summary, inventory, worldInfo } = snapshot;

    return [
        renderStability(stability),
        renderTotals(snapshot, summary),
        renderNearLimit(snapshot),
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

/**
 * Text completion drops the oldest raw messages once the prompt is full
 * (public/script.js:4920), and the block's fixed cap cannot see it coming
 * (docs/decisions.md D-0038).
 */
function renderNearLimit(snapshot) {
    const max = snapshot.memory?.maxPromptTokens;
    if (!nearPromptLimit(snapshot.promptTokens, max)) return '';

    return `<div class="${SLUG}-warn">The prompt is ${fmt(snapshot.promptTokens)} of the ${fmt(max)} tokens
        it may use, so SillyTavern may be dropping the oldest messages from the history.</div>`;
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
    const waiting = memory.stepWaiting
        ? ` <span class="${SLUG}-fair">\u2014 a step is waiting for a summary</span>`
        : '';
    const evicted = memory.evicted
        ? `<span class="${SLUG}-poor">evicted ${memory.evicted}</span>`
        : 'no eviction';

    const title = memory.writing
        ? `Memory block Cairn is injecting (${fmt(memory.tokens)} tokens)`
        : `Memory block Cairn would inject (${fmt(memory.tokens)} tokens)`;
    const budget = `${fmt(memory.tokens)} / ${fmt(memory.cap)} tokens, floor ${fmt(memory.floor)} \u2014 ${evicted}`;

    return renderRecoupled(memory) + `
        <details class="${SLUG}-details">
            <summary>${title}</summary>
            ${row('Writing', renderHandover(memory))}
            ${row('Scenes', `${fmt(memory.included)} in the block, of ${fmt(memory.scenes)} summarised (messages ${memory.oldest ?? '—'}\u2013${memory.newest ?? '—'})`)}
            ${row('Written by', describeSource(memory))}
            ${row('See-saw', `${step} at message ${memory.summarisedThrough}, ${memory.rawWindow} kept raw${waiting}`)}
            ${row('Budget', budget)}
            ${renderFidelity(memory)}
            ${renderIndexTally(memory)}
            ${renderCanon(memory)}
            ${renderCap(memory.budget)}
            ${renderExamples(memory)}
            ${row('Block change', change)}
        </details>`;
}

/**
 * The block's two fidelities (docs/decisions.md D-0075). Only shown once the compact
 * tail is holding something: before that the block is single-fidelity and byte-for-byte
 * what it always was, and a row of zeroes would suggest otherwise.
 *
 * `demoted` is the invariant a run reads: it may be non-zero only on a rebuild turn,
 * because a demotion rewrites the block's head exactly as an eviction does.
 */
function renderFidelity(memory) {
    if (!memory.blockCompact && !memory.compactMissing) return '';

    const demoted = memory.demoted
        ? ` \u2014 ${fmt(memory.demoted)} shortened this turn`
          + (memory.rebuilt ? '' : ` <span class="${SLUG}-poor">on a turn that was not rebuilding</span>`)
        : '';
    // A summary with no compact line evicts as it did before the tier existed. That is
    // the index queue lagging behind the boundary, never a correctness problem.
    const missing = memory.compactMissing
        ? ` <span class="${SLUG}-fair">\u2014 ${fmt(memory.compactMissing)} dropped for want of a short version</span>`
        : '';

    return row('Fidelity', `${fmt(memory.blockFull)} in full, ${fmt(memory.blockCompact)} shortened `
        + `<span class="dim">(tail ${fmt(memory.compactCap)} of ${fmt(memory.sceneCap)} tokens)</span>${demoted}${missing}`);
}

/**
 * The index this turn's pick would read, and its four-way split (docs/decisions.md
 * D-0070). Shown next to canon because it is canon's whole input: a spine that looks
 * wrong is usually an index that is thin, not a pick that chose badly.
 *
 * The split is worth a reader's eye. An extraction given no forced budget calls things
 * `major` far too often (D-0076); the label gates nothing (D-0082), but one that is all
 * `major` says the pass is not discriminating, and one that is all `filler` says it has
 * stopped trying.
 */
function renderIndexTally(memory) {
    if (!memory.indexRecords) return '';

    const kinds = Object.entries(memory.indexKinds ?? {})
        .sort(([, a], [, b]) => b - a)
        .map(([kind, count]) => `${fmt(count)} ${escapeHtml(kind)}`)
        .join(', ');

    return row('Index', `${fmt(memory.indexRecords)} records of ${fmt(memory.scenes)} summaries`
        + (kinds ? ` <span class="dim">(${kinds})</span>` : ''));
}

/**
 * Canon's share of the block (docs/p4-plan.md §3). Only shown once a chat has facts:
 * before that the block is byte-for-byte what it was, and a row of zeroes would
 * suggest otherwise.
 */
function renderCanon(memory) {
    if (!memory.canonFacts) return '';

    const spilled = memory.canonSpilled
        ? ` <span class="${SLUG}-fair">\u2014 ${fmt(memory.canonSpilled)} left out for want of room</span>`
        : '';
    // The applied cap is what the block was actually fitted to, so it is what the
    // numbers here are measured against (CLAUDE.md \u00a74.18). The live cap moves every
    // turn; showing it would read as "49 / 0 tokens" on a turn canon is still holding.
    const applied = memory.canonCapApplied ?? memory.canonCap;
    // Full means the *cap* left facts out, which is the only one of the two kinds of
    // full that is a problem: the slot count is the size of the question, and a pick
    // that fills fewer slots than it was offered is an answer (docs/decisions.md D-0079).
    const room = memory.canonFull
        ? `<span class="${SLUG}-fair">over the block's room, so the newest lines are held back</span>`
        : `${fmt(Math.max(0, applied - memory.canonTokens))} tokens spare`;
    const held = applied !== memory.canonCap
        ? ` <span class="${SLUG}-fair">\u2014 share is now ${fmt(memory.canonCap)}, held until the next rebuild</span>`
        : '';

    const slots = memory.canonSlots
        ? ` <span class="dim">(${fmt(memory.canonPicked)} of ${fmt(memory.canonSlots)} slots filled)</span>`
        : '';
    const lost = memory.canonLostSources
        ? ` <span class="${SLUG}-fair">\u2014 ${fmt(memory.canonLostSources)} lost the summary behind it, so canon is chosen again</span>`
        : '';

    return row('Canon', `${fmt(memory.canonAdmitted)} of ${fmt(memory.canonFacts)} facts, `
        + `${fmt(memory.canonTokens)} / ${fmt(applied)} tokens \u2014 ${room}${slots}${spilled}${held}${lost}`)
        + row('Scene budget', `${fmt(memory.sceneCap)} tokens, `
            + `after canon took ${fmt(memory.cap - memory.sceneCap)} of the block's ${fmt(memory.cap)}`);
}

/** How the cap was arrived at, in words rather than as four bare numbers. */
const CAP_LIMITS = Object.freeze({
    share: 'the fixed 35% share of the prompt',
    room: 'what the rest of the prompt leaves',
    starved: 'the 10% minimum — the card, lore and history already fill the prompt',
    unknown: 'the fixed 35% share — the rest of the prompt could not be read',
});

/** Where the lore reserve stopped. */
const LORE_BOUNDS = Object.freeze({
    budget: 'World Info budget',
    books: 'whole book',
    none: 'no lorebook',
});

/**
 * What the cap is made of (docs/decisions.md D-0052). The four reserves are the
 * difference between a block that fits and one that quietly pushes the card's
 * example messages and the oldest raw history out of the prompt — and from
 * inside Cairn that looks identical, because the block is under its cap either
 * way.
 */
function renderCap(budget) {
    if (!budget) return '';

    const limit = CAP_LIMITS[budget.limitedBy] ?? budget.limitedBy;
    const starved = budget.limitedBy === 'starved'
        ? `<div class="${SLUG}-warn">This chat's card, lorebook and raw history leave the memory block
            less than a tenth of the prompt, so it is keeping the minimum and SillyTavern is trimming
            the history to fit.</div>`
        : '';

    if (budget.limitedBy === 'unknown') return starved + row('Cap from', limit);

    const lore = `${fmt(budget.lore)} <span class="dim">(${LORE_BOUNDS[budget.loreBound] ?? ''}`
        + `${budget.loreBudget ? `, capped at ${fmt(budget.loreBudget)}` : ''})</span>`;
    const reserves = [
        ['card', budget.card], ['lore', lore], ['history', budget.window],
        ['world state', budget.state], ['margin', budget.margin],
    ].map(([name, value]) => `${escapeHtml(name)} ${typeof value === 'string' ? value : fmt(value)}`).join(', ');

    return starved
        + row('Cap from', `${limit} <span class="dim">(share ${fmt(budget.share)}, room ${fmt(budget.room)})</span>`)
        + row('Reserved', reserves);
}

/**
 * The examples latch in words (docs/decisions.md D-0068). It flips once per chat and
 * never back, and the turn it flips is the one cache miss it costs — so the run's check
 * is that this says "dropped" from some turn onwards and the card's reserve fell on the
 * same turn. Nothing is shown before it flips, because until then nothing has changed.
 */
function renderExamples(memory) {
    if (!memory.examplesStripped) return '';

    const latched = memory.examplesLatched
        ? ` <span class="${SLUG}-fair">\u2014 dropped on this turn, which costs one cache miss</span>`
        : '';
    return row('Example dialogue', `dropped \u2014 summaries stand in for it now${latched}`);
}

function describeSource(memory) {
    const source = { qvink: 'Qvink', cairn: 'Cairn', mixed: 'Qvink, then Cairn' }[memory.source] ?? '\u2014';
    return `${source} <span class="dim">(${fmt(memory.cairnScenes)} of Cairn's own in the chat)</span>`;
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
 * Cairn's own summaries: what it is doing now, what it has cost this chat, and what
 * it gave up on. A given-up message holds the memory step, which is invisible in play
 * until the raw history is visibly long (docs/decisions.md D-0037).
 */
export function renderSummaries(status) {
    if (!status) return '';

    const failures = status.failures
        ? `<span class="${SLUG}-poor">${fmt(status.failures)} failed</span> <span class="dim">(last: ${escapeHtml(status.lastReason)})</span>`
        : 'none failed';
    const average = status.calls ? `${fmt(Math.round(status.ms / status.calls))} ms a request` : '\u2014';

    return renderGivenUp(status.givenUp) + `
        <details class="${SLUG}-details">
            <summary>Summaries: ${describeWork(status)}</summary>
            ${row('This chat', `${fmt(status.written)} written from ${fmt(status.calls)} requests, ${failures}`)}
            ${row('Time', average)}
            ${row('Tokens', `${fmt(status.tokensIn)} in, ${fmt(status.tokensOut)} out <span class="dim">(estimated)</span>`)}
            ${row('Prompt', status.promptDefault === false ? 'edited' : 'default')}
        </details>` + renderIndexQueue(status.index) + renderCompaction(status.canon);
}

/**
 * The index queue (docs/decisions.md D-0070, D-0075), between the summaries it reads and
 * the pick it feeds. It is two things at once — the block's compact tier and the pick's
 * whole input — so a chat that has turned canon off still fills it.
 *
 * The four-way split is shown because it is the thing to watch: an extraction with no
 * forced budget over-labels `major` (D-0076), and while the label gates nothing
 * (D-0082), a wildly skewed one says the pass is not reading carefully.
 */
function renderIndexQueue(status) {
    if (!status) return '';

    const failures = status.failures
        ? `<span class="${SLUG}-poor">${fmt(status.failures)} failed</span> <span class="dim">(last: ${escapeHtml(status.lastReason)})</span>`
        : 'none failed';
    const missed = status.missed
        ? `, ${fmt(status.missed)} unanswered`
        : '';
    const dropped = status.dropped ? `, ${fmt(status.dropped)} slots dropped` : '';

    return `
        <details class="${SLUG}-details">
            <summary>Index: ${describeIndexQueue(status)}</summary>
            ${row('This chat', `${fmt(status.records)} records from ${fmt(status.calls)} batches, ${failures}${dropped}${missed}`)}
            ${row('Tokens', `${fmt(status.tokensIn)} in, ${fmt(status.tokensOut)} out <span class="dim">(estimated)</span>`)}
        </details>`;
}

function describeIndexQueue(status) {
    if (status.inFlight != null) return 'reading summaries into records';
    if (status.gate === null) return 'not started';
    if (status.gate === 'not-writing') return 'waiting \u2014 qvink is still writing the block';
    if (status.gate !== 'ready') return escapeHtml(GATES[status.gate] ?? status.gate);
    if (status.givenUp) return `<span class="${SLUG}-poor">gave up on a batch</span>`;
    if (status.pending) {
        return `${fmt(status.waiting)} summaries waiting `
            + `<span class="dim">(next: #${status.pending.from}\u2013#${status.pending.to})</span>`;
    }
    return 'every summary has a record';
}

/**
 * The canon queue (docs/decisions.md D-0071), under the summaries it reads. Its counts
 * are of the applied change: what was written, what the pick repeated itself on, and
 * what the parser refused (CLAUDE.md §4.18).
 */
function renderCompaction(status) {
    if (!status) return '';

    const failures = status.failures
        ? `<span class="${SLUG}-poor">${fmt(status.failures)} failed</span> <span class="dim">(last: ${escapeHtml(status.lastReason)})</span>`
        : 'none failed';
    const refused = status.duplicates || status.refused
        ? `, ${fmt(status.duplicates)} repeated, ${fmt(status.refused)} refused`
        : '';
    const average = status.calls ? `${fmt(Math.round(status.ms / status.calls))} ms a pick` : '\u2014';

    return `
        <details class="${SLUG}-details">
            <summary>Canon: ${describeCompaction(status)}</summary>
            ${row('This chat', `${fmt(status.picked)} facts from ${fmt(status.calls)} picks, ${failures}${refused}`)}
            ${row('Time', average)}
            ${row('Tokens', `${fmt(status.tokensIn)} in, ${fmt(status.tokensOut)} out <span class="dim">(estimated)</span>`)}
        </details>`;
}

function describeCompaction(status) {
    if (status.inFlight != null) return 'choosing the facts the story rests on';
    if (status.gate === null) return 'not started';
    if (status.gate === 'off') return 'off';
    if (status.gate === 'not-writing') return 'waiting \u2014 qvink is still writing the block';
    if (status.gate !== 'ready') return escapeHtml(GATES[status.gate] ?? status.gate);
    if (status.givenUp) return `<span class="${SLUG}-poor">gave up</span>`;
    if (status.pending) {
        return `a pick is due over ${fmt(status.pending.records)} records `
            + `(#${status.pending.covers[0]}\u2013#${status.pending.covers[1]}), ${fmt(status.pending.slots)} slots`;
    }
    // The reasons a pick is not due, in the queue's own words (pipeline/compactor.js).
    if (status.reason === 'too-few') return 'waiting \u2014 too few records to rank yet';
    if (status.reason === 'covered') return 'chosen, and up to date with the index';
    return 'nothing to choose from yet';
}

function describeWork(status) {
    if (status.inFlight != null) return `writing message #${status.inFlight}`;
    if (status.gate && status.gate !== 'ready') return escapeHtml(GATES[status.gate] ?? status.gate);
    if (status.gate === null) return 'not started';
    const waiting = (status.pending ?? 0) - (status.givenUp?.length ?? 0);
    return waiting > 0 ? `${fmt(waiting)} waiting` : 'up to date';
}

function renderGivenUp(givenUp) {
    if (!givenUp?.length) return '';

    const which = givenUp.map((index) => `#${index}`).join(', ');
    const many = givenUp.length > 1;
    return `<div class="${SLUG}-warn">Cairn gave up summarising message${many ? 's' : ''} ${which} after
        repeated failures. The memory step waits before ${many ? 'them' : 'it'} until you reload the page
        or edit the message.</div>`;
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
