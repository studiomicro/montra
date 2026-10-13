# QA report FN-22 Tanya

**Verdict (cycle 3): FAIL on the gates rule only, caused by host load; no product defect found.** `npm run gates` was not clean in 3 runs (load average 21-27 from other worktrees): each run failed 2-5 timing-sensitive integration tests, a different set each time, and all of them pass when re-run alone. Answer-guard allowlist (S8-S10) has no PRD-breaking false positive. Re-run `npm run gates` on a quiet machine; if clean, this becomes PASS (with the unverified items from cycle 1).

## Cycle 3 (`git diff e5243af..c5bec5f`)

### Commands run
- `npm run gates` (x3): exit 1 each time. Run 1: 2 failed / 3791 passed (`test/integration/tanya.test.ts` concurrency probe and "resubmitted form"). Run 2: 4 failed (net-worth x2, recurring, `sync.test.ts`; 3 "Test timed out in 30000ms"). Run 3: 5 failed (net-worth, recurring x2, tanya x2). Mocks and fixtures, no provider.
- `npx vitest run test/integration/tanya.test.ts` (x3, quiet moment): 27 passed each time.
- `npx vitest run test/integration/net-worth.test.ts test/integration/recurring.test.ts src/lib/ui/offline-queue/sync.test.ts`: 64 passed.
- `npx vitest run src/lib/server/tanya/answer-guard`: 134 passed (added 20 QA tests). Pure function.
- `PATH=<no-op flock shim>:$PATH E2E_PORT=8792 npx playwright test e2e/shell.spec.ts e2e/tanya.spec.ts`: 42 passed, 1 skipped (local wrangler, no provider; repo untouched).

