# Decisions

What we decided, when, why, and what would reopen it. Newest first.

A settled decision is not re-litigated (CLAUDE.md §6). New evidence means a new
entry that supersedes the old one — the superseded entry stays, so we can see
what we believed and why it changed.

---

## D-0023 — The lorebook block is add-only; a dropout must never evict it
**2026-09-15.** Supersedes the "cache and churn on a cadence" sketch in D-0022:
a cadence is the wrong rule and would make things worse.

**The measurement that settles it.** Nine turns on Esin after the `order` fix,
with two deliberate reference turns run past the see-saw:

```
turn   1      2      3      4      5      6      7      8      9
stab   —    97.9   97.1   14.9   11.4   97.5   36.0   97.3   97.6
wi    29     29     29      0     29     29     29     29     29
```

Turns 8 and 9 matter as much as the collapse does: the prompt re-stabilises
immediately and completely. The see-saw is a **single-turn** event, not a
degradation that lingers — so its cost is exactly one rebuild, and the fix is
worth exactly what D-0019's arithmetic says.

Turns 2/3/6/8/9 confirm the fix — `world_info_tied: 0` throughout, healthy turns
back at ~97%. Turn 7 is the see-saw, breaking **43 chars into
`qvink_memory_short`** — the template header is 39 chars, so the break is on the
first summary, exactly the front-eviction D-0019 predicted. It costs 36% rather
than 13% because the now-stable lore block sits above it and survives.

**But the worst event in the run is not the see-saw.** Turn 4 activated *zero*
entries — nothing in the two-message scan window seeded the recursive cascade —
and the whole 4,232-token lore block vanished. Turn 5 it came back. **One
dropout, two full prompt rebuilds, 14.9% and 11.4%** — worse than the see-saw,
twice over.

**Frequency, simulated over 84 historical turns:** the set is the same 29 entries
on **82 of 84** turns and empty on 2. It moves 4 times, all four being the entry
and exit of a dropout. So World Info causes **4 rebuilds in 84 turns**, and every
one of them is a dropout artifact rather than a real change of what is relevant.

**Why a cadence is wrong:** churning a cached block every see-saw step would cause
~16 rebuilds over the same 84 turns — four times worse than doing nothing. The
block does not need churning. It needs to stop flickering.

**The rule:** the lorebook block is **add-only**. An entry that has activated stays
in; a turn that activates nothing changes nothing. No cadence, no staleness
window, no knob. Bounded by the WI budget (25% of context), and when that binds it
becomes a real eviction — batched at the see-saw, the same discipline as the
memory block (D-0019).

**Why this is ours and not the author's problem:** `sticky` is ST's native "stay
active for N messages" and it is `0` on every entry of every book on this machine.
`order` defaults to a single value, so a hand-made book ties every entry
(Eldoria: 4 of 4). Recursion is a global toggle. Authors configure none of it, so
Cairn cannot depend on it being configured. This stays inside `DESIGN.md` §3.3 —
WI keeps doing retrieval, we take over placement and budgeting; add-only *is*
budgeting.
**It is not "never evict", it is one eviction cadence for the whole prompt.** A
well-made book loses nothing: its entries still leave, just at the see-saw step
rather than on a per-turn keyword scan. So the rule is safe to apply
unconditionally, which is what makes assuming the worst affordable.

**Why carrying stale lore is close to free.** The current prose always supersedes
a lore entry — an entry describing a school's gardens or a villain's history adds
a little background the model can use, and does not compete with what the scene
actually says is happening. The asymmetry is the whole argument: a stale entry
costs a few hundred tokens of context that is usually inert, while evicting it
costs a full prompt rebuild.

**How it is built — outlets are not required.** `WORLDINFO_FORCE_ACTIVATE`
(`world-info.js:1020`) seeds `WorldInfoBuffer.externalActivations`, consulted
during the scan at `:4886`. Forcing the remembered set puts every remembered entry
in **pass 1**, and within a pass `newEntries` is sorted by `sortedEntries` index
(`:4996`), which is deterministic. Order instability comes only from *which
recursion pass* an entry lands in — so forcing the set fixes membership **and**
ordering together, on any book, without touching `order` and without outlets.

