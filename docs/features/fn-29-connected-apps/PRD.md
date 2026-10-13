# FN-29 Connected apps

Slug: `fn-29-connected-apps`. Phase 5 (Connect, plans, trust). Catalog entry: `docs/FEATURES.md` › FN-29
(lines 290-295). Tracker: `docs/TASKS.md` › "Payment provider sandbox (Phase 5); Slack, Notion, Google
Sheets/Calendar apps (Phase 5)" (**You**, still unchecked) and the Phase 2 note "Google Cloud project: Gmail
access… (no Google sign-in) (Phase 2)" which is also unchecked and separately marked "on hold" (`docs/TASKS.md`
line 90-91). Risk tier: **Medium** (one new migration, a new at-rest encryption design, four pure data-mapping
functions and a settings screen — but no live OAuth, no live webhook endpoint, and no secret material this pass
is ever real; nothing here is money, auth or access-control-subsystem work).

Owner rule applied: no owner credential exists for any of the five apps this feature lists (Gmail's own OAuth
decision is separately "on hold" per `docs/TASKS.md` line 90; Sheets/Calendar/Notion/Slack have no app
registered at all per `docs/TASKS.md` line 45). Per the brief, this pass ships everything up to the credential
boundary and every "Hubungkan" control shows `Belum dikonfigurasi` — the same convention FN-13 (VAPID) and
FN-27 (AI recognition) already established.

## Goal

