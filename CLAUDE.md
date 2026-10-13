# MONTRA — Project Context

## Goal and source of truth

MONTRA is a money tracker for Indonesia that fills itself: payments are captured from Gmail receipts, voice,
receipt photos and statement imports, then shown as one clear monthly number, budgets, net worth and an assistant
that answers from the user's own records. The product is named Montra; logo and domain are still open decisions.

- **Feature catalogue:** `docs/FEATURES.md` (FN-00 – FN-33) records what Montra does, which behaviour follows common
  practice in comparable money apps and where Montra deliberately differs. Behaviour only, never brand: Montra's
  name, mascot, logo, illustrations and copy are its own. A public URL is not source code; never reconstruct
  another app from its bundles.
- Product requirements: `docs/PRD.md`. Design: `docs/design/DESIGN_SYSTEM.md` v1 + `docs/design/tokens.css`.
  Status and evidence: `docs/TASKS.md`, `docs/HISTORY.md`, `docs/ACCEPTANCE.md`.
- Inspect existing code and instructions first; preserve unrelated edits.

## Product boundaries

- Not a bank, wallet or adviser: no funds held, no money moved, no bank login, PIN, password or OTP ever asked.
  Reports and assistant answers are information, not financial, investment, tax or legal advice.
- No ads, no third-party trackers, no data sale; mailbox data never used for ads, credit scoring or lending.
- Server-first: an account is required; guest mode (records on the device) is
  deferred. An account gives sync, sharing, AI reading and Gmail.
- Spaces: everyone has a personal space; shared spaces hold up to 5 people, roles Pemilik (owner) and Anggota
  (member). Every financial row belongs to exactly one space.
- Money is never invented. Balances, totals, budgets and assistant figures are computed from stored rows. AI reads
  (Gmail, voice, receipt, statement) become drafts or carry a source and review state; AI may misread, so the user
  checks before saving except where FN-19 auto-saves (and then the row is tagged and deletable).
- Main journey: open app → add a wallet → record by voice → see Beranda → sign up → connect Gmail → a QRIS payment
  appears → import a statement → set a budget → see safe-to-spend → ask the assistant → invite a family member.

## Locked architecture (Cloudflare)

- Svelte 5 + SvelteKit + TypeScript + Vite; Tailwind CSS v4 with `docs/design/tokens.css`; small Svelte-native
  components; simple SVG charts, no chart library.
- `@sveltejs/adapter-cloudflare`; one app Worker owns SSR, loaders, form actions and API routes.
- Separate Workers: `workers/jobs` (Queues consumers, Cron Triggers incl. hourly Gmail checks 06–23 WIB,
  Workflows for statement reading, look-back scans, agent reports, retention sweeps) and `workers/inbound` (e-mail
  forwarding fallback). Long work goes through Queues/Workflows in small steps.
- **Server-first:** D1 is the working copy; signed-in only; an offline write
  queue may follow. The local-first IndexedDB sync design in `docs/ARCHITECTURE.md` is deferred, not cancelled.
- **SvelteKit 3 facts:** config in `vite.config.ts`; shared imports `#lib/*`; the Cloudflare adapter never populates
  `event.platform` — bindings only via `getEnv()` in `src/lib/server/env.ts`; `dev` from `$app/env`.
- D1 + Drizzle with versioned SQL migrations; R2 only for files the user keeps (attached receipt photos, item and
  collectible photos, agent reports); KV for caches; Analytics Engine for self-hosted usage statistics.
- **Uploads:** statements, screenshots and receipts are processed in memory, never stored; results are sealed to
  the account key (X25519 + HKDF-SHA256 + AES-256-GCM; private key wrapped with a scrypt password key) — FN-21.
- AI: Claude through Cloudflare AI Gateway for e-mail classification/extraction, receipt and statement reading,
  categorisation, the assistant (Agents SDK, one Durable Object per space) and agent reports. Voice uses the
  browser's speech recogniser (Web Speech API); Workers AI Whisper only as a fallback.
- Auth: e-mail + password (PBKDF2 within the Workers cap), no Google sign-in for now; opaque sessions
  stored hashed in D1. The password also unlocks the account key.
- Gmail: read-only access through a certified connection partner or our own CASA-assessed OAuth app (owner
  decision); forwarding address as fallback.
- Payments: Xendit or Midtrans (owner decision). PWA with Web Push; native apps later (FN-33).
- Vitest for domain and integration tests (local D1); Playwright for critical journeys. No Redis, Kafka, Kubernetes
  or mandatory Docker.

## UI and routes

- Follow `docs/design/DESIGN_SYSTEM.md`: one big number first, rupiah not percent, ink-and-white with colour only
  for meaning, grouped lists, floating glass tab bar, Geist (self-hosted, owner decision 2026-10-10), light + dark.