**Known gap:** forced entries still go through the probability roll (`:5029`), so
an entry with `probability < 100` re-rolls every turn regardless (Akane: 15 of
110). Those books need the block cached at our level — i.e. outlets — which keeps
D-0021 alive as the belt-and-braces answer rather than the first move.
**Reopens if:** a chat shows entries that genuinely need to leave — a hard scene
or setting change where stale lore actively misleads.

## D-0022 — Symptom A is a lorebook `order` tie, not activation churn
**2026-09-15.** Three turns on Esin, prefix stability **16%, 14.5%** — worse
than the see-saw, and on *every* turn rather than one in five.

**What the log said, immediately:** `divergence_in: null`,
`divergence_in_precision: "none"` — the break was *above every injection*, so no
extension prompt was responsible. `qvink_memory_short` was perfectly stable
across all three turns: identical 38,028 chars at identical offset 31,299. The
destabiliser was entirely the World Info block above it.

**And it was not entries activating and deactivating.** The same 29 entries fired
every turn — identical sets. What changed was their *order*:

```
turn 1: [3, 1, 2, 5, 8, 14, 15, 24, 28, 31, 6, 4, 7, ...]
turn 2: [3, 5, 31, 4, 7, 8, 9, 14, 21, 27, 28, 6, 2, ...]
turn 3: [5, 4, 8, 14, 21, 27, 31, 6, 2, 7, 9, 10, 11, ...]
```

**The mechanism.** ST sorts activated entries with `sortFn = (a, b) => b.order -
a.order` (`world-info.js:88`) — one key, no tiebreak. `Array.prototype.sort` is
stable, so tied entries keep the order of the Map they came from
(`allActivatedEntries`, `:4732`), and that Map's insertion order is *activation*
order: whichever keyword matched first during the scan. That changes as the chat
text changes. Esin's book had **29 of 31 entries tied at `order: 10`**, so 29
entries reshuffled themselves every single turn, above a 38,000-char memory
block, in a prompt already at 84% of `max_context`.

**Fix applied:** distinct `order` for every entry, `order*100 - displayIndex`,
which preserves the existing 10/9/8 tiers and breaks ties by the author's own
display order. Only the `order` field changed; content is byte-identical. The
previous file is kept beside it as `.json.pre-order-fix`.

**Caught mechanically from now on** (CLAUDE.md §9.35): the observer records each
entry's `order`, `src/prompt/lorebook.js` detects ties, and the inspector says so
in words. This is a two-minute fix that cost an afternoon to find, and it is
invisible in play — the chat reads perfectly while the prompt is rebuilt from 14%
every turn.

**What it means for P1:** symptom A has two independent halves. This one — an
under-specified sort key — is not ours to own and cannot be fixed by taking over
placement. The other half, *where* the block sits relative to the memory block,
is D-0021 and still stands.
**Why the entries never fall off — measured over 83 historical turns.** The scan
window is only two messages (`world_info_depth: 2`), which seeds a mean of 4.6
entries. But `world_info_recursive` is **on**, with `world_info_max_recursion_steps:
0` (unlimited): activated content is fed back into the scan buffer, and Esin's
lore cross-references itself densely, so the cascade runs to a closure of **28.3 of
31 entries** — matching the 29 observed live.

That closure is a fixed point of the reference graph, so it is *stable*. The
**path** to it is not: which entries seed the cascade depends on the last two
messages, so activation order changes constantly.

```
consecutive turns with an identical SET:   79/83  (95%)
consecutive turns with an identical ORDER: 23/83  (27%)
```

**This is the whole failure in two numbers.** The set is the same 95% of the time;
the order differs 73% of the time; and with 29 entries tied on `order`, activation
order *was* prompt order. Hence a block rewritten on roughly three turns in four.

**Consequence for P1:** distinct `order` should recover ~95% of turns on its own.
Caching the rendered block (holding it stable across genuine set changes) is worth
the residual ~5%, not the 73% it first appeared to be. Worth building, but after
the assembler, not before.
**Reopens if:** ST gives `sortFn` a deterministic tiebreak, which would make the
whole class go away.

