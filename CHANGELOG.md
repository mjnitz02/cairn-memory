# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Breaking means the stored data shape changed**, not the API — a major bump is
about your accumulated memory, not our internals (CLAUDE.md §8.32).

## [Unreleased]

## [0.3.1] — 2026-09-15

### Fixed

- Injection token counts used the chars/4 estimate while the prompt total used
  ST's tokenizer, so the two were not comparable — an injection inside its
  budget could read as ~30% over it. Injections now use the real tokenizer, and
  the log carries `injected_tokens_estimated` when they fall back.
- `.cairn-settings label` beat ST's `.checkbox_label` on specificity and stacked
  every checkbox. The inspector also scrolls now instead of blowing out the
  drawer.

## [0.3.0] — 2026-09-15

### Added

- **Inspector log on disk.** Each observed generation is appended to
  `data/<user>/user/files/cairn-inspector.jsonl` as one flat JSON line, so a run
  can be read or scripted against instead of copied out of the panel by hand.
  Uses ST's own Data Bank endpoint; no server plugin. New setting, on by default,
  and writes are debounced.

### Changed

- A settings version with no registered migration now merges defaults instead of
  resetting to them. Losing someone's configuration to our own gap is not an
  acceptable failure mode.
- The migration engine is exported as `applyMigrations` so paths that only open
  up at a future schema version are tested now rather than in production.

## [0.2.2] — 2026-09-15

### Fixed

- The inspector reported "0 injections" while other extensions were visibly
  injecting. Cairn captured `SillyTavern.getContext()` once at load, but ST
  reassigns `extension_prompts` when a chat opens, so the observer was reading
  an orphaned object. The context is now re-read on every observation, which
  also fixes a stale `maxContext` after a preset change.

## [0.2.1] — 2026-09-15

### Fixed

- The stability meter kept one baseline across both generation paths, so the
  first turn after switching connection profiles compared a text-completion
  string against a flattened chat-completion array and reported a collapse that
  was an artifact of the switch. Baselines are now per-API.

## [0.2.0] — 2026-09-15

Phase P0: instrumentation. Read-only — Cairn observes generations and writes
nothing into the prompt yet, so it is safe to run alongside an existing memory
extension.

### Added

- Prompt observer, watching both generation paths (text completion and chat
  completion). It reads the outgoing prompt in place: no write-back, no cloning.
- **Prefix stability meter** — how much of this turn's prompt the model had
  already cached, with the divergence point and an excerpt of what changed.
- Injection inventory: every writer into the prompt, in prompt order, with
  placement, depth and token share — and a warning when more than one extension
  is writing.
- World Info accounting: which lorebook entries fired for the turn.
- Inspector panel in the extension settings drawer, updating each generation.

### Changed

- `docs/st-api-surface.md` now covers 36 verified citations, up from 29.

## [0.1.0] — 2026-09-15

### Added

- Project scaffold: `Makefile`, ESLint, Vitest, GitHub Actions (lint, tests on
  Node 20/22/24, secret scan, version check, CodeQL).
- Settings panel with the four P0 settings, and a versioned settings schema with
  a forward-migration runner.
- SillyTavern and memory-model mocks built against the real ST shapes, including
  the catalogue of malformed model output that parsers must survive.
- `make verify-st`: machine-checks every `file:line` citation in
  `docs/st-api-surface.md` against a local SillyTavern checkout.
- Documentation: design, decision log, ST API surface, development guide.

[Unreleased]: https://github.com/mjnitz02/cairn-memory/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/mjnitz02/cairn-memory/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/mjnitz02/cairn-memory/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mjnitz02/cairn-memory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mjnitz02/cairn-memory/releases/tag/v0.1.0
