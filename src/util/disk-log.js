/**
 * Writes the observer's snapshots to a file on disk, so a run can be read
 * directly instead of copied out of the inspector by hand.
 *
 * Uses ST's own Data Bank endpoint (`/api/files/upload`,
 * src/endpoints/files.js:28) rather than inventing a transport or adding a
 * server plugin. It writes whole files, not appends, so we rewrite the full
 * rolling log each time — a few hundred KB at most for a long session.
 *
 * Lands in `data/<user>/user/files/`.
 */
import { nearPromptLimit } from './context-size.js';
import { warn, debug } from './log.js';

/** Fixed name so the path is predictable between sessions. */
export const LOG_FILENAME = 'cairn-inspector.jsonl';

/** Wait for a quiet moment before writing; generations arrive in bursts. */
const WRITE_DELAY_MS = 1500;

export function createDiskLog({ filename = LOG_FILENAME, delayMs = WRITE_DELAY_MS } = {}) {
    const entries = [];
    let enabled = false;
    let timer = null;
    let lastPath = null;

    async function flush(getContext) {
        timer = null;
        if (!entries.length) return;

        try {
            const context = getContext();
            const body = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';

            const response = await fetch('/api/files/upload', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ name: filename, data: toBase64(body) }),
            });

            if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

            lastPath = (await response.json()).path;
            debug(`Wrote ${entries.length} snapshot(s) to ${lastPath}`);
        } catch (err) {
            // A diagnostic that cannot write is still only a diagnostic.
            warn('Could not write the inspector log.', err);
        }
    }

    return {
        setEnabled(value) {
            enabled = Boolean(value);
        },

        /** Queue a snapshot. Writes are debounced, not per-turn. */
        append(snapshot, getContext) {
            if (!enabled) return;

            entries.push(toEntry(snapshot));
            clearTimeout(timer);
            timer = setTimeout(() => flush(getContext), delayMs);
        },

        /** Drop the accumulated run — a new chat is a new run. */
        reset() {
            entries.length = 0;
        },

        get count() {
            return entries.length;
        },

        get path() {
            return lastPath;
        },
    };
}

/**
 * One line per generation. Flat and self-describing: this file is meant to be
 * read by a person or a script that has never seen the code.
 */
function toEntry(snapshot) {
    return {
        at: snapshot.at,
        api: snapshot.api,
        prompt_tokens: snapshot.promptTokens,
        prompt_chars: snapshot.promptChars,
        max_context: snapshot.maxContext,
        context_percent: snapshot.contextPercent,
        stability_percent: snapshot.stability.stabilityPercent,
        common_prefix: snapshot.stability.commonPrefix,
        previous_chars: snapshot.stability.previousLength,
        divergence_index: snapshot.stability.divergence?.index ?? null,
        divergence_previous: snapshot.stability.divergence?.previous ?? null,
        divergence_current: snapshot.stability.divergence?.current ?? null,
        // Which block the prefix broke inside. `precision` says how much to
        // trust it — see attributeOffset in src/prompt/locate.js.
        divergence_in: snapshot.divergenceIn?.key ?? null,
        divergence_in_owner: snapshot.divergenceIn?.owner ?? null,
        divergence_in_offset: snapshot.divergenceIn?.offsetInEntry ?? null,
        divergence_in_precision: snapshot.divergenceIn?.precision ?? null,
        injected_tokens: snapshot.summary.tokens,
        injected_tokens_estimated: snapshot.inventory.some((entry) => entry.estimated),
        injection_count: snapshot.summary.count,
        writers: snapshot.summary.writers,
        by_owner: snapshot.summary.byOwner,
        injections: snapshot.inventory.map((entry) => ({
            key: entry.key,
            owner: entry.owner,
            position: entry.positionName,
            depth: entry.depth,
            tokens: entry.tokens,
            chars: entry.chars,
            // Where it actually landed, which is the only way to tell a plan
            // that was written from a plan that was honoured.
            offset: entry.offset ?? null,
            offset_percent: entry.offsetPercent ?? null,
            match: entry.match ?? null,
        })),
        world_info: snapshot.worldInfo.map((entry) => ({
            world: entry.world,
            uid: entry.uid,
            comment: entry.comment,
            order: entry.order ?? null,
        })),
        // Entries tied on `order` keep activation order, which changes per turn.
        world_info_tied: snapshot.worldInfoOrdering?.tiedEntries ?? 0,
        world_info_ordering_stable: snapshot.worldInfoOrdering?.stable ?? null,
        // How many entries the holder is keeping in; null when it is off, which is
        // what tells a control run apart from a treatment run.
        world_info_held: snapshot.worldInfoHeld ?? null,
        // The held set's re-evaluation (docs/decisions.md D-0069). `lore_reprioritised`
        // is true only on turns where `memory_rebuilt` is; any other turn is D-0067
        // failing. `lore_dropped` is non-zero only on those same turns.
        lore_reprioritised: Boolean(snapshot.worldInfoTrim),
        lore_dropped: snapshot.worldInfoTrim?.dropped ?? null,
        lore_held_tokens: snapshot.worldInfoTrim?.tokens ?? null,
        // Full enough that text completion may have dropped the oldest raw messages,
        // which the block's cap cannot see (util/context-size.js).
        prompt_near_limit: nearPromptLimit(snapshot.promptTokens, snapshot.memory?.maxPromptTokens),
        ...memoryFields(snapshot.memory),
        ...summaryFields(snapshot.summaries),
        ...stateFields(snapshot.state, snapshot.summaries?.state),
        ...compactionFields(snapshot.summaries?.canon),
        ...indexFields(snapshot.summaries?.index),
    };
}

