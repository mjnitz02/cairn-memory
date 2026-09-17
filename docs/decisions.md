# Decisions

What we decided, when, why, and what would reopen it. Newest first.

A settled decision is not re-litigated (CLAUDE.md §6). New evidence means a new
entry that supersedes the old one — the superseded entry stays, so we can see
what we believed and why it changed.

---

## D-0052 — The memory cap is the smaller of 35% and what the chat leaves
**2026-09-17.** P6, from `docs/p6-plan.md`. Supersedes the fixed share in D-0038,
which stands as the ceiling and as the fallback.

**The decision.** `cap = min(35% of the max prompt, the room)`, never below 10%.

```
room = max prompt − card − lore − raw window − world state − margin
```

Each reserve is worked out from the chat and the settings, and each is an *upper
bound*:

| Reserve | Worked out from | Esin |
|---|---|---|
| Card | The card fields in the story string, plus the system prompt ST would use | 4,500 |
| Lore | ST's World Info budget, or every enabled entry if they come to less | ~5,000 |
| Raw window | The heaviest 19 consecutive visible messages the chat has had | 7,968 |
| World state | Its schema bound, 0 while the state is off or a WTracker is loaded | 439 |
| Margin | 5% of the max prompt | 1,152 |

On Esin that is a cap of about 4,000 against a share of 8,063, so the block holds
33–38 summaries and rebuilds about every two steps instead of four.

**Why nothing is measured.** D-0028 and D-0030–D-0032 measured the rest of the
prompt and fed it into the next plan; each piece had its own cold start, errors
fed forward, and a reload took until turn 4 to settle. D-0033 removed all of it.
Working each reserve out from the chat gives the same numbers with no cold start,
nothing stored and no schema change — and the cap stays a function of the chat,
so the same chat always gets the same block.

**19 is `RAW_WINDOW + STEP − 1`**, the widest the window gets before a step. Taking
the heaviest such run in the whole chat needs no guess about message length, and
over a growing chat it can only rise — so the cap moves on the turn a heavier run
is written and on no other turn. A deletion or a branch can lower it, which raises
the cap, and a rise costs nothing.

**The margin turns `prompt_near_limit` into a check.** 5% is the complement of
`NEAR_LIMIT_FRACTION`. Every other reserve is an upper bound, so a prompt at its
fullest should land under that line; the warning firing now means a reserve
missed something rather than that the cap was optimistic.

**What it cannot see:** other extensions' injections, the story string's own
wording, and the instruct wrappers (about 10 tokens a message). The margin covers
them, and `budget_window_now` in the log says what it actually had to cover.

**Degrading.** A failed world-info import or a card that will not read gives
`limitedBy: 'unknown'` and D-0038's fixed share, with one console warning. A
reserve of zero would be the dangerous guess, not the safe one.

**What this replaces.** `DESIGN.md` §13's P6 reserved lore by *watching* it and
re-ran the budget when a check showed an overflow. Both depended on what had been
seen; neither is needed.

**The cost, stated plainly.** On a 24k context with a 9k card and lorebook the
block gets about 4,000 tokens. Today the same space is taken silently from the
card's example messages and the oldest raw messages (`script.js:4920`, `:4959`).
P4's compaction is what gives the dropped summaries somewhere to go.

**Reopens if:** the run shows the cap moving on turns §8 of the plan does not
name — then D-0038's fixed share stands and P6 is abandoned. Raising the ceiling
above 35% is a separate decision, for when P4 and P5 have something to fill it
with.

---

## D-0051 — P6 comes before P4: the fixed cap is bigger than the room
**2026-09-17.** Reorders `DESIGN.md` §13. The plan is `docs/p6-plan.md`.

**The evidence.** The P3 branch's log, with real-length user messages at a 23,040
max prompt. On the turn before the second step the prompt was 21,964 with a
4,945-token block, so the rest came to 17,019: card and lore about 9,080, and a
19-message raw window about 7,860. That leaves about 6,000 for the block at its
fullest, against D-0038's cap of 8,063. The block is 6,017, and a step adds about
1,050, so the cycle after the next step overflows by about 1,000. Text completion
then drops unpinned examples and the oldest raw messages without telling Cairn
(`script.js:4920`, `:4960`). The cap was never reached by growth: only the first
turn after a reload evicted (33 summaries).

**Why P6 first.** P4 compacts under budget pressure, and on this chat the cap never
feels pressure before ST trims the prompt. Compaction would fire only on reloads,
and canon added to the block would make the overflow worse.

**Scope, from Matt.** Keep things as static as possible and assume as little as
possible: improve on the fixed 35%, don't build a dynamic estimate. The see-saw's
`RAW_WINDOW` and `STEP` stay as D-0034 measured them. P4 and P5 follow P6.

**Reopens if:** P6's run shows the cap can't hold still between events (§13's own
gate), which would leave D-0038 standing and send P4 ahead on the fixed share.

---

## D-0050 — Any message can be summarised on request, and the chat shows what the prompt reads
**2026-09-17.** Quality-of-life changes before P4.

**The decision.**
- **Summarise with Cairn** in a message's actions menu sends it again, whatever the
  queue would do with it. It replaces a summary (Cairn's or Qvink's) only on success,
  and it resets the failure count on a message the queue gave up on. It works on
  the last message and on messages older than Qvink's newest summary, which the queue
  skips (D-0037). It sends the same request, goes ahead of the queue, and waits
  on the same gates.
- **Qvink's summaries are shown** as `Qvink:` while Qvink isn't loaded or has
  `display_memories` off, so a summary is never drawn twice. The chat shows what
  `readScenes` gives the block, so a stale Cairn summary hides the Qvink one too.
- **Every message with a usable state** shows it in a collapsed **World state**
  section, rendered by `renderState`, so what you see matches the prompt text.
  Hidden while the switch is off or a WTracker is loaded. No setting.

**Why the queue's limits don't apply.** The queue skips the last message because
it may still change, and messages before Qvink's newest summary so it never adds
scenes into the middle of the block. Both rules keep automatic work from being
wasted or moving the cache without being asked. A click is asked. A summary of
the last message goes stale by its hash if a swipe or edit changes the text.

**Costs we accept.** Replacing a summary already in the block changes the block
from that summary on, so the next prompt misses the cache from there, as an edit
would. A summary added before Qvink's newest one adds a scene mid-block. A failed
request toasts every time, since you asked for it, but doesn't end the run.

**Reopens if:** a regenerate button for the state is wanted. It only makes sense
on the newest state, because each state patches the one before it.

---

## D-0049 — P3 is measured and closed: Cairn keeps the world state
**2026-09-17.** Closes P3 (`DESIGN.md` §13). The plan's decisions are D-0042 to
D-0046, the run added D-0047 and D-0048, and the plan page is deleted.

**The run.** A branch of Esin forked at message 84, on text completion. 25
generations: 20 with the state on, then 5 with it off as the control. The user
messages were written with ST's **Impersonate**, about 2,000 characters each, with
a few 8-character "continue" messages among them. So unlike D-0041's runs, the
raw window held real-length user messages. Stability is the share of each prompt
already cached.

```
state on                               n   stability    break
the state didn't move                  9   96.9–97.7    just after cairn_state
the state moved forward a reply        7   92.1–95.7    where the state used to be
step                                   2   58.6, 65.1   the old block's tail
swipe                                  1   100          none

state off (the control)
normal turns and one impersonate       4   97.3–97.7    the newest message
```

- **The state costs about 1.6 points.** Held generations averaged 95.9% with the
  state on and 97.5% with it off. D-0042 predicted about 2.2 points (≈95%) from
  corpus sizes. The plan's "about 0.5 points on Esin" assumed its 2-token
  "continue" messages, which this run didn't use.
- **The cost lands on whichever generation first carries the moved state.** With
  Impersonate, that's usually the impersonate: it re-reads from the state's old
  position, and the next normal turn breaks just after the state. Without it, the
  normal turn pays.
- **A step still breaks at the block's tail.** Both steps broke at the end of the
  old block (20,031 and 25,054 characters). The two figures differ by how big the
  block was, not by the state.