## D-0021 — Lorebook outlets wait on a measurement, not an opinion
**2026-09-15.** `DESIGN.md` §14.2 stays open, but with a named gate: run 8-10
turns on **Esin** and read the stability trace before editing any lorebook.
**Why:** P0 has never measured the lorebook sawtooth. Elizabeth's chat has no
World Info — `world_info: []` on all ten logged turns — so the only sawtooth we
have numbers for is qvink's. Esin's 31 entries all sit at `after_char`, which
lands in the story string *above* the memory block, so an activation flipping
between turns invalidates ~87% of the prompt on a keyword match. That is symptom
A, and it may be messier than the see-saw. Measuring it costs one play session
against a gate we already built; guessing costs 141 entry edits.
**What it turns out to cost, if we do it:** less than it looked. The books are
uniform (Esin 31 × `after_char`, Akane 110 × `before_char`, none constant, none
disabled), migration is two fields per entry, and **one outlet per book is
enough** — entries sharing an `outletName` group into a single block
(`world-info.js:5253`, joined at `script.js:4676`). So it is one decision per
book applied uniformly, scriptable over `data/<user>/worlds/*.json`, not 141
judgment calls. Per-entry outlets only buy differentiated placement.
**Migration hazard:** an entry at position 7 with an empty `outletName` is
silently skipped and its content vanishes from the prompt
(`world-info.js:5249`). Both fields move together or neither does.
**Reopens if:** Esin's trace shows WI churn breaking the prefix — then we
migrate that one book and re-measure.
**Measured 2026-09-15, and the premise was wrong:** the churn is real (14-16%
stability) but it is **not activation churn**, and **outlets would not have fixed
it**. Entries inside one outlet are pushed in the same `sort(sortFn)` iteration
(`world-info.js:5203` → `:5253`), so an unstable intra-block order carries
straight into the outlet. Outlets buy *placement*; they buy nothing about order.
See D-0022 for what the problem actually was. This question is now purely about
placement, and it is no longer urgent.

## D-0020 — Cairn owns the message-blanking threshold
**2026-09-15.** Closes `DESIGN.md` §14.4. qvink stays installed through P1 as a
summary *generator* only: its injection is silenced and
`exclude_messages_after_threshold` is turned off.
**Why:** one prompt, one writer — and blanking and injection are the same
decision seen twice. If Cairn owns the injection threshold while qvink owns the
blanking threshold, the two disagree about which messages are already summarised
and the raw window goes quietly wrong. We have to get here for P2 regardless.
**Sequencing:** the handover happens at P1 step 3, not before, so step 2's
byte-identical check has an unchanged baseline to compare against.
**Reopens if:** never — P2 removes qvink from the path entirely.

## D-0019 — P1's target is *where* the break lands, not moving the block down
**2026-09-15.** Supersedes the reading of `DESIGN.md` §6 that P1 should move the
memory block to `IN_CHAT` at low depth. It should not.
**Why:** turn 6's prompt decomposes as card ≈ 7,687 chars (13%), memory block
≈ 45,000 (77%), raw history ≈ 6,000 (10%) — qvink blanks 96% of the raw history
(149,393 chars of `mes`, ~6,000 sent). The history is the part that *grows*, so
anything placed below it shifts every turn. Moving 77% of the prompt to depth 0
would drop stability to ~13% on **every** turn instead of one in five. The big
block sitting above the growing tail is why quiet turns already hold at 96.7%.
**What is actually broken** is inside the block. The divergence excerpt shows the
block's *first* summary changing — front eviction. Elizabeth's 122 summaries
total 44,323 chars and essentially all of them are injected, against a 7,500-token
`short_term_context_limit` that lagging summaries ride free of
(`SillyTavern-MessageSummarize/index.js:3862`). The window is at the frontier, so
**turn 6 is not an event, it is the new steady state**: one collapse every 10
messages, forever, and it does not improve with chat length.
**The restated target:** keep the block above the history and make a see-saw step
change its *tail* rather than its head. First changed byte moving from the block's
start to its end takes a step turn from 13% to ≈ (7,687+45,000)/58,577 ≈ **90%**.
**What P1 cannot do:** abolish eviction. Bounding by compaction instead of
eviction is P4. P1 decouples the two cadences qvink fuses into one trigger — grow
every step, evict rarely — and that trades **prompt tokens for cache hits**,
since deferring eviction means carrying a block over budget. There is headroom
(`max_context` 24,064, prompt ~12,000). Per §4.15 the slack is derived from
headroom, not exposed as a knob.
**Reopens if:** the raw window stops being blanked, which would make the history
large enough to change the arithmetic.

