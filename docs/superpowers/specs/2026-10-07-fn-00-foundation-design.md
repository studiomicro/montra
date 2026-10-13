# FN-00 Foundation — design

Date: 2026-10-07. Status: approved by the owner 2026-10-07, including the merge with the component kit (§ 4).
Catalog entry: `docs/FEATURES.md` › FN-00. Locked stack: `CLAUDE.md`. Runtime map: `docs/ARCHITECTURE.md`.

## Intent

Montra is a full-scope money tracker (public site and web app) as a PWA on Cloudflare, under our own name and
brand. Decisions recorded on 2026-10-07:

- Scope is the full public product in `docs/FEATURES.md` (public site, payments, Gmail, legal review all stay).
- Claude designs screens from `docs/design/DESIGN_SYSTEM.md`. Behaviour follows common practice; name, mascot,
  logo, copy and code are Montra's own.
- Brand stays the placeholder: name "Montra", accent `#1F6FEB`.

FN-00 delivers an empty app that runs, on which every later FN builds without reworking setup.

## Consistency with the design system

FN-00 follows the design system in: the five tab items and their order
(Beranda, Riwayat, Laporan, Kekayaan, Tambah); Tambah opening the capture paths Otomatis, Suara, Struk, Mutasi; the
Suara/Struk pills on Beranda; the browser dashboard with the same features as the phone; the neutral visual system
(palette, type scale, radii, spacing, motion, component shapes) from `docs/design/DESIGN_SYSTEM.md`. It differs only
in brand identity: name, logo, mascot, illustrations, copy and the accent hue (`--brand`). Screens without a
precedent are noted as ours in `docs/FEATURES.md`.

## Success criteria

1. `npm run gates` (check, lint, test, build) passes on a clean checkout after `npm ci`.
2. `npm run test:e2e` passes: each tab opens at 360 px and 1280 px, Tambah sheet works, site host renders, themes
   and English locale work, no CSP violations.
3. `npm run db:reset:local` and `npm run db:seed:local` run against local D1 only and refuse any remote target.
4. All three Workers start locally and share one local D1; a `ping` message goes app → queue → jobs Worker.
5. RUNBOOK describes local setup, migrations (local vs remote), seed/reset, secrets and the staging gap.

## Out of scope

Staging deploy (blocked by the Cloudflare account), accounts
(FN-01), local-first storage and sync (FN-02), spaces and the space-access helper (FN-03), PWA manifest and push
(FN-13), the landing page and blog content (FN-32), AI bindings and Durable Objects (their own FNs).

The open owner decisions (local-first scope, Google sign-in, Gmail access, payment provider, git remote) do not block
FN-00.

## 1. Structure and runtime

### Repository layout (single npm package)

```
src/
  routes/(app)/…        app: Beranda /, /riwayat, /laporan, /kekayaan, stubs for other app routes
  routes/(site)/site/…  public site: home, /blog, /privasi, /ketentuan, /hapus-akun (served on the site host)
  routes/api/v1/health/ health endpoint
  hooks.ts              reroute: site host → (site) tree
  hooks.server.ts       locale, theme cookie, security headers
  lib/shared/           pure TS shared by device and Workers (i18n now; money/date later); no Worker or DOM imports
  lib/server/           env typing, db (Drizzle)
  lib/ui/shell/         TabBar, Sidebar, Sheet, ScreenTitle, EmptyState
workers/jobs/           queue consumer, cron, Workflow class; own wrangler.jsonc
workers/inbound/        email() handler; own wrangler.jsonc
migrations/             D1 SQL migrations shared by all three Workers
scripts/                seed, reset, deploy-staging guard (local tooling)
wrangler.jsonc          app Worker
```

Workers import shared code from `src/lib/shared` through a path alias. One install, one `gates` run. npm workspaces
were considered and rejected: more config and cross-package build steps with no benefit at this size.

### Two hosts, one app Worker

The public site and the app live on different hosts. One app Worker serves both.
The universal `reroute` hook (`src/hooks.ts`) reads `url.hostname`:

- site host (`SITE_HOST`, and `site.localhost` locally) → `/x` is resolved as `/site/x`, inside the `(site)` group;
- any other host → the `(app)` tree, unchanged. Direct requests to `/site/*` on the app host return 404.

