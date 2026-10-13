# FN-42 — Version, updates and usage in Pengaturan

Risk tier: **Medium** (no migration — every figure is read from tables that already exist; no new auth surface;
no money calculation, since credits are an integer count, not `amount_minor`; the one real-browser mechanic is the
service-worker update handshake). Engineer, then QA and a narrow red team in parallel (per `/build-feature` §0a).

## Goal

The owner asked (2026-10-09) to "add version update and usage on settings." Today a signed-in user has no way to
tell what build they are running, what changed since the last one, whether a pending update is waiting to apply,
or how much of their plan — spaces, categories, API tokens, credits — they have actually used. This closes that
gap with two read-only Pengaturan pages: **Tentang Montra** (version, release notes, update control) and
**Pemakaian** (plan, credits and limits for the signed-in account and its current space), both computed from rows
already stored — never a new figure invented — plus a safer in-app update flow so a user with the app open during
a deploy can apply it without losing unsent offline-queue writes (FN-02).

## Scope

### A — `/pengaturan/tentang` ("Tentang Montra")

- New route `src/routes/(app)/pengaturan/tentang/{+page.server.ts,+page.svelte}`. Signed-in gate identical to
  `/pengaturan/api` (`redirect(303, '/masuk')`, `src/routes/(app)/pengaturan/api/+page.server.ts:36-40`); no space
  scoping needed (nothing here is space data).
- **Version row:** `APP_VERSION` from `getEnv()` (`src/lib/server/env.ts`), the same value
  `/api/v1/health` reports (`src/routes/api/v1/health/+server.ts:8`, `src/lib/server/health.ts:1-18`,
  `wrangler.jsonc:13`). Shown as "Versi {version}" — never re-derived from `package.json` at runtime (that file is
  not bundled to the client; the Worker var is the one source already used by health).
- **"Apa yang baru":** a new bilingual, build-time content source — `src/lib/content/release-notes/<version>.id.md`
  and `<version>.en.md`, one pair per user-visible release, parsed the way `src/lib/server/content/blog.ts:33-64`
  parses `src/lib/content/blog/*.md` (`import.meta.glob(..., { query: '?raw', eager: true })`, frontmatter
  `{version, date}` via `splitFrontmatter`/`renderMarkdown` from `src/lib/server/content/markdown.ts`, a build-time
  throw on a missing language exactly like blog's "has no English version" check). New module
  `src/lib/server/content/release-notes.ts`: `listReleaseNotes(locale, limit = 3)` → newest-first by `version`
  (semver-aware compare, not string compare, since "0.10.0" must sort after "0.4.0"), each entry
  `{ version, date, html }`. `getPost`-equivalent not needed (the page only ever lists, never links to one slug).
  `CHANGELOG.md` at the repo root is **not** read by the app and is unchanged by this feature — it stays the
  engineering/release record (see Owner decisions #1 for why these are two files, not one, and the backfill of the
  four existing versions).
  Plain-language bullets only (the existing CHANGELOG.md convention already separates these from its own
  "Behind the scenes: …" line per version, e.g. `CHANGELOG.md:14`); the new release-notes files carry only the
  user-facing bullets translated to Indonesian (and the original English), no "Behind the scenes" line at all —
  there is nothing to filter at render time because it was never written into this file.
- **Release date:** the matched entry's `date` (ISO `YYYY-MM-DD`, `z.string().refine(isDateString)` exactly as
  `src/lib/server/content/blog.ts:26`), formatted with the shared date formatter used elsewhere for a plain WIB
  calendar date (no time component — a release date is a day, not a timestamp — `src/lib/shared/dates.ts`).
