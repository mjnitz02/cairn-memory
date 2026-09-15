# Cairn-Memory

A memory extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

Long roleplays lose the thread. Existing memory extensions treat memory as a
*compressed transcript* — messages in, summaries out, summaries re-summarised —
which degrades uniformly until everything is equally vague, and still develops
holes. Cairn treats memory as **state**: what is true right now, plus a sparse
set of retrievable past events.

> **Status: pre-alpha, early P1.** Cairn *measures* — it reports what your prompt
> is made of and how stable it is — and makes one change to it: lorebook entries
> are held in place once they have activated, so a keyword-scan miss cannot make
> the whole lore block vanish and come back. It also plans the memory block it
> *would* inject, from the summaries your existing memory extension has already
> written, and shows the two side by side. It writes no memory of its own and
> injects nothing, so it remains safe to run alongside that extension. The
> features below are being built in phases; see [`DESIGN.md`](DESIGN.md).

## The major choices

- **Memory is typed, not tiered by age.** Current world state, scene summaries,
  permanent canon and archived episodes each have their own update rule and
  lifetime. State is *overwritten*, so it cannot develop gaps.
- **One writer to the prompt.** Cairn assembles memory *and* lorebook content
  into a single ordered block with one budget. Two extensions injecting
  independently is how prompts quietly destabilise.
- **It cooperates with lorebooks rather than replacing them.** World Info keeps
  doing retrieval; Cairn takes over placement and budgeting, via ST's own
  outlet and force-activate mechanisms. An entry that has activated stays in
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
- A second connection profile for memory work — any competent non-roleplay
  model. It does not need to be large.
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

The **Memory connection** setting is inert until Cairn starts writing memory
(P2). When it does, point it at a profile that is *not* your roleplay model.

| Setting | What it does |
|---|---|
| Enabled | Turns Cairn off without uninstalling. Existing memory is kept. |
| Memory connection | The profile Cairn uses to write memory. Must not be your roleplay model. Not used yet. |
| Show inspector | Shows what was injected, from where, and how stable the prompt is. |
| Write inspector log to disk | Appends each generation to `user/files/cairn-inspector.jsonl`. |
| Hold World Info entries | Keeps a lorebook entry in the prompt once it has activated, instead of letting it drop out when the keyword scan misses it. On by default; off restores stock SillyTavern behaviour. |
| Debug logging | Verbose browser-console output. Only needed for bug reports. |

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