- **Depth** was 1 on every normal turn, 0 or 2 on impersonates, and 3 when a turn
  went out within seconds of a reply, before its update was written. The state
  stayed after the messages it had read every time.
- **Updates:** 13 written, plus the cold start before the log began, 0 failures, 0
  dropped fields. About 1,300 tokens in and 59 out each, 2.5–15.2 s, 6.9 s on
  average. The state was 50–77 tokens, median 57, against a bound of about 330.
- **Summaries:** 23 requests, 22 written, and 1 error, retried and written.
- **Overlap:** a state request was out during 3 of 25 generations, all sent within
  seconds of a reply. A summary request was out during 6.
- **One writer** on every generation.

**Rollback held.**
- **Swipe.** The swipe generation matched the original's prompt byte for byte, with
  the previous state at depth 1, and the new swipe got its own state 6 s later.
  ST's copy of the new swipe's `extra` still holds the old swipe's state until the
  next swipe away overwrites it (`script.js:10338-10340` → `:6939`), and a state is
  only used if it matches its message.
- **Edit.** After an edit to the newest reply, the next generation used the state
  before it (depth 2), a second update rewrote it 42 s after the reply, and the
  turn after that used the new state at depth 1.
- **The control.** Switching the state off stopped its requests, and the prompt
  broke once where the state had been (95.1%).

**Found in the run.**
- **The first build left out hair and weather** (D-0048).
- **The prompt reached 95% of its limit** once: 21,964 of 23,040 tokens, the turn
  before the second step, which brought it down to 18,737. With real-length user
  messages the raw window is widest just before a step. Nothing overflowed. It is
  input for P6.
- **The log doesn't say what kind of generation it was.** Impersonates, continues
  and swipes were told apart from the chat file's timestamps.

**What this run cannot show.** Whether the state helps the story. Quality is
deferred with the summaries' (D-0041).

---

## D-0048 — A first build records everything the messages establish
**2026-09-17.** Found in the P3 run. Amends D-0044's prompt.

