# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Breaking means the stored data shape changed**, not the API — a major bump is
about your accumulated memory, not our internals (CLAUDE.md §8.32).

## [Unreleased]

### Added

- **The memory block now holds two fidelities, so old scenes fade instead of
  vanishing.** A fixed part of the block is kept for one-sentence versions of older
  summaries: when a summary no longer fits in full it is shortened rather than
  dropped, and only when the compact tail is also full does anything leave the block
  at all. On the chat this was measured against it roughly doubles how much of the
  story the block carries — about 86 summaries where it held 51 — for the same
  tokens. The short version comes from the compact record Cairn writes beside each
  summary, so the longer memory costs no extra call to your memory model. Until
  those records exist, full summaries keep the whole block, and a summary with no
  record behind it is dropped exactly as it was before.
- **Cairn reads each summary into a compact record.** One small record per summary,
  written on the same message, holding who it was about, what happened, what
  lastingly changed, why, anything the summary says was already true, and the
  one-sentence version the block uses. It rides the same queue as summaries, in
  batches, after them, and a failed batch changes nothing at all. These records are
  what the next release derives long-term canon from.

- **Lorebook cap.** A new setting, in tokens, for the most of the prompt your
  lorebook may take. SillyTavern has always had this cap and ships it at 0 — no
  cap — so only its 25% budget binds, and on a large book that is more than the
  character card costs and more than the whole memory block gets. Cairn defaults
  it to **3,500** and hands the difference to memory. Set it to 0 to leave
  SillyTavern's budget exactly as it was. It is SillyTavern's own setting, so it
  applies to every chat and is saved with the rest of your settings — that is why
  it is a number you can see and change rather than something Cairn decides.

### Changed

- **Your stored memory moves to version 4.** Older chats are read and carried
  forward exactly as they were — nothing is re-summarised and nothing is lost —
  and a chat written by a newer Cairn than yours is left alone rather than
  overwritten. The new version holds one compact record per summary. A record is
  tied to the summary it was read from, so re-summarising a message or editing it
  clears the record too, and it is written again from the new summary.
- **Example dialogue is dropped once summaries stand in for messages.** A card's
  example messages say how a character *would* speak in a situation that never
  happened, and they do not move as the character develops — thirty turns of
  someone growing into confidence are contradicted by examples that still show
  them meek. Once any message behind the raw window carries a summary, the real
  messages say it better, so Cairn switches SillyTavern's own **Strip Examples**
  behaviour on and the card's examples leave the prompt for good. On the run's
  card that is about 2,176 tokens, 49% of the card, handed back to memory. It
  latches: it happens once per chat, never flips back while you play forward, and
  a branch taken before the first summary correctly gets its examples again.
  **Your saved setting is not changed** — the switch lasts for the session, so a
  brand-new chat still opens with its examples, which is the one place they earn
  their tokens. SillyTavern's own dropdown still shows what you chose; Cairn's
  inspector says when it is stripping.
- **The raw window is narrower: 8 messages behind the threshold, advancing in
  8s.** It was 10 and 10. The window swings between 8 and 15 messages instead of
  10 and 19, which is the six-to-ten-message lag that reads correctly in play,
  and it hands the memory block about 1,855 tokens it was reserving to carry
  prose the summaries already carry.
- **The held World Info set is re-checked against SillyTavern's lorebook budget,
  and only on a rebuild turn.** Cairn holds every lorebook entry that has ever
  fired so a missed keyword scan cannot make the block vanish, which means the
  set only ever grows. Once it outgrows the budget SillyTavern drops the tail
  itself, and it picks where the tail starts from a count taken mid-scan — so the
  entry on the boundary moves turn to turn and the prompt below it is rewritten
  each time. Cairn now trims the held set to the budget itself, lowest priority
  first, on the turn the memory block is being rebuilt anyway. Between rebuilds
  nothing is ever dropped, so a keyword miss still cannot evict an entry, and an
  entry that was trimmed comes straight back if the lorebook activates it again.
  Entries set to ignore the budget are never trimmed.

## [0.10.0] — 2026-09-18

### Added

