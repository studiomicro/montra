# QA report: fn-19-gmail (cycle 1)

**Verdict: PASS** (AC 49 and AC 50 are NOT verified: they need the real Google and Anthropic providers and are not blockers per the brief). No failing finding. Four low observations below, none breaks an acceptance criterion.

Reviewed: commit `f6e95d7` (`git diff HEAD~1..HEAD`, base `integrate/2026-10-10`), PRD `docs/features/fn-19-gmail/PRD.md`, `docs/ENGINEERING_CHECKLIST.md`. Production code was not edited. QA added three test files (listed at the end).

## Commands run

One line each; provider column says what the command touched. No command reached real Google or Anthropic.

- `npx vitest run test/integration/gmail.test.ts src/lib/server/gmail src/lib/shared/gmail workers/jobs` -> `Test Files 5 passed (5), Tests 101 passed (101)`, exit 0. Fake Google (`test/helpers/fake-google.ts`) and stubbed AI: mock.
- `FIN_PERSIST_TO=<fresh scratch dir> npm run db:migrate:local` -> all 34 migrations applied on an empty local D1, `0033_gmail_connection.sql ✅`; second run `No migrations to apply!`. Local D1 only.
- `npx playwright test e2e/gmail.spec.ts e2e/aplikasi.spec.ts` (flock shim on PATH) -> `13 passed (18.7s)`, exit 0. Local `wrangler dev`, no Google client configured: real browser, local server, no provider.
- `QA_GMAIL_CONFIGURED=1 E2E_PORT=8957 npx playwright test -c playwright.gmail-configured.config.ts e2e/gmail-configured.spec.ts --project=phone` -> `5 passed (16.9s)`, exit 0 (the first two attempts failed on my own selector mistakes and were fixed in the spec, not in the app). Local `wrangler dev` with a fictional Google client id/secret; the browser request to `accounts.google.com` is stubbed; no button that makes the Worker call Google was pressed: real browser, fixture client.
- `npx vitest run test/integration/gmail-qa.test.ts` -> `Test Files 1 passed (1), Tests 4 passed (4)`, exit 0. Fake Google: mock.
- `npm run gates` -> exit 0: svelte-check `COMPLETED 1959 FILES 0 ERRORS 0 WARNINGS`, tsc service-worker/jobs/inbound clean, `All matched files use Prettier code style!`, eslint clean, `Test Files 267 passed (267), Tests 4031 passed (4031)`, build `✔ done`. Run after adding the QA files (the first run showed two type errors in my own new test; fixed, then clean). Mock/fixtures only.

## Is "connect flow and connected UI not run in a browser" adequate?

Not by itself. The PRD marks AC 6 (POST answers page data, "Lanjut ke Google" plain link, CSP unchanged), AC 32/45/46 (no-JS submission, 360 px, 44 px targets) as **Browser** level, and the engineer's e2e only covered the unconfigured state. QA closed the gap with `e2e/gmail-configured.spec.ts` (needs `playwright.gmail-configured.config.ts`, skipped in the default run). Result in a real Chromium at 360 px (Pixel 7 project): the configured page shows the explanation, the Testing notice, "Dicatat ke" and a 44 px+ Hubungkan; the POST answers 2xx page data (not a 3xx); JS follows the link at once; without JS the same POST returns 200 with a working `Lanjut ke Google` anchor to `accounts.google.com/o/oauth2/v2/auth` carrying `gmail.readonly`, `S256`, the fixed `redirect_uri` and no verifier; zero CSP violations. With a seeded connection: connected state, address, "Belum pernah diperiksa", Testing notice, Gratis look-back (only 7 days enabled, others disabled with "Tersedia di paket Pro"), 44 px buttons, no horizontal scroll, the toggle shows success only after the server wrote and survives reload, works without JS, the Aplikasi row reads "Terhubung", the disconnect confirmation opens. **Not run in a browser** (would make the Worker call real Google): a real Google round trip and callback, the submit of "Putuskan", "Periksa sekarang", "Pindai sekarang", look-back progress rendering. Those are covered server-side in `test/integration/gmail.test.ts`; the remaining browser gap is not a blocker.

## Checked criteria

Auto = `test/integration/gmail.test.ts` unless stated. Everything is fake Google/AI (Mocked); none of it counts as a working capture path.