Site host names are a constant list in `src/lib/shared/hosts.ts` (`site.localhost` now; production domains added
when the owner picks them), so the domain decision is a one-line change. `reroute` runs on client and server and
during prerendering, where `$env/dynamic` is unavailable, hence a constant rather than an env var. FN-00 prerenders
nothing; FN-32 decides prerendering for the site. Locally the app runs at
`localhost:5173` (dev) / `localhost:8787` (wrangler) and the site at `site.localhost` on the same port.

### Bindings

Declared in FN-00 and typed in `src/app.d.ts` (app) and `workers/*/env.d.ts`:

| Binding | Type | Workers | FN-00 use |
| --- | --- | --- | --- |
| `DB` | D1 | app, jobs, inbound | first migration, health check |
| `FILES` | R2 | app, jobs | declared only |
| `CACHE` | KV | app | declared only |
| `JOBS_QUEUE` | Queue | app (producer), jobs (consumer) | `ping` round trip |
| `STATS` | Analytics Engine | app, jobs | declared only |
| `WORKFLOW_STATEMENT` | Workflow | jobs | stub Workflow with one step |

AI, AI Gateway and Durable Objects are added by the FN that first uses them.

### jobs Worker

- Cron Trigger `0 23,0-16 * * *` (UTC) = hourly 06:00–23:00 WIB. FN-00 logs a heartbeat only.
- Queue consumer: message body `{ type, id }` validated with zod. `ping` is acked. Unknown or invalid types are
  retried up to 3 times, then go to the dead-letter queue `financer-jobs-dlq`.
- `StatementWorkflow` stub: one `step.do` that returns; proves the binding and class export.

### inbound Worker

`email()` rejects messages larger than the size cap (`MAX_INBOUND_BYTES`, 5 MB) with a clear reason and drops the
rest without reading the body. The real forwarding path arrives with FN-19.

### Health

`GET /api/v1/health` runs `SELECT 1` on D1 and returns `{ ok, db, version }`. It never includes env values or error
details; a D1 failure returns `{ ok: false, db: false }` with status 503.

## 2. Shell, UI, i18n, security

### App shell (`src/routes/(app)/+layout.svelte`)

- **Phone (< 1024 px):** single column, 20 px side padding. Floating glass tab bar, 68 px high, 14 px from the
  screen edges and above `env(safe-area-inset-bottom)`; items Beranda · Riwayat · Laporan · Kekayaan · Tambah;
  11 px labels; the active item sits in a darker pill. Content has bottom padding so the bar never hides it.
- **Desktop (≥ 1024 px):** left sidebar with the five items plus Impor, Kotak masuk and Pengaturan. Content column
  max 640 px; a route opts into 1080 px.
- **Tambah** is not a route. It opens a bottom sheet (radius 28; a centred dialog on desktop) listing the capture
  paths in the reference order: Otomatis (Gmail), Suara, Struk, Mutasi (statement), then Ketik manual. In FN-00 they
  are disabled rows with the muted note "Segera hadir". The sheet closes with Esc, the close button and a backdrop
  tap; focus returns to the opener.
- **Tab screens** Beranda, Riwayat, Laporan and Kekayaan: sticky screen title that shrinks on scroll, then an empty
  state (one muted sentence, one action). No invented figures. Beranda already places the two capture pills from
  the reference, Suara (panel fill) and Struk (ink fill), side by side, disabled with "Segera hadir".
- **Stub routes** `/kotak-masuk`, `/tanya`, `/impor`, `/ruang`, `/pengaturan`, `/masuk`, `/daftar`: title plus
  "Segera hadir", so no navigation ends in a 404.
- **Error page** per group (`+error.svelte`): one sentence through `tr()`, a link home, never a raw code or path.

Shell components (`TabBar`, `Sidebar`, `Sheet`, `ScreenTitle`, `EmptyState`) live in `lib/ui/shell/`; the rest of
the kit is § 4.

### Site shell (`src/routes/(site)/+layout.svelte`)

Sticky 64 px header with the name and a "Mulai gratis" link to the app host; footer with Privasi, Ketentuan and
Hapus akun. Home is a hero plus one placeholder section; `/blog` is an empty index; the three legal pages carry a
title and a "draft" notice. Full content is FN-32.

### Theme

- `src/app.css` imports Tailwind and `docs/design/tokens.css` by relative path (one source of truth, never copied).
  Tailwind v4 reads the `@theme inline` block.
