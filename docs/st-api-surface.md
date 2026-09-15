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
| `getTokenCountAsync` | Prompt token totals | `public/scripts/st-context.js` | 151 |
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
| `CHAT_CHANGED` | Drop the stability baseline on a new chat | `public/scripts/events.js` | 19 |
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

## Verified, not yet called

Cited by `DESIGN.md` and mirrored in `test/mocks/`. Verified now so the design
does not rest on an unchecked claim; each moves up as its phase lands.

| Symbol | Used for | ST file | Line |
|---|---|---|---|
| `chatMetadata` | Chat-global stores: canon, episodes, entity index | `public/scripts/st-context.js` | 135 |
| `saveMetadataDebounced` | Persist those stores | `public/scripts/st-context.js` | 136 |
| `setExtensionPrompt` | Our own injections | `public/scripts/st-context.js` | 153 |
| `ConnectionManagerRequestService` | Profile-routed memory-model calls | `public/scripts/st-context.js` | 294 |
| `setExtensionPrompt` | Signature and stored shape | `public/script.js` | 8926 |
| `CUSTOM_WI_OUTLET` | Where ST parks outlet content, unplaced | `public/script.js` | 4676 |
| `outlet` | `world_info_position.outlet === 7` | `public/scripts/world-info.js` | 863 |
| `outletName` | Declared WI entry field, editable in the WI UI | `public/scripts/world-info.js` | 4108 |
| `outlet::` | The `{{outlet::key}}` macro that places parked content | `public/scripts/macros.js` | 668 |
| `ConnectionManagerRequestService` | Class definition and `sendRequest` contract | `public/scripts/extensions/shared.js` | 392 |
| `ExtractedData` | `{ content, reasoning }`, the non-streaming return shape | `public/scripts/custom-request.js` | 60 |
| `coreChat` | Entries are fresh objects but **share `extra` by reference** with the real chat | `public/script.js` | 4539 |
| `IGNORE_SYMBOL` | The flag that drops a message from the sent history | `public/scripts/constants.js` | 25 |
| `doChatInject` | Where `IN_CHAT` injections are spliced into the history | `public/script.js` | 5628 |
| `flushWIInjections` | ST clears depth and outlet injections every generation | `public/script.js` | 5678 |
| `getOutletPrompt` | Resolves `{{outlet::key}}` from the parked injection | `public/scripts/macros.js` | 597 |
| `world_info_position.outlet` | The outlet branch of the placement switch | `public/scripts/world-info.js` | 5248 |
| `WIOutletEntries` | Entries sharing an `outletName` group into one block | `public/scripts/world-info.js` | 5253 |

## Hazards

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