| AC | Result | Evidence |
| --- | --- | --- |
| 1 not configured | PASS | Auto "configuration"; e2e `gmail.spec.ts` (reasons in words, no Hubungkan, no `GOOGLE_`, no-JS, Aplikasi row); connect 503 |
| 2 redirect origin validation | PASS | `gmail-unit.test.ts` "accepts exactly one origin" / "treats a path ... as unset" |
| 3 no secrets in results/logs | PASS | `captureConsole()` + `leaks()` in connect/callback/disconnect/read tests |
| 4 own connection only | PASS | "settings writes and access"; QA `gmail-qa.test.ts` re-checks with another user's REAL connection and scan ids: identical answer to unknown ids, nothing changed |
| 5 authorization URL | PASS | "the authorization URL carries exactly the fixed parameters"; `gmail-unit` S256 test; browser spec reads the live URL |
| 6 page data, plain link, CSP | PASS | Browser: `gmail-configured.spec.ts` tests 1 and 2 (QA); `csp.ts` not in the diff |
| 7 callback happy path | PASS | "callback: exchanges with verifier and secret, seals ... 303 without a query" |
| 8 state single-use/bound, 20 concurrent | PASS | "state is single-use and bound ..." and "20 concurrent callbacks" |
| 9 access_denied, missing scope/refresh, Testing notice | PASS | "access_denied ... revoked, nothing stored"; Testing notice seen in browser |
| 10 hostile origin/params | PASS | "a foreign origin is 404; hostile parameters ..." (40 rounds) |
| 11 Dicatat ke | PASS | "settings writes and access"; target persists (browser reload test only for the toggle) |
| 12 throttle, 5 live states | PASS | "connect refuses ... 11th start (429)" asserts 5 states |
| 13 sealing/rotation | PASS | `gmail-unit.test.ts` round-trip, wrong key/tamper/moved row, rotation; "an unopenable token ..." |
| 14 cron fan-out, quiet hours, 06:00 night mail, toggle | PASS | "cron fans out only due connections ..."; "the 06:00 check lists since checked_through - 120 s" |
| 15 idempotent ticks, 20 concurrent reads | PASS | "a repeated tick, a redelivered page ..." |
| 16 query, 20 pages, label check | PASS | "pages are capped at 20"; `gmail.test.ts` query tests; "no amount, an OTP ... Promotions/Spam label" |
| 17 quota, backoff, 403/404 | PASS | "quota: never more than 3,000 units ..."; `gmail-unit` error mapping; `gmail.test.ts` backoff |
| 18 sweep recovery, 48 h expiry | PASS | "sweep: listed rows untouched 15 min ..." |
| 19 hostile responses | PASS | "hostile responses end unreadable ..." and shared `message` tests |
| 20 attachments never opened | PASS | "attachments are never opened ..." (no `attachments.get` call) |
| 21 no amount / OTP / promo: AI never called | PASS | "no amount, an OTP, promo ... AI never called" |
| 22 not_payment keeps id/date only, CHECK | PASS | "the schema refuses text in a listed or not_payment row ..."; migration CHECK test. Diff grep: no body-text write to D1/R2/KV/logs/queue |
| 23 four fixtures equal forwarding | PASS | "the four fixtures through Gmail make the same drafts as through forwarding" |
| 24 forwarding + Gmail = one draft | PASS | "the same payment by forwarding and by Gmail is one draft" |
| 25 discarded never recreated | PASS | "a discarded draft is never recreated ..." |
| 26 duplicate flag, review, no transactions write, cap | PASS | "duplicate amount within 12 h is flagged; nothing ever writes a transaction; the draft cap holds" |
| 27 masking | PASS | "masking: account numbers ..." |
| 28 money/WIB | PASS | "WIB buckets: a 23:30 WIB month-end ..." plus shared parser tests |
| 29 AI only when needed, owner key, gateway headers | PASS | "reads with the owner's own key through the gateway (no cache, no log)"; "no gateway -> ai_unconfigured; no key ..." |
| 30 prompt injection | PASS | "injection: an amount not printed in the mail ..." |
| 31 plan gate, forged form | PASS | "Gratis: 7 days works, 30 is refused server-side; Pro: 365; a lapsed plan is clamped"; QA forged values (`''`, `0`, `-7`, `7.5`, `30abc`, `1e1`, `99999`, NUL, 400 digits) all 400, `30` on Gratis 403, no scan row |
| 32 look-back bounded, one running, 4th refused, Hentikan, no credit | PASS (Auto); Browser part partial | Auto test passes; progress after reload is server-side; running-scan rendering not exercised in a browser (needs queue + Google) |
| 33 invalid_grant -> needs_reconnect, reconnect same row | PASS | "invalid_grant: needs_reconnect ..." |
| 34 space lost | PASS | "the owner removed from the target space: checks pause (space_lost)" |
| 35 no other user's data | PASS | "settings writes and access" + QA test |
| 36 disconnect deletes, tombstones pending | PASS | "revokes with the refresh token, deletes every Gmail row ..." |
| 37 failed revoke | PASS | "a failed revoke still deletes locally ..." |
| 38 read racing disconnect | PASS | "a read racing a disconnect creates no draft ..." |
| 39 account deletion + export | PASS | "account deletion revokes and removes all four tables' rows ..." |
| 40 reconnect after disconnect | PASS | covered by "a discarded draft is never recreated ..." (reconnect leg) and disconnect tests |
| 41 assistant reads no mail table | PASS | No allowlist test existed; QA added `gmail-qa.test.ts` "no assistant tool reads mail tables" (source of `src/lib/server/tanya` names none of drafts/gmail_mail/gmail_connections/inbound_mail/oauth_states) |
| 42 crawl cross-user/removed/signed-out | PASS | "configuration: signed out ... redirects to /masuk"; cross-user tests; space_lost test. Timing class not measurable here |
| 43 D1 limits, bounded deletes | PASS | disconnect/sweep tests with 100+ rows; diff grep finds no `inArray`, `LIKE`, `parseFloat` |
| 44 jobs idempotency | PASS | `workers/jobs/src/queue.test.ts` (+44), `cron.test.ts` (+53) |
| 45 form guard | PASS | All 8 actions call `readFormBody` first (read in `+page.server.ts`); no-JS submit verified in browser (QA spec) |
| 46 UI states, 360 px, 44 px, i18n | PASS | i18n test in the suite; 360 px and 44 px verified in browser (QA spec); loading/error/empty states present in the Svelte file (Skeleton/ErrorState/FormBanner), not exercised in a browser |
| 47 gates | PASS | `npm run gates` exit 0. "New tests shown failing before the code": not demonstrable on a new feature (no code existed); not treated as a defect |
| 48 migration 0033 | PASS | Fresh `db:migrate:local` applies it, re-run is a no-op; "migration 0033" tests (CHECKs, rerun) |
| 49 real Google | NOT verified | Needs the owner's Google Cloud setup (RUNBOOK). Also unconfirmed: PKCE at the token endpoint, `users.getProfile` under `gmail.readonly`, real authserv-id, 7-day expiry |
| 50 real Anthropic | NOT verified | Needs the owner's own key and a real unparsed receipt |

