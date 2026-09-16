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
Small, structured, **continuously rewritten**. Location, time, who is present, per-character mood
/ intent / physical condition, relationship axes, open threads, last significant shift.
~300-600 tokens. Bounded **by design**, not by eviction. Never grows.

Generated as a **diff against the previous state** plus the new messages, not regenerated from
scratch — cheaper, more stable, and a small model can do it. Stored per-message in `extra` so it
branches correctly.

This is the piece no existing extension has in combination with the others, and it is what
actually kills the holes: state is always current, so it cannot have gaps.

### Tier 2 — Scene summaries
The see-saw layer. Rolling prose summarisation of messages falling out of the raw window,
delta-style (Summaryception's good idea). Bounded by token budget, evicted by recency.
Compacted under pressure, never silently rolled up.

### Tier 3 — Canon
Things that became permanently true. One-liners, append-only, tagged with entities.
"Her brother is dead." "They kissed at the lighthouse." Absurdly cheap per item. This is the
store that *receives* promotions, and long-term it is where generated lorebook entries would
come from.

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
   depth 2:  [ world state ]                   volatility: every N turns
   depth 0:  [ retrieved episodes + dynamic WI ]  volatility: per turn
```

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

---

## 9. Branching, swipes and durability

ST branches and swipes freely. A linear memory log breaks under both.

- **Per-message data in `message.extra`** branches for free. WTrackerLite already proves this.
  Everything that can be per-message should be.
- **Anything genuinely global** (canon, episode archive, entity index) lives in `chatMetadata`
  and needs **explicit checkpointing keyed to message index**, with rollback on branch/swipe.
  This is the single most likely source of quiet wrongness in the whole system. Design it in
  from turn one; do not bolt it on.
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

**P4 — Canon + compactor.** Promote / merge / drop under budget pressure. Fixes symptom B.

**P5 — Episodes + entity retrieval.** The long tail.

**P6 — A budget worked out from the chat.** Until P6, the block's cap is a fixed 35% of the max
prompt (`docs/decisions.md` D-0038). P6 works the cap out from the chat's own parts, so the
block uses the room the chat actually leaves, and P4 and P5 get more space to work with. The
prompt splits into four parts:

- **Fixed:** system prompt, card, persona and example messages. These can be counted directly,
  and they only change when the user edits them.
- **World Info:** a reserve that starts at a floor, with no reserve for a chat that has no
  lorebook. It is raised only when observed lore goes past it.
- **Raw window:** the see-saw's most messages times the measured average message length, plus
  a buffer, with a floor it never goes below.
- **Memory block:** whatever is left, minus a safety margin.

If a check shows the next turn would overflow, Cairn pauses and works the budget out again.

**How this differs from what D-0033 removed** (D-0028, D-0030 to D-0032). Those budgets were
measured again every turn and fed the plan straight away. Every turn had a different cap, each
piece had its own cold start, and the patches piled up. In P6, each reserve changes only at a
discrete event, when a ceiling is crossed. Each change is at most one rebuild, and in between,
the cap holds still. Raising the cap costs nothing, because the block simply has more room to
grow. Lowering it costs a rebuild only if the block is already bigger than the new cap. P6 has
to show, with a trace, that the cap holds still between those events. If it can't, D-0033
stands.

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