- **Keep canon.** Before the oldest summaries are dropped from the prompt to make
  room, Cairn asks the memory model which of them said something permanent — a
  death, a kinship, a promise made, a place learned, something broken or given —
  and keeps those one-liners under **Established facts** at the top of the memory
  block. It runs one see-saw step before the rebuild that would drop them, so the
  facts and the rebuild change the block together and cost one break instead of
  two, and it is the last of the three memory calls: the world state and every
  waiting summary come first. Each batch of facts is stored on the newest summary
  it read, so branches and swipes carry it correctly, and each is shown in the chat
  under that message. Canon takes at most a fifth of the memory block, and always
  less than that if the summaries would otherwise be left with under two steps of
  room. That share is settled when the block is rebuilt and held until the next
  rebuild, so the facts at the top of the block never move on an ordinary turn.
  A chat with no canon yet has exactly the memory block it had before.
  **A fact kept this way cannot be removed**, so the prompt errs towards keeping
  fewer, and a fact longer than 160 characters is thrown away rather than shortened.
  On by default, and inert until a memory connection profile is chosen.
- New log fields: `memory_canon_facts`, `memory_canon_admitted`,
  `memory_canon_tokens`, `memory_canon_cap`, `memory_canon_limited_by`,
  `memory_canon_full`, `memory_canon_spilled`, `memory_canon_through`,
  `memory_canon_cap_applied`, `memory_scene_cap`, `memory_step_tokens`, and the
  `compaction_*` group for the pass queue.
- The inspector gains a **Canon** line in the memory block section, a **Scene
  budget** line saying what the summaries were fitted to, and a **Canon** section
  under the summaries with the pass tally: facts promoted, facts canon already
  held, and facts the parser refused.

### Changed

- **Stored data is now version 3.** A canon batch is written to
  `message.extra.cairn.canon` alongside the summary and the world state. Chats
  written by an earlier version are read unchanged and upgraded by the next write —
  nothing is lost and nothing needs converting.

- Cairn writes its own summaries. After each reply, and as soon as you edit a
  message, it summarises the messages waiting for one, one request at a time, through the **Memory connection**
  profile, and stores each summary on its message in `message.extra.cairn`. It
  starts after the newest summary your existing extension wrote, and waits while
  Qvink Memory is enabled with Auto Summarize on. A failed summary writes nothing and warns
  once per run of failures. A message that fails three times is skipped for the
  session, and the memory step waits before it. **Back up your chats before
  turning off Qvink's Auto Summarize**: this is the first version that writes to
  message data.
- **Summary prompt** setting. `{{message}}` is the message and `{{history}}` is
  the summaries before it, with Qvink's `{{#if history}}` syntax, so a Qvink
  prompt can be pasted in unchanged. Left unedited, it follows the built-in
  default. **Reset to default** restores it.
- Cairn's summaries appear under their messages, as Qvink's do. The message being
  summarised shows that a request is out, the ones behind it show they're
  waiting, and a failed summary shows why and whether it will be retried.
- **Summarise with Cairn** in each message's actions menu writes that message's
  summary again, replacing Cairn's or Qvink's. A failure keeps the old one. It
  also works on the newest message and on a message Cairn gave up on.
- Qvink's summaries appear under their messages as `Qvink:` while Qvink isn't
  drawing its own.
- Each message that carries a world state shows it under the message, in a
  collapsed **World state** section.
- The inspector has a **Summaries** section that updates as summaries are written.
  It shows what Cairn is doing or waiting on, what the open chat has cost
  (summaries, requests, failures, time, estimated tokens), and any message it gave
  up on. The memory block section says who wrote the summaries in it and whether
  a step is waiting.
- **Cairn keeps the world state**: where the scene is, the weather, who is there,
  and each character's hair and outfit. After each reply, and as soon as you edit a
  message, it updates the state through the **Memory connection**, before the
  summaries, and stores it on the newest message it read, in
  `message.extra.cairn.state`. Each update asks for the whole record back, so a
  field that was missed once is asked for again every turn until it is filled. A
  field is never cleared: what the model leaves out, sends blank or writes too long
  keeps the value it had. The characters the model lists are the ones present, so a
  character leaves by being left out. The state goes into the prompt just above your
  newest message. Swipes, edits, deletions and branches fall back to the previous
  state on their own. A failed update writes nothing and warns once per run of
  failures. Cairn does nothing with the state while WTracker or WTrackerLite is
  loaded.
- **Keep the world state** setting, on by default. It does nothing until a memory
  profile is chosen.
- The inspector has a **World state** section: what the state queue is doing, the
  state as the last prompt carried it, its depth and size, and the open chat's
  requests, failures, dropped fields, time and tokens.
