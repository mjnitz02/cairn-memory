<p align="center">
  <img src="assets/banner.jpg" alt="Cairn Memory" width="800">
</p>

# Cairn-Memory

A memory extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Long roleplays lose the thread. Existing memory extensions treat memory as a
*compressed transcript* — messages in, summaries out, summaries re-summarised —
which degrades uniformly until everything is equally vague, and still develops
holes. Cairn treats memory as **state**: what is true right now, plus a sparse
set of retrievable past events.

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
  GLM-4.7 class or better, with reasoning off. Cairn turns it off itself on an
  OpenRouter profile; on any other source, turn it off in the profile's preset.
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
message and open **Last generation**.

Point **Memory model → Connection profile** at a profile that is *not* your
roleplay model. Without one, Cairn never calls a model. Each summary appears under
its message, with a collapsed **World state** below it, and Cairn never blocks
sending, so you can keep chatting while it works. To redo a summary, choose
**Summarise with Cairn** (the stacked-cubes icon) in the message's actions menu; to
redo the world state on a message, choose **Rebuild the world state** (the
stacked-boxes icon).

Everything below is on by default and works unconfigured.

| Setting | What it does |
|---|---|
| Enabled | Turns Cairn off without uninstalling. Existing memory is kept. |
| **Memory model** | |
| Connection profile | The profile Cairn uses to write summaries, the index, canon and the world state. Must not be your roleplay model. |
| Reasoning | How much the memory model may think: None (the default), Low, or whatever the profile's preset says. |
| **What Cairn keeps** | |
| Replace old messages with summaries | Cairn injects the summaries and keeps the messages they cover out of the history. It waits until your existing memory extension is silent — see below. |
| Track the world state | Where the scene is, who is there, the weather, and each character's hair and outfit, just above your newest message. Waits while WTracker or WTrackerLite is loaded. |
| Keep canon | Picks the few facts the story cannot be understood without from the whole index, and keeps them at the top of the memory block. Picked again as the story grows. |
| Canon entries | How many canon facts to pick. |
| Drop example dialogue once summarised | Strips the card's example dialogue once summaries stand in for the early chat, and puts SillyTavern's own setting back when off. |
| Hold lorebook entries | Keeps a lorebook entry in the prompt once it has activated, instead of letting it drop out when the keyword scan misses it. Off restores stock SillyTavern behaviour. |
| **Advanced settings** | Collapsed by default. |
| Memory budget | The memory block's share of the prompt, canon's share of the block, the one-line summaries' share of what is left, how many recent messages stay in full, how many build up before they are summarised, and the lorebook cap — the most tokens your lorebook may take, written into SillyTavern's own setting so it applies to every chat (**0** leaves it alone). |
| Memory prompts | The summary, index, canon and world-state prompts. Each has **Reset to default**, and falls back to its default if an edit loses the placeholder it needs. |
| Adopt this chat | Brings a chat started before Cairn up to date, or redoes an old one from scratch. |
| Diagnostics | **Show last generation** (the inspector), **Log each generation to disk** (`user/files/cairn-<chat>-<id>.jsonl`, one file per chat), and **Debug logging** for bug reports. |

**Last generation**, folded under the settings, shows what was injected, from
where, how stable the prompt is, and the canon in the prompt.

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

Disabling or uninstalling Qvink does all of the above at once. The inspector's
**Writing** line says whether Cairn is the writer and, if not, exactly what it is
waiting for.

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