**What went wrong.** The run's first build read 6 messages into an empty record and
wrote a location and two outfits. It left out hair and weather, which
WTrackerLite's tracker on the same message had for all three characters. Nothing
was dropped: the model never wrote them. The prompt only asks for changes
("Include only what the messages change", "When unsure whether something changed,
leave it out"), and from an empty record, a hairstyle set earlier and mentioned
once in passing doesn't read as a change.

**The decision.** When the state renders to nothing, the prompt swaps those two
lines for a first-build pair: fill in every field the messages and earlier events
establish, including hair and outfit for each character present, and leave out
what's unsure to still hold at the end. Once the record holds anything, updates
keep the changes-only wording. One template with two `{{#if}}` branches, so a
state still stores one prompt hash.

**Why it matters more than one turn.** The tier exists to carry a hairstyle
forward after the story changed it. A first build that skips it waits for the
story to mention hair again. In the run, hair arrived three replies later.

**Cost we accept.** A change made before the 6-message window is still missed.
Reading further back on a first build would fix that, at the cost of a bigger
request.

**Reopens if:** first builds still miss fields the messages state, or updates start
rewording fields they shouldn't touch.

---

## D-0047 — The state doesn't follow the handover gate
**2026-09-17.** Asked during the P3 run.

**The decision.** Whether the state goes into the prompt depends only on **Keep the
world state** and the WTracker check (D-0046), not on whether the handover gate
lets Cairn write the memory block (D-0027). When the gate is shut, the state is
still placed, and a state is still left out when it's older than the step Cairn
has planned.

**Why.** Each setting controls one thing, which is what the settings text already
says. The gate is shut in two cases. With qvink still writing its block, its
summaries and Cairn's state don't overlap, because qvink keeps no state. With
**Write the memory block** off, tying the state to it would switch off two things
at once, and that setting exists so the block can be measured on its own.

**Reopens if:** a summarising extension that also keeps state, so the gate's "who
writes" question covers the state too.

---

## D-0046 — Cairn reads nothing from WTracker, and waits while one is loaded
**2026-09-16.** P3 plan decision 8.

**The decision.** No migration from `extra.WTrackerLite` or `extra.WTracker`. While
either extension is loaded, under `third-party/SillyTavern-WTrackerLite` or
`third-party/SillyTavern-WTracker`, Cairn neither updates nor places the state, and
the panel names the one it's waiting on.

**Why not migrate.** Only Esin had the data, its newest tracker was message 84, and
the live chat was about 60 messages past it. A state that old is the wrong seed,
and the schema differs. A cold start from recent messages costs one request.

**Why ask whether it's loaded.** Two state writers in one prompt is the problem this
project exists to end. The check reads what's loaded, not the extension's
settings, because settings outlive a disabled extension (D-0040).

**Reopens if:** someone needs to keep a long WTracker history, or a tracker installs
under another folder name.

---

## D-0045 — Each state stands alone and hashes what it read; the newest valid one wins
**2026-09-16.** P3 plan decision 7 and §1, §5.

**The decision.** A full state snapshot is stored on the newest message the update
read, as `extra.cairn.state`: `value`, `read` (how many messages it read, ending at
its own, hidden ones skipped), `hash` (those messages as `name: mes`), `changed`
(kinds, never content), `prompt` and `at`. A state counts only while its range still
hashes the same. The reader walks back from the newest message in the prompt to the
first valid state. Store version 2; the migration from v1 is a no-op, since v1 has
no state.

**Why a snapshot, not a chain of patches.** A deletion, a branch
(`bookmarks.js:173`) or a stale state in the middle never breaks the ones around
it. It costs about 1 KB per reply in the chat file.

**Why `read`, not an index.** Deleting an earlier message shifts indexes, but not a
count that ends at the state's own message.

**Rollback needs no code.** Editing, hiding, unhiding or deleting a message in range,
or swiping the state's own message, makes it stale, and the one before it is used
until the queue catches up. Swiping back restores the old swipe's `extra`
(`script.js:7015`), state included.

**No cascade.** An edit to an older message invalidates only the state that read it.
Later states were built on the old text and stay valid. The most common edit is to
the newest reply, and a cascade would redo every later state over a story that has
usually overwritten that fact since. *Cost:* a fact from an edited old message stays
wrong until the story touches that field again.

**Failure writes nothing** (CLAUDE.md §4.17). The previous valid state stays in the
prompt. After 3 failures on the same read range, the state gives up on it for the
session; a new message or an edit changes the range. Each kind keeps its own streak
(`pipeline/tally.js`), so a failing state prompt never starves the summaries.

**Consequence.** An older Cairn reads a v2 store as `future` and stops reading its
own summaries until upgraded.

**Reopens if:** stale states from old edits turn up in play often enough to want the
cascade.

---

## D-0044 — One state update per reply: a JSON merge patch from a built-in prompt
**2026-09-16.** P3 plan decisions 2, 3, 5 and 6, §2 and §3.

**The decision.** After each reply, and as soon as a message is edited, the queue
brings the state up to date through the newest message, the latest reply included.
The state job runs first in the run, then the summaries, one request at a time. It
reads every message since the last valid state, at most the newest 6; a cold start
or catch-up with more also gets the 5 scenes before them as background. The model
replies with a JSON Merge Patch (RFC 7386) against the current state. The prompt is
built in, and there's one setting, **Keep the world state**, on by default and
inert until a memory profile is chosen.

**Why include the latest reply.** The tier exists to be current, and the reply the
user answers is where the scene moved. It also keeps the state at depth 1
(D-0042). *Cost:* a swipe, continue or edit of the reply wastes one request, which
the hash catches (D-0045).

**Why every reply.** Under D-0042, the placement costs the same every turn whatever
the cadence, so updating every N replies only saves requests that cost almost
nothing, and leaves the state up to N replies behind.

**Why a patch.** Fields the patch leaves out keep their bytes, so rewording can't
creep in: Elizabeth's regenerate-everything tracker reworded weather in 7 of its 10
changes. `{}` means no change, which the log needs, and a model that sends the whole
state anyway still merges correctly.

**Why JSON, unlike D-0037.** ST returns no finish reason (`custom-request.js:60`),
and cut-off JSON fails to parse. The parser strips `<think>` blocks and fences
(shared with summaries, `memory/model-reply.js`), takes the first bracketed span
that parses, and rejects a reply that is empty, a refusal, not JSON or not an
object. A field that breaks the schema (unknown key, wrong type, over its cap, a
6th character) is dropped and counted, never clamped. What changed is worked out by
comparing before and after the merge, not taken from the model (CLAUDE.md §4.18).

**Why not editable.** The prompt is tied to the schema and the parser, so an edit can
only break them. D-0039's reasons for the summary prompt, a prompt proven in play and
pasting in qvink's, don't apply.

**Reopens if:** updates fail or drop fields often in play, or the per-reply cost stops
being negligible.

---

## D-0043 — The world state is WTrackerLite's fields, and nothing else
**2026-09-16.** P3 plan decision 4. Revised before release: the first draft also had
`time`, per-character `appearance`, `condition`, `mood` and `intent`, and `threads`.

**The decision.**

```js
{
  location: string,    // ≤ 120 chars, most specific place first
  weather: string,     // ≤ 80, or indoor conditions
  characters: {        // ≤ 5 present characters, keyed by name (≤ 40)
    [name]: { hair: string /* ≤ 80 */, outfit: string /* ≤ 120 */ },
  },
}
```

It renders as labelled lines under `[Current scene]`, in fixed order, with a
`Present:` line so a character with nothing recorded still counts as there. The
widest state renders to about 1,750 characters, about 330 tokens. A typical
two-character state is about 55.

**What the tier is for** (Matt, from hundreds of roleplays). A card's description
fixes facts like "wears a combat uniform". When the story changes them, summaries
tend to leave the change out, and ten messages later the character is wiping sweat
off their combat uniform in the gym. The state carries the latest hair and outfit
forward until they change again. Location and who is present cement that.

**Why nothing more.** Mood, time of day and plot are dynamic, and the card already
gives the roleplay model a range to evolve. Recording them gridlocks it: it
narrates the dictated lane, keeps characters frozen in a recorded mood, and won't
move time forward until the user does. The memory model would be steering the
story. Upstream WTracker tracked all of that, and Matt's WTrackerLite fork cut it
down to these fields.

**Caps from the corpus.** WTrackerLite-shaped trackers peak at hair 60, outfit 109,
location 81 and weather 69 characters, and at 5 characters present. Only Risa's
verbose upstream schema passes a cap. The bound sits outside the block's 35% cap
(D-0038); `prompt_near_limit` still covers the whole prompt.

**Reopens if:** a stuck-hard-fact case from play that these fields can't hold. A
might-help field isn't one.

---

## D-0042 — The world state sits just after the newest message it read
**2026-09-16.** P3 plan decision 1 and §4. Supersedes `DESIGN.md` §6's depth 2.

**The decision.** `setExtensionPrompt('cairn_state', text, IN_CHAT, depth, false,
SYSTEM)` (`script.js:8926`), where depth is the number of prompt messages after the
state's message. In normal play that's depth 1: between the reply the state includes
and the user's new message. The state's message is found in the interceptor's
`coreChat` by `extra` identity, never by index, since `coreChat` drops hidden
messages (`script.js:4496`) and pops the last one on a swipe (`:4498`). A state at
or before the step's `summarisedThrough` is older than the block and isn't placed,
nor is one that renders to nothing.

**Why the depth matters more than the change rate.** ST inserts an `IN_CHAT` prompt
*depth* messages from the end (`doChatInject`, `script.js:5628`, `:5665-5666`). Next
turn, two messages go in below it, so its old position no longer matches even if the
text didn't change. Every in-chat placement costs a re-read each turn, of the state
and everything below it. Predicted on D-0034's layout, with corpus sizes:

| Placement | Extra re-read per turn | Held turn |
|---|---|---|
| No state | — | ~97% |
| `IN_PROMPT` after the block | a change re-reads from the block's tail, like a step | ~71–79% |
| `IN_CHAT` depth 2 | reply + user + state ≈ 700 tokens | ~93% |
| **`IN_CHAT` depth 1** | user + state ≈ 380 tokens | **~95%** |
| `IN_CHAT` depth 0 | state ≈ 80 tokens | ~96.5% |

The state changed in 7 of Esin's 8 tracked exchanges, so `IN_PROMPT` would break
the prefix high almost every turn. D-0049 measured depth 1 at about 1.6 points.

**Why not depth 0.** The state would sit below the user's newest message, which it
hasn't read, so a message that moves the scene would be contradicted just before the
reply. Depth 0 is also where per-turn retrieval goes (P5).

**Why "after the message", not a fixed depth.** On a swipe the previous state is
still at depth 1. When the queue falls behind, the state sits deeper and stays in
order. On a continue, ST moves a depth-0 injection up one message (`:5665`).

**Reopens if:** the state's cost in play moves well past the prediction, or P5's
retrieval needs the slot.

---

## D-0041 — P2 is measured and closed: Cairn summarises, and qvink can go
**2026-09-16.** Closes P2 (`DESIGN.md` §13). The plan's four decisions are
D-0037 to D-0040, and the plan page is deleted.

**Two runs on Esin**, text completion on oMLX, memory model GLM-4.7 through
OpenRouter. Stability is the share of each prompt already cached.

```
cutover, qvink enabled with Auto Summarize off (7 turns)
turn     1           2     3     4     5     6     7
reason   first-turn  held  held  held  held  step  held
stab     —           95.0  96.4  97.0  96.8  65.5  96.8

qvink disabled, after D-0040 (7 turns)
turn     1           2     3     4     5     6     7
reason   first-turn  held  held  held  held  step  held
stab     —           96.9  96.7  96.7  97.3  67.3  97.1
```

- **A step still breaks at the block's tail.** On the disabled run's step turn,
  `memory_change_at` was 20,441, exactly the old block's length: 5 summaries were
  appended (38 → 43, 3,978 → 4,560 tokens) and nothing was evicted. The cycle mean
  is (96.9 + 96.7 + 96.7 + 97.3 + 67.3) / 5 ≈ **91%**, the same as P1 (D-0034).
- **Disabling qvink cost nothing extra.** The first turn after the reload was
  `writing` with the summarizer `ready`, and its rebuild is the one every reload
  pays (D-0033). Before D-0040 that turn would have stayed `unproven`.
- **Uninstalling was not run separately.** To Cairn an uninstalled qvink differs
  from a disabled one only in which check says so (no manifest instead of the
  disabled list), and both are unit-tested.
- **Summaries:** 14 written across both runs, 0 failures, no given-up message, and
  `memory_step_waiting` never true. Requests averaged about 1,200 tokens in and 110
  out (the chat model's tokenizer, so estimates), against qvink's 1,012 and 111;
  times ran from 3.6 to 17.7 s.
- **The qvink part of the block stayed byte-identical** through the cutover, and
  `prompt_near_limit` never fired (80% at most).

**One target was missed, and is accepted.** The plan said no summary would overlap
a generation. One turn in seven did in each run, both times when a continue was
sent within seconds of a reply: that reply's arrival starts the queue, and the next
generation starts before it finishes. On a remote memory model beside a local chat
model the two don't compete, and the block only changes on a step, so a summary
landing mid-generation doesn't touch a prompt already sent. It would compete on a
shared backend.

**What these runs cannot show.** Esin's chat had derailed into "continue" messages,
which are too short to summarise. So each turn made one summary call where a real
chat makes two, and the overlap rate here is optimistic. **Summary quality is
deferred** (Matt, 2026-09-16): it is judged after P4 or P5, as a final test in a
real roleplay, and until then phases close on mechanics.

**Reopens if:** a step waits in normal play (`memory_step_waiting` true without
failures), summary calls measurably slow generation on a shared backend, or the
quality test fails.

---

## D-0040 — The qvink mirror is retired
**2026-09-16.** P2 step 6. Supersedes the byte-for-byte gate (D-0020, D-0027) and
placement mirroring (D-0027, D-0029).

**The decision.** Cairn reads nothing from qvink's settings to build the block.
The template, the `\n* ` separator, and `IN_PROMPT` at depth 2 with the system role
are Cairn constants equal to qvink's defaults (`BLOCK_RENDERING`,
`BLOCK_PLACEMENT` in `prompt/assembler.js`). The fidelity check and its proof are
gone. What stays is the read-only reader of `extra.qvink_memory`, and a gate that
qvink is neither placing a block nor, while it runs, excluding messages.

**Why.** The mirror existed so the handover changed only who writes, and the
proof could only be earned while qvink was still the writer. Both had done their
job. What they cost was qvink itself: a disabled qvink parks no block to compare
against, so after a reload Cairn never took the block over.

**Discovery: an extension's settings outlive it.** A disabled or uninstalled qvink
still says Auto Summarize is on in `extension_settings`, so the summarising gate
kept waiting on an extension that wasn't running. The gate now asks whether qvink
is loaded first (`qvinkRunning` in `memory/scenes.js`). ST never loads a disabled
extension (`extensions.js:626`) and disabling one reloads the page (`:490`). An
uninstalled one has no manifest (`:524`). qvink parks both of its injection keys on
every chat refresh (its `index.js:4004-4005`), so a parked key also counts, which
catches an install under another folder name.

**Cost.** Anyone whose qvink template, separator or prefill display wasn't the
default gets one rebuild, as the block's wording changes. Esin's settings were all
defaults, and its position was Macro Only, which Cairn had already stopped
mirroring (D-0029), so its prompt did not change by a byte.

**Reopens if:** the `DESIGN.md` §6 block move, which chooses a placement rather
than keeping qvink's default. Or a qvink install that runs without either sign, so
Cairn summarises alongside it.

---

## D-0039 — The summary prompt is editable, and defaults to the qvink prompt proven in play
**2026-09-16.** P2 plan decision 3. Settles what D-0036 left open.

**The decision.** One setting, **Summary prompt**. Empty means the built-in
default, so an unedited install follows improvements to the default. The default
is Matt's qvink prompt, verbatim. `{{message}}` is the message as `Name: text`,
`{{history}}` is the 5 summaries before it, one per line, and
`{{#if history}}…{{/if}}` uses qvink's syntax, so a qvink prompt pastes in
unchanged. A prompt with no `{{message}}` falls back to the default with one
warning. Each summary stores a hash of the template that wrote it, and editing the
prompt rewrites nothing.

**Why editable now.** It passes CLAUDE.md §4.15's one-sentence test, and adding it
later would mean a settings migration for a knob people already expect.

**Why this default.** A prompt measured in play on the D-0036 model floor beats
one written to rules, so `DESIGN.md` §12's structure is not applied to it.

**How it renders.** ST's macros (`substituteParams`, `st-context.js:163`) are
expanded on the template before the message goes in, so a `{{user}}` typed in chat
reaches the model as typed. Cairn's three macros go through its own small renderer
(`util/template.js`): ST's `{{if}}` exists only behind the experimental macro
engine (`script.js:2997`) with different syntax, and Handlebars, qvink's route, is
deprecated for extensions (`st-context.js:177`).

**Reopens if:** edited prompts routinely break summaries, or a strategy other than
one-per-message needs a prompt of a different shape.

---

## D-0038 — The memory block's cap is a fixed 35% of the max prompt
**2026-09-16.** P2 plan decision 2.

**The decision.** The cap is 35% of what SillyTavern may send (the context window
minus the reserved response, `getMaxPromptTokens`, `script.js:5981`), with no
setting. It replaces qvink's `short_term_context_limit`, which goes away with qvink.

**Why 35%, not 30%.** Esin's qvink limit was 7,500 tokens, 34% of 22,016. 35% gives
7,705 and keeps at least the history it had, where 30% would drop it to 6,605. A
share scales with context size. The move cost one rebuild, on the same turn as the
update's first-turn rebuild.

**What it can't see.** On a small context with a large card and lorebook, text
completion silently drops the oldest raw messages (`script.js:4920`). The log sets
`prompt_near_limit` when a prompt is within 5% of its limit.

**Known behaviour.** The cap follows the response length. Lowering Esin's from
2,048 to 1,024 during the cutover raised the max prompt to 23,040 and the cap to
8,063. Raising it shrinks the cap and costs one rebuild if the block is over the
new cap.

**Reopens if:** P6, a budget worked out from the chat's own parts (`DESIGN.md` §13).

---

## D-0037 — One plain-text summary per message, stored on the message
**2026-09-16.** P2 plan decision 1. Reverses the first draft, which proposed one
JSON delta summary per step.

**The decision.** Each summarisable message gets its own summary, in plain text,
written by one request carrying the message and the 5 summaries before it. It is
stored on the message itself as `extra.cairn.scene`: `text`, a hash of the
message's `mes`, a hash of the prompt, and `at`.

**Why.** The prompt is small, the reply short, and there is nothing to unpack.
Batching risks blending summaries and losing detail, builds a backlog paid off in
one lump each step, and needs a format the model can get wrong. The block grows at
the rate it already did, because qvink wrote one summary per message too, so
D-0034's numbers held and the assembler's input kept its shape.

**Evidence.** Matt's OpenRouter export, 2026-09-12 to 09-16: 105 qvink summary calls
to GLM-4.7. Median 1,012 tokens in and 111 out, p90 2,408 and 161, longest reply
199, no reasoning tokens. A call took 6.9 s at the median and 21.2 s at most; all
105 cost $0.08 and finished with `stop`. Calls ran one at a time, in bursts of 2–3
after each turn, and no burst in 30 outlasted the pause after it.

**How it holds together.**
- **Validity is checked on read.** A scene counts only while its message's hash
  matches, so an edit sends the message back to raw and requeues it. A deletion
  takes its scene with it; a branch copies the messages it keeps, scenes included
  (`bookmarks.js:173`). Only the last message can be swiped (`script.js:9195`),
  and it is never summarised.
- **Summarisable** is a pure rule: not hidden or system, and at least 50 tokens,
  Matt's qvink `message_length_threshold`. Nothing is stored for a skipped message.
- **Migration is a read.** qvink's summaries are read as they are, a Cairn scene
  wins where both exist, and Cairn starts after qvink's newest summary, so it
  never inserts scenes mid-block.
- **Queue.** Starts on `MESSAGE_RECEIVED` and `CHAT_CHANGED`, never on
  `MESSAGE_SENT`, when the chat model starts generating. Oldest first, one request
  at a time, never the last message.
- **A missing summary holds the step.** The threshold never moves past a
  summarisable message without a valid scene, so nothing is blanked without its
  summary.
- **A failure writes nothing.** A throw, refusal, parse failure or abort stores
  nothing, toasts once per streak, and a message that fails 3 times is left alone
  for the session. A reply for a chat, message or text that has changed since the
  request went out is discarded.

**Cost we accept.** ST returns no finish reason (`custom-request.js:60`), and JSON
would have caught a cut-off reply by failing to parse. The parser checks instead:
after stripping `<think>` blocks, fences, a `Summary:` label and list markers, it
rejects a reply that is empty, opens like a refusal, looks like JSON, runs past
1,500 characters, or doesn't end in sentence-ending punctuation. A refusal worded
in a way it misses gets stored; it stays visible, and editing the message
replaces it.

**Reopens if:** truncated or refused summaries get past the parser in play, or
per-message cost stops being negligible on the D-0036 model floor.

---

## D-0036 — The memory model is a strong one, and the prompts may assume it
**2026-09-16.** Closes `DESIGN.md` §14.3.

**The decision.** Default to a strong model: GLM-4.7 class or better, and a
newer GLM or DeepSeek is fine. Memory prompts are written for that floor, not for
flash-class models, so they can carry more nuance than §12 originally allowed.

**Why.** A summary request is small input and small output. Per call, quality
costs little more than cheapness, and a bad summary stays in the chat for good.
Choosing the model is still a connection profile (D-0006), so moving to a newer
model later means switching profiles, with no code change.

**Left open for P2.** Whether the summary prompt is user-editable. "The
instructions sent to the memory model" passes CLAUDE.md §15's one-sentence test,
so it is allowed. Whether it is *wanted* gets decided when P2 is planned.

**What would reopen it.** Users running flash-class models in practice, or
GLM-4.7-class output failing the parser in play often enough that the prompts
have to assume less.

---

## D-0035 — Lorebook outlets are not needed for P1
**2026-09-16.** Closes `DESIGN.md` §14.2, which D-0021 left open until a
measurement came in. The measurement is D-0034's run.

**The question was never really about outlets.** Outlets were proposed because
lore that changed between turns was breaking the cache. D-0022 found the real
cause, which was entries tied on `order`, and D-0021 had already shown that
outlets control only where lore goes, not what order it is in. With the holder
(D-0023, D-0024) and the tie fix in place, Esin's run held 29 entries with 0 ties
in the same order on every turn, and quiet turns stayed at 96.5–97.2%. Even the
step turn broke at the end of the memory block, well below the lore.

**So outlets buy placement only, and placement waits.** The only reason left to
use them is to keep lore above the memory block if the block ever moves (the
deferred `DESIGN.md` §6 move; D-0019, D-0027). Until then they would mean an
edit to every lorebook entry and change nothing we can measure.

**Discovery: forcing an entry does not skip its probability roll.** The holder
pushes entries in through `WORLDINFO_FORCE_ACTIVATE`. A forced entry is added to
the normal `activatedNow` set (`world-info.js:4886-4888`), which becomes
`newEntries` (`:4997`, `:5005`), and every entry in that list goes through
`verifyProbability` (`:5028-5049`, called at `:5051`). The roll is skipped only
when probability is off or set to 100 (`:5030`), or when the entry is sticky
(`:5035`). So a held entry below 100% is re-rolled every turn, drops out on a
failed roll, and comes back on the next pass. Outlets would not fix this either,
because they use the same scan. Esin's book has 0 such entries out of 31, and
Akane's has 15 out of 110, none of them sticky. Nothing is done about it yet: the
chat we measure is not affected, and changing a user's probabilities from inside
Cairn is not something to do quietly.

**What would reopen it.** The `DESIGN.md` §6 block move. Or a trace on a book
with probability entries (Akane's) where lore churn breaks the prefix, which
makes the probability roll the thing to solve, not outlets.

---

## D-0034 — P1 is measured: a step breaks at the block's tail, and the see-saw is accepted
**2026-09-16.** Restates D-0019's target. The mechanism D-0019 predicted holds,
but its ~90% step-turn figure does not, because that figure came from a
different prompt layout. This closes P1's measurement.

**The run.** Esin, text completion on oMLX, with qvink generating summaries and
Cairn writing the prompt. All seven lines are in `cairn-inspector.jsonl`.

```
turn     1           2     3     4     5     6      7
reason   first-turn  held  held  held  held  step   held
stab     —           96.5  96.5  96.8  97.2  68.2   96.5
```

- **Turn 1** rebuilt the block, as D-0033 designs it to: 69 summaries evicted,
  leaving 36 summaries in 3,694 tokens, under the 3,750 floor.
- **Held turns:** the memory block was 100% identical, 29 lore entries were held
  with 0 ties, and the cache hits were fast. `prompt_tokens` went from 15,666 to
  17,762, against a 22,016-token limit.
- **The step turn** (14:05:22Z) added 5 summaries (36 → 41, summarised through
  125 → 135), evicted none, and grew the block from 3,694 to 4,156 tokens.
  `memory_change_at` is 18,814, which is exactly the old block's length, so the
  new summaries were appended at the tail. The block itself was 88.6% stable.
  The whole prompt diverged at char 50,112, which is the end of the block.

**The mechanism holds.** A break at the head of the block would have landed at
char 31,298 and given 42.6% (31,298 / 73,504). A break at the tail gives 68.2%.
Everything above the new summaries stayed cached: the card, the lore and the
old block.

**The 90% does not.** D-0019 computed it on Elizabeth's prompt, where the block
was 77% and the raw history 10%. Under D-0033 the block opens at the floor, so
the raw history below it is 23,392 chars, about 32% of this prompt, and any
change to the block means re-reading all of it. On this layout, **68.2% is the
most a step turn can get.** The restated target is where the step breaks (the
block's tail), not a fixed percentage.

**The cycle is what matters.** A step comes roughly every 5 turns, so the mean
is about (4 × 96.75 + 68.2) / 5 ≈ **91%**. The same run with a head break would
average about 86%.

**The see-saw is accepted.** Several fast turns, then one slower one. The first
turn of a session is always slow because it rebuilds the block. Matt's call:
this is the best prompt caching has worked for him, and nothing needs to be done
about it. Only three levers could raise the step turn: step cadence, the size of
the raw window (P2 owns both), and placement (the deferred `DESIGN.md` §6 move).
None of them is being pulled.

**Also found.** Every line reported `writers: 2`. The inspector was counting
qvink's parked "Macro Only" block, which ST never places. Fixed in the same
change (`src/prompt/inventory.js`).

**What would reopen it.** A slow step turn that is actually felt in play, for
example on a chat whose raw window is much bigger. Or a P2 cadence that pulls
the cycle mean below this run's.

---

## D-0033 — the plan is a function of the chat
**2026-09-16.** Supersedes D-0028, D-0030, D-0031 and D-0032, and the measured
cap in D-0026. Those entries stay as the record of what we believed.

**What happened.** Four fixes in a row, each found in live play, each adding
state Cairn learned by watching prompts go out: a measured budget, a projection
of its growth, a raw-window allowance, a provisional eviction for the turn before
any measurement, and a store to carry all of it across a reload. Every piece had
its own cold start, and each one's error fed the next turn's plan. On the first
real reload the prefix did not settle until turn 4 (30.5%, 40.8%, then 97.1%);
the build before those four fixes settled on turn 3. The fixes were worse than
the bug.

**The decision.** The plan reads nothing it measured. Everything is derived from
the chat and settings the user already chose:

- **Cap** = qvink's own short-term limit, resolved as qvink resolves it (tokens,
  or percent of `getMaxPromptTokens`, which is qvink's `getMaxContextSize` under
  another name — public/script.js:333). No foreign cost, no projection, no
  headroom, no estimate.
- **Sizes** are counted from this turn's own block. No ratio is carried between
  turns.
- **The see-saw and the eviction mark** still live in memory for the session, and
  start from the chat's current state. Nothing is stored in `chatMetadata`.
- **The first turn of a session rebuilds, and lands at the floor.** That turn
  re-reads the block anyway, so the slack it buys is free. From the second turn
  on, the block is byte-identical until a step appends to its tail.

A reload therefore costs exactly one rebuild, and a fresh session on the same chat
builds the same block as any other. The observer still measures the whole prompt,
for the log only.

**What it gives up.** The block no longer grows into whatever the prompt has
spare, and a session opens with half the limit. If card + lore + raw window +
block overflows the context, ST trims history before sending it, and the log
shows the prompt size. We accept both: a user who drops in for one turn pays one
rebuild either way.

**Discoveries.** On the reload that exposed this, turn 1 carried all 29 held lore
entries with *nothing* stored — the store D-0032 added for them was never needed.
And the loop itself is the lesson: when the second patch for the same symptom
arrives, stop and simplify instead of writing the third.

**What would reopen it.** A trace where the qvink limit overflows the context in
normal play, or where one rebuild per session is shown to matter.

---

## D-0032 — a reload should cost nothing
**2026-09-16.** Both of Cairn's startup costs have the same shape, and together
they meant every test run burned two messages before it was measuring anything.

Cairn derives two things by watching prompts go out, and a fresh page has
watched none:

1. **The budget split.** `foreignTokens` comes from a measured prompt, so the
   first turn of a session ran on the half-budget estimate, evicted
   provisionally (D-0028), and the second turn took it all back — a different
   prompt, and a second rebuild.
2. **The held World Info set.** The holder is add-only and learns from
   `WORLD_INFO_ACTIVATED` (D-0023, D-0024), so the first prompt after a reload
   went out with zero lore — 29 entries, ~5.5k tokens, absent — and the second
   had them all back. The one turn the holder structurally cannot protect.

Neither is a bug in the derivation. Both are the derivation having nowhere to
live across a reload. So it gets one: `store/chat-store.js`, in `chatMetadata`.

**What is stored is chosen to be cheap to be wrong about.** The foreign count is
an estimate either way and the next measurement corrects it. Lore is stored as
**identity only** — `world` and `uid`, never content — and resolved back through
`getSortedEntries` (world-info.js:4590) at load, so a book edited while the page
was closed cannot come back stale and the chat file never grows a copy of the
lorebook.

**Why `chatMetadata` and not settings.** The set is per chat: another
character's lore is not ours to hold, and one chat's budget says nothing about
another's. It also travels with the chat between devices, which is where the
question came from.

**No version bump.** `STORE_VERSION` is 1 and this is its first use — there is no
earlier shape to migrate from. A stored shape from a version this build does not
know is ignored rather than trusted, so a downgrade costs a rebuild and not
someone's state.

**What would reopen it.** Restored lore that no longer matches what the scan
would have activated — a chat branched elsewhere, say. The holder is add-only
within a session for the same reason; if the restore proves noisier than the
rebuild it saves, store the set per branch or drop it.

---

## D-0031 — the raw window is Cairn's spend, not a cost imposed on it
**2026-09-16.** Found in play, and the cause of the handover's prompt growth.

The cap was `maxPromptTokens - otherTokens`, where `otherTokens` was everything
that was not the memory block — including the un-blanked history. But that
history is Cairn's own choice: the see-saw decides where the blanking boundary
sits. Drawing the line there meant **evicting summaries to pay for prose we
chose to keep raw**, and eviction is permanent because the mark only moves
forward (D-0026).

**What went out.** The prompt grew 14030 -> 21919 tokens across the handover, 58%
to 91% of the window, and oMLX rebuilt its cache every message. The block
explained only ~1,750 of that. The rest was the raw window:

| | qvink | Cairn |
|---|---|---|
| boundary | recomputed every turn (`lagging = i > first_to_inject`, its index.js:3830) | held between steps (D-0019) |
| raw window | always exactly 10 messages | 10 -> 20, sawtooth |

Holding the threshold still is what makes the block byte-identical, so the
sawtooth is the price of D-0019 and not a mistake. What was a mistake is who
pays for it.

**The fix.** Split the prompt three ways — the block, the raw window, and
`foreignTokens` (card, persona, lore, note, other injections). The first two come
out of one `deriveAllowance`; only the third is projected against. And when an
eviction is about to happen *while the window is above its target*, the see-saw
is asked to step (`reason: 'budget'`), which snaps the window back and converts
prose into summaries already held. It rests on a summary costing a fraction of
the prose it stands for — ~353 characters against ~1,650 in the corpus.

**Rejected:** capping the raw window at `RAW_WINDOW` outright. It fixes the size
but not the accounting, and it trims mid-prompt on turns that have no budget
problem — a rebuild bought for nothing.

**Side effect worth recording.** `test/mocks/qvink.js` had 35-character messages
against 353-character summaries, inverting the real ratio ~50x. Nothing depended
on message length until now. Fixtures are real in shape (CLAUDE.md §3.13), and
this is what it costs when one is not.

**What would reopen it.** Budget steps firing often. The valve should be rare; if
it is not, `RAW_WINDOW` or `STEP` is wrong for the window size and the cadence
wants retuning rather than the valve doing it every turn.

---

## D-0030 — the cap is drawn against next turn's prompt, and keeps headroom
**2026-09-16.** A second bug found in play, on the first clean handover run.

`deriveCap` was `maxPromptTokens - otherTokens`, and `otherTokens` is what the
observer measured on the prompt that *already went out*. It is spent a turn
later, on a prompt that has since grown by a step of history. So the invariant
the cap exists to hold — block + everything else fits the budget — was never
actually the invariant; it held for last turn's prompt, not this one.

**What went out.** Esin, four consecutive turns, budget 22016:

| turn | other (measured) | cap | block | prompt |
|---|---|---|---|---|
| 1 | — (estimated) | 11008 | 4296 | 15941 |
| 2 | 11645 | 10371 | 9264 | 21421 |
| 3 | 12157 | 9859 | 9264 | **21919** |
| 4 | 12655 | 9361 | 9264 | **21919** |

The block was inside its cap on every turn. The prompt still reached 99.6% of
the budget, because each cap was drawn against a measurement ~500 tokens stale.
Turn 3 was rejected as oversize by the backend; the identical resend went
through, so the rejection was marginal rather than deterministic — which is what
running with no margin looks like.

**Two terms, because two things are approximate.**

1. **Projection.** `projectOther` adds last turn's growth to last turn's
   measurement. Self-correcting: when the prompt stops growing the projection
   collapses onto the measurement and the block gets the room back, so a steady
   chat is not permanently taxed for a step it is not taking.
2. **Headroom.** `HEADROOM_FRACTION` (2%) comes off the top regardless. ST's
   tokenizer is not the model's, and the cap is built out of two numbers that are
   both approximations; spending to the last token makes any disagreement a
   rejected request instead of a slightly smaller block.

**Rejected:** a high-water mark of `otherTokens`. It is monotonic in a growing
chat, so it equals the last measurement and fixes nothing; after a branch it is
stale high and taxes the block for history that no longer exists.

**Known gap.** The first *measured* turn of a chat has no previous measurement
to project from, so it gets headroom only. It is the turn least likely to need
it — the one before it ran on an estimated cap at half the budget — and the cost
of guessing a growth rate there is a permanently smaller block.

**What would reopen it.** A trace where the projection over-reserves: prompts
sitting well under budget while the block is evicting. That would say growth is
too noisy to project one turn at a time and wants smoothing over several.

---

## D-0029 — `NONE` is not a placement to mirror
**2026-09-15.** A bug, found in play on the first handed-over turn, and the
entry exists because the shape of it is worth keeping (CLAUDE.md §6.27).

D-0027 mirrors qvink's placement so the handover changes only *who* writes. The
handover also asks the user to set qvink's memory position to **Macro Only** —
`extension_prompt_types.NONE` (`script.js:484`). So the act of opening the gate
rewrote the placement we mirror, Cairn parked its block at `NONE`, and
`getExtensionPrompt` collects by position (`:3312`) and never took it.

**What went out.** Esin, first message after flipping both switches:

```
injections: cairn_memory (parked, match none), qvink_memory_short (parked, match none)
prompt_tokens 7557   (14030 the turn before)   context 31.4%
memory_writing true  memory_blanked 92  memory_tokens 9033 — none of it in the prompt
```

Nine thousand tokens of summaries written to a key nothing reads, 92 messages
held out of the history, and no lore that turn either: the model got the last
handful of raw messages and nothing else. The chat did not break, which is
precisely the problem — it read as a normal turn.

**Two fixes, because two things were wrong.**

1. `resolvePlacement` mirrors a position only when qvink names one ST collects.
   `NONE` — or no setting at all — takes qvink's own default (`IN_PROMPT`, its
   index.js:153) and reports `defaulted`, so the panel says the block is not where
   qvink had it. Depth, role and scan are still theirs.
2. The gate refuses to write at all if the block would not be placed
   (`HANDOVER.UNPLACED`). Unreachable through fix 1, and kept anyway: **writing is
   also blanking**, and that invariant should hold regardless of how a placement
   is arrived at. The assembler test asserts it across every position qvink could
   offer.

**The lesson worth paying for once.** We read another extension's *settings* to
mirror behaviour, and the handover procedure mutates those settings. Anything
read from a neighbour's configuration has to be read with the handover's own
instructions in mind — the state we copy is the state we are asking the user to
change.

**Reopens if:** we decide the block should sit where DESIGN.md §6 wants it rather
than where qvink had it, which retires the mirroring question entirely; or a user
wants their pre-handover placement remembered across reloads, which means
persisting it rather than re-deriving it.

---

## D-0028 — An estimated cap may shape a turn, not the rest of the chat
**2026-09-15.** Corrects one claim in D-0027. That entry said the first turn's
estimated cap "is replaced by the measurement one turn later". True of the cap;
false of what the cap did, because eviction moves a mark that only ever moves
forward (D-0026).

**The trace.** First message on Esin after loading 0.8.0, gate still shut:

```
memory_cap 11008  memory_cap_estimated true  memory_floor 5504
memory_over_cap true  memory_evicted 46  memory_tokens 4351
memory_scenes 94  memory_blanked 91  memory_included 45   (messages 46-96)
```

`getMaxPromptTokens` was 22016, so the unmeasured turn capped the block at half
of it, 91 covered summaries did not fit, and 46 were dropped to reach the floor.
The next turn's cap is measured and larger — and those 46 stay out anyway,
because `oldest` had already been committed to 46. A guess made one turn cost the
oldest half of the block for the session.

**The rule.** `fit({provisional: true})` when the cap is an estimate: the block is
cut to fit exactly as it would be otherwise, and the mark is not moved. The first
measured turn starts from every candidate again and evicts — or does not — against
a real number.

**Why not simply skip eviction while estimated.** Because the gate can already be
open when a chat is reloaded mid-session, and then an uncut block goes into a real
prompt. ST would drop history to fit, and a block bigger than the whole budget
would overflow the request. Cutting the block is never the wrong thing to do; only
*remembering* the cut is.

**Why not let the mark rewind whenever the cap grows.** The mark's forward-only
rule is what spaces rebuilds apart — a mark that follows the cap up and down
re-admits summaries on an ordinary turn, which is a rebuild at the block's head,
which is the thing P1 exists to stop (D-0019). The estimate is one exception, at
one known moment, not a new policy. Every measured turn still commits.

Folded into 0.8.0; it never ran outside this machine.

**Reopens if:** a trace shows a provisional turn's block going out oversized —
meaning the cut is not happening where it must — or estimated caps turning out to
be so far from the measurement that the first turn of every chat visibly loses
memory anyway, which would make the estimate itself the thing to fix.

---

## D-0027 — Cairn writes the block, behind a gate the user opens
**2026-09-15.** P1 step 3, the handover D-0020 sequenced. Cairn now parks the
memory block itself (`prompt/injector.js`) and holds the messages it covers out
of the sent history, and the plan that decides both is made in the generate
interceptor — the last hook still ahead of prompt assembly (`script.js:4564`
against `:4635`).

**It is a swap, and both halves have to move together.** Injecting while qvink
injects puts the block in the prompt twice; blanking while qvink blanks means two
extensions writing the same `Symbol.for('ignore')` from different thresholds and
a raw window decided by whichever interceptor ran last. So there is a gate
(`prompt/handover.js`), checked every turn, and it opens only when the setting is
on, qvink is placing neither injection, its
`exclude_messages_after_threshold` is off, and our render of its own selection has
matched its live block byte for byte in this chat. Every closed state names the
switch that would open it, in the inspector and in the log, because a gate that
closes silently looks exactly like a gate that is open and working.

**Cairn does not reach into qvink's settings to open it.** Silencing qvink is the
user's deliberate act: its short- and long-term memory position to *Macro Only*
and *Exclude messages after threshold* off. An extension that configures another
extension is the "two systems, one prompt" failure this phase exists to end, and
"Macro Only" is `extension_prompt_types.NONE` (`script.js:484`), which keeps the
value parked for the fidelity check while nothing places it (`:3312`).

**The proof is remembered, not re-earned.** It can only be earned while qvink is
still the writer, and the moment the handover happens there is nothing left to
compare against. It is dropped on a chat change, because it was a statement about
this chat's configuration.

**Placement is mirrored, not chosen.** Position, depth, role and scan come from
qvink's live settings, so the handover changes exactly one thing — who writes.
Moving the block to where DESIGN.md §6 wants it is a separate change, made and
measured on its own. One thing does move regardless: `getExtensionPrompt` sorts
by key (`:3310`), so `cairn_memory` sits where `qvink_memory_short` did not among
other injections at the same position. The inspector's `locate.js` is what shows
it.

**Blanking is written in place, through the live chat.** DESIGN.md §9 forbids the
clone qvink uses, and the interceptor's array is not the chat anyway: it is
`coreChat`, filtered of system messages (`:4496`), rebuilt as `{...chatItem,
index}` (`:4525`) — entries that share `extra` by reference, carrying an `index`
that counts the *filtered* array (`:4527`). Following that index blanks the wrong
messages on any chat containing a system message, and the prompt looks entirely
plausible either way. So indexes are the live chat's, the write goes through the
live chat, and `extra` being shared is what carries it into the generation. Every
message is written every turn, set or cleared: the flag lives on the real message,
so one left behind blanks a message nothing summarises any more. It never reaches
the file — `JSON.stringify` drops Symbol keys, which is the same fact that made
WTrackerLite's `structuredClone` bug silent.

**A message whose summary was evicted stays blanked.** Eviction means the block
can no longer afford that summary; putting the message's prose back would cost
several times what the summary did, on the oldest and least useful part of the
chat.

**The first turn of a chat has nothing to measure.** The cap is
`maxPromptTokens - otherTokens` and `otherTokens` comes from the observer, which
only runs after a prompt has gone out. Until then the block gets half the prompt
budget (`UNMEASURED_CAP_FRACTION`) rather than all of it, and the estimate is
replaced by the measurement one turn later. The inspector says which of the two a
cap is.

**A failure leaves last turn's block and flags exactly as they were** rather than
clearing either. They were coherent with each other; half-clearing them is a
prompt that hides messages it is also not summarising (CLAUDE.md §4.17).

**Reopens if:** a trace shows the gate open while the block is in the prompt
twice — meaning qvink can inject by a route `extensionPrompts` does not show — or
the mirrored placement turns out to be the wrong place to keep the block, which
is DESIGN.md §6's question and gets its own entry and its own measurement.

---

## D-0026 — The assembler splits growth from eviction, and the split is conditional
**2026-09-15.** Builds what D-0019 restated: keep the memory block high, make a
see-saw step change its **tail** rather than its head. Three modules, because the
design's claim is that there are two cadences and the code should say so —
`pipeline/scheduler.js` (growth), `pipeline/budgeter.js` (eviction),
`prompt/assembler.js` (rendering and measurement), reading tier 2 out of
`message.extra` through `memory/scenes.js`.

**The rule.** The threshold advances in steps of 10 messages, so between steps
the included set is *identical* and the block is byte-identical. When it advances,
summaries append at the tail of an oldest-first render, so the head keeps its
offsets. Eviction is a separate event: it fires only when the block will not fit
the prompt, and then drops to **half the cap** rather than shaving the one summary
that overflowed — so the next rebuild is half a cap of growth away instead of one
summary away.

**The cap is measured, not chosen.** `getMaxPromptTokens` (`script.js:5981`) is
ST's own prompt budget — context window minus the reserved response — and the
observer already measures what the rest of the prompt costs, so the cap is the
difference. Neither term is a setting (CLAUDE.md §4.15). ST does not put
`getMaxPromptTokens` on `getContext()` (`st-context.js:115`), so it is imported
dynamically from `/script.js`; that is the URL ST itself loads
(`index.html:8218`), so it resolves to the same module whatever our install depth
is, and a failed import degrades to a share of `maxContext` rather than stopping
the extension loading.

**Simulated over 170 turns against the regime it replaces**, same summaries, same
chat, same cap — only the cadences differ:

```
                      block rebuilt from its head    eviction turns
qvink's rule                              90                    90
split cadences                             2                     2
```

The control is qvink's own defaults expressed in our code: advance the threshold
every message (its `index.js:138`) and evict exactly enough to fit
(`floorFraction: 1`). It matters that both arms run past the point where the cap
binds — before that they are identical, which is D-0019's "turn 6 is not an event,
it is the new steady state" seen from the other side.

**The half-cap floor buys the spacing; it does not guarantee it.** Rebuilds are
`(cap - floor) / growth-per-step` steps apart, so a cap only a step or two wide
puts eviction back on every step — qvink's behaviour, reached by a longer road,
with the block looking entirely correct while it happens. The first simulation run
did exactly this and it took a printed trace to see it. So `recoupled()` checks
the condition every turn and the inspector says so in words (CLAUDE.md §9.35).
There is no policy that fixes the underlying case: if one step costs more than
half the cap, the block holds fewer than two steps and no floor makes rebuilds
rare.

**Not yet the writer.** qvink still injects. Every turn the assembler also renders
*qvink's own* selection — the set its `include`/`lagging` flags describe — and
compares it to the block qvink actually parked. Until that is byte-identical,
taking over the injection would move the block and change its contents in one
step, and no measurement afterwards could separate the two. D-0020 already
sequences the handover behind this check; `memory_fidelity` in the log is the
check.

**What is read from qvink and what is not.** Rendering is read from its live
settings — template, separator, prefill (`its index.js:93, :113, :133`) — because
the fidelity check has to hold for *this* user's configuration, not for the
defaults. The cadences are ours. Reading those would import the behaviour P1
exists to replace: qvink's growth trigger defaults to `0`, meaning "advance every
turn", which is the 13% regime itself.

**Half is the one judgement call in this.** Eviction is the expensive event, so it
should buy the most steps it can; half the cap is the largest share that still
keeps the block above half its capacity. `memory_evicted` and
`memory_change_percent` in the log are what would move it.
**Reopens if:** a real trace shows the block spending long stretches
under-filled — the floor is too low — or `recoupled` firing on an ordinary chat,
which would mean the cap is genuinely too tight and the block needs compaction
rather than a better eviction rule (P4).

---

## D-0025 — Gitleaks allowlists ST injection-key literals, narrowly
**2026-09-15.** `generic-api-key` flagged `'2_floating_prompt'` in
`src/prompt/inventory.js:41` — ST's Author's Note injection key — on the
`key === '...'` shape plus entropy 3.62. Not a secret. CI scans full history
(`fetch-depth: 0`), so an inline `gitleaks:allow` comment does **not** clear it:
the finding is pinned to the blob in `1c3b743` and the old blob keeps tripping.
It has to be config.

Allowlist is scoped three ways rather than exempting the file: `targetRules =
["generic-api-key"]`, `regexTarget = "secret"`, and `^[0-9]+_[a-z][a-z0-9_]*$` —
numeric-prefixed lowercase snake_case, which no real credential looks like. A
file-wide exemption would have been one line shorter and would silently cover
whatever lands in that file later.

Also added `make secrets`, which CI had no local twin for despite §9.34 — the
reason this surfaced in CI rather than on the machine that wrote it.

**Reopens if:** a real key ever matches that shape, or gitleaks' allowlist schema
changes shape across a major version.

---

## D-0024 — The holder is built, and D-0023 was wrong about *how* it works
**2026-09-15.** Ships the add-only World Info holder D-0023 specified
(`src/prompt/lorebook.js` for the set, `src/prompt/injector.js` for the push).
The **rule is unchanged** — an entry that has activated stays in, no cadence, no
staleness window. Two claims about the mechanism were wrong, and both would have
produced a holder that looked right and silently did the wrong thing.

**Wrong #1 — "forced entries land in pass 1 and within a pass the sort is
deterministic (`:4996`)".** The conclusion holds; the reason does not, and the
reason is what you would have built against. ST substitutes *our* object for the
book's own (`activatedNow.add(buffer.getExternallyActivated(entry))`,
`world-info.js:4888`), and our object is not an identity member of
`sortedEntries`, so the pass tiebreak scores it `-1`:

