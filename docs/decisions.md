# Decisions

What we decided, when, why, and what would reopen it. Newest first.

A settled decision is not re-litigated (CLAUDE.md §6). New evidence means a new
entry that supersedes the old one — the superseded entry stays, so we can see
what we believed and why it changed.

---

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
- **ST line citations rot across releases.** Four of `DESIGN.md` §7's citations
  moved between 1.18.0 and 1.19.0 while every mechanism stayed intact. The
  mechanism surviving is not evidence the citation did. See D-0009.
