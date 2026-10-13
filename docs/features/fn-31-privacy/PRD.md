# FN-31 Privacy, usage statistics and data rights

Slug: `fn-31-privacy`. Phase 5 (Connect, plans, trust). Catalog entry: `docs/FEATURES.md` › FN-31 (lines
305-312). Tracker: `docs/TASKS.md` › "Legal review of privacy policy, terms, UU PDP consent and cross-border
notice (before launch)" (**You**, unchecked). Risk tier: **Medium** (one new account-scoped table, first real
use of the already-bound `STATS` Analytics Engine dataset, and a full-account export that reuses FN-18's own
export path — no migration touching money, no new auth/access-control subsystem, no payment).

Owner rule applied: legal review of the privacy policy/terms/consent copy is explicitly a **You** item
(`docs/TASKS.md` line 46); this pass writes the mechanism (consent recording, cross-border notice copy,
opt-out, export) and labels every piece of legal-sounding copy as a draft pending that review, exactly as the
existing `/privasi`/`/ketentuan` pages already do ("Draf. Isi lengkap menunggu tinjauan hukum.",
`src/routes/(site)/site/[legal=legal]/+page.svelte:17`).

## Goal

CLAUDE.md's trust promises — no ads, no tracker, no data sale, mailbox data never used for scoring or
lending, delete anywhere, export any time — are currently promises in prose, not something a user can see or
act on from inside the app. FN-31 gives the user the controls that make those promises checkable: an
opt-out for the usage statistics MONTRA does keep (self-hosted, stripped of anything personal), a record of
what they consented to and when (the UU PDP Law 27/2022 obligation CLAUDE.md names), a one-tap full export of
everything the account holds, and a clear path to the account-deletion flows FN-01 already built. None of this
needs an AI key, a payment provider or a Gmail connection — it is the one Phase-5 feature that is entirely
buildable today.

## Scope

1. **`/pengaturan/privasi` settings screen** (new `GroupRow` in `src/routes/(app)/pengaturan/+page.svelte:14-27`,
   after "Notifikasi"). One page containing, under its own headings:
   - **"Statistik pemakaian"** — the opt-out toggle named verbatim in FEATURES.md FN-31's own mirror line
     ("opt-out in Settings › Statistik pemakaian"), a native `role="switch"` like FN-12's `Toggle.svelte`,
     default **on** (statistics are collected unless the user opts out — matching FEATURES.md's "self-hosted
     usage statistics… with an opt-out", not an opt-in) with a one-line explanation of exactly what is and is
     not collected (the same list as scope item 2, in plain language).
   - **"Ekspor data"** — a single "Ekspor semua data" button (scope item 4).
   - **"Persetujuan"** — the stored consent record's version and timestamp (scope item 3), with the current
     draft privacy-policy/terms/cross-border-notice text linked (the existing `/privasi`/`/ketentuan` site
     pages).
   - **"Hapus akun"** — a link to the existing in-app flow (`/pengaturan/akun`,
     `src/routes/(app)/pengaturan/akun/+page.svelte`) and a mention that the same deletion is also reachable
     without signing in, at the public `/hapus-akun` page (`src/routes/(site)/site/hapus-akun/+page.svelte`,
     already built per FN-01) — this feature adds no new deletion mechanism, only the link, per the brief's
     "account deletion already exists (FN-01) — link it."
2. **Usage-statistics instrumentation** — the first real write to the `STATS` Analytics Engine binding
   (`wrangler.jsonc:23`, declared in FN-00 but unused since). `src/lib/server/analytics/track.ts`:
   `trackEvent(env, opts, event: { screen: string; action: string })` calling `env.STATS.writeDataPoint`. The
   data point's **blobs are exactly**: `screen`, `action`, `deviceType` (`detectMobileOs`'s existing
   `'ios'|'android'|'other'` from `src/lib/shared/user-agent.ts:33-39`, reused as-is), `language`
   (`locals.locale`), `country` (`request.cf?.country`, Cloudflare's own resolved two-letter code — **never**
   the raw IP or any other `request.cf` field). **Never written, by construction (no parameter accepts them):**
   account id, session id, user id, e-mail, any amount, any typed free text, any header or IP address — matching
   FEATURES.md FN-31's own list verbatim and the `docs/ACCEPTANCE.md` row "Usage statistics hold no account id,
   amount, typed text or IP; opt-out works" (line 39). A small POST endpoint,
   `src/routes/api/v1/track/+server.ts`, receives `{screen, action}` from the client (a tiny `track()` helper
   called on navigation and on named button presses — screen/action names are a fixed, reviewed vocabulary, a
   `const` union like `MODULES`, never arbitrary client-supplied strings, so a compromised client cannot smuggle
   typed text into a blob), capped at a few hundred bytes (reuse the bounded-read shape from
   `src/lib/server/forms.ts`), and no-ops (200, nothing written) when the opt-out preference is set or
   `request.cf` is absent (local dev without a real Cloudflare edge) in a way that still lets the rest of the
   page work — a failed or skipped track call is never visible to the user and never blocks navigation.
