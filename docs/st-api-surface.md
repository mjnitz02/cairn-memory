# SillyTavern API surface

Every ST API Cairn depends on, and the `file:line` it was verified against
(CLAUDE.md §2.6–2.7). `make verify-st` re-checks this file against a local
checkout and reports anything that moved.

**Pinned: ST 1.19.0 (`06bde939f`)**

The tables are machine-read. Keep the column order; the symbol column is matched
literally against the cited line.

## In use

| Symbol | Used for | ST file | Line |
|---|---|---|---|
| `getContext` | The entry point for everything below | `public/scripts/st-context.js` | 115 |
| `chat` | The live message array; per-message memory lives in `extra` | `public/scripts/st-context.js` | 118 |
| `saveSettingsDebounced` | Persist settings after a panel edit | `public/scripts/st-context.js` | 132 |
| `maxContext` | Prompt size as a share of the window | `public/scripts/st-context.js` | 134 |
| `eventSource` | Hook registration | `public/scripts/st-context.js` | 138 |
| `eventTypes` | Event name enum | `public/scripts/st-context.js` | 139 |
| `getTokenCountAsync` | Prompt token totals, and the estimated size of each summary request and reply | `public/scripts/st-context.js` | 151 |
| `extensionPrompts` | Read every injection and who parked it | `public/scripts/st-context.js` | 152 |
| `renderExtensionTemplateAsync` | Load `settings.html` from our third-party folder | `public/scripts/st-context.js` | 191 |
| `extensionSettings` | Our settings bag, and Connection Manager's profile list | `public/scripts/st-context.js` | 201 |
| `renderExtensionTemplateAsync` | Template loader definition | `public/scripts/extensions.js` | 137 |
| `extension_settings` | Settings bag definition | `public/scripts/extensions.js` | 141 |
| `getExtensionManifest,` | Whether Qvink Memory is installed | `public/scripts/st-context.js` | 300 |
| `export function getExtensionManifest` | Matches the internal name, with or without `third-party/`; null when not installed | `public/scripts/extensions.js` | 524 |
| `const isDisabled = extension_settings.disabledExtensions.includes(name);` | A disabled extension is never loaded, so its leftover settings are ignored | `public/scripts/extensions.js` | 626 |
| `export async function disableExtension` | Disabling reloads the page, so "disabled" and "not running" agree | `public/scripts/extensions.js` | 490 |
| `type: 'local', name:` | A user extension's internal name is `third-party/<folder>` | `src/endpoints/extensions.js` | 518 |
| `getProfile` | Shape of a connection profile (`id`, `name`) | `public/scripts/extensions/shared.js` | 546 |
| `getRequestHeaders` | Auth headers for the file-upload call | `public/scripts/st-context.js` | 129 |
| `/upload` | Data Bank write endpoint, for the inspector log | `src/endpoints/files.js` | 28 |
| `validateAssetFileName` | What filenames the endpoint accepts | `src/endpoints/assets.js` | 21 |
| `extension_prompt_types` | `NONE` / `IN_PROMPT` / `IN_CHAT` placement enum | `public/script.js` | 484 |
| `GENERATE_AFTER_COMBINE_PROMPTS` | Text-completion prompt, read-only in P0 | `public/script.js` | 5243 |
| `CHAT_COMPLETION_PROMPT_READY` | Chat-completion prompt, read-only in P0 | `public/scripts/openai.js` | 1619 |
| `WORLD_INFO_ACTIVATED` | Observe which WI entries fired | `public/scripts/world-info.js` | 902 |
| `CHAT_CHANGED` | Drop the stability baseline on a new chat; abandon a memory request for the chat being left | `public/scripts/events.js` | 19 |
| `GENERATE_AFTER_COMBINE_PROMPTS` | Event name | `public/scripts/events.js` | 57 |
| `WORLD_INFO_ACTIVATED` | Event name | `public/scripts/events.js` | 62 |
| `CHAT_COMPLETION_PROMPT_READY` | Event name | `public/scripts/events.js` | 65 |
| `inject_ids` | Injection key patterns, for attributing a prompt to its writer | `public/scripts/constants.js` | 48 |
| `2_floating_prompt` | Author's Note injection key | `public/scripts/authors-note.js` | 26 |
| `1_memory` | ST Summarize injection key | `public/scripts/extensions/memory/index.js` | 36 |
| `extension_prompts` | **Reassigned** in clearChat — a held reference goes stale | `public/script.js` | 1590 |
| `updateChatMetadata` | **Reassigns** `chat_metadata` on every update | `public/script.js` | 8978 |
| `getExtensionPrompt` | Collects a position; **sorts keys**, so key names decide order | `public/script.js` | 3301 |
| `value.trim()` | Each injection is trimmed before joining — what locate.js matches on | `public/script.js` | 3318 |
| `substituteParams(values)` | Macros resolve *after* parking, so `{{outlet::x}}` works inside our block | `public/script.js` | 3326 |
| `sortFn` | WI insertion sort: **one key, no tiebreak** — `b.order - a.order` | `public/scripts/world-info.js` | 88 |
| `allActivatedEntries` | A **Map**, so `.values()` is activation order — the de facto tiebreak | `public/scripts/world-info.js` | 4732 |
| `sortFn` | Applied to scan order | `public/scripts/world-info.js` | 4610 |
| `allActivatedEntries` | Applied to prompt order; ties keep activation order | `public/scripts/world-info.js` | 5203 |
| `order` | The sort key itself; plain number, default 100, unbounded | `public/scripts/world-info.js` | 4092 |
| `world_info_recursive` | Activated content re-enters the scan buffer, so sets cascade to a closure | `public/scripts/world-info.js` | 75 |
| `matchKeys` | Key matching; whole-word vs substring per entry, then global | `public/scripts/world-info.js` | 337 |
| `sticky` | Native "stay active for N messages" — but `0` on every entry in practice | `public/scripts/world-info.js` | 4118 |
| `WORLDINFO_FORCE_ACTIVATE` | Push the held set back in before the scan | `public/scripts/world-info.js` | 1020 |
| `WORLDINFO_FORCE_ACTIVATE` | Event name | `public/scripts/events.js` | 77 |
| `externalActivations` | Where a forced entry is parked, keyed `${world}.${uid}` | `public/scripts/world-info.js` | 1025 |
| `getExternallyActivated` | Consulted **before** the keyword match, so a forced entry needs no key | `public/scripts/world-info.js` | 4886 |
| `activatedNow.add(buffer.getExternallyActivated(entry))` | A forced entry joins the ordinary candidate set... | `public/scripts/world-info.js` | 4888 |
| `newEntries = [...activatedNow]` | ...which is the list the probability and budget checks walk... | `public/scripts/world-info.js` | 4997 |
| `entry.probability === 100` | ...so a held entry below 100% is re-rolled every turn (D-0035) | `public/scripts/world-info.js` | 5030 |
| `const isSticky = timedEffects.isEffectActive('sticky', entry);` | Sticky entries skip the re-roll | `public/scripts/world-info.js` | 5035 |
| `resetExternalEffects` | Clears the forced set after **every** scan — we re-push each turn | `public/scripts/world-info.js` | 5275 |
| `sortedEntriesIndex.get(a) ?? -1` | A forced entry is not in `sortedEntries`, so it sorts at -1 | `public/scripts/world-info.js` | 5002 |
| `structuredClone(entries)` | The scan works on a copy, so a held entry cannot track a book edit | `public/scripts/world-info.js` | 4639 |
| `allActivatedEntries` | WORLD_INFO_ACTIVATED carries full entries, and skips dry runs | `public/scripts/world-info.js` | 900 |
| `WORLDINFO_UPDATED` | A saved book releases our snapshot of it | `public/scripts/world-info.js` | 4160 |
| `WORLDINFO_UPDATED` | Event name | `public/scripts/events.js` | 42 |
| `generate_interceptor` | Manifest key naming our interceptor; run in `loading_order` | `public/scripts/extensions.js` | 2033 |
| `globalThis[interceptorKey]` | How ST resolves it — `(chat, contextSize, abort, type)` | `public/scripts/extensions.js` | 2037 |
| `runGenerationInterceptors` | Our push runs here... | `public/script.js` | 4564 |
| `getWorldInfoPrompt` | ...which is before the scan reads it | `public/script.js` | 4635 |
| `if (!dryRun) {` | Dry runs skip interceptors, so they cannot pollute the held set | `public/script.js` | 4562 |
| `getMaxPromptTokens` | What the memory cap is 35% of — context window minus the reserved response | `public/script.js` | 5981 |
| `if (tokenCount < this_max_context) {` | Text completion stops adding history at the limit, so a prompt that dropped messages ends just under it — the near-limit flag | `public/script.js` | 4920 |
| `src="script.js"` | The URL ST loads it under, so `/script.js` is the same module however deeply we are installed | `public/index.html` | 8218 |
| `setExtensionPrompt` | Park the memory block | `public/scripts/st-context.js` | 153 |
| `setExtensionPrompt` | Signature: `(key, value, position, depth, scan, role, filter)` | `public/script.js` | 8926 |
| `.sort()` | `getExtensionPrompt` sorts the keys, so our key name decides order within a position | `public/script.js` | 3310 |
| `.filter(x => x.position == position && x.value)` | An injection is placed only with a matching position and a non-empty value — how "Macro Only" silences one | `public/script.js` | 3312 |
| `symbols: {` | Where `getContext()` exposes the ignore flag | `public/scripts/st-context.js` | 302 |
| `IGNORE_SYMBOL` | The flag that drops a message from the sent history | `public/scripts/constants.js` | 25 |
| `if (chatItem.extra?.[IGNORE_SYMBOL]) {` | Honoured on the text-completion path | `public/script.js` | 5841 |
| `if (chat[j].extra?.[IGNORE_SYMBOL]) {` | ...and on the chat-completion path | `public/scripts/openai.js` | 584 |
| `let coreChat = chat.filter` | The interceptor's array is **filtered**, so its indexes are not the chat's | `public/script.js` | 4496 |
| `...chatItem,` | Its entries are fresh objects that **share `extra` by reference** with the real chat | `public/script.js` | 4525 |
| `index,` | The index they carry counts the *filtered* array — never use it as a chat index | `public/script.js` | 4527 |
| `coreChat.pop();` | A swipe drops the reply being replaced, so the state used is the one before it | `public/script.js` | 4498 |
| `doChatInject` | Places the world state: an `IN_CHAT` prompt goes in `depth` entries from the end of `coreChat` | `public/script.js` | 5628 |
| `const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);` | Depth counts prompt entries, so the state's depth is the number of entries after its message | `public/script.js` | 5666 |
| `const depth = isContinue && i === 0 ? 1 : i;` | On a continue, a depth-0 state moves above the message being continued | `public/script.js` | 5665 |
| `const roles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];` | At the same depth, a system prompt lands below a user or assistant one | `public/script.js` | 5636 |
| `export const extension_prompt_roles = {` | The state is parked with the system role (`SYSTEM: 0`) | `public/script.js` | 494 |
| `injectedIndices = await doChatInject(coreChat, isContinue);` | Text completion injects while blanked messages are still in `coreChat`; they are all older than a placed state | `public/script.js` | 4745 |
| `oaiMessages = setOpenAIMessages(coreChat);` | Chat completion builds from the same `coreChat`, dropping blanked messages (`openai.js:584`)... | `public/script.js` | 4834 |
| `? await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, roleTypes[role], wrap)` | ...before placing by depth, which still matches because no state behind the step is placed | `public/scripts/openai.js` | 856 |
| `lastMessage.mes = getMessage;` | A new swipe replaces `mes` and keeps `extra`, so the state on it goes stale by its hash | `public/script.js` | 6676 |
| `targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {};` | Swiping back restores that swipe's `extra`, state included, as a new object | `public/script.js` | 7015 |
| `syncMesToSwipe(mesId);` | Swiping away saves the current `extra` into that swipe first, so a new swipe's copy made before its state was written is overwritten (`targetSwipeInfo.extra`, :6939) | `public/script.js` | 10340 |
| `if (typeof globalThis[interceptorKey] === 'function') {` | An extension's interceptor is called by its manifest name, so a defined one means WTracker or WTrackerLite is running | `public/scripts/extensions.js` | 2035 |
| `message.is_system = hide;` | Hiding a message sets `is_system`, so `summarisable()` skips hidden messages | `public/scripts/chats.js` | 157 |
| `structuredClone(chat.slice(0, Number(mesId) + 1))` | A branch copies the messages it keeps, `extra` and all, so their scenes go with them | `public/scripts/bookmarks.js` | 173 |
| `ConnectionManagerRequestService` | Profile-routed summary calls | `public/scripts/st-context.js` | 294 |
| `ConnectionManagerRequestService` | Class definition and `sendRequest` contract | `public/scripts/extensions/shared.js` | 392 |
| `static async sendRequest` | Summary calls; takes `ChatCompletionMessage[]`, which is what `perMessage.build` returns | `public/scripts/extensions/shared.js` | 423 |
| `disabledExtensions.includes('connection-manager')` | `sendRequest` refuses outright without Connection Manager, so the summarizer checks first | `public/scripts/extensions/shared.js` | 427 |
| `throw new Error('API request failed', { cause: error });` | Every transport error, an abort included, arrives wrapped | `public/scripts/extensions/shared.js` | 490 |
| `ExtractedData` | `{ content, reasoning }`, the non-streaming return shape | `public/scripts/custom-request.js` | 60 |
| `selectedProfile: null` | The chat's own profile, so a memory profile that matches it gets a warning | `public/scripts/extensions/connection-manager/index.js` | 29 |
| `substituteParams,` | Expands ST macros on the summary template before chat text goes in | `public/scripts/st-context.js` | 163 |
| `chatId: selected_group` | Keys a message's failure count to its chat | `public/scripts/st-context.js` | 125 |
| `saveChat: saveChatConditional` | Persist a written scene; saves the *current* chat | `public/scripts/st-context.js` | 155 |
| `MESSAGE_RECEIVED` | Event name; the summarizer's trigger | `public/scripts/events.js` | 9 |
| `event_types.MESSAGE_RECEIVED, chat_id, type` | Emitted for a new reply with its chat index, **before** the reply is rendered | `public/script.js` | 6781 |
| `event_types.MESSAGE_RECEIVED, this.messageId, this.type` | ...and for a streamed one | `public/script.js` | 3799 |
| `!fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);` | ...and for a generated swipe, so the state that read the replaced reply is redone | `public/script.js` | 6691 |
| `!fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);` | ...and for a continue, whose text is appended to the reply first (:6701) | `public/script.js` | 6716 |
| `MESSAGE_EDITED` | Event name; a trigger, so an edited message's summary and state are redone without waiting for a reply | `public/scripts/events.js` | 10 |
| `mes.mes = text;` | `updateMessage` writes the edit to the message... | `public/script.js` | 8178 |
| `await eventSource.emit(event_types.MESSAGE_EDITED, this_edit_mes_id);` | ...before the event, which is awaited before the message is re-rendered | `public/script.js` | 8405 |
| `await listeners[i].apply(this, args);` | ST awaits every listener in turn, so the summarizer starts its work and returns | `public/lib/eventemitter.js` | 146 |
| `chat.splice(0, chat.length, ...data);` | Opening or reloading a chat refills the same array with **new** message objects, so a late reply's message is no longer in it | `public/script.js` | 7658 |
| `await reloadCurrentChat();` | A rename reloads the chat too | `public/script.js` | 10713 |
| `export const chatElement = $('#chat');` | The chat container the summary marks are drawn into | `public/script.js` | 449 |
| `.mes[mesid=` | One element per message, addressed by its chat index | `public/script.js` | 1654 |
| `class="mes_text"` | The message body; a summary mark goes directly after it, as qvink's does | `public/index.html` | 7461 |
| `messageElement.find('.mes_text').html(messageHTML);` | A re-render replaces only the body, so a mark beside it survives | `public/script.js` | 2696 |
| `await printMessages();` | Messages are in the page before `CHAT_CHANGED`, so the marks can be drawn on it | `public/script.js` | 7697 |
| `MORE_MESSAGES_LOADED` | Event name; older messages scrolled into the page need their marks | `public/scripts/events.js` | 17 |
| `event_types.MORE_MESSAGES_LOADED` | Emitted once those messages are in the page | `public/script.js` | 1474 |
| `CHARACTER_MESSAGE_RENDERED` | Event name; a reply's element exists, so its neighbours' marks are redrawn | `public/scripts/events.js` | 49 |
| `USER_MESSAGE_RENDERED` | Event name; the same for a sent message | `public/scripts/events.js` | 48 |
| `MESSAGE_UPDATED` | Event name; an edit can invalidate a summary, so its mark is redrawn | `public/scripts/events.js` | 12 |
| `MESSAGE_DELETED` | Event name; a deletion renumbers the messages after it | `public/scripts/events.js` | 11 |
| `MESSAGE_SWIPED` | Event name; a swipe changes the last message | `public/scripts/events.js` | 7 |
| `const messageTemplate = $('#message_template .mes');` | Every message is cloned from the template, so the summarise button added to it once is on every message drawn after | `public/script.js` | 448 |
| `<div class="extraMesButtons">` | The message's actions menu, where the summarise button goes | `public/index.html` | 7414 |
| `'.mes_buttons .mes_button',` | A `mes_button` in that menu answers Enter like a click | `public/scripts/keyboard.js` | 17 |