```js
// world-info.js:5002
|| (sortedEntriesIndex.get(a) ?? -1) - (sortedEntriesIndex.get(b) ?? -1);
```

Every forced entry ties at `-1`. Determinism comes from `Array.prototype.sort`
being **stable** over `activatedNow`'s insertion order, which is the scan's walk
down `sortedEntries` — deterministic, but by a different route than the index
lookup. Consequence worth knowing: on a mixed turn every forced entry sorts
*above* every naturally-activated one regardless of the book's own order. It only
shows in the prompt where `order` ties, because final placement is `sortFn` on
`order` (`:5203`) with this as the tiebreak.

**Wrong #2 — "force-activate the remembered *set*".** A set of `{world, uid}`
keys is exactly the thing that does not work. Because ST swaps in our object
wholesale (`:4888`), a stub would have evicted the content it was meant to
preserve — a lore block of empty entries, on every turn, and the prefix would
have looked *more* stable while the lore was gone. The holder keeps the **entry
objects** from `WORLD_INFO_ACTIVATED` (`:900`), which are post-scan: decorators
already parsed back out of `content`, `world` already attached (`:4639`, `:4535`).
Raw entries read from the book file have neither, so `loadWorldInfo` is not a
substitute source.

**A third thing neither entry saw: held entries go stale on a book edit.**
`getSortedEntries` hands the scan a `structuredClone` (`:4639`), so a held object
is a copy with no link to the book. While we keep forcing it the book's own entry
never reaches the scan again — so an author editing an entry would see no change,
indefinitely, with no error and nothing in the log. The holder subscribes to
`WORLDINFO_UPDATED` (`:4160`) and releases that book's entries; the next turn
re-scans them from source. One rebuild per edit, which is obviously the right
price.

