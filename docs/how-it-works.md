# How it works

A short map of the pieces. The reasoning behind them is in
[`DESIGN.md`](../DESIGN.md); this page says what is where.

> **Built today: P0 to P2.** Cairn observes generations and reports on them,
> holds the lorebook block steady, writes its own summaries, and writes the memory
> block from them and from any your previous memory extension made. That
> extension can be disabled or uninstalled. Everything from "The shape of the
> problem" down is design, not code.

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

### Two fidelities, so old scenes fade rather than vanish

A summary pushed out of the block used to be gone. Now it is **demoted** first: the
block keeps part of its budget — at most a fifth by default, **Short-summary share** in
the settings — for one-sentence versions of older summaries,
so the oldest part of the chat is present in less detail instead of absent. Only when
the compact tail is full as well does anything leave.

The one sentence is not a fresh summary of the message. It comes from the index
record written beside each summary (below), which holds both the structure the canon
pass reads and one plain sentence for this. Writing it there rather than as a second
summary is why the longer memory costs no extra model call.

Three things follow, and they are the ones worth knowing:

- **The tail's share is a ceiling, not a reservation.** Until those sentences exist —
  a fresh install, a chat Cairn has not caught up on — full summaries keep the whole
  budget. Nothing is held back for a tail that cannot be filled.
- **Demotion happens only on a turn that was rebuilding the block anyway.** Replacing
  a summary with its sentence rewrites the same part of the prompt that dropping it
  would, so it is done on the same turns and costs no extra cache miss.
- **A summary with no sentence evicts exactly as it did before.** If the index has
  fallen behind, the block is no worse than it was; it simply misses that line.

On the measured chat this roughly doubles how much of the story the block holds —
about 86 summaries where it held 51 — for the same tokens (`docs/decisions.md`
D-0075, D-0076).

### How much room the block gets

At most 35% of the prompt SillyTavern may send — the context window minus the
reserved response — and less than that when the rest of the prompt does not leave
that much (`docs/decisions.md` D-0038, D-0052). The 35% is **Memory share** in the
settings (D-0085), and Qvink's short-term limit no longer counts.

What is left over is what the rest of the prompt does not need:

| Reserved for | Worked out from |
|---|---|
| The character card | The card fields that reach the prompt, and the system prompt SillyTavern would use |
| The lorebook | SillyTavern's own World Info budget, or every enabled entry if they come to less |
| The raw history | The heaviest run of messages your chat has had at the widest the raw window ever gets — **Recent messages kept in full** plus one **Summary step**, less one: fifteen by default |
| The world state | Its largest possible size, or nothing while it is switched off |
| Everything else | 5% of the prompt, for instruct wrappers, other extensions and the tokenizer's own error |

**None of it is measured from a prompt that went out.** Every number above comes
from the chat and your settings, so the same chat always gets the same block,
nothing Cairn saw last turn can change this one, and reloading the page costs no
warm-up. Nothing is stored, either.

That also means the cap holds still. It moves when one of its inputs moves — you
edit the card or a lorebook, you change the context size or response length, or
your chat writes a heavier run of messages than it ever has — and on no other
turn. A cap that falls below the block costs one rebuild; a cap that rises costs
nothing and never brings evicted summaries back. If a reserve cannot be read at
all, the block keeps the flat 35% and the inspector says so.

On a chat whose card, lorebook and history already fill the prompt, the block
keeps a tenth of it and the inspector calls the chat starved: an empty block
would lose all of the memory to save a few raw messages.

Because every reserve is a ceiling, a full prompt should land under 95% of the
limit. The inspector warns, and the log sets `prompt_near_limit`, when one does
not — which now means a reserve missed something rather than that the block was
too greedy. On text completion SillyTavern fills the history to the limit and
then fits the card's example messages into what is left, so an overfull prompt
loses the examples and the oldest messages without saying so.

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

### Where the summaries come from