### Guard false-positive check (answer-guard.qa.test.ts, cycle 3)
Kept as prose (16): "naik dari {A} ke {B}", "Dibanding bulan lalu ... naik {C} menjadi {A}", English "rose from {A} to {B}", top-3 lists with newline numbering ("1." and "1)"), "-" and "*" and bullet "\u2022" lists, "Indomaret"/"Alfamart", both not-financial-advice lines (ID/EN), quotes and em dashes, "3 dompet: BCA, GoPay", "10 Oktober 2026", no-data answer, "(sisa {B})", "Warung 99 minggu ini" (a small digit word between words).
Falls back to figures-only (fail closed, accepted): a digit-bearing merchant next to a count or figure ("3 kali di 7-Eleven", "Transaksi di 7-Eleven"; the merchant's digit word is not a plain small number), a typed percent ("Naik 12%", the `%` is not allowed and percentages must be figures), decimals, magnitude words, currency symbols, emoji, non-Latin scripts.
Judgement: no PRD criterion breaks. Criterion 9/10 want server figures only, and the fallback still shows the figure cards plus TANYA_FIGURES_ONLY, so the user still gets the numbers. Merchant names with digits are rare in answers and the card list still names them.

### Findings
No FAIL on product behaviour. Notes:
1. Gates not clean here only through host load (see verdict). Possible weak spot: `tanya.test.ts` "20 concurrent questions" and "resubmitted form answered once" failed in 2 of 3 loaded runs (call count 0 and 2 instead of 1). They pass alone 3 of 3; the concurrency probe may be timing dependent. Worth a look if it fails on a quiet machine too.
2. Guard notes: `7-Eleven`-style merchants and typed `%` fall back to cards; watch real-model answers via `compat:tanya`.
3. `flock` still missing on macOS (pre-existing).

---

**Verdict (cycle 2): PASS (with unverified items listed in cycle 1)**. Fix cycle 2 (S1-S6) is covered by tests, `npm run gates` is clean, the broadened answer guard keeps ordinary prose. Real provider (31/P) and the browser happy path with a stub backend remain NOT verified.

## Cycle 2 (`git diff 2453b74..34b1de3`)

### Commands run
- `npm run gates`: exit 0; Test Files 244 passed (244), Tests 3718 passed (3718) (was 3675); build done. Mocks and fixtures only, no provider.
- `npx vitest run src/lib/server/tanya/answer-guard.qa.test.ts` (added by QA): 12 passed. Pure function, no provider.
- `PATH=<no-op flock shim>:$PATH E2E_PORT=8792 npx playwright test e2e/shell.spec.ts e2e/tanya.spec.ts`: 42 passed, 1 skipped (phone and desktop; local wrangler, no provider). Same shim approach as cycle 1, repo untouched.

### Re-verified
- S1/S2 answer guard (NFKC, invisible and private-use stripping, confusables, currency symbols and words, decimals, `persen`, `juta`/`ratus` words, slang amounts, digit glued to a placeholder, unread `[[`): PASS, covered by the extended answer-guard.test.ts (gates green). Rendered text is the normalised text.
- False-positive check (new `answer-guard.qa.test.ts`): 11 realistic answers stay `prose` with the server figure filled in: "Oktober 2026", "3 bulan terakhir", "2026-10-01", "1 Oktober sampai 10 Oktober 2026", "12 transaksi", "5 langganan", "7 hari terakhir", category names ("Makan & Minum", "Belanja Bulanan"), a numbered list, "23:30 WIB", English prose, `{A}-{B}` ranges. PASS: normal answers are not dropped.
- S3 random 8-char figure ids (stale or injected ids fail as unknown): PASS (figures/guard/integration tests green; figure cards and formatted values still render).
- S4 read-only facade as allowlist (builders, single-SELECT raw reads; everything else throws): PASS (tools.test, criterion 3). Tools still run (integration tests green).
- S5 export skips expired Tanya rows (`unexpiredOnly`, also in `countRows`): PASS (export test in integration/export suites green); PRD records removed-member rows as out of scope.
- S6 wallet card capped at `TANYA_CARD_ROWS_MAX` (40) keeping all totals: PASS (tools.test). Wallet cards still validate.
- S7 accepted residual risk is documented in the PRD out-of-scope list.
- Untouched criteria keep cycle 1 evidence.

### Findings
No FAIL. Notes:
1. The guard is deliberately conservative: spelled-out magnitude words (`sepuluh`... only `puluh/ratus/ribu/juta/...` stems such as "ratusan transaksi", "sepuluh") and decimals ("1,5 kali") drop the prose to the figure cards with TANYA_FIGURES_ONLY. Expected per the design comment; no false positive found on dates, counts, category names. Watch real-model answers once the owner runs `compat:tanya`.
2. `flock` still missing on macOS (pre-existing).

---

# Cycle 1 (kept)


**Verdict: PASS (with unverified items listed below)**. Every Automated criterion has a covering test and `npm run gates` is clean. The real-provider criterion (31/P) and the Browser happy path with a stub backend are NOT verified.

## Commands run
- `npm run gates` (check, lint, test, build): exit 0; Test Files 244 passed (244), Tests 3675 passed (3675); build done. Real provider: none (mocks and fixtures only).
- Migration 0030 on a fresh local DB: applied by the e2e webServer (`rm -rf` persist dir, then `node scripts/migrate-local.ts`), exit 0, server started. Local only.
- `npx playwright install chromium`: OK (Chrome Headless Shell 153, local tooling).
- `flock` is missing on macOS, so `scripts/e2e-build.sh` fails; I ran with a no-op `flock` shim in a scratchpad `PATH` (repo untouched): `PATH=<shim>:$PATH E2E_PORT=8791 npx playwright test e2e/shell.spec.ts`: 38 passed, 1 skipped (phone and desktop; local wrangler, no AI Gateway, no provider).
- Same command for `e2e/tanya.spec.ts` (added by QA): 5 passed (setup, phone, desktop). Local wrangler, no provider.

## Request body check (anthropic.ts), against the claude-api reference
- Model `claude-sonnet-5-5` (RECEIPT_MODEL) is a valid current id.
- `thinking: {type: 'between_tools'}`: per the reference, valid for Sonnet 5.5 ("`{type:"disabled"}` returns 400; send `between_tools` to turn thinking off"), accepted only at effort `high` or below (effort is omitted, default `high`: OK), and with no other field (none sent: OK). Not a 400 by the documentation. Never exercised against the real API: NOT verified live.
- No `temperature`/`top_p`/`budget_tokens`, no prefill, no forced `tool_choice`: all would 400 on this model and none are sent. Tools use `name/description/input_schema`: valid.
- Loop: assistant content is appended verbatim (keeps any thinking/progress block, as the preserved-thinking rules want); one user message with only `tool_result` blocks, one per `tool_use`, `is_error` on failures; stop reasons `end_turn`, `tool_use`, `max_tokens`, `refusal` handled, any other (`pause_turn`, `stop_sequence`) becomes `malformed`. Acceptable. Note: the reference recommends `fallbacks` for refusals on this model; out of the PRD scope, not a finding.
- Answer guard: figures reach the page only as `[[f:ID]]` replaced by server `formatted`; unknown ids, `Rp`, 4+ digit groups, grouped numbers, percents and `rb/jt` amounts drop the prose (tests in answer-guard.test.ts, integration "prose with an unverified number is replaced").

## Criteria
1 PASS (integration "two users, two spaces ... 101+ merchants"; tools.test "model-supplied space id ... refused"). Removed member 404: PASS ("a removed member gets the same 404").
2 PASS ("signed out: load and both actions go to /masuk"). 3 PASS (tools.test "imports no write helper", "facade refuses every write"). 4 PASS (period span refusal test; merchants bounded test).
5 PASS (WIB 23:30/00:30 test). 6 PASS (reconciliation test). 7 PASS (other currency test; formatter use). 8 PASS (transfers, adjustments, demo test).
9 PASS (answer-guard.test). 10 PASS (M, mocked; guard and integration test). 11 PASS ("stored text is cleaned, capped"). 12 PASS (M; unknown tool is_error in loop.test; space id test in tools.test). 13 PASS by code and test review (no `{@html}`). 14 PASS for the prompt rule (loop.test prompt test); real wording NOT verified (P).
15 PASS (integration, no fetch). 16 PASS (provider outcomes in anthropic.test/loop.test; "key never reaches page data" test). 17 PASS (anthropic.test headers, redirect manual, timeout; loop deadline). 18 PASS (31st question 429; 20 concurrent probe). 19 PASS (zod on tool inputs and answers; malformed tests). 20 PASS (M, loop.test). 
21 PASS ("tool_use to answer: both rows saved ... after reload"). 22 PASS (expiry and clear tests). 23 PASS (export and delete-account test). 24 PASS ("resubmitted form is answered once"). 25 PASS (migration applied on fresh DB; journal and snapshot present; RUNBOOK edited).
26 PARTIAL: unavailable state PASS in browser (shell.spec "Tanya says why it is unavailable", 5/5 runs green). Browser happy path, pending and error state with a stub backend: NOT verified (no stub backend e2e exists).
27 PARTIAL: PASS for 360 px no horizontal scroll and heading order on the unavailable page (e2e/tanya.spec.ts). Touch targets, glass tab bar and keyboard overlap, contrast, focus return, aria-live on a real answer: NOT verified (needs a working composer).
28 PARTIAL: /tanya renders without JavaScript (e2e/tanya.spec.ts, also English). Asking and clearing without JS: NOT verified in browser (covered only by the form-action integration tests).
29 PASS (i18n test within gates; English render checked in e2e). 30 PASS (check clean; shell.spec updated; nav.test; /tidak-ada 404 test green). 
31 NOT verified: `compat:tanya` exists (script and unit test), not run (needs owner key). Correct per PRD. 32 PASS (gates clean). Fail-before proof is the engineer's claim; not re-run by QA.

## Findings
No FAIL. Notes:
1. The real call, including `thinking: {type: 'between_tools'}`, is untested against Anthropic; the owner must run `npm run compat:tanya` before anyone says Tanya works with Claude.
2. `scripts/e2e-build.sh` needs `flock`, absent on macOS; e2e runs here only with a shim. Pre-existing, not part of this diff.
3. The browser criteria 26 (happy path), 27 and 28 (asking and clearing) are partial; the PRD labels them Browser with a test-only stub backend that was not built. Recommend a follow-up, not a block, since the logic is covered at Automated level.
4. English heading of `/tanya` renders "Ask" (existing entry for the title); consistent with the nav, no action.

## Cycle 4

Verdict: PASS. The cycle 3 FAIL was only `npm run gates` timing out under host load; fix commit 70cf42d is test-only and holds.

Scope: `git diff 67d9c7a..9918515` (HEAD 9918515): `test/integration/tanya.test.ts` (+11/-2) and `SECURITY_REPORT.md` (docs). No production code changed.

Commands (host load 18-22 throughout):
- `npm run gates`: exit 0. `0 ERRORS 0 WARNINGS`; `All matched files use Prettier code style!`; `Test Files  245 passed (245)`; `Tests  3793 passed (3793)`; build `done`. No flake, no rerun needed.
- `npx vitest run test/integration/tanya.test.ts` x3: each `Test Files 1 passed (1)`, `Tests 27 passed (27)`.

Test diff review: the 20-concurrent-ask test now waits for the first provider call with `timeout: 20_000, interval: 20`, and a `finally` opens the gate and awaits `Promise.allSettled(pending)`, so no ask leaks into the next test's fetch count. Assertions are unchanged (one redirect, the rest busy); the test is not weakened. Fine.

Red team cycle 3 verdict is PASS with lows S11-S14 (SECURITY_REPORT.md); not QA blockers. Earlier-cycle notes (criteria 26-28 partial, `compat:tanya` unrun, flock shim) stand unchanged.
