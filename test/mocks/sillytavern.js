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

/**
 * The positions ST asks `getExtensionPrompt` for when it builds a prompt:
 * BEFORE_PROMPT and IN_PROMPT around the story string (public/script.js:4700-4701),
 * IN_CHAT per depth (:5647, and public/scripts/openai.js:856). NONE is never asked for.
 */
export const COLLECTED_POSITIONS = [
    extension_prompt_types.BEFORE_PROMPT,
    extension_prompt_types.IN_PROMPT,
    extension_prompt_types.IN_CHAT,
];

/**
 * Keys ST would place on its own — getExtensionPrompt's filter,
 * `x.position == position && x.value` (public/script.js:3312), over every
 * position it collects. Anything else reaches the prompt only through a macro.
 */
export function collectedKeys(extensionPrompts) {
    return Object.keys(extensionPrompts ?? {})
        .filter((key) => {
            const prompt = extensionPrompts[key];
            return prompt.value && COLLECTED_POSITIONS.some((position) => prompt.position == position);
        });
}

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

/**
 * The generate interceptor's `chat` (public/script.js:4496-4527): hidden and system
 * messages filtered out, the last popped on a swipe, each entry a fresh object that
 * shares `extra` with the live message. Regex scripts and attachments are not
 * modelled, so `mes` comes through unchanged.
 */
export function makeCoreChat(chat, { type = 'normal' } = {}) {
    const core = chat.filter((message) => !message.is_system);
    if (type === 'swipe') core.pop();
    return core.map((message, index) => ({ ...message, index }));
}

/**
 * A new swipe on a reply. The current swipe is saved first, `extra` cloned into its
 * `swipe_info` (public/script.js:10340 → :6932-6939). The new reply then replaces
 * `mes` and keeps the same `extra` object (:6671-6684).
 */
export function newSwipe(message, mes) {
    saveSwipe(message);
    message.swipes.push(mes);
    message.swipe_id = message.swipes.length - 1;
    message.mes = mes;
    saveSwipe(message);
}

/**
 * Swiping to an existing swipe: the current one is saved (:10340), then `mes` and a
 * clone of that swipe's saved `extra` replace the message's own (:7012-7015).
 */
export function swipeTo(message, swipeId) {
    saveSwipe(message);
    message.swipe_id = swipeId;
    message.mes = message.swipes[swipeId];
    message.extra = structuredClone(message.swipe_info[swipeId]?.extra) ?? {};
}

function saveSwipe(message) {
    message.swipe_info ??= [];
    message.swipes[message.swipe_id] = message.mes;
    message.swipe_info[message.swipe_id] = { send_date: message.send_date, extra: structuredClone(message.extra) };
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
export function createContext({
    chat = makeChat(),
    chatMetadata = {},
    profiles = [],
    selectedProfile = null,
    requestService = null,
    extensions = [],
} = {}) {
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
            WORLDINFO_UPDATED: 'worldinfo_updated',
            MESSAGE_RECEIVED: 'message_received',
            CHAT_CHANGED: 'chat_id_changed',
        },

        /** public/scripts/extensions.js:141 */
        extensionSettings: {
            disabledExtensions: [],
            /** public/scripts/extensions/connection-manager/index.js:28-29 */
            connectionManager: { profiles, selectedProfile },
        },

        /**
         * public/scripts/extensions.js:524, exposed at public/scripts/st-context.js:300.
         * `extensions` holds internal names, `third-party/<folder>` for a user install
         * (src/endpoints/extensions.js:518); the prefix may be left off, as ST allows.
         */
        getExtensionManifest(name) {
            const found = extensions.find((id) => id === name || id === `third-party/${name}`);
            return found ? { display_name: found } : null;
        },

        /** public/scripts/st-context.js:294 — a class with a static `sendRequest`. */
        ConnectionManagerRequestService: requestService,

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

        /**
         * public/script.js:2815. Only the two macros anything here uses:
         * `environment.user` is name1 and `environment.char` is name2
         * (public/script.js:2949-2950). Enough to prove we resolve a template
         * before comparing it; not a macro engine.
         */
        substituteParamsExtended(content, additionalMacro = {}) {
            let text = String(content)
                .replace(/\{\{user\}\}/gi, context.name1)
                .replace(/\{\{char\}\}/gi, context.name2);
            for (const [name, value] of Object.entries(additionalMacro)) {
                text = text.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'gi'), String(value));
            }
            return text;
        },

        /**
         * public/script.js:2981, exposed at public/scripts/st-context.js:163. The
         * same two macros as above. An unknown `{{macro}}` is left as it is: the
         * legacy engine (the default, public/script.js:2997) replaces a fixed list
         * of named patterns (public/scripts/macros.js:610).
         */
        substituteParams(content) {
            return context.substituteParamsExtended(content);
        },

        /** public/scripts/st-context.js:302 — the ignore flag's home. */
        symbols: { ignore: Symbol.for('ignore') },

        saveSettingsDebounced: () => { context.saved.settings++; },
        saveMetadataDebounced: () => { context.saved.metadata++; },
        /** public/scripts/st-context.js:155 — saveChatConditional, which saves the *current* chat. */
        saveChat: async () => { context.saved.chat++; },

        /** Rough but monotonic — enough for budget arithmetic in tests. */
        getTokenCountAsync: async (text) => Math.ceil(String(text).length / 4),

        renderExtensionTemplateAsync: async () => '<div class="cairn-settings"></div>',

        /** Test-only bookkeeping, not part of ST's surface. */
        saved: { settings: 0, metadata: 0, chat: 0 },
    };
    return context;
}

/**
 * A reply arriving: ST puts it in `chat`, then emits the message's index and the
 * generation type, and awaits every listener before it renders the message
 * (public/script.js:6780-6782, public/lib/eventemitter.js:146).
 */
export async function receiveMessage(context, message, type = 'normal') {
    context.chat.push(message);
    await context.eventSource.emit(context.eventTypes.MESSAGE_RECEIVED, context.chat.length - 1, type);
}

/**
 * Opening a chat: ST refills the *same* array with new message objects
 * (public/script.js:7658), then emits the new chat id (:7700). Reloading the
 * current chat takes the same path with the same id (:1710-1717).
 */
export async function openChat(context, { chatId, messages }) {
    context.chatId = chatId;
    context.chat.splice(0, context.chat.length, ...messages);
    await context.eventSource.emit(context.eventTypes.CHAT_CHANGED, chatId);
}
