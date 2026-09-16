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
    WRITING: 'writing',
});

/**
 * @param {{own?: boolean, injecting?: string[], excluding?: boolean}} input
 *        `own` is the setting. `injecting` lists qvink injection keys ST would
 *        still place. `excluding` is whether a running qvink still has
 *        `exclude_messages_after_threshold` on.
 * @returns {{writing: boolean, reason: string, detail: string}}
 */
export function assessHandover({ own = false, injecting = [], excluding = false } = {}) {
    if (!own) {
        return verdict(false, HANDOVER.OFF, 'Cairn is planning the memory block but not writing it.');
    }

    // The order the user flips the switches in (D-0020): the injection first.
    if (injecting.length) {
        return verdict(false, HANDOVER.QVINK_INJECTING,
            `qvink is still injecting (${injecting.join(', ')}). Set its memory position to "Macro Only" to hand over.`);
    }

    if (excluding) {
        return verdict(false, HANDOVER.QVINK_EXCLUDING,
            'qvink is still removing summarised messages. Turn off "Exclude messages after threshold" to hand over.');
    }

    return verdict(true, HANDOVER.WRITING, 'Cairn writes the memory block and holds back the messages it covers.');
}

function verdict(writing, reason, detail) {
    return { writing, reason, detail };
}