## Verified, not yet called

Cited by `DESIGN.md` and mirrored in `test/mocks/`. Verified now so the design
does not rest on an unchecked claim; each moves up as its phase lands.

| Symbol | Used for | ST file | Line |
|---|---|---|---|
| `chatMetadata` | Chat-global stores: canon, episodes, entity index | `public/scripts/st-context.js` | 135 |
| `saveMetadataDebounced` | Persist those stores | `public/scripts/st-context.js` | 136 |
| `CUSTOM_WI_OUTLET` | Where ST parks outlet content, unplaced | `public/script.js` | 4676 |
| `outlet` | `world_info_position.outlet === 7` | `public/scripts/world-info.js` | 863 |
| `outletName` | Declared WI entry field, editable in the WI UI | `public/scripts/world-info.js` | 4108 |
| `outlet::` | The `{{outlet::key}}` macro that places parked content | `public/scripts/macros.js` | 668 |
| `flushWIInjections` | ST clears depth and outlet injections every generation | `public/script.js` | 5678 |
| `getOutletPrompt` | Resolves `{{outlet::key}}` from the parked injection | `public/scripts/macros.js` | 597 |
| `export function substituteParams(` | Signature; the legacy engine is the default | `public/script.js` | 2981 |
| `experimental_macro_engine` | ST's own `{{if}}` exists only behind this switch, so Cairn renders `{{#if}}` itself | `public/script.js` | 2997 |
| `registerMacro('if'` | ...and its syntax is not qvink's `{{#if}}` | `public/scripts/macros/definitions/core-macros.js` | 134 |
| `Handlebars for extensions are no longer supported` | Handlebars, qvink's route, is deprecated for extensions | `public/scripts/st-context.js` | 177 |
| `export function evaluateMacros` | The legacy engine replaces a fixed list of named macros, so an unknown `{{x}}` survives | `public/scripts/macros.js` | 610 |
| `export function getStringHash` | Not on `getContext()`; `util/hash.js` reproduces it | `public/scripts/utils.js` | 522 |
| `world_info_position.outlet` | The outlet branch of the placement switch | `public/scripts/world-info.js` | 5248 |
| `WIOutletEntries` | Entries sharing an `outletName` group into one block | `public/scripts/world-info.js` | 5253 |

