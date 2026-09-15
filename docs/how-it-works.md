# How it works

A short map of the pieces. The reasoning behind them is in
[`DESIGN.md`](../DESIGN.md); this page says what is where.

> **Built today: P0 plus the first two steps of P1.** Cairn observes generations
> and reports on them, holds the lorebook block steady, and plans the memory
> block without yet injecting it. It writes no memory of its own, so it is still
> safe to run alongside an existing memory extension. Everything below "Planning
> the memory block" is design, not code.

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
  remove, so the inspector says so plainly.
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

How much room the block gets is worked out rather than configured: SillyTavern's
own prompt budget, minus what the rest of the prompt measured last turn. There is
no setting, because there is nothing to decide.

Two things the inspector says about this, because neither is visible in play:

- **Where in the block the first change fell.** Near the end is the whole point;
  near the beginning means the block was rebuilt and nothing was gained.
- **Whether the two cadences have collapsed back into one.** The spacing between
  rebuilds is the slack a rebuild buys divided by what a step costs, so a context
  too tight to hold more than a step or two puts eviction back on every step. The
  block still looks correct while that happens, so the panel says it in words.

Cairn does not inject any of this yet. Every turn it also renders the *existing*
extension's own selection and compares it to the block that extension actually
placed; until those match byte for byte, taking over would move the block and
change its contents at the same time, and no later measurement could tell the two
apart.

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

World Info keeps doing retrieval. Entries set to ST's `outlet` position are
parked rather than placed, and Cairn drops them into its own block at a stable
position — so lorebooks stop moving the prompt around underneath the memory
system, without a fork and without a second injector.

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