/**
 * The assembler's plan for this turn, flattened.
 *
 * `memory_change_percent` is the number P1 is aimed at: how far into the block
 * the first changed byte fell. Near 100 means a step changed the block's tail,
 * which is the whole of docs/decisions.md D-0019. Near 0 on a step turn means it
 * changed the head and nothing was gained.
 */
function memoryFields(memory) {
    if (!memory) return { memory_planned: false, ...budgetFields(null) };

    return {
        memory_planned: true,
        // Who wrote the summaries in the block: qvink, cairn, mixed, or null.
        memory_source: memory.source,
        memory_cairn_scenes: memory.cairnScenes ?? null,
        // A due step held back by a summary not yet written. Stays false in normal play.
        memory_step_waiting: memory.stepWaiting ?? null,
        // Which arm the turn is in: Cairn writing the block, or qvink still
        // writing it and Cairn only measuring (docs/decisions.md D-0027).
        memory_writing: memory.writing ?? false,
        memory_handover: memory.handover ?? null,
        memory_blanked: memory.blanked ?? null,
        memory_scenes: memory.scenes,
        memory_included: memory.included,
        memory_oldest: memory.oldest,
        memory_newest: memory.newest,
        memory_summarised_through: memory.summarisedThrough,
        memory_stepped: memory.stepped,
        memory_step_reason: memory.stepReason,
        memory_evicted: memory.evicted,
        // The rebuild turn (docs/decisions.md D-0067): everything discontinuous
        // batches here, and nothing discontinuous may happen anywhere else.
        memory_rebuilt: memory.rebuilt ?? null,
        memory_over_cap: memory.overCap,
        // The cap in use: the smaller of the fixed share and what the chat leaves
        // (docs/decisions.md D-0038, D-0052).
        memory_cap: memory.cap,
        // Canon at the block's head (docs/p4-plan.md §3). `memory_canon_admitted` is the
        // check the run reads: it may change only on a turn where `memory_evicted > 0`
        // or `memory_step_reason` is `first-turn`.
        memory_canon_facts: memory.canonFacts ?? null,
        memory_canon_admitted: memory.canonAdmitted ?? null,
        memory_canon_tokens: memory.canonTokens ?? null,
        memory_canon_cap: memory.canonCap ?? null,
        // What the block was fitted to, which between rebuilds is the cap the last
        // rebuild froze. A gap against `memory_canon_cap` is canon over its share.
        memory_canon_cap_applied: memory.canonCapApplied ?? null,
        // share or guard — whether canon's fifth or the see-saw's two steps bound it.
        memory_canon_limited_by: memory.canonLimitedBy ?? null,
        memory_canon_full: memory.canonFull ?? null,
        // Facts the chat holds that the cap left out of this block.
        memory_canon_spilled: memory.canonSpilled ?? null,
        memory_canon_through: memory.canonThrough ?? null,
        // The cap less what canon took: what the summaries are actually fitted to.
        memory_scene_cap: memory.sceneCap ?? null,
        // The block's two fidelities (docs/decisions.md D-0075). The checks a run reads:
        // `memory_demoted` may be non-zero only where `memory_rebuilt` is true, and
        // `memory_block_full + memory_block_compact` is `memory_included`.
        // `memory_compact_missing` counts summaries evicted only for want of a line —
        // the index queue lagging, never a correctness problem — and
        // `memory_compact_cap` is 0 until lines exist to fill the tail.
        memory_block_full: memory.blockFull ?? null,
        memory_block_compact: memory.blockCompact ?? null,
        memory_demoted: memory.demoted ?? null,
        memory_compact_missing: memory.compactMissing ?? null,
        memory_compact_cap: memory.compactCap ?? null,
        memory_full_cap: memory.fullCap ?? null,
        memory_compact_boundary: memory.compactBoundary ?? null,
        memory_floor: memory.floor,
        // What one see-saw step costs. It drives `canonCap`'s guard, so without it a
        // moving canon cap cannot be explained from the log alone.
        memory_step_tokens: memory.stepTokens ?? null,
        memory_max_prompt_tokens: memory.maxPromptTokens,
        ...budgetFields(memory.budget),
        memory_chars: memory.chars,
        memory_tokens: memory.tokens,
        memory_stability_percent: memory.change?.stabilityPercent ?? null,
        memory_change_at: memory.change?.divergenceAt ?? null,
        memory_change_percent: memory.change?.divergencePercent ?? null,
    };
}

