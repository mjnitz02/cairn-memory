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
| `getProfile` | Shape of a connection profile (`id`, `name`) | `public/scripts/extensions/shared.js` | 546 |
| `getRequestHeaders` | Auth headers for the file-upload call | `public/scripts/st-context.js` | 129 |
| `/upload` | Data Bank write endpoint, for the inspector log | `src/endpoints/files.js` | 28 |
| `validateAssetFileName` | What filenames the endpoint accepts | `src/endpoints/assets.js` | 21 |
| `extension_prompt_types` | `NONE` / `IN_PROMPT` / `IN_CHAT` placement enum | `public/script.js` | 484 |
| `GENERATE_AFTER_COMBINE_PROMPTS` | Text-completion prompt, read-only in P0 | `public/script.js` | 5243 |
| `CHAT_COMPLETION_PROMPT_READY` | Chat-completion prompt, read-only in P0 | `public/scripts/openai.js` | 1619 |
| `WORLD_INFO_ACTIVATED` | Observe which WI entries fired | `public/scripts/world-info.js` | 902 |
| `CHAT_CHANGED` | Drop the stability baseline on a new chat; abandon a summary request for the chat being left | `public/scripts/events.js` | 19 |
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
| `substituteParamsExtended` | Resolve a template's macros before comparing it to qvink's block | `public/scripts/st-context.js` | 164 |
| `export function substituteParamsExtended` | Signature and semantics | `public/script.js` | 2815 |
| `symbols: {` | Where `getContext()` exposes the ignore flag | `public/scripts/st-context.js` | 302 |
| `IGNORE_SYMBOL` | The flag that drops a message from the sent history | `public/scripts/constants.js` | 25 |
| `if (chatItem.extra?.[IGNORE_SYMBOL]) {` | Honoured on the text-completion path | `public/script.js` | 5841 |
| `if (chat[j].extra?.[IGNORE_SYMBOL]) {` | ...and on the chat-completion path | `public/scripts/openai.js` | 584 |
| `let coreChat = chat.filter` | The interceptor's array is **filtered**, so its indexes are not the chat's | `public/script.js` | 4496 |
| `...chatItem,` | Its entries are fresh objects that **share `extra` by reference** with the real chat | `public/script.js` | 4525 |
| `index,` | The index they carry counts the *filtered* array — never use it as a chat index | `public/script.js` | 4527 |
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
| `await listeners[i].apply(this, args);` | ST awaits every listener in turn, so the summarizer starts its work and returns | `public/lib/eventemitter.js` | 146 |
| `chat.splice(0, chat.length, ...data);` | Opening or reloading a chat refills the same array with **new** message objects, so a late reply's message is no longer in it | `public/script.js` | 7658 |
| `await reloadCurrentChat();` | A rename reloads the chat too | `public/script.js` | 10713 |

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
| `doChatInject` | Where `IN_CHAT` injections are spliced into the history | `public/script.js` | 5628 |
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
(`SillyTavern-MessageSummarize/index.js:4022`). Cairn only reads them for
attribution in the inspector; nothing depends on that extension being installed.

`auto_summarize` is Qvink Memory's Auto Summarize setting, default on
(`SillyTavern-MessageSummarize/index.js:116`, read through `?? default_settings[key]`
at `:655`). Cairn does not summarise while it is on.
