# Cairn-Memory — Design

Working notes for a from-scratch SillyTavern memory extension. Pre-implementation; nothing here
is committed to yet. Named **Cairn-Memory** — see `NAMES.md` for how we got there.

Status: draft, 2026-09-15.

---

## 1. The problem

Two symptoms, one cause.

**Symptom A — lorebooks destabilise the prompt.** World Info entries activate on keyword scan at
arbitrary depths with an independent token budget. They collide with a summarisation extension
that has carefully stabilised its own injection, and the collision is invisible until the
generation is slow or the model forgets something.

**Symptom B — memory grows without bound and still develops holes.** Short-term memory is capped
by a token budget, so it evicts. Long-term memory is a second-tier fallback that accumulates and
is never compacted, so it becomes a pile of disconnected micro-facts with no narrative coherence.

**The cause:** every existing extension models memory as *a compressed transcript*. Messages in,
summaries out, summaries injected. But at generation time the model does not need a compressed
transcript. It needs **state** — what is true right now, where we are, who is present, what is
unresolved — plus a *sparse* set of retrievable past episodes.

A compressed transcript degrades uniformly: each rollup pass averages load-bearing detail
together with texture, and after enough passes everything is equally beige. State does not
degrade, because state is *overwritten* rather than summarised. It has a current value, not a
history with gaps in it.

Symptom A is the same failure at a different layer: two independent systems writing into one
shared prompt, with no shared budget and no shared ordering discipline.

---

## 2. Why build rather than extend

Not because the existing code is large. Because the data model is wrong in all three, and
because the three halves of the answer already exist as three extensions that cannot see each
other.

| | what it is | LOC | mechanism |
|---|---|---|---|
| `qvink/SillyTavern-MessageSummarize` | scene summaries + the see-saw | 4,980 (one `index.js`) | two `setExtensionPrompt` calls (`_long`, `_short`) + a generate interceptor that blanks summarised messages |
| `SillyTavern-WTrackerLite` | structured scene state | ~935 (TS/React) | JSON-schema -> `ConnectionManagerRequestService.sendRequest` -> `message.extra['WTrackerLite']` |
| `Lodactio/Extension-Summaryception` | delta compression | 3,455 | recursive L0(~3 turns) -> L1(~9) -> L2(~27), hand-rolled `connectionutil.js` |

Specific findings:

- **qvink's long-term memory is not a store, it is a flag.** `remember` / `remember_auto` on
  messages; `get_long_memory()` concatenates the summaries of flagged messages. No compaction,
  no merge, no promotion. LTM grows linearly with flagged messages and the only lever is *which
  messages get flagged*. This cannot be evolved into a compacted store — there is nothing there
  to compact.
- **Interleaved interceptors are a proven hazard, not a theoretical one.** WTrackerLite's
  interceptor `structuredClone`'d the chat array, silently dropping qvink's
  `extra[Symbol.for('ignore')]` flags (structured clone drops Symbol keys with no error). Result:
  full raw history sent, prompt pinned at `max_context`, oMLX common prefix down to ~25-55% per
  turn. Fixed 2026-08-17. Two extensions politely coexisting is exactly how this happens.
- **No layer has a budget arbiter.** Every one of them assumes it is the only writer.
- **The 4,980-line `index.js` is not an ST constraint.** House style is raw browser ES modules
  with no build step; `manifest.json` lists what loads. Multiple modules cost nothing.

### What to take from each

- **qvink — the see-saw.** `get_injection_threshold()` with `INJECTION_THRESHOLD_INDEX` as a
  module global, recomputed only when messages / summaries / percent-of-context triggers fire.
  That is the cache-stability machine and it is genuinely good. Lift it wholesale.
- **qvink — the message-blanking interceptor.** Removing summarised messages from the sent
  history via the ignore Symbol, keeping `lagging` ones.
- **Summaryception — delta summarisation.** Each batch is summarised *against what has already
  been summarised*, emitting only the narrative delta, so snippet 10 does not re-establish
  characters or setting. Snippets get cheaper over time. Steal this. Do **not** steal the
  recursive rollup on top of it — that is the part that produces uniform loss.
- **WTrackerLite — per-message storage.** State in `message.extra` branches and swipes correctly
  *for free*. This is the single most important structural decision in the whole design.
- **WTrackerLite — `ConnectionManagerRequestService`.** ST's own profile-routed request service.
  Summaryception's 676-line `connectionutil.js` re-implements this by hand; do not repeat that.