- Default follows the system. A `theme` cookie (`system | light | dark`) is read in `hooks.server.ts`, which sets
  `data-theme` on `<html>` during SSR, so no flash. System font stack only.

### i18n (`src/lib/shared/i18n.ts`, `src/lib/shared/i18n-en.ts`)

- `tr('Beranda')`, `trf('{n} transaksi', { n })`. The key is the Indonesian phrase; `i18n-en.ts` maps it to
  English. `trf` substitutes named placeholders only; it does not escape or render HTML (Svelte escapes output).
- Locale: `lang` cookie (`id | en`), else `Accept-Language`, else `id`. Resolved per request into `locals.locale`;
  `<html lang>` follows it.
- Coverage test: scans `src/**/*.{svelte,ts}` for string-literal `tr(` / `trf(` calls and fails when an English
  entry is missing. Unused English keys are reported as a warning, not a failure.

### Security headers

- CSP through SvelteKit `kit.csp`, mode `auto` (nonces for SSR, hashes for prerendered pages):
  `default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. No
  `'unsafe-inline'`. Later FNs add per-route sources only.
- Set in `hooks.server.ts`: `Strict-Transport-Security: max-age=63072000; includeSubDomains`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy: microphone=(self), camera=(self),
  geolocation=()`.
- SvelteKit's built-in CSRF origin check stays on.
- `.dev.vars.example` lists secret names only (none needed by FN-00; each FN adds its own).

### Contrast test

A Vitest parses `tokens.css` and checks WCAG AA (4.5:1 text, 3:1 large text/UI) in light and dark for: ink/bg,
ink-2/bg, muted/bg, muted/panel, money-in/bg, money-up/bg, brand/bg, on-dark/dark, on-dark-muted/dark.

## 3. Data, tooling, tests

### D1 and Drizzle

- Schema in `src/lib/server/db/schema.ts`; `drizzle-kit generate` writes SQL to `migrations/`; `wrangler d1
  migrations apply` applies it. Applied migrations are never edited.
- First migration: `app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`. Domain
  tables arrive with their FN, following the CLAUDE.md conventions (`space_id`, `updated_at`, `deleted_at`, sync
  sequence).
- `getDb(env.DB)` in `src/lib/server/db/index.ts` is the single entry point.
- The space-access helper is not stubbed here: FN-03 owns it, and a placeholder would look like a guard that is
  not one.
- All three Workers use one local state dir (`--persist-to .wrangler/state`), so they share local D1, R2, KV and
  Queues.

### npm scripts

| Script | Command | Notes |
| --- | --- | --- |
| `dev` | `vite dev` | bindings through the adapter's local platform proxy |
| `check` | `svelte-kit sync && svelte-check` and `tsc -p workers` | |
| `lint` | `prettier --check . && eslint .` | |
| `test` | `vitest run` | unit and local-D1 integration |
| `test:e2e` | `playwright test` | webServer runs `build` then `wrangler dev` |
| `build` | `vite build` | |
| `gates` | check → lint → test → build | stops at the first failure |
| `db:migrate:local` | `wrangler d1 migrations apply DB --local` | |
| `db:seed:local` | `node scripts/seed-local.ts` | writes `app_meta.demo_seed`; refuses `--remote` and any non-local target |
| `db:reset:local` | `node scripts/reset-local.ts` | deletes only the local D1 state dir, then migrate and seed |
| `deploy:staging` | `node scripts/deploy-staging.ts` | exits non-zero with a clear message while staging is not configured; untested |

Seed data is deterministic and marked as demo (`Data demo`); FN-00 seeds only the `app_meta` marker because no
financial tables exist yet.

### Vitest

- i18n coverage; `trf` substitution.
- Contrast AA, both themes.
- `reroute` host mapping: app host, site host, `site.localhost`, unknown host.
- Cron hours map to exactly 06–23 WIB (pure helper).
- jobs queue handler with a fake batch: `ping` acked; unknown type retried; invalid body never throws.
- inbound: oversize message rejected; normal message dropped without reading the body.
- `/api/v1/health` against local D1 via `getPlatformProxy`: `db: true`, no env values in the body.
- Security header builder returns the listed headers.

### Playwright (on `wrangler dev`)

- 360 px: each tab loads; no horizontal scroll; tab targets ≥ 44 px; active state on the current tab.
- Tambah sheet: opens; closes with Esc and with the close button; focus returns to the opener; disabled rows show
  "Segera hadir".