Each message holds at most one summary (`docs/decisions.md` D-0037). Cairn
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
the block to replace it. That only happens when the memory model falls behind: a
message can be summarised once it is one message old and leaves the history at
eleven, so the queue has to be about five exchanges behind.

The first turn after you open a chat or reload the page always rebuilds the
block, and it trims straight to half the limit while it is at it — that turn
re-reads everything anyway, so the room it frees costs nothing. From the second
turn on, the block only changes at its end until it outgrows the limit again.

## Writing summaries

After each reply, and as soon as you edit a message, Cairn summarises the
messages waiting for a summary, one request at a time, oldest first, through the **Memory connection** profile. Each
request carries the message and the five summaries before it. A reply that
arrives after you have switched or reloaded the chat, edited the message or
deleted it is thrown away. The request is cancelled when the chat changes.

Cairn does nothing without a memory profile, in group chats, or while Qvink
Memory is running with **Auto Summarize** on. Two extensions summarising the same
message would pay for it twice and race each other to store it. A disabled or
uninstalled Qvink doesn't count: SillyTavern keeps its settings, but nothing reads
them.

A failed request writes nothing. That covers an error, a refusal, and a reply
cut off or in the wrong shape (see **The reply** below). The first failure shows a
warning, and further failures stay in the console until a summary succeeds
again. A failure also ends the run, so an outage costs one request per reply,
and the next reply retries. A message that fails three times is left alone for
the rest of the session, unless you edit it. The memory step waits before that
message rather than moving past it, so the raw history grows instead of losing
anything.

Nothing starts when you send a message, because that's when the chat model starts
generating, and on a shared or local backend a summary would compete with it.
Running the summaries never delays SillyTavern. It waits for every
`MESSAGE_RECEIVED` listener before it shows the reply, so Cairn starts the work
and returns at once. Unlike Qvink with **Block generation** on, Cairn never holds
up your next message either, so you can keep chatting while a summary is written.
The message you send is the newest, so it's summarised after the next reply. If
summaries fall behind, the memory step waits for them instead of moving past.

**In the chat**, each summary appears under its message, where Qvink shows its
own. While a request is out, the message being summarised says so, and the ones
behind it say they're waiting. A failure shows its reason under the message and
says whether Cairn will retry after the next reply or has given up. Qvink's
summaries are shown too, as `Qvink:`, while Qvink isn't loaded or has its own
display turned off, and one excluded in Qvink is dimmed. The chat shows what the
block reads: a message whose Cairn summary went stale after an edit shows neither.

**Summarise with Cairn**, in a message's actions menu, sends that message to the
memory model again. The request is the one the queue would send, and it goes
next, after any state update. A new summary replaces the one there, Cairn's or
Qvink's; a failure keeps it and says so every time. It works on any message long
enough to summarise, including the last one and messages older than Qvink's newest
summary, which the queue skips, and it gives a message Cairn gave up on a fresh
start. It waits on the same switches as the queue and says which one is closed.
Replacing a summary that is already in the memory block changes the block from
that summary on, so the next prompt misses the cache from there, as an edit would.

**The prompt** is the **Summary prompt** setting. `{{message}}` is the message as
`Name: text`, and `{{history}}` is the summaries before it, one per line.
`{{#if history}}…{{/if}}` works as it does in Qvink, so a Qvink prompt can be pasted
in unchanged, and so do SillyTavern's own macros, such as `{{char}}`. SillyTavern's
macros are expanded before the message goes in, so a `{{user}}` typed in the chat
reaches the model as typed. The box shows the default until you edit it, and an
unedited prompt keeps following the default when it changes. A prompt with no
`{{message}}` can't summarise anything, so Cairn uses the default and warns once.
Editing the prompt doesn't rewrite existing summaries. Each summary stores a hash
of the prompt that wrote it.