## Findings

No FAIL. Observations, all low and not blocking:

1. Two authorizations opened in two tabs, both completed while connected: the second callback replaces the sealed token, target space and `auto_check` on the same row (one row only; checked in `gmail-qa.test.ts` "a second authorization completed while already connected"). The first refresh token is not revoked. The PRD forbids a second *start* when connected, but not this race. Harmless in practice.
2. Forged "turn on Periksa otomatis" while the connection is paused (`space_lost`) answers 409 "changed meanwhile" instead of a message about the lost space. No 500, no write.
3. Look-back `days=07` is accepted as 7 (normalised to a listed value). Benign.
4. Checklist: no violated item found in the diff (no `inArray`, no `LIKE`, no `parseFloat`, no `unsafe-inline`, no redirect via `startsWith('/')`, i18n entries present, CSP file untouched). `GOOGLE_API_BASE` in the PRD architecture note (dev-only fake base URL) was not built; the e2e relies on integration tests for connect/callback, which is acceptable since no AC requires it.

## Files added by QA

- `test/integration/gmail-qa.test.ts` (cross-user with real ids, forged look-back values, two-tab reconnect, AC 41 source check).
- `e2e/gmail-configured.spec.ts` and `playwright.gmail-configured.config.ts` (configured-state browser checks; skipped unless `QA_GMAIL_CONFIGURED=1`, run with the config above).
