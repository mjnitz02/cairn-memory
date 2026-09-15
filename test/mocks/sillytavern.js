/**
 * SillyTavern mock.
 *
 * Mirrors the real shapes rather than inventing convenient ones (CLAUDE.md §3.11).
 * Every field below is cited against the pinned checkout — ST 1.19.0 (06bde939f).
 * When ST moves, `make verify-st` tells us, and this file is updated with it.
 */

/** public/script.js:484 */
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

/** public/scripts/world-info.js:863 */
export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

/**
 * One chat message. ST builds these all over public/script.js (e.g. :4821);
 * `extra` is the per-message bag extensions own, and it branches and swipes
 * with the message for free (DESIGN.md §9).
 */
export function makeMessage({ name = 'Aster', isUser = false, mes = '', extra = {} } = {}) {
    return {
        name,
        is_user: isUser,
        is_system: false,
        send_date: '2026-01-01T00:00:00.000Z',
        mes,
        extra: { ...extra },
        swipe_id: 0,
        swipes: [mes],
    };
}

/**
 * A synthetic chat. Names and content are invented — no real logs, ever
 * (CLAUDE.md §3.13).
 */
export function makeChat(turns = 6) {
    const chat = [];
    for (let i = 0; i < turns; i++) {
        const isUser = i % 2 === 0;
        chat.push(makeMessage({
            name: isUser ? 'Wren' : 'Aster',
            isUser,
            mes: isUser
                ? `Wren says something at turn ${i}.`
                : `Aster answers at turn ${i}.`,
        }));
    }
    return chat;
}

/** Minimal eventSource: registration plus await-all emit, as ST's does. */
function makeEventSource() {
    const handlers = new Map();
    return {
        on(type, fn) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(fn);
        },
        removeListener(type, fn) {
            const list = handlers.get(type) ?? [];
            const at = list.indexOf(fn);
            if (at >= 0) list.splice(at, 1);
        },
        async emit(type, ...args) {
            for (const fn of handlers.get(type) ?? []) {
                await fn(...args);
            }
        },
        /** Test helper, not part of ST's surface. */
        listenerCount(type) {
            return (handlers.get(type) ?? []).length;
        },
    };
}

/**
 * The subset of `SillyTavern.getContext()` (public/scripts/st-context.js:115)
 * we actually depend on. Deliberately a subset: an unlisted field means we have
 * not declared that dependency in docs/st-api-surface.md yet.
 */
export function createContext({ chat = makeChat(), chatMetadata = {}, profiles = [] } = {}) {
    const extensionPrompts = {};
    const context = {
        chat,
        chatMetadata,
        name1: 'Wren',
        name2: 'Aster',
        characterId: 0,
        groupId: null,
        chatId: 'synthetic-chat',
        maxContext: 8192,
        mainApi: 'textgenerationwebui',

        eventSource: makeEventSource(),
        /** public/scripts/st-context.js:139 — context exposes event_types as eventTypes. */
        eventTypes: {
            CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
            GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
            WORLD_INFO_ACTIVATED: 'world_info_activated',
            WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
            MESSAGE_RECEIVED: 'message_received',
            CHAT_CHANGED: 'chat_id_changed',
        },

        /** public/scripts/extensions.js:141 */
        extensionSettings: {
            disabledExtensions: [],
            connectionManager: { profiles },
        },

        extensionPrompts,
        /** public/script.js — setExtensionPrompt(key, value, position, depth, scan, role, filter) */
        setExtensionPrompt(key, value, position, depth, scan = false, role = 0, filter = null) {
            extensionPrompts[key] = {
                value: String(value),
                position: Number(position),
                depth: Number(depth),
                scan: Boolean(scan),
                role: Number(role),
                filter,
            };
        },

        saveSettingsDebounced: () => { context.saved.settings++; },
        saveMetadataDebounced: () => { context.saved.metadata++; },
        saveChat: async () => { context.saved.chat++; },

        /** Rough but monotonic — enough for budget arithmetic in tests. */
        getTokenCountAsync: async (text) => Math.ceil(String(text).length / 4),

        renderExtensionTemplateAsync: async () => '<div class="cairn-settings"></div>',

        /** Test-only bookkeeping, not part of ST's surface. */
        saved: { settings: 0, metadata: 0, chat: 0 },
    };
    return context;
}