3. **Consent records.** Migration `0019_privacy.sql` (renumber at merge — FN-29/30 propose 0017/0018 in the same
   window): `consent_records` table, account-scoped (`user_id`, no `space_id` — consent is given by a person,
   like `account_keys`): `id`, `user_id`, `kind` (enum `terms`, `privacy_policy`, `cross_border_notice`),
   `version` (text, e.g. `2026-10-08` — the date the shown copy was last changed, not a semantic version),
   `accepted_at`, `created_at`. The existing sign-up action (`src/routes/(auth)/daftar/+page.server.ts`) gains
   one new required checkbox next to the existing "18+ or guardian permission" one
   (`src/routes/(auth)/daftar/+page.server.ts:26`), and `signUp`'s batch gains one more guarded insert per
   `kind` — the same "one more item in the existing batch" pattern this phase's other PRDs also use for FN-21's
   account key and FN-30's starter grant. **No re-consent flow this pass**: if `version` ever changes, an
   existing account's stored row simply becomes "an earlier version was accepted" information on the settings
   page; prompting for re-consent on a version bump is a future PRD (named in Out of scope), not invented here
   without a real policy change to react to.
4. **Full-account export.** `src/lib/server/export/account-export.ts`: `exportAccount(db, userId, now):
   ReadableStream<Uint8Array>` — a streamed, **uncompressed ("store" method) ZIP container** (no new npm
   dependency: a minimal store-only ZIP writer — local file headers, CRC-32, central directory — is well within
   the "pure, tested, like `csv.ts`" ethos this codebase already follows, and avoids adding a dependency for a
   format simple enough to hand-roll losslessly) containing: one `transactions-<space>.csv` per space the user
   is a live member of, built by **re-running FN-18's own exporter** (`exportTransactionsCsv`,
   `src/lib/server/imports/csv-export.ts:35-68`, called once per space instead of once per request) — not a
   second implementation of CSV export — plus one `account.json` per space-independent fact (profile, plan
   state from FN-30 if present, feature flags, consent records, connected-app labels from FN-29 if present,
   **never any secret, token or password hash**). Reachable from `/pengaturan/privasi`'s "Ekspor semua data"
   button as a direct download (`Content-Disposition: attachment`), no e-mail step, no waiting period — "export
   any time" per `docs/PRD.md` § 9's own risk mitigation.