- 1280 px: sidebar shown, tab bar hidden.
- `colorScheme: 'dark'` sets dark colours; the `theme` cookie overrides the system.
- `lang=en` cookie: labels in English.
- Site host `site.localhost:8787`: home, `/privasi`, header and footer links.
- CSP header present and no CSP violation in the console; with JavaScript disabled pages still render.

### Docs updated at the end

RUNBOOK (local setup, the three Workers, local vs remote migrations, seed and reset, secrets, D1 Time Travel
bookmark before a remote apply), TASKS, HISTORY, and the ACCEPTANCE Design rows only with named checks.

## 4. Component kit (merged into FN-00 by owner decision)

Small Svelte 5 components in `src/lib/ui/`, styled only with the tokens, each matching its entry in
`docs/design/DESIGN_SYSTEM.md` › Components. Props are typed; text arrives already translated; amounts arrive as
integer minor units plus currency and are formatted by one shared formatter.

| Component | Notes |
| --- | --- |
| `Button` | sizes `lg`/`md`/`sm`, variants `primary`/`secondary`/`ghost`/`destructive`, disabled state, press scale 0.97 |
| `Chip`, `Segmented` | filter chips with counts; segmented control, ink fill when selected |
| `Badge`, `StatusTag` | 28 px pill; green check tag |
| `GroupList`, `GroupRow`, `DayHeader` | grey radius-18 groups, hairline inset 62 px, day header with in/out totals |
| `TransactionRow` | category tile, title, meta, signed amount, optional status tag, min 56 px, whole row tappable |
| `CategoryTile` | circle with 16 % hue mix and emoji |
| `HeroBlock`, `ComparisonPill` | one big number with "Rp" superscript; rupiah comparison (more / less / about the same) |
| `TextInput`, `AmountInput` | 48 px inputs; amount field with live thousand separators, integer output |
| `FloatingCard`, `Banner` | captured-toast card; glass in-app banner |
| `Skeleton`, `ErrorState` | pulse rows (static under reduced motion); one sentence plus retry |
| `BarChart`, `CategoryBar`, `MonthLines` | plain SVG: daily bars (14 days, tap shows the figure), stacked category bar, this month vs last month |

Shared formatting in `src/lib/shared/money-format.ts`: `formatRupiah(minor, currency)` → `Rp 1.264.000`,
compact `Rp5,24 jt` / `Rp187 rb`, signed `−Rp 25.000` (U+2212) and `+Rp 9.500.000`, non-breaking space after `Rp`.
Parsing is not part of FN-00 (Phase 2 parser item). `amount_minor` uses the ISO 4217 exponent; IDR is 2, so
Rp 25.000 is stored as `2500000` and display drops `,00`.

Contrast: the FN-00 contrast gate showed light `--money-in`, `--money-up` and `--same` below AA; the plan darkens
them minimally (design system v1.1).

**Preview page `/dev/ui`:** every component in every variant with fictional values, light and dark side by side,
badged `Data demo`. It exists only when `dev` (from `$app/environment`) is true or the local-only var
`DEV_ROUTES=1` is set (used by e2e on `wrangler dev`); otherwise it returns 404. The same gate covers the dev-only
queue ping route `/api/v1/dev/ping` that proves the app → queue → jobs round trip.

**Tests:** Vitest for the formatter vectors (zero, negative, millions, compact thresholds, non-IDR currency),
`AmountInput` integer output, and chart scaling (empty data, all zeros, one day). Playwright opens `/dev/ui` at 360
px in both themes, checks no horizontal scroll and ≥ 44 px targets on interactive components.

## Facts to verify while planning

Checked against official docs and the installed packages before the plan relies on them:

- SvelteKit 3.0.1: `reroute` signature and behaviour, `kit.csp` options, route-group conventions.
- `@sveltejs/adapter-cloudflare` 8: local platform emulation in `vite dev`, `platformProxy` options.
- Vitest 5 with wrangler `getPlatformProxy` (or `@cloudflare/vitest-pool-workers` if it supports Vitest 5).
- wrangler 4.148: Workflows binding syntax, queue consumer and DLQ config, `--persist-to` across Workers, Email
  Workers local testing.
- drizzle-kit 0.31 output layout versus `wrangler d1 migrations apply`.

If a fact contradicts this spec, the plan says so and proposes the smallest change.
