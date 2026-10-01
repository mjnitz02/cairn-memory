# Contributing

Cairn is a pre-release, single-maintainer project. It is open source in case the
approach helps someone, and it is still changing fast. That shapes how
contributions are handled:

- **Bug reports and ideas are welcome** via
  [issues](https://github.com/mjnitz02/cairn-memory/issues).
- **Open an issue before a non-trivial PR.** PRs may be declined if they don't
  fit the design, even when they're well made.

## Where things are

| | |
|---|---|
| [`DESIGN.md`](../DESIGN.md) | Why Cairn works the way it does |
| [`CLAUDE.md`](../CLAUDE.md) | The house rules — how code, tests and docs are written here |
| [`docs/decisions.md`](../docs/decisions.md) | What was decided, when, why, and what would reopen it |
| [`docs/development.md`](../docs/development.md) | Setup, the local gate, working against a local SillyTavern |

Settled decisions are not re-argued in a PR. New evidence gets a new entry in
the decision log that supersedes the old one.

## The rules that most often matter in a PR

- **Zero runtime dependencies**, no build step. SillyTavern loads the files as
  they are.
- **Cairn never breaks the chat.** A failure inside a generate hook injects
  nothing new and shows one toast; errors never reach SillyTavern's generation path.
- **Every claim about SillyTavern internals cites `file:line`** from the pinned
  checkout, and every API we call is listed in `docs/st-api-surface.md`.
- **Fixtures are synthetic in content, real in shape.** This repo is public: no
  real chat logs, character cards, personas or names — not in tests, docs or
  examples.
- **Few knobs.** A new setting needs a one-sentence description, a default that
  works unconfigured, and a reason it can't be derived.

## Before you open a PR

```sh
make install   # npm ci
make check     # lint, version check, rule references, tests, secret scan, verify-st
```

`verify-st` needs a local SillyTavern checkout; CI runs everything else.

- Bump the version in both `manifest.json` and `package.json` (`make bump`) —
  CI fails a PR that doesn't. Dependabot PRs are exempt, and merge themselves
  once CI is green.
- Add a `CHANGELOG.md` line for anything a user would notice.
- Update the docs that describe the behaviour you changed, in the same PR.
- Fill in the PR template.

## License

By contributing, you agree your contributions are licensed under the
[MIT License](../LICENSE).
