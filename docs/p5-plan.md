# P5 plan — strong canon, and the tokens to pay for it

**Status: PLANNED, 2026-09-18.** Decisions logged as D-0066 to D-0071. Re-examined 2026-09-19
and left unchanged (D-0072); the build order below is staged.

P5 is the phase that answers `DESIGN.md` §13's question: **how do we derive strong, reliable
canon with a model that cannot ingest the whole story** (D-0065). It has two halves that pay for
each other.

- **Reclaim.** The prompt spends 41.7% on nineteen raw messages and 0.3% on the whole story's
  canon. Three levers move that, and all three are SillyTavern settings that ship off.
- **Derive.** Promotion keyed to eviction pressure cannot see what matters (D-0062, D-0064).
  Selection moves off the eviction stream and onto an index built over every summary in the chat.

Neither half is new machinery in the sense P4 was. The reclaim is configuration and timing. The
derive half deletes more code than it adds — the evict-set simulation goes, and with it the
mechanism that caused P4's failure.

**What this phase is not.** Episodes, the entity index and retrieval are not in it. They answer
capacity, and capacity is not the binding constraint (D-0064). The budget priority in
`budgeter.js` is not re-derived here either: reordering the sacrifice while canon is still bad
would protect bad canon and evict real summaries, invisibly (D-0065's sequencing rule).

---

## What the evidence says

### The prompt, measured

Thirty generations, `~/workspaces/cairn-corpus/p4-run-part1.jsonl`, `max_prompt` 23,040:

| reserve | tokens | share |
|---|---|---|
| card | 4,414 | 19.2% |
| lorebook | 4,982 | 21.6% |
| **raw window** | **9,613** (median; 8,987–9,798) | **41.7%** |
| world state | 439 | 1.9% |
| margin | 1,152 | 5.0% |
| **left for the memory block** | **2,440** | **10.6%** |
| — of which canon | 72 | 0.3% |

**The raw window costs 3.9× the entire memory block.** It reserves nineteen messages' worth of
room to carry nineteen messages, while 159 summaries and the whole story's canon share 2,440
tokens. `budget_limited_by` read `room` or `starved` on every generation; the 35% share
(`CAP_FRACTION`, `src/pipeline/budgeter.js:44`) has never once bound.

### Where the card's tokens are

Measured on the run's card (field sizes only; no content in this repo, CLAUDE.md §3.13):

| field | chars | ~tokens |
|---|---|---|
| description | 10,081 | ~2,520 |
| **example dialogue** | **8,704** | **~2,176** |
| first message | 6,112 | ~1,528 |
| personality, scenario, system prompt | 0 | 0 |

`CARD_FIELDS` includes `mesExamples` (`src/prompt/reserves.js:52-54`), so **example dialogue is
49% of the card reserve and 9.4% of the whole prompt.**

### What the raw window is actually for

Raw messages carry tone, style, emotion, pacing and dialogue — how characters speak and act.
They carry almost none of the narrative content, because the summaries already carry that.
Example dialogue carries the same thing, worse: it says how a character *would* speak, in a
situation that never happened, and it does not move as the character develops. Thirty turns of
a character growing into confidence are contradicted by examples that still show them meek.

So once real messages exist in quantity, examples are strictly dominated by them. Before that —
turns two and three, when nobody has said much — they anchor the character profoundly. The
crossover is not subtle and it is not a tuning problem.

The window's *width* is a separate question with a separate answer, and the answer is
experience rather than measurement: hundreds of characters played at a fixed six-to-ten message
lag, with summaries behind, read and play correctly. This repo already decided how to weigh
that kind of evidence — D-0039 kept a summary prompt measured in play over one written to
`DESIGN.md` §12's rules.

### Why the levers are settings, not features

All three reclaims already exist in SillyTavern 1.19.0 (`06bde939f`) and all three ship off:

- **`power_user.strip_examples`** — default `false` (`public/scripts/power-user.js:122`). Blanks
  `mesExamplesArray` outright at `public/script.js:4738-4740`, after the story string is
  rendered. With it off and `pin_examples` off (`power-user.js:121`), ST fits as many examples
  as the leftover context allows (`public/script.js:4960-4970`), so a prompt with room keeps
  all of them.
- **`world_info_budget`** (percent, default 25) and **`world_info_budget_cap`** (absolute
  tokens), declared at `public/scripts/world-info.js:73,81` and applied at `:4736-4741`. ST
  stops adding entries once the running count reaches the budget (`:5061-5070`), walking
  `getSortedEntries()` — ordered by `order` (`:5587`) with the entry's own index as the tiebreak
  (`:5002`), and `ignoreBudget` entries added on top (`:5669`). On the run's lorebook,
  4,982 tokens is 21.6% against a 25% default, so the budget has never bound.
- **The window width** is `RAW_WINDOW` and `STEP` (`src/pipeline/scheduler.js:25,33`), already
  options on `createSeeSaw`, and already the terms `reserves.js` sizes the window from.

**This is the third time in one session that a Cairn idea turned out to be an existing ST
setting**, after `world_info_position.outlet`. CLAUDE.md §2.5 is updated accordingly (D-0066).

### What the window costs at each width

Heaviest consecutive run over the run's chat, 163 visible messages, ~4 chars/token:

| window | heaviest run | ratio to 19 | Cairn's reserve |
|---|---|---|---|
| 19 messages (`RAW_WINDOW` 10, `STEP` 10) | 11,008 | 1.00 | 9,613 |
| **15 messages (8 / 8)** | **8,881** | **0.807** | **~7,758** |
| 11 messages (6 / 6) | 6,663 | 0.605 | ~5,816 |

Median message 453 tokens. The opening message is 1,551 tokens and **does not** pin
`heaviestRun` — heaviest-19 is identical with and without it, so excluding the greeting from the
reserve reclaims nothing. Checked and dropped.

### Why selection is broken, restated

D-0062 found three compounding gaps and D-0064 made them structural. The single sentence that
covers all of them: **P4 treats the prompt block as the source of summaries, and the source is
the chat file.** `pendingCompaction` (`src/pipeline/compactor.js`) takes the block, simulates
the budgeter's drop-loop one step early, and hands the evict-set to the prompt. Meanwhile
`readScenes(chat)` (`src/memory/scenes.js:54`) returns all 159, qvink's and Cairn's alike, and
always could.

Eviction from the *prompt* has nothing to do with availability on *disk*. Once selection reads
the chat instead of the block, generation 1's 108 unread summaries stop being a special case,
and "a local window cannot rank global importance" stops applying because there is no window.

### The shape of the story, and the yardstick

Measured by hand over the run's first 85 summaries (D-0064): 5 introductions or departures,
14 major occurrences, ~66 description or filler — **78% of the volume is the two kinds that
rarely carry a durable fact.** Two long sequences totalling 15 summaries carry one durable fact
between them.

The canon that story actually needs is five lines, ~100 tokens, and it matches the user's own
~90-word telling on the spine. It lives outside this repo (CLAUDE.md §3.13). Against canon's
measured room of 72 it is short by ~1.4×; against the room the reclaim gives it, it is
sixteen times over-provisioned.

### Why summaries cannot be asked to do this themselves

The shipped summary prompt is a deliberate divergence from qvink's, which asks for "a single
concise statement of fact". At several hundred tokens a message that over-condenses: individual
summaries become too terse to read an *arc* across, and the models struggled on them. The
divergence lengthened them to fix that, and qvink's author acknowledged the problem without a
fix for it.

That is the real finding: **a summary has two consumers with different needs and has only ever
had one prompt.** The roleplay model wants a readable narrative bridge for recent history. A
canon deriver wants comparable structure across 159 items. Prose can only carry structure
implicitly, and short prose has nowhere to put it — which is exactly why condensing broke arcs.
Metadata carries it explicitly, at a fixed ~20 tokens, without touching the prose.

So D-0039 stands. Nothing about the summary prompt changes in P5; the pressure that caused the
divergence is relieved rather than reversed (D-0071).

---

## Decisions

**1. Discontinuous work batches to the rebuild turn** (D-0067). A rebuild already breaks the
prefix at the block's head and is already the expensive turn. Everything that changes the stable
part of the prompt happens there and nowhere else: block eviction, canon admission (D-0059),
canon re-derivation, World Info reprioritisation, and the examples latch (which fires on the
first step, itself a head-change). This is the rule that answers "when does X happen" for
anything added later, and it is logged separately from this plan because it outlives the phase.

**2. Example dialogue is dropped once summaries are injected, and never returns** (D-0068).
Cairn sets `power_user.strip_examples` when the chat is past the point where summaries stand in
for messages. The trigger is **derived, never stored**: *does any message behind the raw window
carry a summary*. That is monotonic within a branch, rolls back correctly on a branch or a
swipe, survives a reload and needs no bookkeeping — the same shape as the canon fold (D-0045).

An instantaneous test ("are we injecting summaries right now") is wrong: a summarisation failure
could empty the block for a turn and un-flip it, and flipping examples back and forth destroys
the prefix every time. Latched, it costs exactly one cache miss, once per chat.

**`cardReserve` must read the same latch.** `CARD_FIELDS` includes `mesExamples`, so a flip that
`reserves.js` does not know about reserves 2,176 tokens for text that is not in the prompt, the
cap does not move, and **the entire reclaim disappears into the margin with nothing to see.**
This is the failure most likely to make P5 look like it did nothing.

**3. World Info is capped, add-only between rebuilds, reprioritised at them** (D-0069, scoping
D-0023). The cap and the ordering are ST's (`world_info_budget_cap`, `order`), so Cairn sets
rather than implements them, and `loreBudget` already reads both as live exports (D-0016) so the
reserve tracks the change with no code.

What Cairn adds is the *when*. The holder stays add-only between rebuilds, so a keyword-scan
miss still cannot evict an entry — the thing D-0023 exists to prevent. At a rebuild the held set
is re-evaluated: **union of currently-activated and currently-held, then trimmed to budget by
`order`.** A union rather than a recompute, because a recompute would let a keyword miss that
happens to land on a rebuild turn drop an entry, which is D-0023's failure again, rarer and
harder to catch.

**4. The raw window narrows to `RAW_WINDOW` 8 / `STEP` 8** (D-0068). The window then swings
between 8 and 15 messages, which is the range hundreds of played characters say works. The
reserve is sized by the maximum (`RUN_LENGTH = RAW_WINDOW + STEP − 1`), so both terms have to
come down for the reserve to move.

8/8 rather than 6/6 deliberately: it lands the cap within ~110 tokens of the 35% share, so the
share becomes the binding constraint for the first time without *exceeding* it. 6/6 would
overshoot, which drags D-0038's 35% into a re-derivation this phase is committed to not doing.

**5. Every summary carries an index record** (D-0070). One compact record per summary, written
per-message beside the scene, branching for free. It holds the four-way kind (D-0064) and the
slots — who, what, what lastingly changed, and *because*. Bounded by construction at ~20 tokens,
which is what makes it cheap to write for all 159 and what stops it laundering specifics into
connective tissue the way prose-to-prose compression does.

It rides the existing summarisation queue for new messages. A chat Cairn has not indexed gets a
batched backfill — the same prompt at batch size 10–15 with a little overlap, which is the
selection primitive that already worked in the qvink era (D-0064).

**6. The kind is a sort key, not a gate** (D-0070). A local four-way label is not stable under
hindsight: a purchase is filler until it turns out to be where they settled. If the label
*filters* what the derive pass can see, D-0062's third gap comes straight back at a smaller
scale. The derive pass reads the whole index — 159 records at ~20 tokens is ~3,200, one call —
and ranks it, with the kind as a strong prior it may overrule.

This is also the answer to P5's framing question. The model does not need to ingest the whole
story; it needs to ingest the whole *index*, which is the story at a fifth of the tokens with
the structure made explicit.

**7. Canon is a fixed number of slots, derived, not a bag that is appended to** (D-0071,
superseding D-0055's append-only bag). The durable artefacts are the per-message index records.
Canon is a *pick* over them — a forced budget, "fill exactly N slots", which is calibration by
construction and the thing that stops a small model saying yes to everything.

Three consequences, all of them simplifications:

- **A wrong fact stops being permanent.** It is removable by fixing the record it came from,
  which is what D-0055 could not offer and D-0063 was worried about.
- **The fixed size is a slot count, not a token cap.** The spine does not grow linearly with
  chat length — kinds 1 and 2 are necessarily rare — so a 300-message chat wants 8 to 12 lines,
  not 30. One knob, one sentence (CLAUDE.md §4.15), and leftover tokens fall back to summaries
  rather than being held.
- **A small fixed allocation is not the budget reorder D-0065 forbade.** The forbidden move was
  letting the guard sacrifice summaries to protect canon under pressure, which risks hundreds of
  tokens of real memory. A floor of ~150 tokens risks 0.6% of the prompt.

**8. The eviction trigger is deleted** (D-0071). `pendingCompaction`'s pressure test, evict-set
simulation and `covers` once-per-cycle test all go. What replaces them is the pattern
`pendingScenes` already uses for the summary queue: work is due when a summary has no index
record. Re-derivation is due when the picked set would change, and it runs on a rebuild turn
(decision 1).

**9. No tone or register field on canon** (D-0071). A factually-accurate canon line can still
read far lighter than the truth, and the risk that compression launders a dark story into a
neutral one is real. But `DESIGN.md` §5 excludes mood from Tier 1 on purpose (D-0043: tracking
it gridlocks the roleplay model into a dictated lane), and a permanent register field one tier
up is the same hazard, worse.

The position taken here is that the laundering is a missing `because`, not a missing adjective —
a line reads light *in isolation* and does not read light inside its causal chain. **Genre is
the verifier, not a field**: one cheap call asking what kind of story this is, reading only the
canon, against the same question over a sample of real text. Divergence means selection is
broken, it needs no per-fact ground truth, and it is the signal that actually caught P4's
failure. If the verifier still reads light over a correctly-selected, chained canon, the field
earns its place and this decision reopens.

---

## 1. On the run's chat, after the reclaim

`strip_examples` latched, `world_info_budget_cap` 3,500, `RAW_WINDOW` / `STEP` 8 / 8:

| | today | after |
|---|---|---|
| card | 4,414 | 2,238 |
| lorebook | 4,982 | 3,500 |
| raw window | 9,613 | ~7,758 |
| state + margin | 1,591 | 1,591 |
| **block cap** | **2,440** (`room`) | **~7,953** (`room`, 110 under the share) |
| `stepTokens` | 1,116 | ~893 |
| **`canonCap`** | **72** (`guard`) | **~1,591** (`share`) |
| `sceneCap − floor` ÷ `stepTokens` | 1.007× | ~3.4× |
| rebuild spacing, in messages | ~10 | ~27 |

The block triples. **Canon goes up 22×**, from 72 tokens to ~1,591 against a yardstick that
needs ~100. `canonCap`'s recoupling guard stops binding and `CANON_FRACTION` becomes a real
number for the first time — which is precisely D-0060's stated reopen condition, met by
configuration rather than by tuning.

Recoupling goes from a six-token margin to 3.4×, and rebuilds get **less** frequent per message,
not more: spacing in messages is `STEP × (sceneCap − floor) / stepTokens`, and the cap rises
faster than `STEP` falls. That matters twice, because rebuilds are where the derive pass runs.

**Per derive call:** ~3,200 tokens of index in, ~150 out, once every ~27 messages. Comparable to
one summary call, at a twenty-seventh of the frequency.

---

## 2. Where it lives

- **`store/chat-store.js`:** `readIndex(message)` / `writeIndex(chat, j, record)` beside the
  scene, state and canon pairs, through the same `writeKey` envelope. `STORE_VERSION` 4 with a
  migration from 3, and a v3 fixture kept (CLAUDE.md §8.32).
- **`memory/index-record.js` (new):** the record shape, its caps and its normaliser. Pure.
- **`memory/index-strategy.js` (new):** the batched classify-and-slot prompt and its parser,
  the same boundary `scene-strategy.js`, `state-strategy.js` and `canon-strategy.js` sit on.
  Reuses `model-reply.js`.
- **`memory/canon.js`:** `canonFor(chat)` stops being a fold over written batches and becomes
  the fold over *picked* records. The dedup, the normaliser and the per-message storage stay.
- **`memory/canon-strategy.js`:** the prompt becomes a forced-budget pick over the index, not an
  open-ended "what became permanently true" over an evict-set. `MAX_FACTS_PER_PASS` and the
  per-pass `room` plumbing go; the slot count replaces them.
- **`pipeline/compactor.js`:** `pendingCompaction`'s pressure test, evict-set simulation and
  once-per-cycle test are deleted. What remains is `pendingIndex` (which summaries lack a
  record) and `applyPick`.
- **`prompt/reserves.js`:** `cardReserve` reads the examples latch and drops `mesExamples` from
  `CARD_FIELDS` once it is set. `RUN_LENGTH` follows `RAW_WINDOW` / `STEP` with no change.
- **`prompt/lorebook.js`:** the union-then-trim at a rebuild; add-only between them.
- **`prompt/lore-cap.js` (new):** the `loreCap` setting written into ST's
  `world_info_budget_cap`. Separate, and a setting rather than a derived number, because
  the write persists and is global — there is no session-only form of it (D-0073).
- **`pipeline/scheduler.js`:** `RAW_WINDOW` and `STEP` to 8.
- **`memory/examples.js` (new):** the derived latch and the `strip_examples` write. Small, and
  separate because it is the only module that writes a `power_user` setting.
- **`pipeline/gates.js`, `pipeline/summarizer.js`:** the index job kind and its tally.
- **`ui/inspector.js`, `ui/canon-section.js`, `settings.html`:** the index tally, the latch's
  state in words, and the canon slots.
- **`docs/st-api-surface.md`:** new rows for `power_user.strip_examples`,
  `power_user.pin_examples`, `world_info_budget_cap` and the sorted-trim behaviour, each with
  the `file:line` above (CLAUDE.md §2.7).
- **`index.js` unchanged.**

---

## 3. What the inspector and the log show

- **Log fields:** `index_records`, `index_pending`, `index_kinds` (the four-way counts),
  `canon_slots`, `canon_picked`, `canon_rederived`, `examples_stripped`, `examples_latched_at`,
  `lore_reprioritised`, `lore_dropped`.
- **The checks a run reads:**
  - `examples_stripped` goes false→true exactly once and never back, and `budget_card` falls by
    the card's example tokens on the same turn. **Both, or the reclaim did not happen.**
  - `canon_rederived` is true only on turns where `evicted > 0` or the step reason is
    `first-turn`. Any other turn is decision 1 failing.
  - `lore_dropped` is non-zero only on those same turns.
  - `budget_limited_by` reads `room`, not `starved` — and `budget_cap` lands ~111 under
    the share, so one further reclaim would make the share bind.
  - `memory_canon_limited_by` reads `share`, not `guard`.
- **The inspector** gains an index line (records, pending, the four-way split) and shows the
  examples latch and the lore cap in the reserves breakdown.

---

## 4. Tests that guard the invariants (CLAUDE.md §3.10)

| Invariant | Test |
|---|---|
| The examples latch is monotonic | Over a synthetic chat, the derived latch never goes true→false; a branch before the first summary correctly reads false |
| The latch and the reserve agree | `cardReserve` excludes `mesExamples` exactly when the latch is set; a property test asserts the cap rises by the example tokens |
| Examples flip once | A chat played past the threshold writes `strip_examples` once; replaying further turns writes nothing |
| Lore is add-only between rebuilds | A keyword miss on a non-rebuild turn leaves the held set unchanged |
| Lore trims only at a rebuild, by order | At a rebuild over budget, the lowest-`order` entries go and `ignoreBudget` entries stay |
| A keyword miss at a rebuild does not evict | The union keeps a held entry that did not activate that turn |
| Selection reads the chat, not the block | A chat whose defining summaries were evicted before Cairn was watching still yields them in the pick |
| The kind does not gate | A record labelled filler can still be picked; a fixture asserts it |
| The pick is a forced budget | Over-long and under-long replies are both rejected to exactly N slots |
| Canon is derivable | Removing an index record removes the fact; re-deriving from the same records is stable |
| Canon changes only on a rebuild | A record written between rebuilds leaves the block byte-identical |
| Canon never recouples the see-saw | Property test over random caps and step sizes: `sceneCap ≥ 2 × stepTokens`, or canon is 0 |
| Branch and swipe roll back | Truncating past a record's message removes it, with no rollback code called |
| Store v4 | v1, v2 and v3 fixtures read; v4 round-trips; a future store is refused, not overwritten |
| The parser against mess (§3.12) | Fenced JSON, preamble, truncation mid-array, refusal, a slot over its cap, an unknown kind, `null` slots, a duplicate index |
| Degrade | A failed index or pick writes nothing, the block is unchanged, one toast per streak (CLAUDE.md §4.17) |
| Gates | No index or pick while the handover gate is shut, with no memory profile, in a group chat, or with the setting off |

**Selection quality is a fixture, not a run.** The 159 summaries are on disk and the ground
truth is ~90 words. The regression test is: does the pick over the real index contain the spine?
Zero generations (D-0061).

**Mocks:** `test/mocks/llm.js` gains plausible index and pick replies, including the bad kinds.
Fixtures stay synthetic in content and real in shape (§3.13) — the record format is confirmed
against the real corpus locally, then written fresh.

---

## 5. Cutover, and what we measure

**Step 0 — the labelling pass, before any code.** A frontier model, once, offline, over the
run's 85 real summaries: four-way labels, slot-filled records, a genre read. Saved outside the
repo in `~/workspaces/cairn-corpus`. It produces the regression fixture, the few-shot examples
and the calibration target at once, and it is what confirms the last unmeasured number in this
plan — whether a record really costs ~20 tokens.

**The teacher must not also be the examiner.** The user's ~90-word telling and the ~100-token
extraction are fixed *before* the pass runs and stay the independent measure.

**Then, in order:**

1. The reclaim. It is visible on the first turn, in `budget_card`, `budget_limited_by` and
   `memory_canon_cap`. No play needed to see whether it worked.
2. The index, backfilled over the chat. Counted in records written, not turns.
3. The pick, and the genre verifier against it.

**What needs live play, and it is not much** (D-0061): prefix stability against a real cache,
which needs about three rebuilds, not thirty-five turns. At `RAW_WINDOW` / `STEP` 8/8 with the
reclaimed cap, a rebuild is every ~27 messages — so the run has to be sized off that number
rather than off P4's, and the cycle shrunk first if it comes out long.

**Measure:**
- **The reclaim landed.** `budget_card` falls by ~2,176, `budget_limited_by` reads `room`,
  `memory_canon_cap` reads ~1,591 and `memory_canon_limited_by` reads `share`.
- **The latch fired once.** One transition, one cache miss, and the prefix recovers the turn
  after.
- **Stability.** Held turns against D-0049's 95.9%. Rebuild turns still break at the block's
  head and only there — canon re-derivation must not add a second break.
- **Selection.** Does the pick contain the spine? Against the ~90-word yardstick, not against
  the labelling pass's own output.
- **Genre.** The verifier's read of the canon against its read of real text.
- **No overflow.** `prompt_near_limit` silent.

**The gate.** If the pick over a correct index still misses the spine, the harness is wrong and
P5 stops rather than proceeding on faith (CLAUDE.md §7.29). If the reclaim lands but the prose
degrades at an eight-message floor, that is decision 4 and it reverts on its own — `RAW_WINDOW`
and `STEP` are two numbers.

---

## Build order

Six stages. Each one ends somewhere the tree is green and the work so far stands on its own,
and each one has a check that says whether to carry on. The eleven items are unchanged; the
stages say where to stop and what to look at.

### Stage 0 — Calibrate. No shipped code.

**0a.** The labelling pass (§5 step 0): a frontier model, once, offline, over the run's 85 real
summaries, into `~/workspaces/cairn-corpus`. Four-way labels, slot-filled records, a genre read.
It produces the regression fixture, the few-shot examples and the calibration target at once.

**0b.** While that runs, the three zero-generation checks D-0072 leaves open, against the same
fixture: does the judgment flip at two different lags; are derived boundaries more stable than
importance verdicts; does the `kind` field help the ranker at all versus slots alone.

**Freeze first.** The ~90-word telling and the ~100-token extraction are fixed *before* the pass
runs and stay the independent measure — the teacher must not also be the examiner.

**Check:** a record really costs ~20 tokens. That is the last unmeasured number in this plan,
and every budget in §1 rests on it. If it comes back at 40, the index is ~6,400 tokens and the
one-call claim in D-0070 needs re-arguing before stage 3 is built.

### Stage 1 — The reclaim. No model calls, visible on turn one.

Items 1–3: `memory/examples.js` + `reserves.js` (the derived latch, `cardReserve` reading it,
the `strip_examples` write); `scheduler.js` to `RAW_WINDOW` / `STEP` 8; `prompt/lorebook.js`
union-then-trim at a rebuild, add-only between.

**First, because it is testable with no model and it does not depend on the derive half at
all.** It is also the half that makes the derive half affordable.

**Check** — on the run's chat, on the first turn, no play needed: `budget_card` falls by ~2,176
**and** `examples_stripped` goes true, both or the latch and the reserve disagree and the whole
reclaim vanishes into the margin; `budget_limited_by` reads `room`, not `starved`;
`memory_canon_cap` reads ~1,591 and `memory_canon_limited_by` reads `share`. If the prose degrades at an eight-message
floor, decision 4 reverts on its own — it is two numbers.

### Stage 2 — The record. Storage and parsing, no behaviour change.

Items 4–6: D-0067 as an invariant with a test before anything depends on it; `chat-store.js`
`readIndex` / `writeIndex`, `STORE_VERSION` 4 and its migration, the v4 fixture beside v1–v3;
`index-record.js` and `index-strategy.js` — the shape, the prompt and the parser, tested against
mess before a caller exists.

**Check:** v1–v3 fixtures read, v4 round-trips, a future store is refused rather than
overwritten, and the parser survives the §3.12 mess suite. Nothing about the prompt has changed
yet, so the assembler tests should not have moved.

### Stage 3 — Selection. The phase's actual claim.

Items 7–9: `compactor.js` loses the pressure test, the evict-set simulation and the
once-per-cycle test, and gains `pendingIndex` and `applyPick`; `canon.js` and
`canon-strategy.js` become the forced-budget pick over the index; `gates.js`, `summarizer.js`
and `assembler.js` carry the index job kind, the re-derivation on rebuild turns and the new log
fields.

**This is the gate, and it is a fixture, not a run** (D-0061). Does the pick over the real index
contain the spine, measured against the ~90-word yardstick and not against the labelling pass's
own output? Then the genre verifier: its read of the canon against its read of real text.
**If the pick over a correct index still misses the spine, the harness is wrong and P5 stops
here** rather than proceeding on faith (CLAUDE.md §7.29).

### Stage 4 — Surface.

Item 10: `inspector.js`, `canon-section.js`, `settings.html` — the index tally and its four-way
split, the examples latch in words, the lore cap in the reserves breakdown, the canon slots.

**Check:** the inspector says enough that stage 5's run can be read from the disk log alone,
without a second pair of eyes on the chat while it plays.

### Stage 5 — The run, then the close.

Item 11. **Size the run off rebuilds, not turns:** the run needs about three rebuilds for prefix
stability against a real cache, and at 8/8 with the reclaimed cap a rebuild is every ~27
messages. Count that out of the log before starting, and if it comes out long, shrink the cycle
first (D-0061) — a phase run is hours of an evening and they have been growing.

Then `decisions.md`, `DESIGN.md` §13 P5 as built, `docs/how-it-works.md`,
`docs/st-api-surface.md` (the new rows for `power_user.strip_examples`, `pin_examples`,
`world_info_budget_cap` and the sorted trim, each with its `file:line`), and `CHANGELOG.md`.

---

## Not in P5

- **Episodes, the entity index and retrieval** (tier 4). They answer capacity; capacity is not
  the constraint (D-0064). `entities` stays stored and unread.
- **Re-deriving the budget priority in `budgeter.js`.** D-0065's sequencing rule: after
  selection is demonstrated, with canon's measured value as the input, never before.
- **Re-deriving D-0038's 35% share.** Decision 4 is sized deliberately to land just under it.
- **Changing the summary prompt** (D-0039). The index relieves the pressure that caused the
  divergence; it does not reverse it.
- **A tone or register field on canon** (decision 9), pending the genre verifier.
- **Making the World Info reserve track actuals per turn.** That is what D-0033 removed, and
  D-0052's discrete-event model is the reason the cap holds still between rebuilds.
- **Lowering the window reserve toward `budget_window_now`.** The reserve is the heaviest-ever
  run and the median actual is ~2,400 tokens under it. A percentile instead of a maximum is a
  real reclaim and a separate decision with its own D-0033 hazard.
- **D-0063's qvink adoption.** Checked and it is *not* a prerequisite: `scenes.js` already reads
  both sources into one shape, so the index can be built over qvink's summaries today. It stays
  a small chore, and its strongest argument weakens once canon is re-derivable.
- **Canon in a lorebook**, editing canon from the UI, merge (`DESIGN.md` §8's second
  operation), and group chats.