## Hazards

**The generate interceptor's `chat` is not `context.chat`.** It is `coreChat`:
system messages filtered out (`public/script.js:4496`), the last message popped
on a swipe (`:4498`), and every entry rebuilt as `{...chatItem, index}` (`:4525`)
— a fresh object whose `index` counts the *filtered* array. The objects share
`extra` by reference, so a flag written through the live chat reaches them.
Address messages by the live chat's index and write through the live chat;
`coreChat`'s own index is a different number that usually agrees.

**`SillyTavern.getContext()` is a snapshot, not a handle.** It copies primitives
(`maxContext`) and captures object references (`extensionPrompts`,
`chatMetadata`) as they are at call time. ST reassigns `extension_prompts` in
`clearChat` (`public/script.js:1590`) and `chat_metadata` in ten places including
`updateChatMetadata` (`:8978`), so a context captured at extension load is
orphaned the moment a chat opens. **Call `getContext()` fresh at the point of
use.** `chat` is the exception — ST mutates that array in place.

## Not from SillyTavern

`qvink_memory_long` / `qvink_memory_short` are Qvink Memory's injection keys
(`SillyTavern-MessageSummarize/index.js:4022`). Cairn reads them for attribution
in the inspector, to see whether Qvink still places a block, and as a sign that
Qvink is loaded: it parks both on every chat refresh, empty or not (`:4004-4005`).
Nothing depends on that extension being installed.

Cairn looks for Qvink under `third-party/SillyTavern-MessageSummarize`, the folder
its repository clones into. Its `auto_summarize` (default on, `index.js:116`, read
through `?? default_settings[key]` at `:655`) and `exclude_messages_after_threshold`
(default on, `:136`) are read only while it is loaded. A disabled or uninstalled
Qvink leaves both in the settings, and Cairn ignores them.

WTrackerLite and upstream WTracker are looked for under `third-party/SillyTavern-WTrackerLite`
and `third-party/SillyTavern-WTracker`, and by the interceptors their manifests name,
`wtrackerliteGenerateInterceptor` and `wtrackerGenerateInterceptor`. Cairn reads nothing else
from either, and no settings, since those outlive the extension.

Qvink's summaries are shown under their messages only while Qvink isn't drawing its own: it
isn't loaded, or its `display_memories` (default on, `index.js:160`, checked at `:1460`) is off.
