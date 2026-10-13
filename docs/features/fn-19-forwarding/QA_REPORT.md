# QA report: fn-19-forwarding, cycle 1

**Verdict: PASS** (diff `fb697d2..f2a3726`; all verifiable criteria pass; real-mail and real-Anthropic criteria NOT verified here, as the PRD states)

## Commands run
- `npm run gates`: exit 0; svelte-check 0 errors 0 warnings; vitest `Test Files 242 passed (242)`, `Tests 3660 passed (3660)`; build done. Mocks/fixtures only.
- `FIN_PERSIST_TO=<scratchpad>/qa-d1 npm run db:migrate:local` (fresh dir): all migrations applied, `0030_email_forwarding.sql` shows applied. Local D1 only.
- `E2E_PORT=8927 npx playwright test e2e/shell.spec.ts`: `36 passed, 1 skipped` (flock pass-through shim in scratchpad; no repo change). Local server.
- `E2E_PORT=8927 npx playwright test e2e/aplikasi.spec.ts`: `7 passed`.
- `E2E_PORT=8927 npx playwright test e2e/email-forwarding.spec.ts` (new, QA): `5 passed` (2 tests x phone/desktop + setup).

## Criteria
1 PASS (forwarding.test.ts unconfigured; shell.spec Otomatis disabled with reason; new e2e: reason, no create control)
2 PASS (create, reload, 20 concurrent creates -> one row)
3 PASS (rotate old refused/new accepted, foreign id = missing id 404)
4 PASS (process.test removed owner = identical reject; "Dicatat ke" refusal)
5 PASS (forwarding.test two-user/removed-member cases)
6 PASS (nav.test, shell.spec green)
7 PASS (declared size and overlong stream)
8 PASS (identical reject; 61st dropped; 20 concurrent exact)
9 PASS (malformed set, no text stored)
10 PASS (bank-qris 2800000 minor, WIB date, gmail source; all four parsers incl. income)
11 PASS (wrong-shape fixtures, month boundaries)
12 PASS (non-payment keeps id/date/status only; pending_text nulled in same batch)
13 PASS (last-4 masking across every written column, no logging)
14 PASS (authserv unset/foreign/fail/injected header -> needs_review; transactions count unchanged)
15 PASS (duplicate, same reference new Message-ID, 20 concurrent, tombstone)
16 PASS, 17 PASS
18 PASS (no_ai_key / ai_unconfigured / re-forward; page links /pengaturan/integrasi)
19 PASS with stub (retry, ai_failed after max, ai_invalid, injection fixture, idempotent)
20 PASS (only row owner's key opened)
21 NOT VERIFIED (real Anthropic call; owner item)
22 PASS, 23 PASS
24 PASS (no id lists are bound in the new code; sweeps use a subselect with a fixed batch limit, so json_each is not needed; no LIKE patterns)
25 PASS (no `{@html}`, keyed each; text through cleanText)
26 PASS (i18n.test inside gates)
27 PASS (export and deletion test)
28 PARTIAL: unconfigured page at 360 px (phone project): no horizontal scroll, renders without JavaScript, no create control. Configured-state page (copy control, 44 px targets, form posts without JS) not browser-tested because the e2e server has no INBOUND_EMAIL_DOMAIN; form-post actions covered by integration tests.
29 PASS (log lines carry counts only: grep of console.* in new code)
30 PASS for gates; real-mail end to end NOT VERIFIED (owner items; Authentication-Results header format from Cloudflare unverified, parser fails closed).

## Findings
None blocking. Notes: criterion 28 configured-state browser check left to a run with `--var INBOUND_EMAIL_DOMAIN`; real-mail/real-AI remain NOT verified.

## Added tests
`e2e/email-forwarding.spec.ts` (unconfigured setup page, 360 px, no JS).

## Cycle 2 re-check (`git diff d5e0636..fe81e8b`, HEAD fe81e8b)

**Verdict: PASS.** Cycle 1 evidence above stays for untouched criteria.

Commands run:
- `npm run gates`: exit 0; svelte-check 0 errors 0 warnings; `Test Files 242 passed (242)`, `Tests 3666 passed (3666)`; build ok (fixtures/mocks).
- `E2E_PORT=8927 npx playwright test e2e/email-forwarding.spec.ts e2e/shell.spec.ts`: `40 passed, 1 skipped` (flock shim).
- `E2E_PORT=8927 npx playwright test e2e/privasi.spec.ts` (export download e2e): `5 passed`.
- No new migration in the range; cycle 1 migration check stands.

Fixes re-verified:
- M1 (criterion 15): dedupe key now hashes the full normalised `referenceKey` (JSON-encoded tuple), masked reference only in the note; `referenceKey` is stripped before the draft is written. New process.test case (same last 4, two drafts) green; replay/tombstone/20-concurrent cases still green.
- L6 (15): no-Message-ID key now includes cleaned text; exact replay still dedupes (tests green).
- L1 (22): Gmail code kept only when `authenticatedFrom` (DMARC pass + aligned DKIM, trusted header); look-alike becomes `not_payment` (id and date only). Fixture updated; integration test passes `INBOUND_AUTHSERV_ID`. Note: without `INBOUND_AUTHSERV_ID` no confirmation code is ever shown (fail closed; RUNBOOK updated).
- L3 (13): DIGIT_RUN widened (`*`, spaced dash, slash between 3+ digit groups). New text.test: card/account/phone forms masked; dates (`08/10/2026`), `1.250.000`, `Rp 28.000 - Rp 5.000`, `1/2` kept. Other callers (receipts, imports, statements, csv, export, connected-apps) covered by the full suite, all green; no regression found.
- L5 (27): forwarding tables exported once per account by `user_id`; new integration test shows a left-space address and ledger in the export and absent from `notIncluded`; omitted columns unchanged (`local_part`, counters, `pending_text`, `confirmation_code`, `message_key`). Account deletion untouched (still by `user_id`).
- L2 (RUNBOOK): docs only, read; no behaviour change. L4 deferred by engineer (not a PRD criterion).

Findings: none. Still NOT verified: real mail, real Anthropic, Cloudflare Authentication-Results shape on the Worker route (L2 assumption).