- **PWA update banner and button**, client-only, needs its own module (not inline in `+layout.svelte` as today):
  `src/lib/ui/pwa/update.svelte.ts` — a small Svelte 5 rune store, `updateAvailable` (boolean) and
  `applyUpdate()`/`checkForUpdate()` functions, used by both `+layout.svelte` (the banner, shown on every page) and
  `/pengaturan/tentang` (the same banner inline plus a "Periksa pembaruan" button that calls `checkForUpdate()`
  and, if nothing new was found, shows a transient "Sudah versi terbaru" confirmation).
  **Service worker behaviour change** (`src/service-worker/index.ts:25-42`): today `install` always calls
  `self.skipWaiting()` and `activate` always calls `self.clients.claim()`, so a new build silently takes over the
  instant it is cached — the install page's own copy already promises this ("Pembaruan masuk sendiri",
  `src/routes/(app)/pengaturan/instal/+page.svelte:43,47`, left unchanged, still true: the new build still
  downloads and caches itself automatically in the background). This pass changes only what happens **after** that
  background caching finishes on a page that is already open and controlled by an older worker:
  - A worker's `install` event still precaches the shell (`cache.addAll(SHELL)`) and still skips waiting
    immediately when there is **no existing controller** (a tab's very first-ever registration — nothing open to
    disrupt, matches today's behaviour, keeps the existing e2e assertions in `e2e/pwa.spec.ts:123-139` passing
    unchanged).
  - When a controller **does** already exist (an update, not a first install), the new worker calls
    `self.skipWaiting()` only after receiving a `{ type: 'SKIP_WAITING' }` `postMessage` from a client, not
    automatically. Until then it sits in the `waiting` state (the standard Service Worker lifecycle, not a new
    concept Montra invents).
  - The page's `update.svelte.ts` listens for `registration.installing`/`updatefound` → once that worker reaches
    `'installed'` and `registration.waiting` is set and `navigator.serviceWorker.controller` already existed
    before this registration (i.e. this is an update, not the first install), sets `updateAvailable = true`.
  - `applyUpdate()` posts `{ type: 'SKIP_WAITING' }` to `registration.waiting`, then on the resulting
    `controllerchange` event calls `location.reload()` once. The reload is safe for FN-02's offline write queue
    because the queue lives in IndexedDB (`src/lib/ui/offline-queue/db.ts`), not page memory, and an item only
    leaves the queue after the server confirms it (`src/lib/ui/offline-queue/sync.ts:176` — `confirm` only on
    `outcome.kind === 'ok'`); a reload mid-flight at worst repeats an in-flight, idempotent send.
  - `checkForUpdate()` calls `registration.update()` (a manual check, for "Periksa pembaruan"); it does not itself
    reload — it only makes a waiting worker (if any) show up through the same `updatefound` path above.
  - Banner copy: "Versi baru tersedia — Muat ulang" (button: "Muat ulang sekarang"); shown as a dismissible-but-
    reappearing-next-load row/banner (dismissing hides it for the current page only, consistent with "every
    primary action works or shows why it is unavailable" — it is never permanently silenced, since skipping an
    update forever is not an option the user actually gets today either).
- Works without JavaScript for the version number and "Apa yang baru" list (both rendered by the `load` function,
  plain HTML, no client fetch); the update banner/button inherently needs JavaScript (a Service Worker operation)
  and simply does not render without it — no broken control, no error.

### B — `/pengaturan/pemakaian` ("Pemakaian")

- New route `src/routes/(app)/pengaturan/pemakaian/{+page.server.ts,+page.svelte}`. Signed-in gate as above.
  Space-scoped parts use `locals.space` (the current space, `src/lib/server/spaces/current.ts`) re-validated
  through `requireSpaceAccess(db, locals.user.id, locals.space.id)` (`src/lib/server/spaces/access.ts:48`) — never
  trust a space id from a query string; there is none here (the page only ever shows the current space).