### What Cairn actually contributes

"Build rather than extend" implies Cairn adds capability. Mostly it does not
(`docs/decisions.md` D-0066). SillyTavern already ships the levers that keep a prompt stable and
recapture its tokens — `world_info_position.outlet`, `power_user.strip_examples`,
`world_info_budget_cap`, ordered World Info trimming — and every one of them ships off, static,
or dependent on per-card configuration that authors never do.

**Cairn's contribution is the *when*: pulling levers ST already has, at the moments that matter,
in a chat where nobody configured anything.** It decides how many raw messages to keep, when a
summary stands in for a message, when example dialogue has been superseded by real ones, when
lore may be reprioritised, and what becomes of a summary when the room runs out. In a normal
roleplay none of that ever fires.

This is why §2.5 of `CLAUDE.md` reads the way it does. Before inventing a mechanism, check
whether ST has the lever — and if it does, the work is the timing.

---

## 3. Hard requirements

1. **The summarisation model is never the roleplay model.** Separate connection profile,
   mandatory, not optional. RP models are trained to be fluffy and evocative; those objectives
   compete with summarisation in every observed case. The extension must not work at all without
   an explicitly selected memory connection.
2. **State is structured, not prose.** Prose state invites the summariser to wordsmith, which
   damages flow. Hard facts live in structured state; *flavour* comes from the recent raw
   messages, which is what they are for.
3. **Cooperate with lorebooks, do not replace them.** WI keeps doing retrieval. We take over
   placement and budgeting. **Assume the worst about lorebook hygiene**: `sticky` and `cooldown`
   are `0` on every entry of every book observed, `order` ties on anything hand-made, and
   recursion is a global toggle. Roughly nineteen books in twenty have none of it configured, so
   nothing may depend on configuration being correct. The rules cost a well-made book nothing —
   it still evicts, just on the see-saw instead of per turn (`docs/decisions.md` D-0023).
4. **Retrieval is entity-based first.** Vector/RAG retrieval pushes the user toward writing
   keyword bait to hit the index. Fine for a work agent, not fine for roleplay. Names and
   entities matter more than semantics here. Vectors stay an optional second stage, if ever.
5. **Single-character chats only.** Group chats are unused; degrade with a toast, leave the
   extension point obvious, build no member pickers.
6. **Few knobs.** Prompt guidance is baked in rather than made selectable. Configurability that
   is not exercised is moving parts that rot.

---

## 4. Cache economics — the actual numbers

The two halves of the system optimise for **different things**, which reinforces requirement 1.

- **RP model — local Gemma via oMLX.** Resident KV cache, no TTL. Freezing the prompt prefix is a
  large, real win. Volatility ordering (section 6) matters here and only here.
- **Summariser — cloud (GLM 4.7 class).** Turn pacing is ~10 minutes of hand-writing per turn
  with multi-hour gaps between sittings. A 5-minute-TTL cache is a flat ~25% surcharge that never
  reads; a 1-hour TTL breaks even at three turns in a sitting. **Optimise total tokens per call,
  not cache-hit rate.** Do not build cache-warming behaviour for the cloud side.

Consequence: the scheduler optimises *prefix stability* for the RP prompt and *call count x
tokens* for the memory prompts. These are different objective functions and should be separate
code paths with separate instrumentation.

---

## 5. The memory model — typed, not tiered-by-age

Five kinds, different update rules, different lifetimes. Eviction by age is replaced by
compaction under budget pressure.

### Tier 0 — Raw window
ST's own recent messages. Not ours. Carries the flavour that state deliberately omits.

### Tier 1 — World state
Small, structured, **continuously rewritten**. Only the hard facts a character's description
fixes and the story then changes: location, weather, who is present, and each one's hair and
outfit, as WTrackerLite keeps them. Mood, time and plot stay with the roleplay model, because
tracking them gridlocks it into narrating a dictated lane (`docs/decisions.md` D-0043).
At most ~330 tokens. Bounded **by design**, not by eviction. Never grows.

Generated as a **diff against the previous state** plus the new messages, not regenerated from
scratch — cheaper, and fields the diff leaves out keep their exact wording. Stored per-message in
`extra` so it branches correctly (`docs/decisions.md` D-0044, D-0045).

This is the piece no existing extension has in combination with the others, and it is what
actually kills the holes: state is always current, so it cannot have gaps.