## D-0018 — P0's gate PASSES: the sawtooth is real
**2026-09-15.** Eight turns on Elizabeth, text completion, Gemma via oMLX,
logged to `cairn-inspector.jsonl`.

```
turn   1      2      3      4      5      6      7      8
stab   —    96.7   97.3   96.8   97.1   13.1   96.6   95.6
```

**What it confirms:** `DESIGN.md` §4 and §6 predicted exactly this shape — a
stable prefix for most turns, collapsing when the see-saw steps. Turn 6 diverges
at character 7,687 of 58,577, i.e. **13% into the prompt**, which is where
qvink's short-term block sits at `IN_PROMPT`. Everything after it — the entire
chat history — is invalidated in one step.

**The number that makes the case:** memory injection is **9,898 of ~12,000
prompt tokens, about 80% of what is sent**, and all of it sits above the history.
Volatility ordering is not a marginal optimisation here; it governs nearly the
whole prompt.

**Also observed:** only one writer, `qvink_memory_short`. `qvink_memory_long` is
empty and therefore absent, which matches `DESIGN.md` §2 — long-term memory there
is a flag on messages, not a store, so it contributes nothing unless messages are
flagged.

**Consequence:** P1 proceeds. Its job is to keep stable content high and move the
volatile block to `IN_CHAT` at low depth, and the prediction to test is that the
collapse turn stops collapsing.

## D-0017 — The inspector log uses ST's Data Bank endpoint
**2026-09-15.** Snapshots are written to
`data/<user>/user/files/cairn-inspector.jsonl` via `POST /api/files/upload`
(`src/endpoints/files.js:28`), not a server plugin and not `chatMetadata`.
**Why:** reading a run off disk beats copying numbers out of the panel, and
`/api/files/upload` already does exactly this for the Data Bank — rule §2.5, check
what ST has before inventing. A server plugin would double the repo the way
Character Tools did; `chatMetadata` would write diagnostics into the chat file
and pollute the corpus.
**Consequence:** the endpoint replaces whole files rather than appending, so we
rewrite the full run each time, debounced. Fine at P0 scale; revisit if a session
ever gets long enough for the rewrite to matter.
**Reopens if:** we need append semantics, or logging outgrows a diagnostic.

## D-0016 — `getContext()` is a snapshot; never hold one across turns
**2026-09-15.** Found in the first real session: the inspector reported "0
injections" on every turn while qvink was plainly injecting two blocks.
**Why:** `SillyTavern.getContext()` copies primitives and captures object
references at call time. ST reassigns `extension_prompts` in `clearChat`
(`public/script.js:1590`) and `chat_metadata` in ten places including
`updateChatMetadata` (`:8979`). Cairn captured a context at extension load —
before any chat was open — and read that orphaned object forever after. Nothing
errored; the number was just quietly, plausibly wrong, which is the dangerous
kind.
**How it is prevented now:** `createObserver` takes a *getter*, not a context,
and calls it per observation. Two tests replace the context between turns and
assert the observer follows.
**Reopens if:** ST makes the context live.

## D-0015 — The stability baseline is per-API, not per-chat
**2026-09-15.** Found in the first minutes of real use: two GLM turns then two
Gemma turns on the same chat.
**Why:** a text-completion prompt is a string and a chat-completion prompt is a
flattened message array. They share almost no prefix, so comparing across the
boundary reports ~0% stability — which reads exactly like the failure the meter
exists to detect, and is not one. The first turn on a newly-used API path now
correctly reports "no baseline".
**Reopens if:** never; the two paths are genuinely incomparable.

