# Cairn-Memory

A memory extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Long roleplays lose the thread. Existing memory extensions treat memory as a
*compressed transcript* — messages in, summaries out, summaries re-summarised —
which degrades uniformly until everything is equally vague, and still develops
holes. Cairn treats memory as **state**: what is true right now, plus a sparse
set of retrievable past events.

> **Status: pre-alpha, P1.** Cairn *measures* — it reports what your prompt is
> made of and how stable it is — and makes two changes to it. Lorebook entries are
> held in place once they have activated, so a keyword-scan miss cannot make the
> whole lore block vanish and come back. And it assembles the memory block from
> the summaries your existing memory extension has already written, injecting it
> and keeping the messages it covers out of the history — but only once that
> extension has been silenced and Cairn has proved it renders the same block, byte
> for byte. Until then it plans and compares and leaves the prompt alone, so it
> stays safe to run alongside. Once that extension stops summarising, Cairn writes
> its own summaries too, one per message. The features below are being built in
> phases; see [`DESIGN.md`](DESIGN.md).

## The major choices

- **Memory is typed, not tiered by age.** Current world state, scene summaries,
  permanent canon and archived episodes each have their own update rule and
  lifetime. State is *overwritten*, so it cannot develop gaps.
- **One writer to the prompt.** Cairn assembles memory *and* lorebook content
  into a single ordered block with one budget. Two extensions injecting
  independently is how prompts quietly destabilise.
- **It cooperates with lorebooks rather than replacing them.** World Info keeps
  doing retrieval; Cairn keeps it steady, via ST's own force-activate
  mechanism. An entry that has activated stays in
  until the budget genuinely evicts it, rather than flickering with the keywords
  in the last two messages.
- **A separate model writes memory.** Your roleplay model is tuned to be
  evocative, which is the opposite of what summarisation needs. Cairn requires
  its own connection profile and does nothing without one.
- **Compaction extracts before it compresses.** Durable facts are promoted to
  permanent storage *first*, then the remainder is merged or dropped. Nothing is
  destroyed before what matters is pulled out of it.
- **Few knobs.** If a setting can be derived, it is derived.

## Requirements

- SillyTavern **1.19.0** or newer
- A second connection profile for memory work: a strong non-roleplay model,
  GLM-4.7 class or better.
- Single-character chats. Group chats are not supported.

## Install

In SillyTavern: **Extensions → Install extension**, and paste:

```
https://github.com/mjnitz02/cairn-memory
```

Or clone into your ST data directory:

```sh
git clone https://github.com/mjnitz02/cairn-memory \
  ~/SillyTavern/data/default-user/extensions/cairn-memory
```

Reload SillyTavern afterwards.

## Use

Open **Extensions → Cairn-Memory**. There is very little to configure — send a
message and read the inspector.

Point **Memory connection** at a profile that is *not* your roleplay model.
Without one, Cairn never calls a model.

| Setting | What it does |
|---|---|
| Enabled | Turns Cairn off without uninstalling. Existing memory is kept. |
| Memory connection | The profile Cairn uses to write summaries. Must not be your roleplay model. |
| Show inspector | Shows what was injected, from where, and how stable the prompt is. |
| Write inspector log to disk | Appends each generation to `user/files/cairn-inspector.jsonl`. |
| Hold World Info entries | Keeps a lorebook entry in the prompt once it has activated, instead of letting it drop out when the keyword scan misses it. On by default; off restores stock SillyTavern behaviour. |
| Write the memory block | Lets Cairn inject the summaries and keep the messages they cover out of the history. On by default, but Cairn waits until your existing memory extension is silent — see below. |
| Debug logging | Verbose browser-console output. Only needed for bug reports. |

### Handing over from Qvink Memory

Cairn reads the summaries Qvink Memory has already written, so nothing is
migrated and nothing is lost. To let Cairn take over the prompt, in **Qvink
Memory**:

1. set **short-term** and **long-term memory position** to **Macro Only** —
   Qvink keeps building its block, SillyTavern stops placing it;
2. turn off **Exclude messages after threshold**.

Qvink can keep summarising, and Cairn keeps reading what it writes. To have Cairn
write the summaries instead, **back up your chats**, then turn off Qvink's **Auto
Summarize**. Cairn starts after the newest summary Qvink wrote and never changes
Qvink's. Each summary is saved on its message, so it survives uninstalling Qvink.

Cairn will not take over until it has also rendered Qvink's own block byte for
byte at least once in that chat — so send a message or two *before* flipping the
switches. The inspector's **Writing** line says whether Cairn is the writer and,
if not, exactly what it is waiting for.

## Documentation

| | |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Why it works this way — the full design |
| [`docs/how-it-works.md`](docs/how-it-works.md) | How the pieces fit together |
| [`docs/development.md`](docs/development.md) | Setup, tests, the local gate |
| [`docs/decisions.md`](docs/decisions.md) | What was decided, when, and why |
| [`docs/st-api-surface.md`](docs/st-api-surface.md) | Every SillyTavern API we depend on |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed |

## License

MIT — see [`LICENSE`](LICENSE).