### Tier 2 — Scene summaries
The see-saw layer. Rolling prose summarisation of messages falling out of the raw window,
delta-style (Summaryception's good idea). Bounded by token budget, evicted by recency.
Compacted under pressure, never silently rolled up.

**Two consumers, one artefact** (`docs/decisions.md` D-0070). The roleplay model wants a
readable narrative bridge for recent history; a canon deriver wants comparable structure across
every summary in the chat. Prose carries structure only implicitly, which is why condensing a
summary far enough destroys the ability to read an *arc* across a run of them. So each summary
also carries a compact **index record** — the four-way kind (D-0064) plus who, what, what
lastingly changed, and *because* — bounded at ~20 tokens, stored per-message beside the prose.
The index is off-prompt: it is the canon deriver's input, never the roleplay model's.

### Tier 3 — Canon
Things that became permanently true. "Her brother is dead." "They kissed at the lighthouse."
Absurdly cheap per item, and by a wide margin the highest-value content in the prompt — roughly
20× the story per token that a scene summary carries (`docs/decisions.md` D-0065).

**A fixed number of derived slots, not an append-only bag** (D-0071, superseding the bag of
D-0055). The durable artefacts are the tier 2 index records; canon is a forced-budget *pick*
over them — "fill exactly N slots" — re-derived on a rebuild turn (D-0067) and folded fresh
every turn, so branches and swipes roll back with no code. A wrong fact is therefore removable
by fixing the record it came from. The slot count is fixed because the spine does not grow
linearly with chat length: introductions and major occurrences are necessarily rare.

Long-term this is still where generated lorebook entries would come from.

### Tier 4 — Episodes
The long tail. Compacted events with entity keys. **Off-prompt by default**, retrieved on demand.
Unbounded on disk, near-zero cost in context.

---

## 6. The injection contract — monotonic volatility ordering

**Invariant: nothing volatile may sit above something that changes less often.**

Target prompt shape:

```
[ system / persona / character card ]          volatility: never
[ canon block + stable WI (via outlet) ]       volatility: rarely
[ scene summaries ]                            volatility: every N turns (see-saw)
[ ...... raw chat history ...... ]
   depth 1:  [ world state ]                   volatility: every reply
   depth 0:  [ retrieved episodes + dynamic WI ]  volatility: per turn
```

The world state sits just after the newest message it has read, which is depth 1 in normal play.
It moves forward one reply each turn, so it costs a re-read of itself and the user's message:
about 1.6 points of prefix stability, measured (`docs/decisions.md` D-0042, D-0049).

In ST terms this maps directly onto injection depth: stable content high/early via
`extension_prompt_types.IN_PROMPT`, volatile content late via `IN_CHAT` at low depth. Per-turn
retrieval is only affordable *at all* because it sits at depth 0.

The extension assembles all of this as **one ordered plan** and is the only writer. Verified at
`CHAT_COMPLETION_PROMPT_READY` before the request leaves.

---

## 7. Lorebook cooperation — the outlet mechanism

Confirmed present in the local ST checkout (1.19.0, `06bde939f`).

`world_info_position.outlet` (value 7). A WI entry sets `outletName`. On activation ST does:

```js
// public/script.js:4676
setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'),
                   extension_prompt_types.NONE, 0);
```

`extension_prompt_types.NONE` means **no automatic placement**. The content is parked and
retrieved by macro:

```js
// public/scripts/macros.js:668 (getOutletPrompt at :597)
{ regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => getOutletPrompt(key.trim()) || '' }
```

So lorebook entries can be routed into named outlets that *we* place, at a stable position,
inside our own block. WI keeps doing retrieval; we take over placement and budgeting. This is
cooperation without a second competing injector — natively supported, no fork required.

### Supporting hooks (all verified)

- `CHAT_COMPLETION_PROMPT_READY` -> `{chat, dryRun}`, array written back
  (`openai.js:1619`, `script.js:4037`). Last-chance full rewrite for chat completion.
- `GENERATE_AFTER_COMBINE_PROMPTS` -> `{prompt, dryRun}`, string written back
  (`script.js:4031`, `5243`). Same for text completion.
- `WORLD_INFO_ACTIVATED` (`world-info.js:902`) — tells us which entries fired, but emits
  **after** `worldInfoBefore`/`worldInfoAfter` are already assembled. **Observation only, not
  interception.** Good enough for dedup accounting and budget arithmetic.
- `WORLDINFO_FORCE_ACTIVATE` (`world-info.js:1020`) — pushes entries in. **In use**: the
  holder re-pushes the remembered set from the generate interceptor every turn, because
  `resetExternalEffects()` clears it after each scan (`:5275`). ST substitutes the *forced
  object* for the book's own (`:4888`), so what is pushed must be the post-scan entry, not a
  `{world, uid}` stub. See `docs/decisions.md` D-0024.
- Depth entries are visible in `context.extensionPrompts` under `customDepthWI_<depth>_<role>`,
  so unconverted entries can still be accounted for and relocated.

### Two levels of cooperation

- **Level 1 (no lorebook edits):** observe activations, dedup summary content against active WI
  text, budget against it, relocate via the prompt-ready rewrite. Works today, coarse.
- **Level 2 (entries migrated to outlets):** full placement control, clean dedup, stable
  ordering. Costs a per-entry edit on existing lorebooks. Not needed while the block stays
  where it is; see `docs/decisions.md` D-0035.

---

## 8. Compaction — extract, then compress

The reason recursive summarisation produces holes is that it destroys the source before
extracting what must survive. Compaction runs in three declared operations, in this order:

1. **Promote** — pull durable facts out into Canon and durable changes into State. Cheap,
   permanent, structured storage *first*.
2. **Merge** — collapse the remaining items about the same thread into one coarser item.
3. **Drop** — texture with no forward relevance is deleted.

Triggered by **budget pressure per tier**, never by age.

One structured call to the memory model per compaction pass:

```
input:  scene summaries under pressure + current canon + entity index
output: { promote: [{fact, entities}],
          merge:   [{covers: [ids], text}],
          drop:    [ids],
          archive: [{id, text, entities}] }
```

Deterministic to apply, auditable, and reversible because the source items are archived to
Tier 4 rather than destroyed.

**Corrected by P5** (`docs/decisions.md` D-0070, D-0071). "Triggered by budget pressure per
tier" is wrong for promotion, and it is the mistake that made P4's canon worthless: pressure
selects what is about to be *evicted from the prompt*, while every summary in the chat is on
disk and readable at any time (`src/memory/scenes.js` `readScenes`). Eviction from the prompt
has nothing to do with availability on disk. Promotion is a ranked pick over the whole index,
not a salvage operation on the eviction stream, and the pressure trigger is deleted.

Pressure still drives **drop** — that is the budgeter doing its job on the prompt — and merge
is still not built.

---

## 9. Branching, swipes and durability

ST branches and swipes freely. A linear memory log breaks under both.

- **Per-message data in `message.extra`** branches for free. WTrackerLite already proves this.
  Everything that can be per-message should be.
- **Nothing is genuinely global.** Canon was to live in `chatMetadata` with explicit
  checkpoints keyed to message index, and that was called the single most likely source of
  quiet wrongness in the whole system. It is not built. A canon batch is stored per-message
  like a state, on the newest summary its pass read, and the canon set is a fold over the chat
  read fresh every turn — so branches, swipes and deletions roll back with no checkpoint, no
  rollback code and no event wiring (`docs/decisions.md` D-0045, D-0055). The episode archive and
  the entity index (tier 4, P5) inherit the same requirement: find a per-message shape, or
  argue why this one does not apply.
- **Never clone chat messages in an interceptor.** Mutate in place, collect target indexes first,
  splice highest-to-lowest. Symbol-keyed flags from other extensions do not survive cloning and
  the failure is silent.

---

## 10. Observability is a feature

Prompt tuning will take months and will be done from real play, not from tests. Build the
inspector early or tune blind.

- Per-tier token counts and their share of the budget.
- Exactly what was injected, from which tier, at which depth, for the last generation.
- **Prefix-stability meter: common-prefix length vs the previous turn, as a percentage.** This is
  the number that caught the WTrackerLite regression (~25-55% when broken). It should be visible
  at all times, not discovered forensically.
- A diff of what changed in the memory block since the last turn, and which trigger caused it.

---

## 11. Module layout

House style: raw browser ES modules, **no build step**, `manifest.json` lists what loads. Tooling
copied verbatim from `SillyTavern-Character-Tools` — `Makefile` (`make install` / `make check`),
flat `eslint.config.mjs` with browser + `SillyTavern`/`toastr` globals, `vitest` on
`test/**/*.test.js`, `package.json` `private` + `type: module`. CSS classes take a short
per-extension slug; style against `--SmartTheme*` variables.

Note: WTrackerLite's TS/React/webpack stack is inherited from its third-party upstream and is
**not** the house style. Do not copy it.

```
index.js                  bootstrap, event wiring, manifest entry points — nothing else
manifest.json
settings.html
style.css
src/
  constants.js            slug, extension path, display name
  store/
    schema.js             types + schema versioning + migrations
    chat-store.js         message.extra + chatMetadata access, checkpoint/rollback
    entity-index.js       entity -> {canon ids, episode ids}
  memory/
    state.js              tier 1
    scenes.js             tier 2
    index-record.js       tier 2 — the per-summary index record (P5)
    examples.js           the derived example-dialogue latch (P5)
    canon.js              tier 3
    episodes.js           tier 4
  pipeline/
    scheduler.js          when work runs; batching; see-saw thresholds
    budgeter.js           token allocation across tiers under pressure
    compactor.js          promote / merge / drop
    summarizer.js         all LLM calls, via ConnectionManagerRequestService
  prompt/
    assembler.js          builds the ordered block from the tiers
    injector.js           setExtensionPrompt + prompt-ready rewrite + interceptor
    lorebook.js           outlet routing, WI observation, dedup
  ui/
    panel.js              settings
    inspector.js          section 10
  util/
    tokens.js
    log.js
test/
  mocks/                  ST + memory-model mocks, each citing the shape it mirrors
```

Tooling around it: `Makefile` (`make check` is the gate), flat `eslint.config.mjs`, `vitest`,
`scripts/verify-st.mjs` (re-checks `docs/st-api-surface.md` against a local ST checkout), and
GitHub Actions for lint / tests on Node 20-24 / secret scan / version check / CodeQL.

Summarisation strategies and model routing sit behind interfaces, because those will churn
forever and that churn must not touch the spine.

---

## 12. Prompt constraints

Memory prompts run on a strong cloud model: GLM-4.7 class or better, chosen through a connection
profile. Prompts may assume that floor (`docs/decisions.md` D-0036).

- Explicit, concrete, **positive** instructions. No hypothetical framing.
- `IMPORTANT:` prefix on the critical instruction; concrete include/exclude examples; a
  tiebreaker at the end.
- Positive format constraints ("a single paragraph") beat negative ones ("do not use lists"),
  though an explicit prohibition still earns its place as a secondary guard.
- **Exception: the default summary prompt** does not follow this structure. It is Matt's qvink
  prompt, verbatim, because a prompt measured in play beats one written to these rules
  (`docs/decisions.md` D-0039).
- Bake guidance into the prompt rather than making it selectable.
- Anything reported back to the user must reflect the **actual change**, not the model's claimed
  output. Capture pre-state before applying, so counts are real.

---

## 13. Phasing

**P0 — Instrument.** Inspector + prefix-stability meter, read-only, running *alongside* qvink.
Zero risk, immediate diagnostic value, and it validates the whole theory before any commitment.
If the prefix-stability numbers do not show what section 4 predicts, stop and rethink.

**P1 — Own the injection.** Assembler + injector + the World Info holder. Replaces qvink's
injection while still *reading* qvink's existing summaries out of `message.extra`, so migration
is free and the chat history stays usable. Fixes symptom A on its own.

*Landed:* the World Info holder (0.6.0) — the lore block is add-only, so a keyword-scan miss can
no longer evict it (`docs/decisions.md` D-0023, D-0024). The assembler (0.7.0) — growth and
eviction are separate cadences, so a see-saw step appends at the block's tail and the head keeps
its offsets (D-0026). The handover (0.8.0) — Cairn parks the block and owns the blanking
threshold, behind a gate that stays shut until qvink is silent and our render of its block has
matched it byte for byte (D-0020, D-0027). *Measured* (D-0034): on Esin, quiet turns hold at
96.5–97.2%, and a step turn breaks at the block's tail for 68.2%, which is the most this layout
allows. That averages about 91% over a cycle. The see-saw is accepted. Lorebook outlet routing
was dropped from P1 (D-0035).

The measured target is *where* a see-saw step breaks the prefix, not moving the block below the
history — the history is the part that grows, so anything under it shifts every turn. Keep the
block high; make a step change its tail rather than its head. See `docs/decisions.md` D-0019, and
D-0034 for why the ~90% step figure it predicted is layout-dependent.

**P2 — Scenes.** Own summarisation, one plain-text summary per message, with an editable prompt
and the see-saw scheduler ported from qvink. Now independent of qvink.

*Landed:* summaries stored on their messages and hash-checked against edits, a queue that never
blocks the chat, and a step that waits for a missing summary (`docs/decisions.md` D-0037). The
cap is a fixed 35% of the max prompt (D-0038), the summary prompt is editable (D-0039), and the
qvink mirror is retired, so qvink can be disabled or uninstalled (D-0040). *Measured* (D-0041):
on Esin with qvink disabled, held turns at 96.7–97.3% and a step breaking at the block's tail
for 67.3%, about 91% over a cycle, as in P1. Summary quality is deferred to a real-roleplay test
after P4 or P5.

**P3 — State.** Structured, diffed, per-message. Replaces WTrackerLite.

*Landed:* WTrackerLite's fields and nothing more, so the memory model never steers the story
(`docs/decisions.md` D-0043). One update per reply, from a built-in prompt (D-0044), which asks
for the whole record back and never clears a field, so a hole heals instead of persisting
(D-0053, superseding the merge patch of D-0044 and the first build of D-0048). A full
snapshot on the newest message read, valid while what it read hashes the same, so swipes,
edits, deletions and branches roll back with no code (D-0045). Placed just after that message
(D-0042), independent of the handover gate (D-0047), and never while WTracker is loaded
(D-0046). *Measured* (D-0049): on a branch of Esin with real-length user messages, held turns at
95.9% with the state against 97.5% without, steps still breaking at the block's tail, 13
updates with no failures, and the state at a median of 57 tokens.

**Order after P3: P6, then P4 and P5** (`docs/decisions.md` D-0051). On a real-length chat the
fixed cap is bigger than the room the prompt leaves, so P4 would never see budget pressure
before ST trims the prompt.

**P4 — Canon + compactor.** Promote and drop under budget pressure. Fixes symptom B.
*Built and measured* (`docs/decisions.md` D-0055 to D-0058, closed by D-0060).

*Landed:* one step before each rebuild, the memory model is asked what in the summaries about to
be dropped became permanently true, and those one-liners sit at the block's head under
`[Established facts]:` (D-0056). A batch is stored per-message on `extra.cairn.canon` — store v3
— so branches and swipes roll back with no code, and no edit unmakes a fact (D-0055). A pass is
due under budget pressure, once per cycle, derived and never stored, and fails to nothing
(D-0057). Canon's room is `min(20% of the cap, cap − 2 × stepTokens)`, the second term a guard
against recoupling the see-saw. Admission is frozen to the cap in force at the last rebuild
(D-0059). Merge is not built: the budgeter already drops, and the originals stay on their
messages, so nothing is destroyed.

*Measured* (D-0060): the mechanics hold — one pass per cycle, the evict-set matching what the
rebuild drops, no failures, a clean v3 migration — but the run found the chat **starved**, with
the cap on its 10% floor, canon's room squeezed from 613 tokens to 72 by the guard, and
`sceneCap − floor` clearing `stepTokens` by six. The regime P4's own table predicted never
arrived. **P5 inherits that, not canon's fill rate.**

**P5 — Strong canon, reliably, from a modest model** (`docs/decisions.md` D-0065, redefining
this phase). Canon carries roughly **20× the story per token** that a scene summary does, which
makes it the highest-value content in the prompt and the thing worth spending on. P4 proved the
plumbing and D-0062 proved the selection is wrong: promotion keyed to eviction pressure only
ever reads the newest material about to be dropped, and never sees what left the prompt before
Cairn was watching. D-0064 says why that is structural — description and filler are most of the
volume, so any recency window is almost entirely them.

So P5's question is **how to select and compress what matters without a model that can ingest
the whole story**. Episodes and the entity index are candidate mechanisms, not the goal; both
answer capacity, and capacity is not the binding constraint.

*Planned* (`docs/p5-plan.md`, D-0066 to D-0071). Two halves that pay for each other.

**Reclaim.** The prompt spends 41.7% on nineteen raw messages and 0.3% on the whole story's
canon, measured. Three levers move that and all three are ST settings that ship off: example
dialogue is dropped for good once summaries stand in for messages (`power_user.strip_examples`,
latched on a derived trigger); the lorebook is capped (`world_info_budget_cap`) and
reprioritised only at a rebuild, staying add-only between; and the raw window narrows to
`RAW_WINDOW` / `STEP` 8, a window of 8 to 15 messages. Together the block goes 2,440 → ~7,953
and canon's room goes **72 → ~1,591, up 22×** — so the starvation question (D-0060) is answered
by configuration, and `CANON_FRACTION` becomes a real number for the first time.

**Derive.** Every summary carries a compact index record (tier 2, §5). Canon is a forced-budget
pick over the whole index — ~3,200 tokens, one call — so the model ingests the *index* rather
than the story, the kind is a sort key rather than a gate, and the eviction trigger is deleted
outright. Canon becomes a fixed number of derived slots, which makes a wrong fact removable.

**Selection is fixed first, and the budget priority is re-derived after** — reordering the
sacrifice while canon is still bad would protect the bad canon invisibly (D-0065). The window
narrows to 8/8 rather than 6/6 precisely so the cap lands just *under* D-0038's 35% share and
that re-derivation stays out of this phase.

**P6 — A budget worked out from the chat.** *Built and measured* (`docs/decisions.md` D-0052,
closed by D-0054). The block's cap is the smaller of
D-0038's fixed 35% of the max prompt and the room the rest of the prompt leaves, never below
10%. Each reserve is worked out from the chat and the settings — no watching the prompt, so
neither the lore floor nor the pause first sketched here is needed — and each is an upper
bound:

- **Card:** the card fields that reach the story string, plus the system prompt ST would use.
  Counted directly; they change only when the user edits them.
- **World Info:** ST's own budget (`world_info_budget` of the max prompt, capped), or every
  enabled entry in the books ST scans if they come to less. No lorebook, no reserve.
- **Raw window:** the heaviest `RAW_WINDOW + STEP − 1` consecutive visible messages the chat
  has had — the widest the window ever gets, with no guess about message length.
- **World state:** its schema bound, 0 while it is off or a WTracker is loaded.
- **Margin:** 5% of the max prompt, the same line `prompt_near_limit` watches.

**How this differs from what D-0033 removed** (D-0028, D-0030 to D-0032). Those budgets were
measured again every turn and fed the plan straight away. Every turn had a different cap, each
piece had its own cold start, and the patches piled up. Here each reserve changes only at a
discrete event — a card or book edit, a context change, a heavier run of messages. Each change
is at most one rebuild, and in between the cap holds still. Raising the cap costs nothing,
because the block simply has more room to grow. Lowering it costs a rebuild only if the block is
already bigger than the new cap.

**The gate is met** (D-0054). Over 36 generations on a branch of Esin the cap moved seven times,
every move a heavier 19-message run and nothing else, and it held at 3,463 for 28 generations
across three steps, one eviction and a reload — the same cap either side of that reload. The
prompt peaked at 82.7% of its limit against D-0049's 95% under the fixed share, `prompt_near_limit`
never fired, and the derived reserves came within 13–18 tokens of the real prompt at its widest.
Held turns averaged 95.5%, unchanged; the cost lands on step turns, which under P6's smaller
block break earlier in the prompt than P3's did.

---

## 14. Open questions

1. ~~**Text completion or chat completion against oMLX?**~~ **Answered 2026-09-15: text
   completion.** The oMLX profile runs in `tc` mode, so `GENERATE_AFTER_COMBINE_PROMPTS` is the
   primary rewrite hook. See `docs/decisions.md` D-0010.
2. ~~**Willingness to migrate existing lorebooks to outlets?**~~ **Answered 2026-09-16: not
   needed for P1.** The holder and the order-tie fix keep lore stable; outlets only control
   placement, and placement waits on the deferred §6 move. See `docs/decisions.md` D-0035.
3. ~~**Which tier is the memory model, really?**~~ **Answered 2026-09-16: a strong one.** GLM-4.7
   class or better, still chosen through a connection profile, and prompts may assume it. See
   `docs/decisions.md` D-0036.
4. ~~**Does qvink stay installed during P0/P1?**~~ **Answered 2026-09-15: yes, as a summary
   generator only.** Cairn takes both the injection and the blanking threshold; qvink's injection
   is silenced and `exclude_messages_after_threshold` turned off. See `docs/decisions.md` D-0020.
5. ~~**Minimum ST version.**~~ **Answered 2026-09-15: 1.19.0.** Local checkout and server both run
   1.19.0 (`06bde939f`); all outlet and hook citations in section 7 re-verified against it.
