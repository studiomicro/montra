# FN-31 Privacy — engineer report (cycle 1)

Branch `fn-31-privacy` (base `main` 9d3e892). Risk tier Medium. Legal copy (consent text, cross-border notice,
statistics explanation) is **draft**, labelled as such on every page that shows it; legal review stays a
**You** item.

## What works

- **`/pengaturan/privasi`** (new row "Privasi" in Pengaturan, after Notifikasi): Statistik pemakaian switch
  (default on, stored per account, survives reload; plain-form "Simpan" without JS), Ekspor data button,
  Persetujuan (stored kind, version and WIB time per consent kind; empty state for accounts created before
  FN-31; links to the draft `/privasi` and `/ketentuan` site pages), Hapus akun (link to `/pengaturan/akun`
  and the public `/hapus-akun` page — no new deletion mechanism). Loading (Skeleton on retry), error
  (ErrorState), saving, success ("Perubahan disimpan." only after the server confirms) states.
- **Usage statistics**: `src/lib/server/analytics/track.ts` is the only writer of `STATS`
  (`writeDataPoint` appears nowhere else — asserted by a test). Blobs are exactly `screen, action,
  deviceType, language, country`; `StatsFields` has only these keys, `statsDataPoint` throws for any other
  key or an out-of-vocabulary value, `country` is `request.cf.country` reduced to `[A-Z]{2}` or `XX`. The
  opt-out is checked inside `trackEvent` (one place) before any write; nothing is written signed out, without
  `request.cf` (local dev without the edge) or without the binding. `/api/v1/track` takes a form-encoded
  beacon (`navigator.sendBeacon`, so SvelteKit's same-origin check applies), 256-byte cap, closed vocabulary
  (400 otherwise), always an empty 200. Call sites: the five tab destinations + privacy page (navigation,
  `(app)/+layout.svelte`), Tambah sheet open, sign-up, sign-in, account export.
- **Consent records**: `consent_records` (account-scoped, `user_id` FK cascade, kinds `terms`,
  `privacy_policy`, `cross_border_notice`, `version` = date id of the shown text, `accepted_at`). Three rows
  written in the sign-up `db.batch`; a new required checkbox on `/daftar` refused server-side like the 18+
  box. **Append-only**: a `BEFORE UPDATE` trigger raises; DELETE stays possible only for account deletion.
- **Account deletion** (`delete-account.ts`) also deletes `consent_records` and `usage_stats_prefs` in its
  guarded batch.
- **Full-account export**: POST `/pengaturan/privasi/ekspor` → `application/zip` attachment
  `financer-ekspor-<WIB date>.zip`, built by `exportAccount` (`src/lib/server/export/account-export.ts`) and
  the store-only streaming ZIP writer `src/lib/shared/zip.ts` (CRC-32, data descriptors, fixed 1980 file
  times → deterministic bytes; ZIP32 limits enforced; entries opened lazily; `highWaterMark: 0` pull
  streams; cancel propagates to the D1 paging). Contents: `account.json` (fields picked one by one: profile,
  spaces as the member sees them with digits masked, consent records, statistics switch, feature flags,
  notification kinds, account key present yes/no — no hash, salt, token, wrapped key or other member) plus
  one `transactions-NN-<slug>.csv` per live space, produced by FN-18's own exporter
  (`exportTransactionsCsvRanges`, which `exportTransactionsCsv` now delegates to — one implementation) year by
  year, newest first. Without JS the button is a plain form POST (browser download); with JS fetch → blob →
  save, "Ekspor selesai" only once the whole ZIP arrived; refusals come back as `?ekspor=<code>`.
- **Cross-border notice** section and the statistics explanation added to the draft `/privasi` site page
  (still under "Draf. Isi lengkap menunggu tinjauan hukum.").

## Files

- Migration: `migrations/0019_privacy.sql` (+ `meta/0019_snapshot.json`, journal idx 16 tag `0019_privacy`,
  chained to 0015's snapshot) — **renumber/re-chain at merge** after 0016–0018.
- New: `src/lib/shared/privacy.ts`, `src/lib/shared/zip.ts`, `src/lib/server/analytics/track.ts`,
  `src/lib/server/privacy/{repo,messages}.ts`, `src/lib/server/export/account-export.ts`,
  `src/lib/ui/track.ts`, `src/routes/api/v1/track/+server.ts`,
  `src/routes/(app)/pengaturan/privasi/{+page.server.ts,+page.svelte,ekspor/+server.ts}`.
- Changed: `db/schema.ts`, `auth/accounts.ts` (consent in batch, `consentAccepted` required),
  `auth/delete-account.ts`, `auth/throttle.ts` (`account-export` scope, optional `max`),
  `imports/csv-export.ts` (multi-range stream, single implementation), `shared/hosts.ts`
  (`siteOriginForApp`), `ui/icons.ts` (`lock`), `(app)/+layout.svelte`, `pengaturan/+page.svelte`,
  `(auth)/daftar/*`, `(auth)/masuk/+page.server.ts`, `(site)/site/[legal=legal]/+page.svelte`, `i18n-en.ts`.
- Tests: new `src/lib/shared/zip.test.ts`, `src/lib/server/analytics/track.test.ts`,
  `test/integration/privacy.test.ts`, `test/helpers/zip.ts`, `e2e/privasi.spec.ts`; `hosts.test.ts` extended;
  `test/helpers/event.ts` (`cf` option); every `signUp(...)` call site in tests gets `consentAccepted: true`;
  `/daftar` form tests send `consent: 'on'`; e2e sign-ups use the new `tickSignUpBoxes` helper;
  `accounts.spec.ts` gains a "refuses without the consent box" test.

## Decisions (own recommendations, recorded)

1. **Signed-out visitors are never counted** (the opt-out lives with the account, PRD out-of-scope item);
   sign-up/sign-in are counted server-side right after success under the new/returning account's switch.
2. **Opt-out table** `usage_stats_prefs` (one row per user, no row = on), upsert pattern from
   `notification_prefs`.
3. **Export rate limit** reconciles the brief's "rate limit" with PRD criterion 8 ("both downloads
   succeed"): 5 exports per account per 10-minute window via the existing `countAttempt` throttle; two in a
   row always pass.
4. **Export bound**: at most 200 000 exportable rows (one capped count first) and 2 000 (space, year) pairs;
   past either it is refused with a message pointing to FN-18's yearly export — never a truncated archive.
5. **Whole-history CSV**: FN-18's filter is capped at one year, so each space is exported as calendar-year
   ranges, newest first, under one header. One-year spaces are byte-identical to FN-18's endpoint output for
   that year; multi-year files equal FN-18's header + each year's rows (both asserted).
6. **No export timestamp inside the ZIP** (fixed file times, no `exportedAt` in JSON) so two exports of
   unchanged data are byte-identical (criterion 8); the date is only in the file name.
7. **Consent append-only enforced in the database** by a trigger (UPDATE refused), not only by convention.
8. **`exportAccount(db, userId, maxRows?)`**: the PRD's `now` parameter is not needed (deterministic
   output); `maxRows` exists for the cap test.

## Pre-handoff probes (result lines)

- Opt-out zero writes: PASS — `privacy.test.ts` "opted out…": 6 tracked screens + sign-in + export →
  `writeDataPoint` 0 calls; fail-before shown (opt-out check removed → that test fails, restored).
- Banned fields: PASS — `track.test.ts` call-site test (every `trackEvent(trackContext(…), { screen, action })`,
  only `track.ts` calls `writeDataPoint`, every client `track('<name>', '<name>')`), `statsDataPoint` refuses
  extra keys (`userId`, `email`, `amountMinor`, `ip`, `text`, `sessionId`, plus `@ts-expect-error`) and
  free text; integration: written JSON contains no user id, e-mail, space id, session token, city, ASN, colo.
- Removed member's former space: PASS — export after removal lists only `account.json` + own personal CSV;
  removal during a running download → that space's CSV ends after the header (membership re-checked per page).
- ZIP opens with standard unzip, CSVs = FN-18 byte-for-byte: PASS — `unzip -t` "No errors detected", `unzip
  -p` content equal, Python `zipfile.testzip()` None (`zip.test.ts`); integration compares ZIP entries to
  `/impor/ekspor` responses byte-for-byte; ad-hoc wrangler dev :8850: export 200 `application/zip`,
  `unzip -t` OK, two exports `cmp` identical.
- Large-account memory bound: PASS — 48 MiB entry streamed through `zipStore`, heap+arrayBuffers growth
  < 40 MiB sampled (`zip.test.ts`); 2 600-row, 3-year account exported page by page in newest-first order;
  cap → `too_large` at 2 599, ok at 2 600.
- Export rate limit: PASS — 5 sequential succeed (first two byte-identical), 6th → 303
  `?ekspor=terlalu-sering`; other account unaffected; 20 concurrent → exactly 5 answered, 15 refused.
- Consent append-only: PASS — `UPDATE consent_records …` rejected with "append-only"; rows intact; deletion
  with the account removes them and the switch (other account's rows kept).
- Cross-space / account scope: PASS — load/actions read only `locals.user.id`; another account's switch and
  consent never show; signed-out export → 401 via hooks.
- 360 px / no-JS: PASS — `e2e/privasi.spec.ts` (phone 360 px, no horizontal scroll; no-JS export download and
  switch save).
- User copy: no file path or internal identifier in any new message.

## Gates and e2e

- `npm run check`: 0 errors, 0 warnings. `npm run lint`: prettier clean, eslint exit 0.
- `npx vitest run --maxWorkers=4`: 116 files, 1851 tests passed.
- `npm run build`: done.
- Full e2e (`E2E_PORT=8866 --workers=2`): 239 passed, 15 skipped, 1 failed — `[phone] privasi.spec.ts` no-JS
  test (floating tab bar intercepted a pointer click on the button). Fixed by pressing Enter (as other no-JS
  specs do); `privasi.spec.ts` rerun alone: 5/5 passed.
- Observed during the full e2e: workerd "Broken pipe" log lines (11) around various specs; no test failed
  from them; not attributed (likely requests cut when contexts close).

## ACCEPTANCE evidence (row "Usage statistics hold no account id, amount, typed text or IP; opt-out works")

Automated: `src/lib/server/analytics/track.test.ts` (data-point shape, extra-key refusal, vocabulary,
call-site scan) and `test/integration/privacy.test.ts` › "usage statistics" (exactly five blobs, banned
values absent, opt-out → zero writes on endpoint, sign-in and export, persistence across reload). Analytics
Engine writes cannot be read back locally; the real dataset write is unverified until staging.

## Gaps and follow-ups

- Legal review of all draft copy (**You**, before launch). No re-consent flow on a version bump (PRD).
- Export carries transactions (FN-18 CSV) and account facts only: wallets, budgets, goals, subscriptions,
  belongings/net-worth rows and photos are not in this export (PRD scope; follow-up).
- "Server logs without IP" (FEATURES.md FN-31) not covered here — PRD's proposed `**Claude**` tracker item.
- Merge: new `signUp(...)` call sites on other branches need `consentAccepted: true`; new e2e sign-ups need
  `tickSignUpBoxes(page)` (two checkboxes now). Migration renumber at merge.
- Real Analytics Engine write on staging not exercised (local binding is a no-op).

# Cycle 2 — ruling R21 (export holds all of the user's data), rebase onto main

Rebased onto `main` 61520ce (FN-28 collectibles, FN-29 connected apps). Migration regenerated as
`0019_privacy.sql` chained to `0017_snapshot.json` (journal idx 18); re-chain at merge after FN-30's 0018.
FN-28/29 sign-up call sites fixed (`consentAccepted: true` in `aplikasi.test.ts`, `koleksi.test.ts`;
`tickSignUpBoxes` in `e2e/koleksi.spec.ts`).

## What changed

- `src/lib/server/export/tables.ts`: an explicit export decision for every table. `SPACE_TABLE_DECISIONS` is a
  `Record` over `SPACE_SCOPED_TABLES` names (compile-time complete), `ACCOUNT_TABLE_DECISIONS` over the
  account tables, `SYSTEM_TABLES` for the rest; `tables.test.ts` fails when any schema table (or any table
  with a `space_id`) lacks a decision (fail-before shown by dropping one entry), when an exported column
  matches secret patterns, or when a `user_id` would be written.
- Exported as JSON per space (`spaces/<slug>-<first 8 of id>/<table>.json`): connected_apps (no
  `encrypted_token`/`token_nonce`/`token_key_id`), subscriptions, space_notifications (own rows only, no
  `data_key`), net_worth_items, net_worth_snapshots, belongings, collectibles, goal_contributions, goals,
  drafts (no `dedupe_key`), import_batches, budgets, categories, wallets; plus `space.json` (name, kind,
  role, member names and roles as Ruang shows them). Transactions stay as the FN-18 CSVs. Not exported, with
  the reason written into `account.json › notIncluded`: space_seq, audit_events, space_invites (token
  hashes), user_passwords, notification_deliveries; account_keys only as `present`.
- Per account (`account/<table>.json`): sessions (no `token_hash`), feature_flags, notification_prefs,
  user_notifications, push_subscriptions (no endpoint/p256dh/auth/session id), consent_records,
  usage_stats_prefs; `account.json` holds profile, spaces index, photos summary, notes. No plan/credits
  table exists on main yet (FN-30).
- Rows as the app shows them: live rows only, `*_minor` integers with their currency column, instants as
  WIB ISO 8601 (`wibIsoString`, new in `shared/dates.ts`), booleans as booleans, account-number digits
  masked in free-text columns; never `space_id`, `user_id`, `seq`, `deleted_at`, R2 keys. Read 500 rows per
  page in rowid order (deterministic), live membership re-checked on every space page.
- Photos: `photos/<belongings|collectibles>/<id>.<jpg|png|webp>`, streamed from R2 (`FILES`) one chunk at a
  time; each row carries `photo` (its path) or `photo: null` + `photoNote`. Before anything streams: at most
  1 000 photos and 500 MiB (R2 HEAD, 8 at a time) — over → refused with "Foto barang dan koleksimu lebih dari
  500 MB…" (`?ekspor=foto-terlalu-besar`), never cut. A missing object is listed with a note. Without the
  R2 binding photos are listed with "not included: photo storage was not available".
- The row cap (200 000) now counts every exported table, not only transactions.

## Probes (cycle 2)

- Every table present: PASS — every `SPACE_JSON_TABLES` file in each live space folder and every
  `ACCOUNT_JSON_TABLES` file present; content checked for goals, contributions (masked note), budget, net
  worth, wallets, categories, import batches, own-only notifications.
- No secret anywhere: PASS — the whole archive scanned for password hash/salt, session token and hash,
  invite token hash, account-key material, push endpoint/p256dh/auth, connected-app ciphertext/nonce/key id,
  password, another member's e-mail; every JSON key scanned against secret patterns.
- Removed member: PASS — former space's CSV and folder absent after removal; removal mid-download ends its
  rows (CSV header only, `wallets.json` `[]`).
- Memory bound with photos: PASS — 4 × 64 MiB photos from a chunk-producing bucket: R2 never read more than
  one 256 KiB chunk ahead of the download (`produced − consumed ≤ 1 chunk`).
- Photo cap: PASS — refused at 70 999 bytes for 71 000 bytes of photos, accepted at 71 000; photo bytes in
  the ZIP equal the R2 objects.

## Gates and e2e (cycle 2)

- check 0 errors / 0 warnings; lint clean; `vitest --maxWorkers=4`: 129 files, 2010 tests passed; build done.
- Full e2e `E2E_PORT=8866 --workers=2`: 256 passed, 15 skipped, 0 failed (no reruns needed).

## Gaps (cycle 2)

- R2 subrequest volume (≤ 1 000 HEAD + 1 000 GET per export) not verified against the Workers plan limits
  on staging; the caps are conservative but unmeasured there.
- An object deleted between HEAD and GET is written as an empty file (the row already names its path).

## Cycle 3 (rebase onto main 780f1cb)

Conflict resolutions:
- `migrations/0019_privacy.sql` keeps its number (main's highest is `0018_billing`); `_journal.json` and
  `meta/0019_snapshot.json` regenerated with drizzle-kit on top of 0018 (generated DDL identical to ours; the
  hand-written append-only trigger kept). Snapshot `prevId` = 0018's id.
- `auth/accounts.ts`: sign-up batch carries both `signUpBillingSteps` (FN-30) and `consentInserts` (FN-31).
- `auth/delete-account.ts`: doc merged (plan state deleted; FN-30 history detached by FK set null; consent and
  statistics switch cascade). No code conflict.
- `auth/throttle.ts`: scope union holds both `billing-checkout` and `account-export`.
- `db/schema.ts`, `i18n-en.ts`: both sides' additions kept.
- Export (`export/tables.ts`): account tables now include `user_plan_state`, `credit_ledger`,
  `voucher_redemptions`, `billing_events` (omits `provider_event_id`, `replay_count`, `last_seen_at`) and
  `plan_changes`; `vouchers` listed in SYSTEM_TABLES (shared definitions, hashed codes). Belongings,
  collectibles and connected apps (token columns omitted) were already covered.
- Main's new tests/e2e updated for the required consent: `billing.test.ts`, `billing-plan-expiry.test.ts`
  (`consentAccepted: true`), `e2e/paket.spec.ts` (`tickSignUpBoxes`).
- New test in `privacy.test.ts`: export carries plan, credit history and redeemed vouchers; never the voucher
  code/hash or another account's rows.

Gates (check, lint, test with `--maxWorkers=2`, build; under the shared flock):
- svelte-check: 1385 FILES 0 ERRORS 0 WARNINGS
- prettier + eslint: clean
- Test Files 138 passed (138); Tests 2077 passed (2077)
- build: ✔ done