/**
 * Where the cap came from (docs/decisions.md D-0052). Every reserve is worked
 * out from the chat and the settings, so these numbers hold still between a card
 * edit, a book edit, a context change and a heavier run of messages — and a run
 * that shows otherwise is the evidence against D-0052, not a detail.
 *
 * `budget_window_now` is the exception: it is what the raw window weighs *this*
 * turn, reported so the margin can be checked against
 * `prompt_tokens − memory_tokens − state_tokens`, and never planned against.
 */
function budgetFields(budget) {
    if (!budget) return { budget_reported: false };

    return {
        budget_reported: true,
        // share, room, starved or unknown — which of the two limits bound the cap.
        budget_limited_by: budget.limitedBy ?? null,
        budget_share: budget.share ?? null,
        budget_room: budget.room ?? null,
        budget_minimum: budget.minimum ?? null,
        budget_margin: budget.margin ?? null,
        budget_card: budget.card ?? null,
        budget_lore: budget.lore ?? null,
        // budget, books or none — what bound the lore reserve.
        budget_lore_bound: budget.loreBound ?? null,
        // ST's own World Info budget, which the holder trims the held set to (D-0069).
        budget_lore_budget: budget.loreBudget ?? null,
        budget_window: budget.window ?? null,
        budget_window_now: budget.windowNow ?? null,
        budget_state: budget.state ?? null,
    };
}

/**
 * The summarizer as the prompt went out. Counts, sizes and times are running totals
 * for the chat, so the work between two generations is the difference of two lines.
 * Never a summary's text.
 */
function summaryFields(status) {
    if (!status) return { summary_reported: false };

    return {
        summary_reported: true,
        // Why Cairn is or is not summarising (src/pipeline/gates.js).
        summary_gate: status.gate ?? null,
        // A request was out while this prompt was built: the overlap docs/decisions.md D-0041 counts.
        summary_in_flight: status.inFlight != null,
        summary_pending: status.pending ?? null,
        summary_given_up: status.givenUp ?? [],
        summary_calls: status.calls,
        summary_written: status.written,
        summary_failures: status.failures,
        summary_last_reason: status.lastReason ?? null,
        summary_ms: status.ms,
        summary_last_ms: status.lastMs ?? null,
        // Counted with ST's tokenizer, which is the chat model's: close, not billed.
        summary_tokens_in: status.tokensIn,
        summary_tokens_out: status.tokensOut,
        summary_prompt_default: status.promptDefault ?? null,
    };
}

/**
 * The compaction queue as the prompt went out (docs/p4-plan.md §3). Counts are running
 * totals for the chat, so the work between two generations is the difference of two
 * lines, and every one of them is of the *applied* change (CLAUDE.md §4.18). Never a
 * fact's text.
 */
