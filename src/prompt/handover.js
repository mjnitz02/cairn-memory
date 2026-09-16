/**
 * The handover gate — when Cairn is allowed to become the prompt's only writer
 * (DESIGN.md §6, docs/decisions.md D-0020).
 *
 * P1 step 3 is a swap, not an addition: Cairn writes the memory block and blanks
 * the summarised messages, and qvink does neither. Both halves have to move
 * together. If Cairn injects while qvink still injects, the block is in the
 * prompt twice; if Cairn blanks while qvink blanks, two extensions are writing
 * the same `Symbol.for('ignore')` flag from different rules and the raw window
 * is whatever the later interceptor decided.
 *
 * So the gate is a precondition check, run every turn, and every closed state
 * names the switch that would open it. Nothing here writes to qvink's settings:
 * silencing it is the user's deliberate act, and an extension that reaches into
 * another extension's configuration is exactly the "two systems, one prompt"
 * failure this phase exists to end.
 *
 * Pure: state in, verdict out. No ST, no DOM, no network.
 */

/** Why Cairn is or is not writing. Stable strings — the disk log records them. */
export const HANDOVER = Object.freeze({
    OFF: 'off',
    QVINK_INJECTING: 'qvink-injecting',
    QVINK_EXCLUDING: 'qvink-excluding',
    UNPROVEN: 'unproven',
    UNPLACED: 'unplaced',
    WRITING: 'writing',
});

/**
 * @param {{own?: boolean, injecting?: string[], excluding?: boolean,
 *           proven?: boolean, placed?: boolean}} input
 *        `own` is the setting. `injecting` lists qvink injection keys ST would
 *        still place. `excluding` is its `exclude_messages_after_threshold`.
 *        `proven` is whether our renderer has matched qvink's live block byte for
 *        byte in this chat — the D-0026 check, which only means anything while
 *        qvink is still the writer, so it is remembered rather than re-earned.
 *        `placed` is whether the block we are about to park will actually be
 *        collected into the prompt.
 * @returns {{writing: boolean, reason: string, detail: string}}
 */
export function assessHandover({ own = false, injecting = [], excluding = false, proven = false, placed = true } = {}) {
    if (!own) {
        return verdict(false, HANDOVER.OFF, 'Cairn is planning the memory block but not writing it.');
    }

    // Order is the handover's own sequence (D-0020): qvink goes quiet first, and
    // the proof has to be in hand by then — it can only be earned while qvink is
    // still injecting something to compare against.
    if (injecting.length) {
        return verdict(false, HANDOVER.QVINK_INJECTING,
            `qvink is still injecting (${injecting.join(', ')}). Set its memory position to "Macro Only" to hand over.`);
    }

    if (excluding) {
        return verdict(false, HANDOVER.QVINK_EXCLUDING,
            'qvink is still removing summarised messages. Turn off "Exclude messages after threshold" to hand over.');
    }

    if (!proven) {
        return verdict(false, HANDOVER.UNPROVEN,
            'Cairn has not yet rendered qvink\'s own block byte for byte in this chat, so it will not take over the injection.');
    }

    // Last, and it is an invariant rather than a step the user takes: writing is
    // also *blanking*, so a block ST will not collect means a prompt missing both
    // the summaries and the messages they stand for (docs/decisions.md D-0029).
    if (!placed) {
        return verdict(false, HANDOVER.UNPLACED,
            'Cairn will not hold messages back while its block has nowhere in the prompt to go.');
    }

    return verdict(true, HANDOVER.WRITING, 'Cairn writes the memory block and holds back the messages it covers.');
}

function verdict(writing, reason, detail) {
    return { writing, reason, detail };
}
