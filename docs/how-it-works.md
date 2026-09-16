# How it works

A short map of the pieces. The reasoning behind them is in
[`DESIGN.md`](../DESIGN.md); this page says what is where.

> **Built today: P0 and P1.** Cairn observes generations and reports on them,
> holds the lorebook block steady, and writes the memory block from summaries your
> existing memory extension has already made, once that extension is silenced.
> P2 is in progress: Cairn writes its own summaries once that extension stops
> summarising. Everything from "The shape of the problem" down is design, not code.

## What P0 measures

P0 exists to check the theory before committing to it (`DESIGN.md` §13). It
watches the finished prompt on its way out and reports:

- **Prefix stability** — how much of this turn's prompt matches the start of the
  last one, as a share of the current prompt. A local model with a resident KV
  cache re-reads from the first changed character, so this is the number that
  decides whether a turn is cheap. Healthy looks like 95%+; the interceptor bug
  that prompted this project showed 25–55%.
- **Where the prompts diverged**, with an excerpt from each side. This turns "it
  feels slow" into "this block moved".
- **Every writer into the prompt**, in prompt order, with placement, depth and
  token share. More than one writer is the condition the design exists to
  remove, so the inspector says so plainly. A block parked for a macro ("Macro
  Only") is listed but not counted, because SillyTavern does not place it.
- **Which lorebook entries fired** this turn.

- **Whether the lorebook block was held**, and how many entries were in the
  held set — so a trace always says which regime produced it.

### What it cannot see

Attribution comes from ST's `extension_prompts`, so P0 can only name writers that
went through `setExtensionPrompt`. An extension that injects from its *generate
interceptor* — by splicing messages straight into the chat array, as WTrackerLite
does — contributes tokens that the inventory cannot attribute to anyone.

The stability meter is unaffected: it measures the finished prompt, so interceptor
content is in the number whether or not we can name it. But if the injected total
and the prompt total disagree, an interceptor is the first thing to suspect.

If the stability numbers do not show what `DESIGN.md` §4 predicts, P0's job is
to stop the project and force a rethink. It is a gate, not a warm-up.

## Holding the lorebook block

SillyTavern decides which World Info entries are active by scanning the last
couple of messages for keywords, every turn, from scratch. With recursion on, a
small seed cascades into a much larger set — and the set it reaches is stable,
because it is a fixed point of the lorebook's own cross-references.

The *path* to it is not stable. When the scan window happens to contain none of
the seed keywords, nothing activates, and the entire lore block disappears from
the prompt. The next turn it comes back. Measured on a real chat that is two
full prompt rebuilds in a row — worse than the summary see-saw it was hiding
behind, and it is invisible in play because the writing reads fine either way.

So Cairn remembers which entries have activated and pushes that set back in
before each scan, using ST's own `WORLDINFO_FORCE_ACTIVATE`. The rule is
**add-only**: an entry that has activated stays in, and a turn that activates
nothing changes nothing. There is no cadence and no staleness window — churning
a held block on a timer costs more rebuilds than the flicker it would fix.

Two consequences worth knowing:

- **Stale lore is cheap; evicting it is not.** An entry about a place you have
  left adds a little inert background. Removing it rebuilds the prompt. The
  asymmetry is the whole argument.
- **Editing a lorebook releases Cairn's hold on that book**, so your change
  appears on the next turn instead of being masked by the held copy.
- **Entries with a probability below 100% still roll every turn**, even while
  held, because SillyTavern rolls for forced entries too. Those entries can still
  drop out (`docs/decisions.md` D-0035).

Eviction is not abolished, only batched: when the World Info budget genuinely
binds, entries leave together rather than one keyword at a time.

## Planning the memory block

The summary block is the largest thing in the prompt — around 80% of what is sent
on a long chat — and it sits above the history, which is where it belongs. What
breaks the prompt is what happens *inside* it.

Today's memory extension moves both ends of the block on the same trigger. Every
tenth message the window slides: new summaries join the end and old ones fall off
the front. Because the front moved, the model re-reads the block and every
character below it. One collapse per ten messages, and it does not improve with
chat length — it is the steady state, not an event (`docs/decisions.md` D-0019).

Cairn separates the two:

- **Growth** advances in steps. Between steps the set of summaries is identical,
  so the block is byte-identical. When it does advance, the new summaries are
  appended to the **end** of an oldest-first block, so everything above them keeps
  the position the model already has cached.
- **Eviction** happens only when the block will not fit the prompt at all — and
  then it drops to half the budget rather than shaving off the one summary that
  overflowed, so the next rebuild is half a budget of growth away.

How much room the block gets is the short-term memory limit you already set in
the summarising extension — in tokens, or as a share of the prompt. Cairn does
not measure the rest of the prompt and adjust: the same chat always gets the same
block, so nothing it saw last turn can change this one.

Two things the inspector says about this, because neither is visible in play:

- **Where in the block the first change fell.** Near the end is the whole point;
  near the beginning means the block was rebuilt and nothing was gained. Measured
  on a real chat, a step turn kept about 68% of the prompt cached against 42% for
  a rebuild, and the quiet turns in between kept about 97% (`docs/decisions.md`
  D-0034).
- **Whether the two cadences have collapsed back into one.** The spacing between
  rebuilds is the slack a rebuild buys divided by what a step costs, so a context
  too tight to hold more than a step or two puts eviction back on every step. The
  block still looks correct while that happens, so the panel says it in words.

**Where the summaries come from.** Each message holds at most one summary. Cairn
reads the ones your summarising extension already wrote and never changes them,
and its own summaries go in `message.extra.cairn`. If a message has both, Cairn's
wins. Each of Cairn's summaries stores a hash of the message it summarised. If
you edit that message, the summary stops counting: the message's own text goes
back into the prompt, and the message is queued to be summarised again. Cairn
summarises only the messages after the newest one your extension summarised. It
skips hidden messages, messages under about 50 tokens, and the last message,
which can still be swiped or edited.

A step never moves past a message that is still waiting for its summary. The
block holds where it is, so no message leaves the history without a summary in
the block to replace it (`docs/p2-plan.md` §3).

The first turn after you open a chat or reload the page always rebuilds the
block, and it trims straight to half the limit while it is at it — that turn
re-reads everything anyway, so the room it frees costs nothing. From the second
turn on, the block only changes at its end until it outgrows the limit again.

## Writing summaries

After each reply, Cairn summarises the messages waiting for a summary, one
request at a time, oldest first, through the **Memory connection** profile. Each
request carries the message and the five summaries before it. A reply that
arrives after you have switched or reloaded the chat, edited the message or
deleted it is thrown away. The request is cancelled when the chat changes.

Cairn does nothing without a memory profile, in group chats, or while Qvink
Memory's **Auto Summarize** is on. Two extensions summarising the same message
would pay for it twice and race each other to store it.

A failed request writes nothing. That covers an error, a refusal, and a reply
cut off or in the wrong shape (`docs/p2-plan.md` §4). The first failure shows a
warning, and further failures stay in the console until a summary succeeds
again. A failure also ends the run, so an outage costs one request per reply,
and the next reply retries. A message that fails three times is left alone for
the rest of the session, unless you edit it. The memory step waits before that
message rather than moving past it, so the raw history grows instead of losing
anything.

Running the summaries never delays SillyTavern. It waits for every
`MESSAGE_RECEIVED` listener before it shows the reply, so Cairn starts the work
and returns at once.

## Taking over the injection

Cairn writes that block itself — but only once it is the *only* thing writing it.
Until then it plans, measures, and leaves the prompt alone.

Two things have to move together. If Cairn injects while your existing memory
extension injects, the summaries are in the prompt twice. If Cairn holds
summarised messages back while that extension also holds them back, two different
rules are deciding the same thing and the raw window is whichever ran last. So
Cairn checks, every turn, that:

1. the other extension is placing neither of its memory injections,
2. it is no longer excluding messages after its threshold, and
3. Cairn's own render of *its* selection has matched its live block byte for
   byte in this chat.

That third one is the interesting one. It has to be earned while the other
extension is still the writer — it is the evidence that swapping writers changes
nothing else about the prompt. Cairn remembers it for the rest of the chat, and
forgets it when the chat changes.

Cairn never flips those switches for you. Configuring another extension from
inside this one is the same "two systems, one prompt" problem in a different
costume, so the panel names the switch it is waiting for and stops there.

With Qvink Memory the two switches are **Memory position → Macro Only** (for both
short- and long-term) and **Exclude messages after threshold → off**. "Macro Only"
is the useful one: the block is still built, so Cairn can keep comparing against
it, but SillyTavern no longer places it.

When the gate opens, the block goes where the other extension had it — same
position, same depth, same role — so the handover changes exactly one thing.
Messages whose summaries the block carries stop being sent, using SillyTavern's
own ignore flag; the chat on screen and on disk is untouched.

## The shape of the problem

Memory extensions store a *compressed transcript*: messages become summaries,
summaries get re-summarised. Each pass averages load-bearing detail together
with texture, so the result degrades uniformly — and because summaries are
evicted under a token budget, it develops holes at the same time.

At generation time the model does not need a compressed transcript. It needs to
know what is true *now*, plus the occasional specific memory. Those are
different storage problems and Cairn treats them separately.

## The five tiers

| Tier | What | Update rule | Cost |
|---|---|---|---|
| 0 | Raw recent messages | ST's own — not ours | — |
| 1 | World state | Overwritten as a diff, never summarised | ~300–600 tokens, fixed |
| 2 | Scene summaries | Rolling, delta-written | Budgeted, compacted under pressure |
| 3 | Canon | Append-only one-liners, entity-tagged | Negligible per item |
| 4 | Episodes | Archived, entity-keyed | Off-prompt; retrieved on demand |

Tier 1 is the piece nothing else has in combination with the rest. State is
*overwritten* rather than summarised, so it always has a current value — it
cannot have gaps.

## One writer, ordered by volatility

Everything volatile sits *below* everything stable in the prompt, so a turn
rarely invalidates the cached prefix:

```
system / persona / character card      never changes
canon + stable lorebook content        rarely
scene summaries                        every N turns
  …raw chat history…
  depth 2:  world state                every N turns
  depth 0:  retrieved episodes         per turn
```

Cairn assembles all of it as one ordered plan and is the only writer, then
verifies the result before the request leaves. Per-turn retrieval is affordable
at all only because it sits at depth 0.

## Lorebook cooperation

World Info keeps doing retrieval and placement. Cairn holds the activated set
steady (above), which is enough to keep lore from moving the prompt around while
the memory block stays where it is. ST's `outlet` position would let Cairn place
lore itself, which only matters if the block ever moves (`docs/decisions.md`
D-0035).

## Compaction

Under budget pressure, in this order: **promote** durable facts into canon and
state, **merge** what remains about the same thread, **drop** texture with no
forward relevance. Sources are archived to tier 4 rather than destroyed, so a
bad pass is recoverable.

Recursive summarisation produces holes because it destroys the source before
extracting what must survive. Extraction goes first here, always.

## Storage and branching

Per-message data lives in `message.extra`, which branches and swipes correctly
for free. Chat-global stores live in `chatMetadata` with explicit checkpoints
keyed to message index, and roll back on a branch or swipe.