**Where the push goes.** The generate interceptor, registered as
`generate_interceptor` in `manifest.json` (`extensions.js:2033`, resolved off
`globalThis` at `:2037`). It is the only hook late enough to know the turn is real
and early enough to beat the scan — `script.js:4564` against `:4635`. It must
repeat every turn: `resetExternalEffects()` runs at the end of *every*
`checkWorldInfo` (`:5275`). Dry runs skip interceptors (`:4562`) and do not emit
`WORLD_INFO_ACTIVATED` (`:900`), so neither can pollute the set.

**How it is tested.** `test/mocks/world-info.js` is a working model of the scan —
recursion, the `-1` tiebreak, the clone, the per-turn reset — so the dropout is
*reproduced* rather than asserted. `test/injector.test.js` runs the turn-4 shape
and checks the block is byte-identical across it, with a control that turns the
holder off and watches the same turn collapse to zero entries. A test that only
checked "we emitted the event" would have passed for both of the wrong builds
above.

**Knob:** one, `holdWorldInfo`, default on — not a cadence, just off/on, so a run
can be measured both ways while the observer keeps recording either way.
**Still open, unchanged from D-0023:** forced entries still roll probability
(`:5029`), so books with `probability < 100` entries (Akane: 15 of 110) need the
block cached at our level. D-0021 stays alive for those.
**Reopens if:** ST gives the pass sort a real tiebreak, or stops substituting the
forced object for the book's own — either would change the shape of this code.

## D-0023 — The lorebook block is add-only; a dropout must never evict it
**2026-09-15.** Supersedes the "cache and churn on a cadence" sketch in D-0022:
a cadence is the wrong rule and would make things worse.
*The rule below still stands. Its account of the ST mechanism is corrected by
D-0024, which built it.*

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
**Closed 2026-09-16 by D-0035:** not needed for P1.

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
**Measured 2026-09-16 (D-0034):** the tail break held, but the ~90% did not.
That number depended on Elizabeth's layout, and on Esin under D-0033 a step turn
tops out at 68.2%.

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
- **An extension's settings outlive the extension.** A disabled or uninstalled
  qvink still said Auto Summarize was on, and Cairn kept waiting on it. A gate
  that reads another extension's settings must first ask whether that extension
  is loaded. See D-0040.
- **ST line citations rot across releases.** Four of `DESIGN.md` §7's citations
  moved between 1.18.0 and 1.19.0 while every mechanism stayed intact. The
  mechanism surviving is not evidence the citation did. See D-0009.