5. **Cross-border notice copy (draft).** A new section on the existing `/privasi` site page
   (`src/routes/(site)/site/[legal=legal]/+page.svelte`, the `privasi === page.params.legal` branch at lines
   18-27, alongside the existing voice-recognition disclosure) stating in plain language that Cloudflare, the
   AI provider and any Gmail connection partner process data outside Indonesia, matching CLAUDE.md § 7's own
   wording ("Cloudflare, AI and connection partners process outside Indonesia; some apps run servers in Jakarta,
   which Cloudflare storage cannot match"). Marked, like the rest of that page, as draft text pending legal
   review — never presented as a final, binding notice.
6. **i18n**: every new string (toggle label and explanation, export button and states, consent section, the
   cross-border paragraph, the "Hapus akun" links) in Indonesian with an English entry.

## Out of scope

- Any change to what the usage-statistics opt-out default should be beyond "on unless the user opts out" (an
  explicit FEATURES.md wording, not a choice this PRD makes).
- A re-consent prompt flow when `consent_records.version` changes for an existing account — there is no real
  policy version change to react to yet; this is a follow-up once legal review actually produces a dated
  version 2.
- Retrofitting every existing screen with `trackEvent` calls — this pass wires the mechanism and a handful of
  illustrative calls (sign-up, sign-in, the five tab-bar destinations); covering every button in the app is
  incremental work for whoever touches that screen next, not a one-pass rewrite.
- Guest-mode (unauthenticated) statistics opt-out — guest/local-first storage itself is deferred
  (`docs/ARCHITECTURE.md` › "Storage is server-first for now… owner decision 2026-10-07"); this pass's opt-out
  preference lives with the signed-in account, consistent with that same deferral.
- Data-copy/correction/objection request handling by e-mail (FEATURES.md's "answered within 3×24 h") — that is
  an operational/support-process commitment, not a feature to build; the export button (scope item 4) is the
  self-service answer to a copy request, which this PRD does build.
- Breach-notice tooling and the 30-day shutdown-notice mechanism (FEATURES.md's other two mirror lines) — both
  are one-off operational actions the owner takes when needed, not a recurring feature.
- Server logs without IP (FEATURES.md's own line) — a logging-pipeline change outside this feature's routes;
  flagged as a separate item in Tracker impact rather than silently assumed done.

## Acceptance criteria

1. Given the opt-out toggle on `/pengaturan/privasi` is off (default), then a tracked navigation or button press
   writes exactly one Analytics Engine data point whose blobs are only `screen`, `action`, `deviceType`,
   `language`, `country` — proven by a unit test on `trackEvent`'s argument shape (a type-level and runtime
   check that no other field can reach it) rather than only an integration smoke test, since Analytics Engine
   writes cannot be read back in a test.
2. Given the opt-out toggle is turned on, then `/api/v1/track` answers 200 and writes nothing (verified by a
   test double for `STATS` asserting zero calls), and the preference survives a reload (signed-in, persisted,
   not just a client-side flag).
3. Given `trackEvent`'s call sites across the codebase, then none of them is ever passed an account id, session
   id, user id, e-mail, amount, free-typed text, or any `request` header/IP value — enforced by the function's
   own parameter type (only the five named fields are accepted) so a future call site cannot smuggle more in
   without a type error, and spot-checked by a grep-based lint test over the call sites.
4. Given a sign-up, then exactly three `consent_records` rows are written (`terms`, `privacy_policy`,
   `cross_border_notice`) in the same `db.batch` as the account row, each with the current copy's `version`; a
   sign-up attempt without the new consent checkbox ticked is refused the same way the existing "adult" checkbox
   is refused today (fail, not a silent default).
5. Given `/pengaturan/privasi`, then it shows the stored consent version and date for a signed-in account that
   has one, and both the Indonesian and English site pages linked from it still show the existing "Draf. Isi
   lengkap menunggu tinjauan hukum." notice until legal review replaces it.
6. Given a user requests the full-account export, then the download contains one CSV per space they are a live
   member of, each byte-identical to what FN-18's own per-space export endpoint
   (`src/routes/(app)/impor/ekspor/+server.ts`) would produce for the same space and date range, plus one
   `account.json` that contains no secret, token or password hash — proven by a test asserting the absence of
   every sensitive column name in the JSON output.
7. Given a user who is a live member of zero, one, or several spaces, then the export contains exactly that many
   CSV files, never a space they left or were removed from, and never another account's space.
8. Given the export is requested twice in a row, then both downloads succeed (no rate limit blocks "export any
   time") and both are byte-identical for unchanged data — a reconciliation check, the same spirit as "a
   dashboard figure equals the sum of the list it links to."
9. Given the account-deletion path runs, then `consent_records` rows are removed with the account (not kept,
   since the record is a fact about this specific person's action, not shared-space history like a voucher
   redemption) and the usage-statistics opt-out preference is removed with it.
10. Given every new route and action in this feature, then it reads only `locals.user.id`'s own consent/export
    data, never a client-supplied user id — the same account-scoped access rule FN-30's PRD applies to billing
    data, applied here to privacy data.
11. Loading, empty (no consent record yet — an account created before this feature shipped), error,
    exporting/saving and success states on `/pengaturan/privasi` match the existing settings-page pattern
    (`Skeleton`, `ErrorState`, `track()` submit, success only once the server confirms).
12. Every new Indonesian string has an English entry; the cross-border notice and the opt-out explanation never
    overstate what is collected (each item listed must correspond to an actual blob the code writes, checked
    against criterion 1's type).

## Architecture notes

- **New migration** `migrations/0019_privacy.sql` (renumber at merge). New Drizzle table `consent_records`,
  account-scoped like `account_keys` — **not** added to `SPACE_SCOPED_TABLES`; removed directly in
  `src/lib/server/auth/delete-account.ts`'s batch alongside `accountKeys`/`featureFlags`. A second small table
  or a single-row-per-user preference (`usage_stats_opt_out`, shaped exactly like `notification_prefs`,
  `src/lib/server/db/schema.ts:715-734`) for the toggle — reuse that table's own upsert pattern rather than
  inventing a new one, since it is the same "no row = default, one row per (user, kind) overwritten in place"
  shape FN-24 already established.
- **New modules:** `src/lib/server/analytics/track.ts`; `src/routes/api/v1/track/+server.ts`;
  `src/lib/server/export/account-export.ts`; `src/lib/shared/zip.ts` (pure, tested store-only ZIP writer — no
  new npm dependency; `package.json`'s `dependencies` today are only `@noble/hashes`, `drizzle-orm`, `zod`, and
  this feature should not be the reason that list grows for a format this simple to hand-roll); `/pengaturan/
  privasi` route tree.
- **Reused:** FN-18's `exportTransactionsCsv`/`listTransactionsForExport`
  (`src/lib/server/imports/csv-export.ts`, `transactions/aggregate.ts`) called once per live space, not
  reimplemented; `detectMobileOs` (`src/lib/shared/user-agent.ts:33`); the `notification_prefs` upsert pattern
  (`src/lib/server/notifications/repo.ts`, `src/lib/server/db/schema.ts:715-734`) for the opt-out flag; the
  existing sign-up batch (`src/lib/server/auth/accounts.ts`'s `signUp`) and its established pattern of adding
  one more guarded item per feature (FN-21's account key, FN-30's starter grant); the existing `/privasi`/
  `/ketentuan` draft-notice convention (`src/routes/(site)/site/[legal=legal]/+page.svelte`); the existing
  `/hapus-akun` and `/pengaturan/akun` deletion flows (FN-01, unchanged, only linked).
- **Worker boundary:** everything runs in the app Worker. `STATS` is also declared in the jobs Worker
  (`docs/ARCHITECTURE.md`'s binding table lists it for app and jobs) but this pass writes from the app Worker
  only — a jobs-Worker-originated event (e.g. a cron tick) is not instrumented this pass, since none of this
  phase's cron jobs exist yet.
- **No AI, no payment, no R2** in this feature (the ZIP export streams from D1 rows directly, never touching
  R2 — belongings/collectibles photos (FN-27/28), if present, are **not** included in the export this pass,
  named explicitly in Out of scope-adjacent follow-up below since including R2-stored files in an export is a
  meaningfully different streaming problem).

## Prerequisites

- **No new credential.** `STATS` is already bound in both environments (`wrangler.jsonc:23`, staging
  equivalent) on the active Cloudflare Workers Paid account. No Worker secret is needed for Analytics Engine
  writes.
- **Legal review of the privacy policy, terms, UU PDP consent copy and cross-border notice is a `docs/TASKS.md`
  **You** item (line 46), explicitly "before launch," not before this PRD.** This feature ships the mechanism
  and placeholder/draft copy; the copy itself is not final until that review happens, and every page showing it
  keeps the existing "Draf" label until it does.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Usage-statistics opt-out defaults to on (collecting), matching FEATURES.md's own wording** —
   auto-accepted; the feature catalog explicitly frames this as "with an opt-out," not an opt-in.
2. **Consent recorded at sign-up only, no re-consent flow for existing accounts on a version bump** —
   auto-accepted; building a re-consent prompt against a policy version that does not exist yet would be
   speculative. Trade-off: once legal review ships a real v2, a follow-up PRD is needed before existing
   accounts are asked to re-consent.
3. **Full-account export is a direct download, not an e-mailed link or an async job** — auto-accepted as the
   simplest "export any time" implementation for the data volumes this app has today (bounded by the existing
   per-space row caps); a very large multi-space account streams rather than buffers, so memory stays bounded
   regardless.
4. **Belongings/collectibles photos (R2) are not included in the account export this pass** — auto-accepted;
   streaming R2 objects into the same ZIP is a real but separate piece of work (listing, fetching, and sizing
   potentially many photos) better scoped once FN-27/28 are further along; the CSV/JSON data (including each
   item's metadata, just not its photo bytes) is still exported.
5. **No new dependency for ZIP writing; a minimal store-only writer in `src/lib/shared/zip.ts`** —
   auto-accepted, consistent with this codebase's existing lean `dependencies` list and the "pure, tested"
   convention every other shared-code module in this repo already follows.

## Tracker impact

- Closes the credential-free portion that was implicitly bundled into `docs/TASKS.md`'s FN-31 catalog entry;
  adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-31 Privacy: usage-stats opt-out (Analytics Engine,
  first real `STATS` write), consent records, full-account export (reuses FN-18). Legal review of policy copy
  still **You** (line 46, before launch)."
- Adds one follow-up `- [ ] **Claude**` item: "Server logs without IP (FEATURES.md FN-31's own mirror line) —
  audit the request-logging path (`src/hooks.server.ts`'s `handleError` and any access log) and confirm no IP
  is ever logged; not covered by this PRD's routes."
- `docs/ACCEPTANCE.md` row "Usage statistics hold no account id, amount, typed text or IP; opt-out works"
  (line 39, currently "Not run") moves to **Automated** once criterion 1-3's tests pass, citing this feature's
  test file.
