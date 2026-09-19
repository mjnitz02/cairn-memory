# Cairn — house rules

Cairn is a SillyTavern memory extension. `DESIGN.md` is the *why*; this file is the *how*.

These rules override general SillyTavern-extension convention and any default habit. They exist
so we stop re-deciding settled things. **If a rule is wrong, change the rule in a deliberate
edit — do not quietly work around it.**

## 0. Settled facts

| | |
|---|---|
| Repo | `cairn-memory` — deliberately **no** `SillyTavern-` prefix |
| Extension name | **Cairn-Memory** — `display_name: "Cairn-Memory"` |
| Slug | `cairn` — CSS prefix, settings key, log namespace, `message.extra` key |
| Target ST | **1.19.0** (`06bde939f`), local checkout `~/workspaces/SillyTavern` |
| Style | raw browser ES modules, **no build step**; `manifest.json` lists what loads |
| Scope | single-character chats only (`DESIGN.md` §3.5) |

`NAMES.md` is closed. It moves to `docs/` as a record; the shortlist is not reopened.

---

## 1. Structure

1. `index.js` is the ST entry point and **nothing else** — bootstrap, event wiring, module
   registration. No logic, no LLM calls, no DOM building. Soft ceiling 150 lines.
2. Code lives in `src/` as logical, testable modules on the layout in `DESIGN.md` §11.
   One responsibility per file, soft ceiling ~400 lines. Crossing it is a signal to split,
   not a rule to route around.
3. Pure logic must be importable and runnable without a browser, without ST, and without a
   network. If a module cannot be tested that way, the ST coupling is in the wrong place.
4. **Zero runtime dependencies.** ST loads our files directly. Dev dependencies only
   (eslint, vitest), and each one earns its place.

## 2. SillyTavern first

5. Before inventing a mechanism, check whether ST already has the **lever** — and if it does,
   the work is the *timing*, not the mechanism (`docs/decisions.md` D-0066).
   `world_info_position.outlet` was the cautionary tale; `strip_examples`,
   `world_info_budget_cap` and ordered World Info trimming make it four. ST ships these off,
   static, or needing per-card configuration nobody does. That gap is the product.
6. **Every claim about ST internals cites `file:line` from the pinned checkout**, in the code
   comment or the doc that relies on it. An uncited claim about an ST API is an unverified
   claim. DESIGN.md §7 is the format to follow.
7. When we depend on an ST API, it goes in `docs/st-api-surface.md` — what we call, from where,
   and the `file:line` it was verified against. `make verify-st` re-checks that table against a
   local checkout (local gate only; CI has no ST).
8. Never clone chat messages in an interceptor (`DESIGN.md` §9). Mutate in place; collect
   indexes first; splice highest-to-lowest.

## 3. Testing

9. Code ships with tests. The gate is `make check` (lint + tests) and it is what CI runs.
10. **Every architectural invariant in `DESIGN.md` gets a test that fails when it is violated** —
    single writer to the prompt, monotonic volatility ordering (§6), no-clone (§9), branch and
    swipe rollback (§9). These are the failures that are invisible in play; they cannot be
    guarded by the inspector alone.
11. Mocks are realistic or they are worthless. `test/mocks/` models the real shapes —
    `SillyTavern.getContext()`, `ConnectionManagerRequestService`, event payloads, `message.extra` —
    and each mock cites the ST `file:line` it mirrors. When in doubt, read the checkout.
12. LLM mocks return *plausible* model output, including the bad kinds: fenced JSON, preamble
    chatter, truncation, refusal, a schema-violating field. Parsers get tested against mess.
13. Fixtures are **synthetic in content, real in shape**. This repo is public: no real chat
    logs, character cards, personas or names ever land in it — not in tests, not in docs, not in
    examples. But a fixture whose *shape* was invented proves only that the test agrees with our
    guess. So: read the real chats locally, confirm the shape against them, then write the
    fixture fresh. The corpus lives outside the repo (`~/workspaces/cairn-corpus`) and a fixture
    derived from it says in a comment which real shape it mirrors.
14. Nothing writes to the corpus. Before installing anything that touches `message.extra`,
    check the backup is current — those chats are not reproducible.

## 4. Settings and failure behaviour

15. Few knobs (`DESIGN.md` §3.6). Before adding a setting, try to derive it. A knob that cannot
    be explained in one plain sentence is a knob we automate away or replace with a simpler lever.
    Qvink's opaque settings pane is the anti-pattern.
16. Every setting has: a one-sentence plain-language description in `settings.html`, a default
    that works unconfigured, and a migration when its shape changes.
17. **Cairn never breaks the chat.** Any failure inside a generate hook degrades to "inject
    nothing new" plus one toast. Errors do not escape into ST's generation path.
18. Anything reported to the user reflects the *actual* applied change, not the model's claimed
    output (`DESIGN.md` §12). Capture pre-state before applying.
19. Logging goes through `util/log.js`, namespaced `cairn`, quiet by default. No bare
    `console.log` in shipped code.

## 5. Docs and comments

20. `README.md` — clear, concise, simple: what it does, how to install, how to use it, the major
    choices, and the ST version floor. It is not the design document.
21. `docs/` — the depth: how-it-works, development, the ST API surface, prompt design, the
    decision log. Where an explanation wants to be long, it goes here, not into a comment block.
22. Comments explain *why*, not *what*. Three lines is a lot. No walls of text — if it needs
    more, it wants a `docs/` page and a one-line pointer.
23. Behaviour changes and their docs land together. A doc that describes last month's behaviour
    is worse than no doc.

## 6. Decisions — the anti-rehash rule

24. `docs/decisions.md` is the log: **what was decided, when, why, and what would reopen it.**
    Short entries, newest first.
25. Closing an open question from `DESIGN.md` §14 means moving it into the log, not deleting it.
26. A settled decision is not re-litigated. New evidence means a new entry that supersedes the
    old one — the old entry stays, so we can see what we believed and why it changed.
27. Discoveries that cost us time go in the log too (the `structuredClone` / Symbol bug is
    exactly this shape). We pay for a lesson once.

## 7. Scope and phases

28. Build the current phase (`DESIGN.md` §13). No speculative abstraction for P4 while we are
    in P1 — except where §11 already names an interface boundary (summarisation strategy, model
    routing), which exists precisely because that churn must not touch the spine.
29. P0 is instrumentation and it is a real gate: if the prefix-stability numbers do not show what
    §4 predicts, we stop and rethink rather than proceed on faith.

## 8. Versions, changelog, schema

30. Semver. `manifest.json` and `package.json` versions always match; CI enforces it.
31. `CHANGELOG.md` in Keep a Changelog format. Every user-visible change gets a line.
32. **Breaking = the stored data shape changed**, not the API. Any change to what we write into
    `message.extra` or `chatMetadata` bumps `store/schema.js`'s version, ships a migration, and
    adds a fixture of the *old* shape to the test suite. We never orphan someone's memory.

## 9. Automation

33. GitHub Actions, following `cbz-tagger` / `memory-echo`: lint, unit tests on Node 20/22/24,
    secret scan (gitleaks), version-bump check, CodeQL. Actions pinned by SHA.
34. Everything CI runs is runnable locally through the `Makefile`, with the same target name.
    `make help` lists them. `make check` is the full local gate.
35. If a mistake can be caught mechanically, catch it mechanically. A rule in this file that
    could have been a lint rule or a test should become one.