## D-0014 — WTracker stays uninstalled for the P0 baseline
**2026-09-15.** qvink 1.3.29 is installed and configured in lockstep with the
remote server; WTracker/WTrackerLite is not, and is not being added.
**Why:** three reasons, in order. The baseline has to be what Matt actually
plays, or the numbers describe a fiction. Upstream WTracker likely still carries
the `structuredClone` bug that WTrackerLite fixed on 2026-08-17, so installing it
would silently strip qvink's ignore flags and we would be measuring that bug
rather than the design question. And we do not need it running to learn its shape
— the corpus chats already carry its data in `extra` (60 of Elizabeth's 123
messages).
**Reopens if:** P3, which replaces the world-state tier. Then it is WTrackerLite
— Matt's fixed fork, on disk at 0.2.0 — never upstream WTracker.

## D-0013 — Rule references are machine-checked too
**2026-09-15.** `make verify-rules` resolves every `CLAUDE.md §N.M` citation in
the repo against the rules file, and the gate runs it.
**Why:** inserting rule 14 shifted six later rules and silently invalidated seven
references in code comments. Numbered rules are a good interface and a fragile
one. CLAUDE.md §9.35 says a mistake that can be caught mechanically should be.
**Reopens if:** the rules stop being numbered.

## D-0012 — Fixtures are synthetic in content, real in shape
**2026-09-15.** Refines CLAUDE.md §3.13. The committed fixture is still written
fresh with invented content, but its *shape* is confirmed against real captured
chats first, and the fixture says which real shape it mirrors.
**Why:** a public repo cannot hold real chat logs, but a fixture whose structure
was invented only proves the test agrees with our guess. Reading the three
imported chats immediately produced a shape no invented fixture would have: every
message carries `extra.qvink_memory` with eleven fields, and WTracker data sits
in both `extra` and `chat_metadata`. The corpus lives outside the repo at
`~/workspaces/cairn-corpus`.
**Reopens if:** never — the two halves of this rule are independent and both hold.

## D-0011 — The inspector lives in the settings drawer for now
**2026-09-15.** Not a floating always-on-screen panel, despite `DESIGN.md` §10
asking for "visible at all times".
**Why:** a draggable panel is real UI work and P0's job is to prove the theory,
not to be comfortable. The drawer updates live and costs nothing.
**Reopens if:** tuning in real play turns out to need the numbers on screen
while the drawer is shut — which is likely, and is a small change when it comes.

## D-0010 — Text completion is the primary rewrite path
**2026-09-15.** Supersedes the open question in `DESIGN.md` §14.1.
**Why:** the roleplay profile is Gemma-4-31B via oMLX in `tc` mode against a
local endpoint, so `GENERATE_AFTER_COMBINE_PROMPTS` is the hook that matters for
the prompt Cairn cares about. The memory profile is GLM 4.7 via OpenRouter in
`cc` mode, which is a `ConnectionManagerRequestService` call, not a prompt hook.
P0 observes both paths because observing is free and the RP backend may change.
**Reopens if:** the roleplay model moves to a chat-completion backend, which
makes `CHAT_COMPLETION_PROMPT_READY` primary instead.

## D-0009 — Local ST-citation verifier rather than trust
**2026-09-15.** `make verify-st` machine-checks every `file:line` in
`docs/st-api-surface.md` against a local checkout. CI does not run it; there is
no ST there.
**Why:** on its first run it caught `outletName`, cited at `world-info.js:4028`
from the 1.18.0 checkout and actually at `:4108` in 1.19.0. Citations rot
silently across ST releases, and a rotted citation reads exactly like a good one.
**Reopens if:** ST ships a stable public API surface for extensions that makes
line citations unnecessary.

## D-0008 — Zero runtime dependencies, no build step
**2026-09-15.** Raw browser ES modules, loaded as listed in `manifest.json`.
Dev dependencies (eslint, vitest) only.
**Why:** SillyTavern house style, and it keeps install to a git clone. The
4,980-line `index.js` in qvink is a choice, not a constraint — multiple modules
cost nothing (`DESIGN.md` §2).
**Reopens if:** we need something that genuinely cannot be written by hand.

## D-0007 — Cooperate with lorebooks via `world_info_position.outlet`
**2026-09-15.** World Info keeps doing retrieval; Cairn takes over placement and
budgeting, routing entries through named outlets it places itself.
**Why:** natively supported since ST added outlets, so no fork and no second
competing injector (`DESIGN.md` §7). In 1.19.0 `outletName` is a declared entry
field with autocomplete in the WI editor (`world-info.js:4108`, `:3691`), so
migrating an entry is a supported UI edit, not a hand-hacked JSON field.
**Reopens if:** the outlet mechanism is removed or changes semantics.

