# FN-19 Gmail auto-capture (own OAuth app): summary

**Status: complete** (2026-10-10, branch `feat/fn-19-gmail` from `integrate/2026-10-10`; not merged, not deployed).
QA PASS and red team PASS on cycle 1 (no fix cycle). Real Google and real Anthropic are **NOT verified**.

## Goal (from the PRD)

Connect a user's Gmail through Montra's own Google OAuth app (owner decision 2026-10-10: own app, starts in Google's
"Testing" status with listed test users; verification and CASA before public launch) so bank, QRIS and e-wallet
payment mails become drafts in Kotak masuk without forwarding. Reuses the forwarding fallback's parsers, dedupe
keys, masking, drafts and AI read path.

## What was built

- `/pengaturan/aplikasi/gmail`: explanation screen (what is read, where text goes), "Belum dikonfigurasi" with the
  reason when `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_ORIGIN` or the
  connected-apps key is unset; connect via authorization-code flow with PKCE (S256) and a single-use, session-bound,
  short-lived `state`; fixed callback `/pengaturan/aplikasi/gmail/callback`; scope `gmail.readonly` only
  (`gmail.metadata` cannot use `q` or read bodies). Refresh token sealed with `CONNECTED_APPS_ENCRYPTION_KEY`
  (Gmail-specific labels); never in logs, page data or errors.
- "Periksa otomatis" (default on after connect) and "Dicatat ke" target space; hourly checks 06.00–23.00 WIB on the
  existing jobs cron, fanned out as `gmail_check` / `gmail_read` Queue steps; night mail picked up at 06.00. Query
  limits to the FN-19 sender list and subject keywords and excludes Promotions/Social; attachments never fetched;
  mails without an amount never go to AI. Per-connection pacing 3,000 units/min with exponential backoff (cap 64 s).
- Captures are drafts with source `gmail` through the shared `captureBatch` (new Gmail ledger variant that writes
  only while the connection is connected); same Message-ID dedupe key as forwarding, so one purchase = one record and
  a discarded draft is never recreated. No mail text persisted; non-payment mails keep only id and date; ledger
  retention 90 days.
- "Lihat ke belakang": 7 days on Gratis, longer via FN-30 `gmailLookbackMaxDays`; bounded background scan (2,000 ids,
  3 starts per 24 h).
- Disconnect: revoke at Google, then delete connection, mail ledger, scans and states and discard pending Gmail
  drafts; transactions stay. `invalid_grant` marks the connection disconnected. Account deletion revokes too.
- Push per captured payment left as a follow-up (FN-24 notification kinds are CHECK-constrained; a new kind needs a
  table rebuild). Auto-save not built (default off).

## Files and migrations

- Migration `0033_gmail_connection.sql` (`gmail_connections`, `gmail_scans`, `gmail_mail`, `oauth_states`) plus Drizzle
  schema, snapshot and journal.
- New: `src/lib/shared/gmail/*`, `src/lib/server/gmail/*`, `src/routes/(app)/pengaturan/aplikasi/gmail/*`,
  `test/helpers/fake-google.ts`, `test/integration/gmail.test.ts`, `test/integration/gmail-qa.test.ts`,
  `e2e/gmail.spec.ts`, `e2e/gmail-configured.spec.ts` + `playwright.gmail-configured.config.ts` (QA, opt-in).
- Changed: `inbound/draft.ts`, `drafts/repo.ts`, `shared/inbound/mail.ts`, `shared/jobs.ts`, `workers/jobs` (cron,
  queue, index, env), `workers/inbound/src/process.ts`, delete-account, throttle, export tables, spaces purge, Aplikasi
  page, akun page, i18n (83 phrases with English), `wrangler.jsonc` (staging var `GOOGLE_OAUTH_REDIRECT_ORIGIN`),
  `.dev.vars.example`, `docs/RUNBOOK.md` › Gmail (FN-19).

## Verification

- Engineer: `npm run gates` exit 0 (266 files / 4027 tests); e2e `gmail.spec.ts` + `aplikasi.spec.ts` 13 passed.
- QA cycle 1 PASS: targeted Vitest 101 passed; fresh-DB migrate applied 0033; e2e 13 passed; configured-state e2e
  5 passed; `gmail-qa.test.ts` 4 passed; `npm run gates` exit 0 (267 files / 4031 tests).
- Red team cycle 1 PASS: no high/medium; seven lows L1–L7 tracked in `docs/TASKS.md`.
- NOT verified: real Google OAuth round trip, real Gmail API reads, revocation at Google, PKCE behaviour of a real web
  client at the token endpoint, real Anthropic read (PRD AC 49, 50). All tests use fakes.
