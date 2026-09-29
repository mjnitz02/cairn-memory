# Security Policy

## Supported versions

Cairn is a pre-release, single-maintainer project. Only the latest version on
`main` receives fixes — SillyTavern installs extensions from `main` and
updates them automatically.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub's
[private vulnerability reporting](https://github.com/mjnitz02/cairn-memory/security/advisories/new),
which notifies the maintainer directly and keeps the report confidential until
a fix ships.

Expect an initial response within roughly a week. There is no formal SLA, but
reports are taken seriously and credited in the advisory unless you'd rather
stay anonymous.

## Scope

Cairn runs inside SillyTavern's browser page with the same access SillyTavern
has. In scope:

- model output or chat content reaching the page as markup (summaries, canon,
  the world state and the inspector are all rendered from model text);
- anything that exposes connection-profile credentials or API keys;
- the inspector log writing more to disk than the settings describe;
- this repository's GitHub Actions workflows.

Out of scope: vulnerabilities in SillyTavern itself or in a model provider
(report those upstream), vulnerabilities in dev dependencies that never ship
to the browser (Dependabot tracks them here), and issues that need an already
compromised machine or SillyTavern instance.
