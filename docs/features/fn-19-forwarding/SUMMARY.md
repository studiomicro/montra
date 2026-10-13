# FN-19 e-mail forwarding fallback: summary

**Status: complete** (2026-10-10, branch `feat/fn-19-forwarding`; not merged to `main`, not deployed). QA PASS and
red team PASS on cycle 2 (`fe81e8b`), after one fix cycle.

## Goal (from the PRD)

Give every user a credential-independent "Otomatis" capture path: a secret forwarding address. Bank, QRIS and
e-wallet notifications forwarded to it become drafts in Kotak masuk with amount, merchant, date, masked reference
and direction. Gmail API access (partner or own CASA OAuth app) is still an owner decision and is not built here.

## What was built

- Per-user secret address `m-<26 characters>@INBOUND_EMAIL_DOMAIN` pointing at one space, on
  `/pengaturan/aplikasi/email` (create, copy, rotate, turn off, Gmail forwarding-confirmation code panel, recent
  mail ledger). It is reachable from Settings › Aplikasi terhubung and from Tambah › Otomatis. Otomatis now links
  there, or shows "Alamat penerusan e-mail belum dikonfigurasi." when the domain is unset; "Segera hadir" is gone.
- `workers/inbound`: size cap 1 MiB, unknown/revoked address rejected identically, 60 mails/hour/address,
  postal-mime parsing, topmost `Authentication-Results` trusted only when its authserv-id equals
  `INBOUND_AUTHSERV_ID` (fail closed), four deterministic parsers (bank QRIS, e-wallet payment, bank transfer in,
  bank transfer out) built on fictional `*.example` sender shapes, drafts written directly to D1.
- Other payment-like mail is queued as `inbound_read` on the jobs queue. The message carries only the row id. The
  jobs Worker reads it with the user's own Anthropic key through AI Gateway (FN-15/FN-41 plumbing), validates with
  zod, and requires the amount to appear in the mail. Without a key, the mail is shown as unreadable with a reason
  and its text is not kept.
- Privacy: every capture is a draft (no code path writes a transaction; auto-save stays off). Source `gmail` is
  labelled "E-mail". The dedupe key hashes the full reference and is kept on tombstones, so a discarded capture is
  never recreated. Masked text is held at most 24 h. Non-payment mail keeps only id and date, enforced by CHECKs.
  Account and card numbers are masked to the last 4, including `*`, `/` and spaced-dash separators. An hourly
  sweep runs. Rows are included in export and account deletion.

## Files and migrations

- Migration `0030_email_forwarding.sql` (`inbound_addresses`, `inbound_mail`) plus Drizzle schema and snapshot.
  **Collision risk:** the parallel `feat/fn-22-tanya` branch may also take 0030. Whichever branch merges second
  renumbers its migration to 0031.
- New: `src/lib/shared/inbound/*`, `src/lib/server/inbound/*`, `workers/inbound/src/{process,mime,env.d}.ts`,
  `src/routes/(app)/pengaturan/aplikasi/email/*`, `test/integration/forwarding.test.ts`, `test/helpers/mail.ts`,
  `e2e/email-forwarding.spec.ts`.
- Changed: nav/AddSheet/layout, Aplikasi page, jobs queue/index, inbound wrangler (JOBS_QUEUE producer), export,
  delete-account, shared `text.ts` masking, `.dev.vars.example`, `docs/RUNBOOK.md` › E-mail forwarding (FN-19). New
  dependency `postal-mime@3.0.1` (exact pin).
- **Merge note:** `nav.ts`, `nav.test.ts`, `i18n-en.ts` and `e2e/shell.spec.ts` also carry an uncommitted Mutasi
  add-path edit in the main tree. Expect a conflict there when merging.

## Verification

- Cycle 2 (`fe81e8b`): `npm run gates` exit 0, `Test Files 242 passed (242)`, `Tests 3666 passed (3666)`.
  Playwright `email-forwarding.spec.ts` + `shell.spec.ts`: 40 passed, 1 skipped. `privasi.spec.ts`: 5 passed.
  Migration 0030 applies on a fresh local D1. All runs used fixtures and stubs.
- Red team cycle 1 FAIL (M1: dedupe on the masked reference). Fixed in cycle 2 together with L1, L2 (RUNBOOK), L3
  (partly), L5 and L6.

## Not verified

- Real forwarded mail through Cloudflare Email Routing, real Anthropic reads and the AI Gateway path (fixtures and
  stubs only; mocked mail never counts as a working capture path).
- The exact `Authentication-Results` header Cloudflare adds on the Worker route, and its authserv-id. Until the
  owner checks it per RUNBOOK step 5, every mail stays an unverified, flagged draft.
- Parser sender shapes are fictional. Real bank mail goes to the AI path until redacted samples confirm them.
- Configured-state settings page at 360 px and without JS in a browser (the e2e server has no domain set).

## Open low findings (tracked in `docs/TASKS.md`)

- L3: some separators still unmasked (unspaced en/em dash, U+2212, U+2010, `_`, `,`, `•`, spaced ` / `), and
  `Rp150.000*12` is over-masked.
- L4: a leaked address can trigger 60 AI reads per hour on the user's own key and fill a shared space's draft
  cap. A separate AI-read cap needs a CHECK/migration change.
- L2: the trust model depends on the header check above (owner step).