- Phone first (360 px up). Tabs: Beranda `/`, Riwayat `/riwayat`, Laporan `/laporan`, Dompet `/dompet`, Tambah
  (sheet). Layout, page structure and interactions follow `docs/design/APP_PARITY.md` (owner request 2026-10-08). Other routes: `/kotak-masuk`, `/tanya`, `/impor`, `/ruang`, `/pengaturan/*`, `/masuk`, `/daftar`; public
  site `/`, `/blog/*`, `/privasi`, `/ketentuan`, `/hapus-akun` on the marketing host. Code and tables use English.
- Default language Bahasa Indonesia; English per user. Indonesian text goes through `tr()`/`trf()` in
  `src/lib/shared/i18n.ts`, English in `i18n-en.ts`; a test fails when a phrase lacks an English entry.
- Currency `Rp 1.264.000`, compact `Rp5,24 jt`; expense `−Rp 25.000` (U+2212), income `+Rp`. Timestamps stored UTC,
  shown WIB.
- Every primary action works or shows why it is unavailable. Loading, empty, error, saving and success states;
  success only after the write is confirmed (by the server; guest mode deferred).

## Data and runtime conventions

- Money: integer `amount_minor` + ISO 4217 `currency`; foreign amounts keep `original_amount_minor` and
  `original_currency` with the rate and its date. Never floats.
- `occurred_on` is the WIB calendar date; month and day buckets use it, never the UTC date.
- Every user-data table has `space_id`, `updated_at`, `deleted_at` (tombstone) and a sync sequence; every server
  query goes through the shared space-access helper. A hidden button is not authorization.
- Captures carry `source` (manual, gmail, voice, receipt, statement, spreadsheet, csv, slack) and a dedupe key;
  a deleted captured row is never recreated from the same source.
- Mail text is deleted after reading; non-payment mails keep only id and date. Account and card numbers masked to
  the last 4 digits.
- Typed bindings via `platform.env`; server code in `src/lib/server`, shared domain code (parsers, money, dates,
  sync) in `src/lib/shared` so the client and Worker run the same logic; never serialise secrets in loaders.
- D1 is SQLite: parameterised, bounded queries; `db.batch`, no interactive transactions; no transaction spans D1,
  R2, Queues or an AI call. Queue delivery may repeat: idempotency keys, bounded retries, dead-letter handling.

## Verification

- Deterministic fictional seed data for local review, badged `Data demo`, excluded from real totals.
- Fixtures and mocked AI never count as a working capture path. Record real-provider tests separately. Never report
  an unrun command as passed.
- Test across two users and two spaces, two devices with deletes, money parsing
  vectors, WIB month boundaries, duplicate captures, webhook replay, AI tool scoping, encrypted-result round trip.

## Execution and repo workflow

- Keep `docs/TASKS.md` current; finished items and evidence move to `docs/HISTORY.md`; `docs/ACCEPTANCE.md` rows
  change only with a named check.
- npm script contract (FN-00): `dev`, `check`, `lint`, `test`, `test:e2e`, `build`, `gates`, `db:migrate:local`,
  `db:seed:local`, `db:reset:local`, `deploy:staging`. Verify before describing them as runnable.
- Local and remote migration commands stay clearly separate. Never seed or reset a remote DB.
- This file grants no permission to buy services, create provider accounts or change production.
- Each completion report: working behaviour, checks run with results, missing credentials or untested integrations,
  next task.

## Multi-agent pipeline and session workflow

Agents in `.claude/agents/`: **cto-strategist** (request → `docs/features/<slug>/PRD.md`
with FN id), **senior-software-engineer** (implements; gates clean; no tracker edits, no push), **qa-tester**
(`QA_REPORT.md`), **red-team-pentester** (`SECURITY_REPORT.md`). Commands in `.claude/commands/`: `/resume`,
`/build-feature`, `/fix-bug`, `/verify`, `/ship` — risk tiers, at most 3 fix cycles (2 for bugs), trackers updated at
the end, commits only through `/ship`.

The `superpowers` plugin covers foundation and cross-cutting work: `brainstorming` → `docs/superpowers/specs/`,
`writing-plans` → `docs/superpowers/plans/`, then `subagent-driven-development`. One bounded feature →
`/build-feature`.

Every change is checked against `docs/ENGINEERING_CHECKLIST.md`.

## Official references

[SvelteKit on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/sveltekit/),
[D1](https://developers.cloudflare.com/d1/), [Queues](https://developers.cloudflare.com/queues/),
[Workflows](https://developers.cloudflare.com/workflows/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/),
[Agents SDK](https://developers.cloudflare.com/agents/), [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/),
[Email Workers](https://developers.cloudflare.com/email-routing/email-workers/),
[Gmail API](https://developers.google.com/workspace/gmail/api). Re-check official docs before choosing versions or
provider calls; never hard-code guessed pricing, quotas or SDK capabilities.