"Aplikasi terhubung" is where MONTRA's capture story extends past itself: a space's data leaving to a
spreadsheet the user already shares with a partner, a calendar reminder, a Notion report, or a Slack channel
that becomes drafts. None of the five app connections can go live this pass (no OAuth client, no Slack/Notion
app, Gmail's own client decision on hold), but every part of the problem that does **not** need a provider
account — the settings screen, the storage shape for a token once one exists, the encryption design for it, the
disconnect/deletion contract, and the pure functions that turn the space's data into each provider's payload
shape — can be built and tested now, so that wiring the real OAuth dance later is a small, well-scoped addition
to an already-reviewed foundation rather than a new design exercise under schedule pressure.

## Scope

1. **`/pengaturan/aplikasi` settings screen** ("Aplikasi terhubung"), added to the settings list
   (`src/routes/(app)/pengaturan/+page.svelte:14-27`, new `GroupRow` after "Notifikasi"). Lists five rows —
   Gmail, Google Sheets, Google Calendar, Notion, Slack (the providers' own product names, so no CLAUDE.md brand conflict) — each showing `Belum dikonfigurasi` this pass. Tapping a row
   opens a detail sheet (`Sheet.svelte`, the FN-07/FN-26 pattern) stating in one short paragraph what that app
   would read or write once available (e.g. Sheets: "akan menambahkan transaksi ke spreadsheet yang kamu
   pilih" / "will append transactions to a spreadsheet you choose") and a disabled "Hubungkan" button captioned
   `Belum dikonfigurasi`, exactly like the AI-recognition control in `docs/features/fn-27-belongings/PRD.md`
   lines 56-59 and the push toggle in `src/lib/server/push/vapid.ts:40`. Clicking the disabled button triggers no
   network request (same rule as FN-27 criterion 7).
2. **`connected_apps` data model**, migration `0017_connected_apps.sql` (renumber at merge — FN-25/27/28 branches
   may already be using 0014-0016; coordinate at merge like every prior PRD in this repo). Space-scoped table:
   `id`, `space_id`, `provider` (enum `gmail`, `google_sheets`, `google_calendar`, `notion`, `slack`), `status`
   (enum `connected`, `disconnected` — this pass a row is only ever created by the dev-only seed action below and
   immediately disconnectable; nothing ever reaches `connected` outside a test), `external_label` (nullable short
   text the detail screen may show once connected — e.g. a Google account's domain or a Slack workspace name,
   never a full e-mail or an unmasked identifier — masked the same way `maskAccountNumbers`/FN-04's `last_four`
   are), `encrypted_token` (nullable blob, base64url ciphertext), `token_nonce` (nullable, base64url), `scope`
   (nullable short text, the OAuth scopes granted — informational only, read-only everywhere this app reads
   data, per CLAUDE.md "no tool can write" applied to the connection itself: MONTRA never asks for write
   scopes to Gmail), `created_by_user_id` (nullable FK, set null on account deletion like `import_batches`),
   `created_at`, `updated_at`, `deleted_at`, `seq`. Content-free tombstone CHECK (`external_label`,
   `encrypted_token`, `token_nonce`, `scope` all null on a tombstone, matching the `subscriptions_content_check`
   style at `src/lib/server/db/schema.ts:800-813`). Added to `SPACE_SCOPED_TABLES`
   (`src/lib/server/spaces/spaces.ts:240-258`), alongside `subscriptions` near the top (it references nothing
   else, but nothing should reference it either, so order is not load-bearing — place it next to `subscriptions`
   for proximity of similar "external integration" tables).
3. **Token encryption — a deliberately different trust model from FN-21.** FN-21's account key seals *AI read
   results* to the signed-in **user's own** key, openable only by a device holding their password-derived
   private key (`src/lib/server/account-keys/repo.ts`, `docs/ARCHITECTURE.md` › "Account key"). A connected
   app's OAuth token must be usable by **unattended server code** — the hourly Gmail cron, a scheduled Notion
   report job — with no user's password anywhere in the request. Sealing it to the account key would make every
   background job impossible (the whole point of FN-21's scheme is that the server *cannot* open it alone).
   FN-29 therefore uses a **server-held** key instead, the same trust boundary any backend OAuth integration
   has for its own refresh tokens: a new Worker secret `CONNECTED_APPS_ENCRYPTION_KEY` (32 raw bytes, base64url),
   read through `getEnv()` like `VAPID_PRIVATE_KEY`. `src/lib/server/connected-apps/crypto.ts`:
   `encryptToken(env, plaintext): { ciphertext, nonce } | null`, `decryptToken(env, ciphertext, nonce): string |
   null` — WebCrypto AES-256-GCM only (no invented scheme, per CLAUDE.md and the sealed-results checklist item),
   a fresh random nonce per encryption (never reused, same rule as FN-21's seal), and `isConnectedAppsConfigured
   (env)` mirroring `isPushConfigured` — false when the secret is unset or not exactly 32 bytes, in which case
   every provider row is forced to `Belum dikonfigurasi` regardless of any stored row's `status`. Round-trip and
   wrong-key tests (decrypting with a different 32-byte key must fail closed, never return the wrong plaintext
   as if valid) in Vitest, the same two vectors FN-21's `account-key.test.ts` runs for its own primitive.
4. **Disconnect and deletion.** `src/lib/server/connected-apps/repo.ts`: `disconnectApp(db, scope, provider,
   now)` — content-free tombstone (clears `external_label`, `encrypted_token`, `token_nonce`, `scope`,
   `status` set to `disconnected`), guarded on `isLiveMember` like every other space write, with an audit event
   (below) in the same `db.batch`. Reachable from the detail sheet's "Putuskan" action once a row exists. Since
   no real app ever writes captured content this pass (no `gmail_messages`-equivalent table exists yet — FN-19
   is its own blocked PRD), disconnect here only ever needs to remove the connection row itself; the PRD text
   for the eventual Gmail row explicitly notes (for the engineer who later builds FN-19) that a real Gmail
   disconnect must *also* purge whatever mail-derived rows FN-19 introduces, per FEATURES.md FN-19's own mirror
   line "disconnect… deletes every e-mail record" — out of scope here, flagged for that future PRD.
5. **Export/import payload builders — pure functions, no network call, each unit-tested:**
   - `src/lib/shared/connected-apps/sheets-export.ts`: `buildSheetsRows(rows: ExportRow[]): string[][]` — reuses
     the exact `ExportRow` shape FN-18 already produces (`src/lib/server/transactions/aggregate.ts`'s
     `listTransactionsForExport`, consumed today by `src/lib/server/imports/csv-export.ts:11-27`) and the same
     formula-injection guard (`csvCell`, `src/lib/shared/csv.ts:422-428`) and `maskAccountNumbers`
     (`src/lib/shared/text.ts`) FN-18's CSV export already applies — a spreadsheet cell is exactly as exploitable
     as a CSV cell, so it gets the same guard, not a new one. Returns a header row plus data rows shaped for the
     real Sheets API's `values.append` body once that call exists; this function never makes that call.
   - `src/lib/shared/connected-apps/calendar-export.ts`: `buildCalendarEvents(reminders: {title: string; date:
     string; note?: string}[]): {summary: string; date: string; description?: string}[]` — `date` is always a
     WIB calendar date string (`isDateString`, `src/lib/shared/dates.ts:33`), never a UTC-shifted one, proven by
     a vector at 23:30 WIB on a month's last day. Tested with FN-24/FN-26-shaped reminder inputs.
   - `src/lib/shared/connected-apps/notion-export.ts`: `buildNotionReportBlocks(summary: {monthLabel: string;
     totalInMinor: number; totalOutMinor: number; currency: string; topCategories: {name: string; amountMinor:
     number}[]}): unknown[]` — maps the same figures Beranda/Laporan already compute into Notion's block-array
     shape; every money figure goes through `formatMoney`/`formatMoneyCompact`
     (`src/lib/shared/money-format.ts`), never hand-formatted.
   - `src/lib/shared/connected-apps/slack-draft-parse.ts`: `parseSlackMessage(text: string, hints: {walletNames:
     string[]}): DraftInput | null` — reuses the existing voice/money parser
     (`src/lib/shared/voice-parse.ts`, `src/lib/shared/money-parse.ts`) exactly, since a Slack message ("kopi
     25rb") is free text exactly like a voice transcript; returns `null` (no draft) for ordinary chat with no
     recognisable amount, so Slack chatter is never misread as a transaction. The output is shaped to feed the
     existing `drafts` insert path (`src/lib/server/drafts/repo.ts`) with `source: 'slack'` — already a valid
     member of `TRANSACTION_SOURCES`/`DRAFT_SOURCES` (`src/lib/server/db/schema.ts:377`,
     `src/lib/shared/drafts.ts:5-13`) from day one of the schema, so no migration is needed for this part. This
     PRD does **not** stand up the live Slack Events API endpoint that would call this function with a real
     message (no Slack app/signing secret exists) — only the pure function and its tests.
6. **Audit events.** `AUDIT_ACTIONS` (`src/lib/server/db/schema.ts:164-173`) gains `app_connected` and
   `app_disconnected`, written through the existing generic `recordAuditEvent`
   (`src/lib/server/spaces/audit.ts`) in the same `db.batch` as the connect/disconnect write, exactly as FN-03
   does for sharing events — no new audit mechanism.
7. **Dev-only seed/clear actions** (`devRoutesEnabled`, the `seedDemoDrafts`/`clearDemoDrafts` convention in
   `src/lib/server/drafts/repo.ts:436-540`): `seedDemoConnectedApp`/`clearDemoConnectedApps` so the settings
   screen's "connected" state, the disconnect action, and the audit trail can all be exercised end to end without
   a real OAuth flow — the only way this feature's write/tombstone/audit paths get proven this pass.
8. **i18n**: every label, the five providers' own names (not translated), the detail-sheet explanation per
   provider, `Belum dikonfigurasi`, the disconnect confirmation, loading/empty/error states for the settings
   list.

## Out of scope

- Any real OAuth or API call to Google, Notion or Slack — no client id/secret exists for any of them.
- The live Slack Events API webhook (needs a real Slack app, signing secret and request-signature verification)
  — only the pure `parseSlackMessage` function ships.
- Gmail's own connect flow (FN-19, separately blocked) — this feature only reserves the `gmail` value in
  `connected_apps.provider` for that future PRD to use; it does not build Gmail capture.
- Writing to a real spreadsheet, calendar or Notion workspace — the three export builders are pure functions
  with zero network calls.
- A `connected_apps` row that is ever `status = 'connected'` outside the dev-only seed action.
- Per-app granular scope/permission pickers (e.g. choosing a specific Sheet tab) — deferred to the real OAuth
  build.
- Retrofitting FN-19/23/30's own gating logic to check a live connection — none of those can go live yet either.

## Acceptance criteria

1. Given the `/pengaturan/aplikasi` screen, then all five providers show `Belum dikonfigurasi` and their
   "Hubungkan" control is disabled; tapping/clicking it makes no network request (dev-tools/network assertion in
   the e2e spec, same pattern as `docs/features/fn-13-pwa/QA_REPORT.md` line 36's VAPID check).
2. Given a user who is not a live member of a space, every connected-apps route and action (list, detail,
   disconnect, the dev seed/clear actions) answers exactly as `requireSpaceAccess` does elsewhere: 404 for an
   unknown or foreign id, identical status/body/timing to a genuinely-missing row — no existence oracle.
3. Given `CONNECTED_APPS_ENCRYPTION_KEY` is unset or not exactly 32 raw bytes, then `isConnectedAppsConfigured`
   is false and every row (even a dev-seeded "connected" one) is shown and treated as `Belum dikonfigurasi`;
   given it is set, then `encryptToken`/`decryptToken` round-trip a synthetic token exactly, and decrypting with
   a different well-formed 32-byte key fails closed (throws or returns null, never the wrong plaintext) —
   proven by a Vitest round-trip test and a wrong-key test, the sealed-results convention from
   `src/lib/shared/account-key.test.ts`.
4. Given a connect or disconnect write, then a `connected_apps` row changes together with exactly one new
   `audit_events` row (`app_connected`/`app_disconnected`) in the same `db.batch` — never one without the other.
5. Given a disconnect action on a dev-seeded row, then the row becomes a content-free tombstone (`external_label`,
   `encrypted_token`, `token_nonce`, `scope` all null, matching `connected_apps`'s own CHECK constraint, refused
   by the harness otherwise) and reloading the settings screen shows `Belum dikonfigurasi` for that provider
   again.
6. Given `buildSheetsRows` is run against FN-18's existing CSV-export money/account-number vectors
   (`test/integration/impor.test.ts`'s formula-injection and masking cases), then it produces the identical
   guarded/masked cell values FN-18's own `exportLine` does for the same input rows — proven by sharing the test
   vectors, not duplicating weaker ones.
7. Given `buildCalendarEvents` is run with a reminder due at 23:30 WIB on a month's last day, then the produced
   event's `date` is that WIB calendar date, never the UTC date one bucket over — the standard FN-24/CLAUDE.md
   WIB-boundary vector.
8. Given `buildNotionReportBlocks` is run with a summary containing `totalInMinor`/`totalOutMinor`, then every
   money figure in the output passes through `formatMoney`/`formatMoneyCompact`, never a hand-built string, and
   the function performs no I/O (pure, synchronous or trivially async with no `fetch`/`db` argument).
9. Given `parseSlackMessage('kopi 25rb dan parkir goceng', { walletNames: [] })`, then it returns the same two
   drafts' worth of amounts/items the existing voice parser already returns for the identical sentence
   (`src/lib/shared/voice-parse.test.ts`'s own vectors, reused) — one parser, two capture paths, never a second
   implementation of money/slang parsing; given ordinary chat text with no amount ("ada yang mau ikut makan
   siang?"), then it returns `null`, never a fabricated draft.
10. Given the account-deletion path runs, every `connected_apps` row of a space the user was the last live member
    of is purged via `SPACE_SCOPED_TABLES`; a shared space's connections survive for the other members.
11. Every new Indonesian string has an English entry; the detail sheet's explanation text never claims a
    capability this pass does not have (no "terhubung" language anywhere while `status` is not truly
    `connected`); no provider's logo or mascot is bundled or fetched (names only, matching FN-26's own "no
    logos" precedent at `docs/features/fn-26-subscriptions/PRD.md` line 20).
12. Loading, empty (no connections yet — the default and, this pass, the permanent state outside dev seeding),
    error and saving/success states on the settings screen and detail sheet match the existing `/kekayaan`/
    `/langganan` pattern (`Skeleton`, `ErrorState`, `EmptyState`, `track()` submit, `invalidateAll` on 404/409).

## Architecture notes

- **New migration** `migrations/0017_connected_apps.sql` (renumber at merge). New Drizzle table `connected_apps`
  in `src/lib/server/db/schema.ts`, added to `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:240`).
  `AUDIT_ACTIONS` gains two members (same file, lines 164-173); `audit_events`'s CHECK constraint (lines
  192-197) must list them too.
- **New modules:** `src/lib/server/connected-apps/{crypto,repo,validation}.ts`; `src/lib/shared/connected-apps/
  {sheets-export,calendar-export,notion-export,slack-draft-parse}.ts`; `/pengaturan/aplikasi` route tree.
- **Reused:** `requireSpaceAccess`/`isLiveMember`/`isPushConfigured`-style configured-check pattern
  (`src/lib/server/push/vapid.ts:28-43`); `recordAuditEvent` (`src/lib/server/spaces/audit.ts`); FN-18's
  `ExportRow`/`listTransactionsForExport`/`exportLine`/`maskAccountNumbers`/`csvCell`; the voice/money parser
  (`src/lib/shared/voice-parse.ts`, `money-parse.ts`); the `seedDemoDrafts`/`clearDemoDrafts` dev-only pattern
  (`src/lib/server/drafts/repo.ts:436-540`); `formatMoney`/`formatMoneyCompact`.
- **New secret:** `CONNECTED_APPS_ENCRYPTION_KEY` (Worker secret, app Worker only this pass — the jobs Worker
  will need it too once a real background job decrypts a token, not before). Add to `src/app.d.ts`'s `Env`
  interface and `.dev.vars.example` with the same "unset → degraded, never a guessed default" comment style as
  `VAPID_PRIVATE_KEY`.
- **No AI, no R2, no live network call** in this feature.
- **Worker boundary:** everything runs in the app Worker (settings screen, actions, dev seed). No jobs-Worker
  change this pass (a real Gmail/Notion cron job is FN-19/a future FN-29 follow-up).

## Prerequisites

- **No credential exists for any of the five apps.** Gmail's OAuth decision is "on hold" (`docs/TASKS.md` line
  90-91: "Anthropic API key and Google OAuth client" on hold by owner 2026-10-08); Sheets/Calendar/Notion/Slack
  have no registered app at all (`docs/TASKS.md` line 45: "Payment provider sandbox (Phase 5); Slack, Notion,
  Google Sheets/Calendar apps (Phase 5)", **You**, unchecked). Until any of these exist, every row stays `Belum
  dikonfigurasi` regardless of this feature shipping — there is no degraded-vs-full state to build, only the one
  state.
- **New local secret** `CONNECTED_APPS_ENCRYPTION_KEY` (generate with e.g. `openssl rand -base64 32`, documented
  in `docs/RUNBOOK.md` alongside the VAPID generation step) — needed only to exercise the encryption round trip
  locally/in CI; unset in production is fine and expected until a real token needs storing.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Server-held key, not account-key sealing, for third-party tokens** — auto-accepted; this is a correctness
   requirement (unattended jobs cannot hold a user's password), not a preference, but is listed here because it
   is a visible departure from FN-21's otherwise-universal "sealed to the account key" story and the owner
   should know why. Trade-off: a compromised `CONNECTED_APPS_ENCRYPTION_KEY` (unlike a compromised individual
   account) exposes every connected token at once — standard for any backend OAuth integration, mitigated the
   usual way (Worker secret, rotated like any other credential, never in source).
2. **`connected_apps` is space-scoped, not user-scoped** — auto-accepted for consistency with wallets/budgets/
   subscriptions all being space data, and because FN-19's own mirror line already names "Dicatat ke" (target
   space) as a per-connection choice. Trade-off: a shared space's connection is visible to every member, like
   every other shared-space resource today.
3. **One settings screen for all five providers, not five separate pages** — auto-accepted as the simpler,
   lower-maintenance structure; matches the single "Aplikasi terhubung" screen in FEATURES.md.
4. **No live Slack webhook endpoint this pass, pure parser only** — auto-accepted; building an unused,
   unreachable webhook (no Slack app to point at it) would be dead code with no way to test it against a real
   signature, so the parser alone is the honest scope boundary.

## Tracker impact

- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-29 Connected apps: settings screen, `connected_apps`
  table and encryption design, Sheets/Calendar/Notion export builders, Slack draft parser — all credential-free;
  real OAuth for any of the five providers waits on Owner decisions still unchecked."
- Does not move any `docs/ACCEPTANCE.md` row (none exists yet for connected apps); once a later PRD adds a real
  provider connection, that PRD can cite this feature's encryption round-trip test as already covering the
  "Sealed results unreadable without the password-derived key"-adjacent row for connected-app tokens (a
  server-key analogue, not the same row — the PRD doing that wiring should add its own row rather than reuse
  FN-21's wording, since the trust model differs as explained above).