- **Plan:** `planStateOf(db, userId, now)` (`src/lib/server/billing/gate.ts:22`) → label via `PLAN_CATALOGUE`
  (`src/lib/shared/billing/plans.ts:40-74`); when the stored plan has lapsed, show that too (the same "ended, data
  stays" wording `/pengaturan/paket` already uses — reuse its copy, not a new phrase).
- **Credits:** `creditBalance(db, userId)` (`gate.ts:45`, a SQL `SUM(delta)`, never a stored counter) for the
  balance; "this month's credits used" = the sum of negative `delta` ledger rows with `created_at` in the current
  WIB calendar month (a new small aggregate query in `src/lib/server/billing/ledger.ts`, same table, same
  `user_id`-bound shape as `listLedger`, grouped by WIB month via the shared date helper, never the UTC month);
  recent entries via `listLedger(db, userId, null, LEDGER_PAGE_SIZE)` (`ledger.ts:37`, already paginated, already
  keyed by `id` for `{#each}`).
- **Limits used vs. allowed**, each a plain "N dari M" row, computed per the table below — every "allowed" number
  comes from an existing constant, every "used" number from a bounded, already-existing query:

  | Limit | Used | Allowed | Source |
  | --- | --- | --- | --- |
  | Spaces | `listSpaces(db, userId).length` | `PLAN_CATALOGUE[plan].maxSpaces` | `src/lib/server/spaces/spaces.ts:76` (bounded by `SPACE_LIST_LIMIT = 100`, `spaces.ts:37`); `plans.ts:40-74` |
  | Categories (current space) | `listCategories(scope).length` | `MAX_CATEGORIES_PER_SPACE` | `src/lib/server/categories/repo.ts:127`, `:12` |
  | API tokens | `listApiTokens(db, userId, now).length` | `API_TOKEN_MAX_PER_USER` | `src/lib/server/auth/api-tokens.ts:97`; `src/lib/shared/api-tokens.ts:16` |
  | Connected apps (current space) | live rows from `listConnections(db, scope)` | *(no plan ceiling exists — show the count only, never a fabricated "of N")* | `src/lib/server/connected-apps/repo.ts:27` |
  | Members (current space) | `listMembers(db, spaceId).length` | `MAX_SPACE_MEMBERS` (shown only when the current space's `kind === 'shared'`; a personal space shows "Ruang pribadi" instead of a ratio) | `src/lib/server/spaces/spaces.ts:94`; `src/lib/server/spaces/access.ts:8` |
  | Gmail look-back | *(no usage number exists — FN-19 is not built)* | `gmailLookbackMaxDays(plan)` shown alone, labelled "paling lama" (at most), not "N dari M" | `src/lib/server/billing/gate.ts:61` |

- **Stored files (R2), current space:** two counted kinds only — `count(*) from belongings where space_id = ?
  and photo_key is not null and deleted_at is null` and the same for `collectibles`
  (`src/lib/server/db/schema.ts` tables `belongings` ~1105, `collectibles` ~1232; keying off `photoKey`, the same
  column `src/lib/server/photos/store.ts:27-28` already treats as the one proof a row holds an R2 object). Shown as
  two labelled rows ("Foto barang: N", "Foto koleksi: N"), never summed into one opaque "files" total and never
  including receipt photos, agent reports or statement uploads (FN-15/16/21/23 either are not built or, per FN-21,
  never store the file at all — nothing to count there; see Out of scope).
- **AI usage placeholder:** a "Kecerdasan buatan" row, always "Belum ada pemakaian AI" (a fixed, truthful string —
  there is no Anthropic call in the product yet). If `/pengaturan/integrasi` exists at implementation time (FN-41,
  in review per `docs/FEATURES.md`), the row links there; if it does not yet exist on `main`, the row renders as
  plain text with no link (never a link to a route that is not shipped).
- Loading (`load` runs once, no client fetch), empty (a brand-new account: 0 credits used, 0 of every limit,
  "Belum ada riwayat kredit" under the ledger list), error (a thrown query surfaces as the page's existing error
  boundary, never a raw error to the user), success/steady states only — this page has no form, no saving state
  (pure read).
- Works at 360 px; no JavaScript required (pure `load`, no client fetch, no action).

### C — Pengaturan index

`src/routes/(app)/pengaturan/+page.svelte:15-97` gains two rows:

- **Akun group:** "Pemakaian" (`icon="bar-chart"` or similar already in `Icon.svelte`'s set, hint "Paket, kredit
  dan batas pakai"), placed **after** "Paket & kredit" (`:26-29`) and **before** "Ruang" (`:30-35`) — usage is a
  read-only view over the same plan/credit data "Paket & kredit" manages.
- **Aplikasi group:** "Tentang" (`icon="info"`, hint "Versi, pembaruan dan yang baru"), placed **last** in that
  group, **after** "Pasang aplikasi" (`:78-83`) — independent of whether FN-41's "Integrasi AI" row has landed;
  if it has, "Tentang" still goes after it, as the final row of the group either way.

## Out of scope

- Any change to `CHANGELOG.md`'s own format, audience or process (it stays the English engineering record; this
  feature adds a parallel, bilingual, user-facing file per release — see Owner decisions #1).
- Counting or showing receipt photos, agent reports, portfolio screenshots or statement uploads as "stored files"
  (FN-15/21/23/16: either not built, or — per FN-21 — processed in memory and never stored at all; there is
  nothing to count).
- Any real AI usage figure, credit-cost accounting for AI, or anything from FN-41's BYOK keys beyond a static
  "no usage yet" placeholder and an optional link.
- A push notification, e-mail, or in-app toast announcing a new release beyond the banner itself (no "what's new"
  marketing campaign).
- Changing how `APP_VERSION` is set, bumped or kept equal to `package.json`'s version (that process is unchanged;
  `e2e/security.spec.ts:5`'s existing comment on the release step stands).
- A history of every past release in "Apa yang baru" — bounded to the 3 most recent (Owner decisions #2); older
  versions are not reachable from this page.
- Any admin or cross-account view of usage (this page is always the signed-in user's own account and current
  space only).
- Per-space usage for every space the user belongs to at once (the page shows the current space only; switching
  space and reloading shows that space's own numbers — no new multi-space aggregation view).
- Automatic generation of `release-notes/*.md` from `CHANGELOG.md` by a script (the two files are written by hand,
  independently, per release — tooling to derive one from the other is a future nicety, not this pass).

## Acceptance criteria

Server-side authorization

1. Given a signed-out visitor, when they request `/pengaturan/tentang` or `/pengaturan/pemakaian` (GET), then they
   are redirected to `/masuk`, identically to `/pengaturan/api` (`src/routes/(app)/pengaturan/api/+page.server.ts:36-40`).
2. Given a signed-in user, when `/pengaturan/pemakaian` loads, then every space-scoped figure (categories,
   connected apps, members, stored files) is read for `locals.space.id` only after
   `requireSpaceAccess(db, locals.user.id, locals.space.id)` succeeds, and every account-scoped figure (plan,
   credits, spaces, API tokens) is read for `locals.user.id` only — never an id read from a query string or form
   field (there is none to read).
3. Given a signed-in user who is a member of space A but not space B, when they manipulate the `space` cookie to
   name space B and reload `/pengaturan/pemakaian`, then `requireSpaceAccess` refuses it with `404` (the existing
   "Not found" shape, `access.ts:69`) and no figure from space B is rendered.

Version and updates

4. Given the Worker's `APP_VERSION` is `"0.4.0"`, when `/pengaturan/tentang` loads, then the page shows "Versi
   0.4.0" and this matches `/api/v1/health`'s `version` field for the same deployment.
5. Given `release-notes/0.4.0.id.md` and `.en.md` exist, when a user whose locale is Indonesian loads the page,
   then the Indonesian bullets render; when their locale is English, the English bullets render — both from the
   same underlying version entry, matched by `version`, not by guesswork.
6. Given a version has no matching `release-notes/<version>.*.md` pair, when `npm run build` runs, then it still
   succeeds (a version with no user-facing release note is legal — only an Indonesian file **with no** matching
   English file, or vice versa, fails the build, mirroring blog's existing "has no English version" check).
7. Given the three most recent release-notes entries, when the page loads, then they render newest-version-first
   by semantic version comparison (not string comparison — "0.10.0" must sort after "0.4.0" once that version
   exists), and no "Behind the scenes" line ever appears (none exists in the source file to filter).
8. Given a browser with no existing service-worker controller (a fresh install), when the worker installs, then it
   calls `skipWaiting()` immediately as today, and no update banner ever appears for that first install (nothing
   to disrupt).
9. Given a page already controlled by an active service worker, when a new worker version finishes installing,
   then it does **not** call `skipWaiting()` on its own; the page shows "Versi baru tersedia — Muat ulang" within
   one `updatefound` cycle, and clicking "Muat ulang sekarang" posts `SKIP_WAITING`, the new worker takes control,
   and the page reloads exactly once.
10. Given items are queued in the FN-02 offline write queue (IndexedDB) when the update banner's reload happens,
    then after reload the queue still lists every item that had not yet been confirmed by the server (no item is
    lost by the reload; an in-flight-but-unconfirmed send is simply retried, which is idempotent per
    `src/lib/ui/offline-queue/sync.ts`'s existing confirm-only-on-`ok` rule).
11. Given no update is pending, when the user clicks "Periksa pembaruan", then `registration.update()` runs and,
    finding nothing new, the page shows a transient "Sudah versi terbaru" message and never reloads.
12. Given JavaScript is disabled, when `/pengaturan/tentang` loads, then the version number and "Apa yang baru"
    list still render (server-rendered `load` output); the update banner and "Periksa pembaruan" button simply do
    not appear — no broken link, no error shown.

Usage figures (never invented, CLAUDE.md "money is never invented")

13. Given a user with 300 starter credits and 0 ledger rows spent, when `/pengaturan/pemakaian` loads, then the
    shown balance equals `creditBalance` and equals the figure `/pengaturan/paket` shows for the same account at
    the same moment (both read the same `SUM(delta)` query shape).
14. Given ledger rows dated across a WIB month boundary (23:30 WIB on the last day, 00:30 WIB on the first — the
    engineering checklist's WIB-date test vectors), when "this month's credits used" is computed, then it groups
    by the WIB calendar month of `created_at`, not the UTC month.
15. Given a space has 100 categories (`MAX_CATEGORIES_PER_SPACE`) including hidden ones, when the page loads, then
    "Kategori" shows "100 dari 100", and given one more category exists beyond the cap from a later preset top-up
    (`CATEGORY_LIST_MAX`, FN-39's two later presets), that extra count is still shown accurately, never silently
    capped to look like 100.
16. Given a space has no connected apps, when the page loads, then "Aplikasi terhubung" shows "0" with no "of N"
    suffix (there is no plan ceiling for this row — never fabricate one).
17. Given the current space is the user's personal space, when the page loads, then the "Anggota" row shows
    "Ruang pribadi" (or equivalent), not a "1 dari 5" ratio that implies a shared-space concept which does not
    apply there.
18. Given a user with no stored key under FN-41 (or FN-41 not yet shipped), when the page loads, then the AI
    row shows exactly "Belum ada pemakaian AI" and no other figure, link only shown when `/pengaturan/integrasi`
    actually exists.
19. Given `belongings` and `collectibles` rows in the current space, some with `photo_key` set and some without,
    when the page loads, then "Foto barang" and "Foto koleksi" each count only the rows with a non-null
    `photo_key` and `deleted_at is null`, scoped to that space only (a photo in another space never counts).

Query budget and bounded work (engineering checklist "Bounded work")

20. Given `/pengaturan/pemakaian`'s `load` runs, then it issues a fixed, small number of bounded queries (plan
    state, credit balance aggregate, this-month aggregate, one ledger page of at most `LEDGER_PAGE_SIZE` rows,
    spaces list bounded by `SPACE_LIST_LIMIT`, categories list bounded by `CATEGORY_LIST_MAX`, API tokens bounded
    by `API_TOKEN_MAX_PER_USER`, connected apps for one space, members for one space, two R2-file-count
    aggregates) — no unbounded scan, no per-row loop issuing its own query, and the total is a small fixed count
    nowhere near D1's 1,000-queries-per-invocation ceiling.

i18n (engineering checklist)

21. Given every new Indonesian string introduced by this feature (`/pengaturan/tentang`, `/pengaturan/pemakaian`,
    the two new Pengaturan-index rows, the update banner, "Sudah versi terbaru", every limit row's label), when
    the i18n English-completeness test (`src/lib/shared/i18n.test.ts`) runs, then each has a matching entry in
    `src/lib/shared/i18n-en.ts` and the test reports no new failure.
22. Given the release-notes Indonesian and English bodies, when rendered, then both are real, separately-authored
    Indonesian and English text (not a machine-translated placeholder left in either language), consistent with
    `tr()`/`trf()` being for UI strings and this being bundled content instead — the parity rule (every Indonesian
    phrase needs an English counterpart) still applies to the content pair.

Other engineering checklist items turned into criteria

23. (Svelte keyed lists) The ledger-entry list and every limit row are keyed by a stable id (ledger row `id`,
    limit name), never by display text.
24. (Truthful state) No figure on `/pengaturan/pemakaian` is shown before its query resolves (no optimistic
    placeholder number); a failed query shows the page's error state, never a stale or zero figure presented as
    real.
25. (Accessibility) The update banner is announced (`role="status"` or equivalent live region), its button and
    every Pengaturan-index row meet the 44 px touch target and AA contrast in both themes, reusing
    `GroupList`/`IconRow`/`ScreenTitle` kit components, not new bespoke markup.
26. (CSP) No new `'unsafe-inline'`; the service-worker message-passing code ships in the already-bundled worker
    script, not an inline `<script>` (same discipline as the existing registration code,
    `src/routes/+layout.svelte:31-33`'s own comment on why).
27. (Fail-before proof) Each new Vitest test in this feature is shown failing against the pre-feature code before
    the feature exists.
28. (No real providers in tests) N/A — this feature calls no AI provider.
29. (Untrusted text) N/A for server-authored release notes (trusted repo content, same trust level as blog posts);
    no user-supplied text is rendered by either new page.

Design

30. `/pengaturan/tentang` and `/pengaturan/pemakaian` pass the 360 px layout and touch-target checks already
    applied to other Pengaturan pages (`docs/ACCEPTANCE.md`'s Design row, `e2e/shell.spec.ts`/`e2e/kit.spec.ts`
    pattern), with no horizontal scroll.

## Architecture notes

- **Vitest-first.** Every figure in Scope B is a server-side aggregate query already exercised by an existing
  repo module (`gate.ts`, `ledger.ts`, `spaces.ts`, `categories/repo.ts`, `auth/api-tokens.ts`,
  `connected-apps/repo.ts`) plus two new small count queries for `belongings`/`collectibles` photo keys and one
  new "this month" ledger aggregate — all unit- and integration-testable against local D1
  (`test/helpers/d1.ts#openLocalD1`, the pattern already used by `test/integration/pengaturan-api.test.ts:1-40`).
  The release-notes parser is unit-testable exactly like `src/lib/server/content/blog.test.ts` tests
  `parsePosts`. The service-worker lifecycle decision (first-install vs. update, when to set `updateAvailable`)
  should be factored into a pure function in `src/lib/shared/sw-update.ts` (inputs: "had a controller before this
  registration", "worker reached `installed`", "this is the same registration's `waiting` slot" → output: show
  banner or not) so it is Vitest-testable the way `src/lib/shared/sw-policy.ts` already is, rather than tested
  only through Playwright.
- **E2e** only for the one real-browser journey this needs: extend `e2e/pwa.spec.ts` (which already drives
  service-worker lifecycle assertions, `serviceWorkerReady`/`cachedEntries` helpers at
  `e2e/pwa.spec.ts:19-67`) with a scenario that registers an old worker, swaps in a new `service-worker.js` build,
  asserts the banner appears, clicks "Muat ulang sekarang", and asserts exactly one reload plus a surviving
  offline-queue item (reuse `e2e/offline-queue.spec.ts`'s queue-seeding helpers if present). Add a 360 px pass for
  both new pages to `e2e/pwa.spec.ts` or a focused new spec — not a second full journey file.
- **New modules:** `src/lib/server/content/release-notes.ts` (+ `release-notes.test.ts`),
  `src/lib/content/release-notes/{0.1.0,0.2.0,0.3.0,0.4.0}.{id,en}.md` (backfilled, see Owner decisions #1),
  `src/lib/shared/sw-update.ts` (+ test), `src/lib/ui/pwa/update.svelte.ts`,
  `src/routes/(app)/pengaturan/tentang/{+page.server.ts,+page.svelte}`,
  `src/routes/(app)/pengaturan/pemakaian/{+page.server.ts,+page.svelte}`,
  `src/lib/server/billing/ledger.ts` gains one new exported function (this-month-used aggregate; no change to
  its existing exports' behaviour).
- **Changed, carefully:** `src/service-worker/index.ts` (`install`/`activate`, the first-install-vs-update branch
  above — every existing `e2e/pwa.spec.ts` assertion about the shell cache, offline page and CSP must still pass
  unchanged); `src/routes/+layout.svelte` (mount the update banner, alongside the existing registration call at
  `:33-36`, moved into `update.svelte.ts`); `src/routes/(app)/pengaturan/+page.svelte` (two new `IconRow`s, see
  Scope C).
- **No migration.** Nothing in this PRD needs a new table or column: every figure is read from existing tables
  (`user_plan_state`, `credit_ledger`, `spaces`, `space_members`, `categories`, `api_tokens`, `connected_apps`,
  `belongings`, `collectibles`) via existing or trivially-added aggregate queries.
- **Worker:** app Worker only. No `workers/jobs` or `workers/inbound` change.
- Reuses unchanged: `requireSpaceAccess` (`src/lib/server/spaces/access.ts:48`), `resolveCurrentSpace`/
  `locals.space` (`src/lib/server/spaces/current.ts`), `tr()`/`trf()` (`src/lib/shared/i18n.ts`),
  `GroupList`/`IconRow`/`ScreenTitle` kit components, `src/lib/shared/dates.ts` for the release date and every
  ledger timestamp.

## Prerequisites

None. This feature needs no new Worker secret or credential — `APP_VERSION` is already set
(`wrangler.jsonc:13`, `workers/jobs/wrangler.jsonc:45`), and every figure comes from tables and plan constants that
already exist. It is independent of FN-41's `ADMIN_EMAILS`/`AI_KEYS_ENCRYPTION_KEY`/AI Gateway prerequisites and
does not depend on FN-41 having merged (the "Tentang/Integrasi" link degrades to plain text if it has not, per
Scope B and acceptance criterion 18).

## Owner decisions

Proposed defaults below; proceeding on these per the house auto-accept-defaults policy.

1. **A new bilingual `release-notes/` content pair per release, not a parsed/translated `CHANGELOG.md`.** Default:
   **separate files**, mirroring the blog's per-language convention. Reasoning: `CHANGELOG.md` is English,
   written for engineers and git history (it already has its own "Behind the scenes" convention for
   implementation detail); forcing it to also be bilingual and user-facing would either junk up the engineering
   record with translation upkeep or require a filter step that is one regex away from showing an internal line to
   a user by accident. A second small file per release, written once by whoever writes the user-facing changelog
   entry, keeps the two audiences cleanly separate. Backfill: the four existing versions (0.1.0–0.4.0) get their
   release-notes files written as part of this feature's implementation, translating the already-plain-language
   bullets already in `CHANGELOG.md` (dropping each version's "Behind the scenes" line, which was never meant for
   a user anyway) — not reusing or inventing new bullets.
2. **"Apa yang baru" shows the 3 most recent releases.** Default: **3**, newest first, no pagination, no link to
   "see all" (there is no public release-notes archive page in this pass). Alternative: show only the current
   version; rejected as less useful for "what did I miss since I last opened this."
3. **Service-worker update: explicit user confirmation on an update, silent auto-activate on a first install.**
   Default: as scoped above. This is a deliberate change to the always-`skipWaiting()` behaviour FN-13 shipped
   with (`src/service-worker/index.ts:25-42` today) and to the promise that quietly implies
   ("Pembaruan masuk sendiri" on `/pengaturan/instal`, left unchanged and still accurate: the *download* is still
   automatic — only *activation on an already-open tab* now waits for a tap, so a long Kotak Masuk review session
   is never yanked out from under the user mid-task). Alternative: keep today's always-silent activation and skip
   the banner entirely; rejected because the owner explicitly asked for a visible "new version — reload" control.
4. **"Periksa pembaruan" is a plain `registration.update()` call, not a server round trip.** Default: as scoped.
   There is nothing server-side to check beyond what the browser's own Service Worker update check already does
   (compares the new `service-worker.js` byte-for-byte); adding a server endpoint would duplicate that for no
   benefit.
5. **Limits with no defined ceiling (connected apps, Gmail look-back usage) show only what is real.** Default: as
   scoped in the table above — never fabricate an "allowed" or "used" number that has no source. Alternative:
   invent a soft cap for connected apps; rejected outright by CLAUDE.md's "money [and figures] is never invented."
6. **Stored files counted: belongings and collectibles photos only.** Default: as scoped. Reasoning: those two
   tables are the only ones with a cheap, already-indexed `photo_key is not null` predicate; every other
   R2-adjacent surface either stores nothing (FN-21: statements/receipts/screenshots processed in memory only) or
   does not exist yet (FN-15 receipt photos, FN-23 agent reports). A single misleading "N files" total that omits
   most real file types without saying so would be worse than two honestly-labelled, narrower counts.
7. **Row placement in the Pengaturan index.** Default: "Pemakaian" in the Akun group right after "Paket & kredit";
   "Tentang" as the last row of the Aplikasi group, after "Pasang aplikasi" (and after FN-41's "Integrasi AI" row
   if that has landed by the time this ships) — see Scope C's reasoning.

## Tracker impact

- Closes the owner request "add version update and usage on settings" (2026-10-09) — not yet a `docs/TASKS.md`
  line; add one when this PRD is accepted: `- [ ] **Claude** — FN-42 version/updates and usage in Pengaturan, no
  migration.`
- Does not duplicate or block on any open `docs/TASKS.md` item: it reads `user_plan_state`/`credit_ledger`
  (FN-30, already done to the credential boundary), `connected_apps` (FN-29, done), `categories`/`api_tokens`
  (FN-06/FN-38, done) — all already-shipped tables; it does not depend on FN-19/FN-41/FN-15/16/17 being unblocked.
- `docs/ACCEPTANCE.md` has no existing row for this feature; add one under a new "Settings: version and usage"
  group once QA runs (mirroring FN-41's own note that it predates the file), rather than overloading the existing
  Design row.
