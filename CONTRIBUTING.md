# Contributing to Montra

Thanks for helping. By contributing you agree that your contribution is licensed under the
[AGPL-3.0](LICENSE), the same as the project. There is no separate CLA or DCO sign-off.

## Setup

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Node 22 or newer. Never commit `.dev.vars`, keys or real financial data.

## Before you open a pull request

Run `npm run gates` (type check, lint, tests, build). All four must pass. Add an e2e spec only for a critical user
journey; automated tests never call real AI or payment providers.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`, `fix(scope): ...`,
`docs: ...`, `chore: ...`, `test: ...`. Keep one logical change per commit.

## Rules the code relies on

- **Language.** Every Indonesian phrase shown to users goes through `tr()` or `trf()` from `src/lib/shared/i18n.ts`,
  and needs an English entry in `src/lib/shared/i18n-en.ts`. A test fails when an entry is missing.
- **Money.** Integer minor units (`amount_minor`) plus an ISO 4217 currency. Never floats, and never sum across
  currencies without an explicit conversion.
- **Dates.** Bucket by the WIB calendar date (`occurred_on`), not the UTC date.
- **Access.** Every load, action, download and AI tool call checks space membership and role on the server through
  the shared space-access helper. A hidden button is not authorization.
- **Tests.** Every non-trivial branch, parser, calculation or policy check gets a Vitest test. Behaviour that touches
  data is tested across two users and two spaces. Fixtures are fictional; never paste real statements or e-mails.
- **Schema.** Add a new numbered file under `migrations/` and update the Drizzle schema. Never edit an applied
  migration.
- **Layout.** Server code in `src/lib/server`, shared domain code in `src/lib/shared`, background work in
  `workers/jobs`, inbound e-mail in `workers/inbound`.

## Adding a language

A full guide will come with the multi-language work (FN-52). For now: Indonesian is the source language and English
lives in `src/lib/shared/i18n-en.ts`. A new language is a new dictionary keyed by the Indonesian phrase.

## Reporting problems

Bugs and ideas: open an issue from the templates. Security issues: see [SECURITY.md](SECURITY.md).