function compactionFields(status) {
    if (!status) return { compaction_reported: false };

    return {
        compaction_reported: true,
        // ready, off, not-writing, no-profile, group-chat, no-chat or profile-missing.
        compaction_gate: status.gate ?? null,
        compaction_in_flight: status.inFlight != null,
        // The range a due pass would read, or null when none is due.
        compaction_pending: status.pending?.covers ?? null,
        compaction_pending_summaries: status.pending?.summaries ?? null,
        compaction_given_up: status.givenUp ?? null,
        // No room left, so no call is made at all (decision 6). P5's evidence.
        compaction_full: status.full ?? null,
        compaction_passes: status.calls ?? null,
        compaction_written: status.written ?? null,
        compaction_promoted: status.promoted ?? null,
        compaction_duplicates: status.duplicates ?? null,
        compaction_dropped_fields: status.refused ?? null,
        compaction_failed: status.failures ?? null,
        compaction_last_reason: status.lastReason ?? null,
        compaction_ms: status.ms ?? null,
        compaction_last_ms: status.lastMs ?? null,
        compaction_tokens_in: status.tokensIn ?? null,
        compaction_tokens_out: status.tokensOut ?? null,
    };
}

/**
 * The index queue as the prompt went out (docs/decisions.md D-0075). Counts are running
 * totals for the chat and every one of them is of the *applied* change: records actually
 * written, slots the parser dropped, and numbers the model never answered. Never a
 * record's text.
 */
function indexFields(status) {
    if (!status) return { index_reported: false };

    return {
        index_reported: true,
        // ready, not-writing, no-profile, group-chat, no-chat or profile-missing.
        index_gate: status.gate ?? null,
        index_in_flight: status.inFlight != null,
        // Summaries with no record: the tier's lag, and 0 once a chat is caught up.
        index_waiting: status.waiting ?? null,
        index_pending_from: status.pending?.from ?? null,
        index_pending_to: status.pending?.to ?? null,
        index_pending_summaries: status.pending?.summaries ?? null,
        index_given_up: status.givenUp ?? null,
        index_batches: status.calls ?? null,
        index_records: status.records ?? null,
        index_dropped_slots: status.dropped ?? null,
        index_unanswered: status.missed ?? null,
        index_failed: status.failures ?? null,
        index_last_reason: status.lastReason ?? null,
        index_ms: status.ms ?? null,
        index_last_ms: status.lastMs ?? null,
        index_tokens_in: status.tokensIn ?? null,
        index_tokens_out: status.tokensOut ?? null,
    };
}

/**
 * The world state: what this prompt carried, then the queue as the prompt went out
 * (docs/how-it-works.md, "Keeping the world state"). Sizes, depths and kinds of change, never the state's text.
 * The queue's counts are running totals, as the summary ones are.
 */
function stateFields(placement, status) {
    return {
        state_reported: Boolean(placement),
        state_injected: placement?.injected ?? false,
        // injected, off, wtracker-loaded, none-yet, empty or behind-step.
        state_reason: placement?.reason ?? null,
        state_tracker: placement?.tracker ?? null,
        // 1 in normal play; more means the queue is behind.
        state_depth: placement?.injected ? placement.depth : null,
        state_chars: placement?.chars ?? null,
        state_tokens: placement?.tokens ?? null,
        // The injected text differs from last turn's, so the break should land in it.
        state_changed: placement?.changed ?? null,
        state_change_kinds: placement?.changeKinds ?? [],
        state_gate: status?.gate ?? null,
        state_in_flight: status ? status.inFlight != null : null,
        state_pending: status?.pending ?? null,
        state_given_up: status?.givenUp ?? null,
        state_calls: status?.calls ?? null,
        state_written: status?.written ?? null,
        state_failures: status?.failures ?? null,
        state_last_reason: status?.lastReason ?? null,
        state_dropped_fields: status?.dropped ?? null,
        state_ms: status?.ms ?? null,
        state_last_ms: status?.lastMs ?? null,
        state_tokens_in: status?.tokensIn ?? null,
        state_tokens_out: status?.tokensOut ?? null,
    };
}

/** UTF-8 safe: btoa alone throws on anything outside Latin-1. */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
