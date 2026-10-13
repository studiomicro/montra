# FN-31 Privacy — Security report

Reviewer: red-team-pentester. Branch `fn-31-privacy`, head 63a10f4, diff `git diff main...HEAD`.

## Verdict: PASS

No medium or high findings. Three low findings and two informational notes, listed so they are tracked.

## Scope checked

- Full-account export: `src/lib/server/export/account-export.ts`, `export/tables.ts`, `shared/zip.ts`,
  `routes/(app)/pengaturan/privasi/ekspor/+server.ts`, `imports/csv-export.ts`.
- Usage statistics: `server/analytics/track.ts`, `routes/api/v1/track/+server.ts`, `ui/track.ts`, `(app)/+layout.svelte`.
- Consent: `migrations/0019_privacy.sql`, `auth/accounts.ts`, `(auth)/daftar/+page.server.ts`, `privacy/repo.ts`.
- Account deletion: `auth/delete-account.ts`. Loaders: `pengaturan/privasi/+page.server.ts`, `daftar` load.

## What holds

- **Cross-user / cross-space**: the export takes only `locals.user.id`; no request field names a user or space.
  Spaces come from live memberships of live spaces (`liveSpaceIds`); every space-table page and every FN-18 CSV
  page repeats `isLiveMember`. `space_notifications` is filtered to the caller's own rows. Spaces left or removed
  from are absent (covered by `privacy.test.ts` "never a space the user left…").
- **Secrets**: `user_passwords`, `account_keys` material, `space_invites` hashes, `sessions.token_hash`, push
  `endpoint/p256dh/auth`, `connected_apps` encrypted token/nonce/key id, `vouchers.code_hash`, dedupe/data keys
  and R2 keys are never written. A test fails when any exported column matches secret patterns or `*user_id`,
  and when a schema table has no export decision. I dumped every unmasked plain column of every exported
  table: none carries secret material.
- **ZIP injection**: entry names are built only from fixed strings, ASCII slugs (`[a-z0-9-]`), sanitised space id
  prefixes and server-generated row ids; `zipEntryName` additionally refuses `..`, `.`, empty segments,
  backslash, NUL and >255 bytes; duplicates refused.
- **R2**: keys come only from `photo_key` of live belongings/collectibles in the caller's live spaces; never from
  input. HEAD-sized against a 500 MiB cap and a 1 000-photo cap before streaming.
- **Throttle**: per-user, 5 per 10-minute window, counted atomically before the work (20-concurrent test holds).
- **Beacon**: form content types only (415 otherwise, so SvelteKit's origin check always applies; CSRF not disabled
  in `vite.config.ts`), 256-byte cap with timeout, closed screen/action vocabulary (400 otherwise),
  `statsDataPoint` refuses any extra key; writes nothing signed out, without `request.cf`, or when opted out;
  an opt-out read failure fails closed. No user id, IP, amount or free text reaches a blob.
- **Consent**: required server-side in `validateSignUp` (the only `signUp` caller is `/daftar`); records written in
  the same batch as the account; `BEFORE UPDATE` trigger makes them append-only.
- **Deletion**: `consent_records` and `usage_stats_prefs` deleted explicitly (and FK cascade).
- **Loaders**: only `siteOrigin`, `exportError`, `statsEnabled`, `consent` (kind/version/date). No secrets.
  New logs carry only error names. Download response is `private, no-store`, `nosniff`, attachment.

## Findings

### L1 (low) — Photos and member names of a space still stream after removal mid-download
`src/lib/server/export/account-export.ts:387-392` (photo entries) and `:369` (`space.json` via `listMembers`,
which has no membership guard, `spaces/spaces.ts:92`).
The photo list is fixed when the export starts and each R2 GET is not re-checked against membership; `space.json`
is also generated without `isLiveMember`. Reproduction (probe run, then deleted): member starts the export,
owner removes the member, the member keeps reading the stream: `belongings.json` is empty as intended, but
`photos/belongings/<id>.jpg` and `spaces/<slug>/space.json` (owner's name) still arrive. Exposure is limited to
data the member could see when the download began; the module comment claims "a removal while the download
runs ends that space's rows", which is true for rows only. Fix: re-check `isLiveMember` before each photo GET and
before `listMembers` (or emit nothing for that space once the check fails).

### L2 (low) — Export throttle fails open when the throttle table errors
`src/lib/server/auth/throttle.ts:156` (pre-existing behaviour, newly reused by `account-export`). On a D1 error
the check returns `false`, so the 5-per-10-minutes cap on the heaviest endpoint in the app (up to 200 000 rows,
1 000 R2 HEAD+GET, 500 MiB) is lifted while D1 is degraded. Consider failing closed for the `account-export` scope.

### L3 (low) — No rate limit on `/api/v1/track`
`src/routes/api/v1/track/+server.ts:18-24`. A signed-in user can POST the beacon in a loop: each costs a D1 read
and an Analytics Engine write, and inflates statistics. No privacy impact (vocabulary closed, opt-out honoured).
Consider a per-user throttle or sampling.

### Informational
- I1: `space_notifications.params` and `user_notifications.params` are exported verbatim (JSON text, not run
  through `maskAccountNumbers`). Today they hold kinds, amounts and ids; if a future notification puts a wallet or
  goal name into `params`, an account-like number would bypass export masking.
- I2: Per-export cost (200 k rows, up to 2 000 R2 subrequests) may approach Worker subrequest/CPU limits on large
  accounts; that is an availability concern, not an access one. Verify on staging with a near-cap account.

## Engineering checklist

Access via the shared membership helper (yes, repeated per page); masking on export (yes, except I1);
form-body guard with 400/415 (yes); bounded queries with caps (yes); no `{@html}`; CSV export reuses FN-18's
formula-prefixing; i18n entries present (i18n test passes); concurrency probe (20 concurrent exports) present.

## Commands run

- `flock … npx vitest run test/integration/privacy.test.ts src/lib/server/export src/lib/shared/zip.test.ts
  src/lib/server/analytics test/integration/delete-account.test.ts --maxWorkers=2` — 5 files, 53 tests passed.
- `flock … npx vitest run src/lib/shared/i18n --maxWorkers=2` — 12 tests passed.
- Probe `test/integration/zz-redteam-fn31.test.ts` (L1 reproduction) — 1 passed, confirming the leak; file deleted.
- Column dump probe on `SPACE_JSON_TABLES`/`ACCOUNT_JSON_TABLES` — run and deleted.
