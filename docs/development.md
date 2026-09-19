# Development

Cairn ships as raw browser ES modules with no build step. SillyTavern loads only
what `manifest.json` lists; `package.json` is dev tooling and never reaches the
browser.

## Setup

```sh
make install     # npm ci
make help        # every target
```

## The gate

```sh
make check       # lint + version-check + verify-rules + tests + secrets + verify-st
```

CI runs all of it except `verify-st`, which needs a SillyTavern checkout that CI
does not have. Every CI step exists here under the same target name — if you can
run `make check`, you know what CI will say.

| Target | |
|---|---|
| `make lint` | ESLint over the browser modules |
| `make test` | Vitest, once |
| `make test-watch` | Vitest, watching |
| `make version-check` | `manifest.json` and `package.json` versions agree |
| `make verify-st` | Re-check `docs/st-api-surface.md` against a local ST |
| `make verify-rules` | Every `CLAUDE.md §N.M`, `docs/<page>.md` and `D-NNNN` reference still resolves |

## Working against a local SillyTavern

Symlink the repo into your ST extensions directory so edits are live:

```sh
ln -s ~/workspaces/cairn-memory \
  ~/workspaces/SillyTavern/data/default-user/extensions/cairn-memory
```

The folder name matters — it is the template path in
`src/constants.js` (`third-party/cairn-memory`).

`make verify-st` defaults to `~/workspaces/SillyTavern`; override with
`make verify-st ST_PATH=/path/to/SillyTavern`.

## Testing

Everything under `src/` that we test is pure logic — no DOM, no ST, no network.
If a module cannot be tested that way, the ST coupling is in the wrong place.

- `test/mocks/sillytavern.js` — the ST surface, mirroring the real shapes. Every
  field cites the `file:line` it was taken from. It is a deliberate *subset*: an
  unlisted field means we have not declared that dependency yet.
- `test/mocks/llm.js` — the memory model, including `badOutputs`: fenced JSON,
  preamble chatter, truncation, refusals, schema violations, leaked reasoning.
  Parsers are tested against these, because this is what mid-tier models
  actually return.
- `test/mocks/qvink.js` — qvink-memory's `message.extra` shape: the per-message
  summary records the scene reader parses, with the flags that decide what it
  would have injected. Shape confirmed against the corpus, content invented.
- `test/mocks.test.js` — guards the mocks themselves. A mock that has drifted
  from ST is worse than no mock; it makes broken code pass.

**Fixtures are synthetic in content, real in shape.** This repo is public, so no
real chat logs, character cards, personas or names land in it — anywhere. But a
fixture whose structure was invented only proves the test agrees with our guess,
so the shape is confirmed against real captured chats first and the fixture says
which real shape it mirrors. The corpus lives outside the repo at
`~/workspaces/cairn-corpus` and nothing in this repo writes to it.

## Adding a SillyTavern dependency

1. Find it in the checkout and read it. Do not assume a signature.
2. Add a row to `docs/st-api-surface.md` with the `file:line`.
3. Mirror the shape in `test/mocks/sillytavern.js`, citing the same line.
4. `make verify-st`.

## Changing a stored shape

Anything written into `message.extra` or `chatMetadata` is someone's accumulated
memory. A change to its shape needs:

1. A version bump in `src/store/schema.js`.
2. A migration registered alongside it.
3. A test fixture of the **old** shape, proving the migration loads it.
4. A `CHANGELOG.md` entry.

## Reading a run

With **Write inspector log to disk** on (the default), every observed generation
appends a flat JSON line to:

```
~/workspaces/SillyTavern/data/default-user/user/files/cairn-inspector.jsonl
```

One line per generation, with `stability_percent`, `prompt_tokens`,
`injected_tokens`, `writers`, the per-injection breakdown and the divergence
excerpts. To watch the stability curve of a session:

```sh
jq -r '[.api, .stability_percent, .prompt_tokens, .writers] | @tsv' \
  ~/workspaces/SillyTavern/data/default-user/user/files/cairn-inspector.jsonl
```

The file is rewritten in full on each write (ST's endpoint replaces files rather
than appending) and reset when the chat changes.

## Driving a long run

A phase gate wants tens of unattended turns.
[`scripts/autoplay.user.js`](../scripts/autoplay.user.js) is a Tampermonkey
userscript that plays them. It is a dev harness: `manifest.json` does not load it
and it ships with nothing.

Install it in Tampermonkey, adjust `@match` if SillyTavern is not on port 8181,
and keep **`@grant none`** — the script needs page context to reach
`globalThis.SillyTavern` (`public/scripts/st-context.js:115`). An overlay appears
bottom-right with the turn count, a settle delay and a Run/Pause toggle.

One turn in `impersonate` mode is `/impersonate await=true`, which leaves the
generated user line in `#send_textarea` (`public/script.js:5524`), then a click on
`#send_but`, which is the path a hand-played turn takes
(`public/script.js:11160`). Completion is read from `chat.length` growing by two,
then from ST clearing `document.body.dataset.generating`
(`public/script.js:7088`). `continue` mode runs `/continue await=true` instead.

Two things to hold in mind when reading the log afterwards:

- **A turn is two generations.** Cairn's interceptor skips only quiet prompts
  (`src/prompt/injector.js:106`), so the impersonation gets the memory block too
  and is logged alongside the story generation. Size a run by its events, not by
  the turn counter.
- **The settle delay does not know about Cairn.** It is a fixed sleep, not a wait
  on the summariser's queue draining, so a long backlog can still be in flight
  when the next turn starts. Raise the delay if `pending` is climbing.

## House rules

[`CLAUDE.md`](../CLAUDE.md) is the full set and takes precedence over habit.