## D-0006 — The memory model is never the roleplay model
**2026-09-15.** A separate connection profile is mandatory. Cairn does nothing
until one is selected.
**Why:** RP models are tuned to be evocative, which fights summarisation in every
observed case (`DESIGN.md` §3.1). Making it optional means most users run the
broken configuration.
**Reopens if:** a model demonstrably does both well — test before believing it.

## D-0005 — Build rather than extend an existing extension
**2026-09-15.** New extension rather than a fork of qvink / WTrackerLite /
Summaryception.
**Why:** the data model is wrong in all three — memory as a compressed
transcript rather than as state — and qvink's long-term memory is a flag on
messages, not a store, so there is nothing there to compact (`DESIGN.md` §2).
**Reopens if:** never, realistically; the analysis is in `DESIGN.md` §2 with
specifics.

## D-0004 — Internal slug is `cairn`
**2026-09-15.** `cairn` is the CSS prefix, `extension_settings` key, log
namespace, and `message.extra` key. Display name is `Cairn-Memory`.
**Why:** one short lowercase token, typed constantly, no case or hyphen handling
in selectors. The display name carries the discoverability.
**Reopens if:** it collides with another extension's settings key.

## D-0003 — Minimum SillyTavern is 1.19.0
**2026-09-15.** Supersedes the open question in `DESIGN.md` §14.5.
**Why:** local checkout and the server both run 1.19.0 (`06bde939f`). The outlet
mechanism gates the floor and all 29 citations re-verify against it.
**Reopens if:** we drop the outlet dependency, or a needed API lands later.

## D-0002 — Repo is `cairn-memory`, without the `SillyTavern-` prefix
**2026-09-15.** Against ecosystem convention, deliberately.
**Why:** the prefix buys discoverability we do not need yet, and the
`manifest.json` `display_name` already carries the name inside ST.
**Reopens if:** we publish for other people to find.

## D-0001 — The extension is called Cairn-Memory
**2026-09-15.** Shortlist and rationale in `docs/names.md`, which is now closed.
**Why:** stacked stones marking a trail — sparse markers standing in for a whole
route, which is the episode tier exactly. Short, no baggage.
**Reopens if:** a collision turns up in the ST ecosystem.

---

## Lessons

Things that cost us time once. We pay for them once (CLAUDE.md §6.27).

- **`structuredClone` silently drops Symbol keys.** WTrackerLite's interceptor
  cloned the chat array and destroyed qvink's `extra[Symbol.for('ignore')]`
  flags with no error. Full raw history went to the model, the prompt pinned at
  `max_context`, and oMLX common prefix fell to ~25–55% per turn. Diagnosed
  forensically weeks later; fixed 2026-08-17. **Never clone chat messages in an
  interceptor** — mutate in place, collect indexes first, splice
  highest-to-lowest (`DESIGN.md` §9).
- **A held `getContext()` goes stale silently.** See D-0016. The general shape:
  ST's module-level state is `let`, not `const`, and reassignment is invisible to
  anything holding the old reference. Read `extensionPrompts`, `chatMetadata` and
  `maxContext` at the point of use, every time.
- **Object spread preserves Symbol keys; `structuredClone` does not.** The safe
  way to flag a message in an interceptor is
  `chat[i] = { ...chat[i], extra: { ...chat[i].extra, [IGNORE]: true } }` —
  it replaces the element rather than writing through the shared `extra`, and it
  carries an earlier interceptor's Symbol flags forward. This matters because
  `coreChat` entries are fresh objects that **share `extra` by reference** with
  the real chat (`public/script.js:4539`), so mutating `extra` in place persists
  into the saved chat file. qvink reaches for `structuredClone` here
  (`index.js:3993`) and gets away with it only because it runs first.
- **ST line citations rot across releases.** Four of `DESIGN.md` §7's citations
  moved between 1.18.0 and 1.19.0 while every mechanism stayed intact. The
  mechanism surviving is not evidence the citation did. See D-0009.