**The reply** is cleaned into one paragraph: `<think>` blocks, code fences, list
markers and a leading `Summary:` label are removed. SillyTavern doesn't say whether
a reply was cut off, so Cairn rejects one that doesn't end in sentence-ending
punctuation. It also rejects a reply that is empty, opens like a refusal, looks like
JSON, or runs past 1,500 characters. A refusal worded in a way Cairn doesn't
recognise is stored as a summary; editing the message gets it written again.

**The panel** has a **Summaries** section that updates as requests go out and come
back, not only when a reply is generated. It shows what Cairn is doing (writing
message #12, 2 waiting, up to date, or the switch it is waiting on), and for the open
chat: summaries written, requests, failures and the last reason, the average time
per request, and tokens in and out. Tokens are counted with SillyTavern's
tokenizer, which is the chat model's, so they are estimates. A message Cairn gave
up on gets a warning, because it holds the memory step. The memory block section
says who wrote the summaries in the block (Qvink, Cairn, or both) and whether a
step is waiting for a summary.

**The log** records the same numbers with each generation, never a summary's text:
`memory_source`, `memory_cairn_scenes`, `memory_step_waiting`, and the `summary_*`
fields. The counts, times and token totals are running totals for the chat since the page
loaded, so the work between two generations is the difference between two lines.
Reloading the same chat keeps them, and switching chats starts them again. Each chat
has its own log file, appended to across sessions (`docs/development.md`, "Reading a run").
`summary_in_flight` is true when a summary request was still out as the prompt was
built. That is how a run shows a summary overlapping a generation.

## Keeping the world state

Cairn keeps a short record of the scene's hard facts: where it is, the weather,
who is there, and each character's hair and outfit. A character card fixes these
("wears a combat uniform"), and when the story changes one, summaries tend to
leave the change out, so the old fact creeps back. Mood, time and plot aren't
recorded, because the roleplay model is the one telling the story. A typical
state is about 55 tokens, and the largest the fields allow is about 330.

**When it runs.** In the same run as the summaries, before them, because the next
prompt carries it. After each reply, and as soon as you edit a message, Cairn sends
the memory model the record as it stands and the messages since it (at most 6 of
the newest), and asks for the whole record back, accurate as of the last message. A
cold start on a long chat sends the summaries just before those 6 as background,
so it is still one request.

**Nothing is ever cleared.** A field the reply leaves out keeps the value it had,
and so does one the model sends blank or too long. A filled field is the whole
point of the tier — an empty one lets the character card's original wording win
again — and nothing here can stop being true: a character always has hair, and is
either wearing something or isn't. What the reply *does* decide is who is in the
scene: the characters it lists are the characters present, so leaving someone out
is how they leave. A reply that lists nobody at all is ignored.

The
state is stored on the newest message it read, in `message.extra.cairn.state`,
with a hash of the messages it read. A reply that arrives after any of those
messages changed, or after you left the chat, is thrown away. A failed state
update writes nothing, warns once per run of failures, and doesn't stop the
summaries. After three failures on the same messages Cairn stops trying until a
new message arrives or one is edited.

**Where it goes.** In the chat, directly after the newest message the state has
read, with the system role. In normal play that is just above your newest
message, so the model reads the scene as the reply you are answering left it.
When the queue is behind, the state sits deeper, still after the message it read.
The state is found by its message, not by position, so:

- **a swipe** uses the state before the reply being replaced, and a new swipe gets
  its own state. Swiping back brings the old swipe's state back with it;
- **an edit, hide or deletion** inside what a state read makes that state stale, and
  the one before it is used until it is rewritten. Later states stay valid;
- **a branch** keeps the states on the messages it copies.

A state older than the memory step, on a message the block already summarises, is
left out, since the summaries are newer than it. While WTracker or WTrackerLite is
loaded, Cairn neither updates nor places the state, so there is never a second
state in the prompt.

**In the chat**, each message that carries a usable state has a collapsed **World
state** under it, holding the text as the prompt would carry it. Stale states are
not shown. Nothing is shown while the switch is off or a WTracker is loaded.

**The switch** is **Keep the world state**, on by default. It does nothing until a
memory profile is chosen. Turned off, the state leaves the prompt at the next
generation and no more state requests go out.

**The panel** has a **World state** section: what the queue is doing (writing, up to
date, waiting on WTrackerLite, or gave up), the state as the last prompt carried it,
its depth, size and the kinds of its last change, then requests, failures, dropped
fields, time and tokens for the open chat. **The log** records the same without the
state's text: `state_injected`, `state_reason`, `state_depth`, `state_chars`,
`state_tokens`, `state_changed`, `state_change_kinds`, and the queue's `state_*`
running totals. `state_changed` says the text differs from last turn's, so the
prefix should break inside `cairn_state`.

## Taking over the injection

Cairn writes that block itself — but only once it is the *only* thing writing it.
Until then it plans, measures, and leaves the prompt alone.

Two things have to move together. If Cairn injects while your existing memory
extension injects, the summaries are in the prompt twice. If Cairn holds
summarised messages back while that extension also holds them back, two different
rules are deciding the same thing and the raw window is whichever ran last. So
Cairn checks, every turn, that:

1. the other extension is placing neither of its memory injections, and
2. it is no longer excluding messages after its threshold.

The second check applies only while Qvink is loaded. Disabling or uninstalling it
satisfies both.

Cairn never flips those switches for you. Configuring another extension from
inside this one is the same "two systems, one prompt" problem in a different
costume, so the panel names the switch it is waiting for and stops there.

With Qvink Memory the two switches are **Memory position → Macro Only** (for both
short- and long-term) and **Exclude messages after threshold → off**.

The block is Cairn's own and reads nothing from Qvink's settings. It uses Qvink's
default template and `\n* ` separator, and goes after the story string with the
system role, where Qvink puts it by default. A chat handed over from a Qvink on its
default template keeps its block byte for byte. Messages whose summaries the block
carries stop being sent, using SillyTavern's own ignore flag; the chat on screen
and on disk is untouched.

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
| 1 | World state | Overwritten as a diff, never summarised | ~55 tokens typical, ~330 at most |
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
  after the newest message it read:
            world state                every reply
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

Recursive summarisation produces holes because it destroys the source before
extracting what must survive. Extraction goes first here, always.

Cairn keeps a short **canon** at the head of the block: the few facts the rest of
the story cannot be understood without.

It is a **pick over the index**, not a promotion out of what is about to be evicted.
Once every summary in the chat carries a compact record, Cairn sends the whole index
— the story at about a fifth of the tokens, with its structure made explicit — and
asks for *exactly* N facts. A fixed budget is the calibration: asked whether a thing
is permanent, a small model says yes to everything; asked to choose ten rows out of
a hundred and fifty, it has to rank them.

```
[Established facts]:

* Her brother drowned in the spring flood.
* They kissed on the lighthouse stair.

[Following is a list of recent events]:

* …
```

**A chat with no canon renders exactly the bytes it did before**, section and all.

**Why the whole index and not the evicted summaries.** Eviction from the prompt has
nothing to do with what is available on disk: the chat file holds every summary,
including ones that scrolled out of the block long before Cairn was installed. A pass
that reads only what is about to be dropped is a local window ranking global
importance, and most of any window sampled by recency is description and scenery. The
earlier design did exactly that, and the canon it produced read like a different,
lighter story than the one being played. Reading the index end to end is what fixed it.

**A wrong fact is no longer permanent.** Each fact cites the records it was picked
from, so canon is *derived* rather than remembered: fix a summary, edit a message or
branch away from a scene and the facts resting on it go with it, and the next pick
fills the slots again over the index as it now stands. Nothing has to be rolled back,
because nothing was ever stored except the answer.

**Canon changes only at a rebuild.** Canon sits above every summary, so changing it
rewrites the block's head — the expensive break. A rebuild rewrites the head anyway,
so a pick written between rebuilds is held back until the turn eviction fires, and
the two head-changes cost one break instead of two. Between rebuilds the canon text is
byte-identical. The pick itself is the lowest-priority memory call: behind the world
state, which the very next prompt carries, behind the summaries, one of which can hold
the see-saw step, and behind the index records the pick reads.

**How many lines is the one knob, and it is a count rather than a budget.** The spine
of a story does not grow as the story does — someone arriving or leaving, something
permanently won or lost, are necessarily rare — so a three-hundred-message chat wants
about the same eight to twelve lines a short one does. Leftover room falls back to
summaries rather than being held.

**Canon's room.** It takes at most a fifth of the block — **Canon share** in the
settings — and never more than the block has left after reserving two see-saw steps
for the summaries. That second term is a guard: canon takes its room from the scene budget,
so it is the one thing that could collapse growth and eviction back into a single
cadence. Reserving two steps makes that arithmetically impossible — canon is
squeezed to nothing first, which is the right order of sacrifice, because the
summaries are the memory and canon is only what is left of the ones already gone.

**And the room is settled at the rebuild, not every turn.** Both terms above move
as a chat runs — the block's cap falls as the card, lorebook and raw window grow,
and a see-saw step costs more as summaries lengthen — so a cap applied live would
re-cut the block's head on ordinary turns. Canon is fitted to the cap that was in
force at the last rebuild and held there until the next one, which is the only turn
the head changes anyway. The cost is that canon can sit a little above its live
share mid-cycle, bounded by what it held at that rebuild; the log carries both
numbers as `memory_canon_cap` and `memory_canon_cap_applied`
(`docs/decisions.md` D-0059).

**The label on a record never decides what may be picked — so the pick never sees it.**
Each record carries a four-way kind — someone arriving or leaving, something large
happening, description, filler — which the inspector and the log count. A local label is
not stable under hindsight: a purchase is filler until it turns out to be where they
settled. Told the kind was only a hint, lower-tier models obeyed it anyway: the promise
the measured story rests on was labelled *filler* in twelve runs of fifteen and never
picked. So the index the pick reads has no kind column at all (`docs/decisions.md` D-0084).


**What the parser guarantees, and what it cannot.** The prompt states a length; a fact
that runs past it by half again is cut at a word rather than thrown away, a repeat is
refused, a fact citing no row at all is refused —
an uncitable fact would be a permanent one again — and every pick is shown in the chat
under the message it was written on. What the panel reports is what was actually
written, never what the model claimed. What no parser can check is whether the chosen
facts are the *right* ones; that is read against the story itself.

Two of the three operations `DESIGN.md` §8 declares are built: **pick**, which replaced
promotion, and **drop**, which the budgeter already did. **Merge** is moot for a fixed
slot count — the pick re-ranks rather than accumulating — and what it was for, making
room once canon is full, is now a question the next pick answers on its own.

## Storage and branching

Per-message data lives in `message.extra`, which branches and swipes correctly for
free. Every tier uses it: a summary on the message it summarises, its compact record
beside it, a world state on the newest message it read, and a canon pick on the newest
record it read.

Nothing records which of them is current. The newest valid state wins, the newest pick
wins, and both are read fresh every turn — so a branch, a swipe or a deletion rolls the
memory back by taking the messages with it, and there is no checkpoint to keep in step
and no rollback code to get wrong. A pick lands on a message behind the raw window by
construction, where swipes never reach. A record is hashed against the summary it was
read from rather than the message, so re-summarising a message invalidates its record
too — and the facts that cited it with it.

**Cairn keeps nothing in `chatMetadata`.** The design once put canon there with
checkpoints keyed to message index; per-message storage removed the need
(`docs/decisions.md` D-0055).