- Log fields `state_*`: whether a state went in and why not, its depth, size,
  whether it changed and the kinds of change, and the state queue's gate, in
  flight, pending, given up and running totals. The state's text is never logged.
- Log fields `memory_source` (now `qvink`, `cairn` or `mixed`),
  `memory_cairn_scenes`, `memory_step_waiting`, `prompt_near_limit`, and
  `summary_*`: gate, in flight, pending, given up, and running totals of calls,
  writes, failures, time and tokens. `summary_prompt_default` is also new.

### Changed

- **Cairn no longer mirrors Qvink Memory.** The block uses Qvink's default
  template, separator and placement as Cairn's own, whatever Qvink's settings
  say, and Cairn no longer waits to match Qvink's block byte for byte before
  taking over. A disabled or uninstalled Qvink counts as silent: its leftover
  **Auto Summarize** and **Exclude messages after threshold** settings are
  ignored, so Cairn writes the block and the summaries straight after a reload.
  If your Qvink template, separator or prefill display wasn't the default, the
  block's wording changes and the first turn rebuilds. The inspector no longer
  shows the byte-for-byte match, and the handover reasons `unproven` and
  `unplaced` are gone. Log fields `memory_placement`,
  `memory_placement_defaulted`, `memory_fidelity`, `memory_fidelity_resolved`,
  `memory_fidelity_diverge_at` and `memory_live_chars` are gone.
- **The memory block's cap is 35% of the max prompt, or less when the rest of the
  prompt needs the room.** It replaces Qvink's short-term limit, which Cairn no
  longer reads, and there is still no setting. Cairn now reserves what your
  character card, lorebook, raw history and world state can cost — each worked out
  from the chat and your settings, never measured from a prompt that went out —
  and the block gets what is left, down to a floor of 10% of the prompt. On a
  chat with a large card and lorebook on a small context this is about half the
  old cap, which is the space SillyTavern was already taking from the card's
  example messages and the oldest raw messages without saying so. The cap changes
  only when one of those inputs does; a fall costs one rebuild at most and a rise
  costs nothing. The first turn after updating rebuilds the block and may drop a
  lot of summaries. The log field `memory_cap_type` is gone.
- The inspector's memory section says where the cap came from and what each
  reserve costs, and warns when a chat is starved — its card, lorebook and history
  leave the block less than a tenth of the prompt.
- Log fields `budget_*`: `limited_by`, `share`, `room`, `minimum`, `margin`,
  `card`, `lore`, `lore_bound`, `window`, `window_now` and `state`.
- A memory step now waits for a missing summary. The block stays where it is
  instead of moving past a message with no summary, so no message leaves the
  history without a summary to replace it. This can't happen while your
  summarising extension keeps up, because Cairn only waits on messages after
  the newest one that extension summarised.
- Cairn reads its own summaries from `message.extra.cairn` alongside your
  existing ones, and prefers its own when a message has both. A summary whose
  message has been edited is ignored until it is written again.

## [0.9.0] — 2026-09-16

### Changed

- **The memory block is a function of the chat.** Its cap is the short-term limit
  already set in the summarising extension (tokens, or percent of the prompt), and
  nothing measured from a previous prompt feeds back into the next plan. The first
  turn of a session rebuilds the block and trims it to half the limit; from the
  second turn on it is byte-identical until a step appends to its end
  (`docs/decisions.md` D-0033). This replaces the measured budget, the growth
  projection and the half-budget first-turn estimate, which together took a
  reloaded page four turns to reach a stable prefix. Log fields
  `memory_cap_estimated`, `memory_evicted_provisionally` and `memory_other_tokens`
  are gone; `memory_cap_type` is new.
- The recommended memory model is now a strong one, GLM-4.7 class or better
  (`docs/decisions.md` D-0036).

### Fixed

- The inspector no longer counts a block parked for a macro ("Macro Only") as a
  second writer. SillyTavern never places it, so after a handover the panel
  warned about two writers and the log said `writers: 2` while Cairn was the only
  one writing. Parked injections are still listed.

## [0.8.0] — 2026-09-15

### Added

- **Cairn writes the memory block** (`src/prompt/injector.js`). The plan is made
  in the generate interceptor, ahead of prompt assembly, and parked with
  `setExtensionPrompt` at the same position, depth and role the existing memory
  extension used — so the handover changes who writes and nothing else
  (`docs/decisions.md` D-0027).
- **Cairn holds summarised messages out of the sent history**, taking over the
  blanking threshold as well as the injection (D-0020). Written in place on the
  live chat with SillyTavern's own ignore flag; nothing is cloned and nothing
  reaches the saved chat.
- The block's placement is mirrored from the other extension only when it names a
  position SillyTavern actually collects. "Macro Only" — the setting the handover
  asks you to change — is not a placement, so Cairn uses its own default and says
  so in the panel. It refuses to hold messages back at all if its block would not
  be placed (`docs/decisions.md` D-0029). Log fields `memory_placement`,
  `memory_placement_defaulted`.
- **The handover gate** (`src/prompt/handover.js`). Cairn writes only when the
  setting is on, the other extension is placing neither of its injections and has
  stopped excluding messages, and our render of its own block has matched it byte
  for byte in this chat. Otherwise it plans and measures as before, and the
  inspector names the switch it is waiting for.
- **Setting: "Write the memory block"** (on by default; the gate still decides
  each turn).
- Inspector: a "Writing" line saying whether Cairn is the writer this turn and,
  when it is not, why; log fields `memory_writing`, `memory_handover`,
  `memory_blanked`, `memory_cap_estimated`.

### Changed

- The memory block is planned once per turn in the interceptor rather than after
  the prompt has gone out; the observer now feeds its measurement back for the
  next turn's budget.
- On the first turn of a chat — before any prompt has been measured — the block is
  capped at half the prompt budget rather than all of it, and any eviction that
  cap causes is **provisional**: the block is cut to fit for that turn, but the
  summaries come back on the first measured turn that has room for them
  (`docs/decisions.md` D-0028). Log field `memory_evicted_provisionally`.
- The fidelity check resolves a template's macros before comparing, so a template
  carrying `{{char}}` is no longer a permanent false divergence. Its log field
  `memory_fidelity_approximate` is now `memory_fidelity_resolved`.
- The generate interceptor is now `cairn_intercept` (it was
  `cairn_holdWorldInfo`); it carries both writes.

## [0.7.0] — 2026-09-15

### Added

- **Cairn now plans the memory block, and the inspector shows what it would
  inject.** It reads the summaries Qvink Memory has already written and works out
  which of them belong in the prompt — but it does not inject anything yet. The
  panel and the log carry the plan beside the block that is actually there, so
  the change can be measured before it is made.
- **The block's two cadences are separated.** Summaries enter the block in steps,
  and old ones are dropped only when the prompt genuinely cannot hold them —
  where today both happen at once. The point is where the prompt breaks: a step
  now adds to the *end* of the block, leaving the beginning where the model
  already has it cached, instead of rewriting the block from its first character
  and everything below it with it. Simulated over 170 turns, that is 2 full
  rebuilds instead of 90.
- **How much room the block gets is worked out, not configured.** Cairn asks
  SillyTavern how large the prompt may be and subtracts what the rest of the
  prompt measured last turn. No new setting.
- The inspector reports where in the block the first change fell — near the end is
  the whole point of this release — and warns when the context is too tight for
  the two cadences to stay apart, which otherwise looks exactly like working.
- The inspector also says whether Cairn's version of the block matches Qvink's
  byte for byte. Cairn will not take over the injection until it does.

## [0.6.0] — 2026-09-15

### Added

- **Lorebook entries no longer drop out of the prompt.** SillyTavern re-derives
  which World Info entries are active from a keyword scan over the last couple of
  messages, every turn. When that scan happens to seed nothing, the entire lore
  block vanishes — and comes back the next turn. Measured on a real chat that
  cost two full prompt rebuilds in a row, the worst event in a nine-turn run and
  worse than the summary see-saw it was masking. Cairn now remembers which
  entries have activated and pushes them back in before each scan, so an entry
  stays once it has appeared. Add-only: nothing is evicted on a keyword miss.
- New setting, **Hold World Info entries** (on by default). Off restores stock
  SillyTavern behaviour; the inspector keeps measuring either way, so a run can
  be compared with and without it.
- Editing a lorebook releases Cairn's hold on that book, so your change shows up
  on the next turn rather than being masked by the held copy.

## [0.5.0] — 2026-09-15

### Added

- **Warns when lorebook entries share an `order` value.** ST sorts World Info
  with one key and no tiebreak, so tied entries fall back to activation order —
  which changes with the chat text. A tied block silently reshuffles itself every
  turn and invalidates everything below it. Measured on a real book: 29 of 31
  entries tied, prefix stability 14-16% on every turn. The inspector now says so
  in a sentence, and the log carries `world_info_tied` and each entry's `order`.

## [0.4.0] — 2026-09-15

### Added

- **The stability meter now names the block it broke inside.** Each injection is
  located in the finished prompt, and the divergence index is attributed to
  whichever block owns that character — "0 chars into Qvink Memory (short)"
  rather than "character 7,687". This is what turns a stability number into a
  thing you can act on, and it is the measurement P1 is steered by.
- The inspector log carries each injection's `offset`, `offset_percent`, `chars`
  and `match`, plus `divergence_in*` for the attributed break. A run can now be
  read for *where* the prefix failed, not only that it did.

### Changed

- Attribution states its own confidence. An injection carrying macros — such as
  `{{outlet::key}}` — is not in the prompt verbatim, so it is matched on its
  macro-free head and reported as approximate. An approximate location presented
  as a certain one sends tuning after the wrong block.

### Fixed

- Two `docs/st-api-surface.md` citations had rotted against the pinned checkout
  (`updateChatMetadata` 8979 → 8978). Exactly the drift D-0009 predicted.

## [0.3.1] — 2026-09-15

### Fixed

- Injection token counts used the chars/4 estimate while the prompt total used
  ST's tokenizer, so the two were not comparable — an injection inside its
  budget could read as ~30% over it. Injections now use the real tokenizer, and
  the log carries `injected_tokens_estimated` when they fall back.
- `.cairn-settings label` beat ST's `.checkbox_label` on specificity and stacked
  every checkbox. The inspector also scrolls now instead of blowing out the
  drawer.

## [0.3.0] — 2026-09-15

### Added

- **Inspector log on disk.** Each observed generation is appended to
  `data/<user>/user/files/cairn-inspector.jsonl` as one flat JSON line, so a run
  can be read or scripted against instead of copied out of the panel by hand.
  Uses ST's own Data Bank endpoint; no server plugin. New setting, on by default,
  and writes are debounced.

### Changed

- A settings version with no registered migration now merges defaults instead of
  resetting to them. Losing someone's configuration to our own gap is not an
  acceptable failure mode.
- The migration engine is exported as `applyMigrations` so paths that only open
  up at a future schema version are tested now rather than in production.

## [0.2.2] — 2026-09-15

### Fixed

- The inspector reported "0 injections" while other extensions were visibly
  injecting. Cairn captured `SillyTavern.getContext()` once at load, but ST
  reassigns `extension_prompts` when a chat opens, so the observer was reading
  an orphaned object. The context is now re-read on every observation, which
  also fixes a stale `maxContext` after a preset change.

## [0.2.1] — 2026-09-15

### Fixed

- The stability meter kept one baseline across both generation paths, so the
  first turn after switching connection profiles compared a text-completion
  string against a flattened chat-completion array and reported a collapse that
  was an artifact of the switch. Baselines are now per-API.

## [0.2.0] — 2026-09-15

Phase P0: instrumentation. Read-only — Cairn observes generations and writes
nothing into the prompt yet, so it is safe to run alongside an existing memory
extension.

### Added

- Prompt observer, watching both generation paths (text completion and chat
  completion). It reads the outgoing prompt in place: no write-back, no cloning.
- **Prefix stability meter** — how much of this turn's prompt the model had
  already cached, with the divergence point and an excerpt of what changed.
- Injection inventory: every writer into the prompt, in prompt order, with
  placement, depth and token share — and a warning when more than one extension
  is writing.
- World Info accounting: which lorebook entries fired for the turn.
- Inspector panel in the extension settings drawer, updating each generation.

### Changed

- `docs/st-api-surface.md` now covers 36 verified citations, up from 29.

## [0.1.0] — 2026-09-15

### Added

- Project scaffold: `Makefile`, ESLint, Vitest, GitHub Actions (lint, tests on
  Node 20/22/24, secret scan, version check, CodeQL).
- Settings panel with the four P0 settings, and a versioned settings schema with
  a forward-migration runner.
- SillyTavern and memory-model mocks built against the real ST shapes, including
  the catalogue of malformed model output that parsers must survive.
- `make verify-st`: machine-checks every `file:line` citation in
  `docs/st-api-surface.md` against a local SillyTavern checkout.
- Documentation: design, decision log, ST API surface, development guide.

[Unreleased]: https://github.com/mjnitz02/cairn-memory/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/mjnitz02/cairn-memory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mjnitz02/cairn-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mjnitz02/cairn-memory/releases/tag/v0.1.0
