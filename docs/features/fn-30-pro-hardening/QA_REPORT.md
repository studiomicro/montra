# QA report: FN-30 / FN-41 hardening before a real payment provider (cycle 1)

**Verdict: PASS.** No product defect found. Every acceptance criterion except 29 has a passing test. Two items
are not fully verified by QA in this cycle: criterion 29 (`npm run gates` was not run, on the caller's instruction
because the machine was heavily loaded) and the full-body half of criterion 25 (see F1). The caller must run
`npm run gates` before merge.

Scope: `git diff 38c5f82..ed30002` (commit `ed30002`, 40 files). QA cycle 1 adds the tests
`test/integration/billing-hardening-qa.test.ts` and one e2e test in `e2e/integrasi.spec.ts`. No production code was
changed.

## Commands run

- `npx vitest run test/integration/billing-hardening-qa.test.ts test/integration/billing-hardening.test.ts test/integration/migration-0030.test.ts src/lib/server/admin.test.ts src/lib/server/billing/claims.test.ts src/lib/server/billing/refunds.test.ts test/admin-page.test.ts test/paket-page.test.ts test/i18n-coverage.test.ts`: `Test Files 1 failed | 8 passed (9)`, `Tests 1 failed | 51 passed (52)`, exit 1. Local D1 and the in-process signed mock webhook; no real provider. The one failure was the new QA test: its own voucher code contained letters outside Crockford (`RangeError: invalid voucher code`). This was a test bug, fixed below.
- `npx vitest run test/integration/billing-hardening-qa.test.ts`: `Tests 3 passed (3)`, exit 0. Local D1.
- `npx vitest run test/integration/billing-hardening-qa.test.ts test/integration/billing.test.ts test/integration/delete-account.test.ts test/integration/integrasi.test.ts workers/jobs/src/cron.test.ts`: `Test Files 5 passed (5)`, `Tests 84 passed (84)`, exit 0. Local D1 and the mock provider. The QA test includes its strengthened assertion.
- `PATH=<flock shim>:$PATH E2E_PORT=5391 npx playwright test e2e/paket.spec.ts e2e/integrasi.spec.ts e2e/accounts.spec.ts e2e/site.spec.ts` (one run): `2 failed`, `6 skipped`, `65 passed (1.9m)`, exit 1. Local `wrangler dev` with the mock provider and the fixed local `CLAIM_HASH_KEY`; no real provider. Both failures (phone and desktop) were the new QA test. It compared `/pengaturan/integrasi/admin` with the shallower `/halaman-yang-tidak-ada`, and SvelteKit's relative asset URLs differ by depth (`./_app/…` against `../../_app/…`). This is a test bug, not a product finding (see F1).
- `npx eslint` and `npx prettier --check` on the two QA test files: clean, exit 0, after one `prettier --write`.
- Not run: `npm run gates` and the full suite (caller's resource limit). `npm run db:migrate:local` was not run separately. Instead, `test/integration/migration-0030.test.ts` applied 0030 on a local D1 migrated to 0029 (above).

## Checked criteria

| # | Result | Evidence |
|---|---|---|
| 1 | PASS | `billing-hardening.test.ts` › "a payment that grants nothing stores one paid_not_applied event and one pending plan_higher refund": the amount and currency equal the event's, and no `credit_ledger` or `plan_changes` row references it. |
| 2 | PASS | "a paid checkout past its expiry owes a checkout_expired refund". |
| 3 | PASS | "a replay, a new event id for the same reference and 20 concurrent deliveries leave exactly one refund" (1 `ignored_paid`, 19 `replay`, 1 row). |
| 4 | PASS | "an applied payment owes no refund". |
| 5 | PASS | "pending → refunded once; …" (`done`, `resolved_at` set, `already_resolved` leaves the row unchanged, `not_found`, RangeError on a bad provider id) and "20 concurrent calls give exactly one done". |
| 6 | PASS | "billing_refunds triggers (criterion 6)": DELETE, an `amount_minor` change, refunded → pending and nulling `user_id` of a live user are all refused with `append-only`. |
| 7 | PASS | `migration-0030.test.ts`: from 0029 with an existing `paid_not_applied` event, applying 0030 gives one `unknown`/`pending` row. Re-running the backfill statement adds nothing. The triggers and indexes exist. |
| 8 | PASS | `billing-hardening.test.ts` › "lists only the signed-in user's own refunds…" (A: `Rp 49.000`, pending, no provider reference; B: `[]`). `paket-page.test.ts` covers the absent group, the WIB date (00:30 WIB on 10 Okt), the status labels and the mock note. QA: `billing-hardening-qa.test.ts` › "only the paket and admin loads use refunds.ts…" shows that no route segment names a refund and that `refundsForUser(locals.db, user.id)` is the only call. |
| 9 | PASS | `billing.test.ts` cycle 2: the mock pay action answers 409 with the new Indonesian text, and `en[…]` gives the English entry. The pending refund exists. |
| 10 | PASS | "a refund survives account deletion with user_id null and stays in pendingRefunds". |
| 11 | PASS | "counts exactly beyond 101 pending rows and lists at most 100, newest first" (105 rows), with no person fields. |
| 12 | PASS | `refunds.test.ts` › "does not reference fetch, PaymentProvider or activeProvider". |
| 13 | PASS | `claims.test.ts` › `canonicalClaimEmail` vectors, plus distinct non-Gmail addresses. |
| 14 | PASS | `claims.test.ts` › deterministic, differs per key, null for unset, empty, 31-byte and 33-byte keys, and never contains the address. |
| 15 | PASS | "delete and sign up again with a Gmail alias…": Gratis, balance 0, one `starter_grant` marker, and no marker column holds `ab15`, `a.b15`, `gmail` or `@`. |
| 16 | PASS | "a per-person voucher redeemed before deletion answers already_redeemed…": 409 `VOUCHER_ALREADY_REDEEMED`, no ledger row, and another user still redeems it. |
| 17 | PASS | The same test runs 20 concurrent redeems and none succeeds. Those redeems stop at the pre-read, so QA added "20 concurrent redeems with a stale 'not marked' pre-read still redeem nothing". With every marker read forced to "not marked", none succeeds, none is named `already_redeemed`, and no redemption or ledger row is written. This proves the `NOT EXISTS` guard in the insert decides on its own. |
| 18 | PASS | "key rotation: markers under the previous key still refuse; without _PREVIOUS they are forgotten". |
| 19 | PASS | "CLAIM_HASH_KEY unset: deletion succeeds without a marker, sign-up grants 300, redeem works" (a malformed key counts as unset). `integrasi.test.ts` › "shows CLAIM_HASH_KEY as not configured…". `admin-page.test.ts` covers the render. |
| 20 | PASS | "a wrong proof deletes nothing and writes no marker". |
| 21 | PASS | "retention: only markers older than 730 days go, at most 500 per call" (507 → 500 + 7). The jobs Worker wiring is in `workers/jobs/src/index.ts`, and `cron.test.ts` passes. |
| 22 | PASS | "a live account holds no marker: sign-up and redeem write none". |
| 23 | PASS | `admin.test.ts` › four `isAdminAccount` tests (case and spaces, non-UUID, unset/empty/`,`, first 20 entries only). |
| 24 | PASS | `integrasi.test.ts` › "admits a listed account id". The engineer's tests did not check `cache-control`. QA added `billing-hardening-qa.test.ts` › "a listed account gets 200 data with cache-control: no-store", which passes. |
| 25 | PASS (partial, F1) | `integrasi.test.ts`: the same `{status: 404, message: 'Not Found'}` for signed-out visitors, non-admins, unset, `''` and `,`, and for a listed e-mail (the old `ADMIN_EMAILS` value) or `ADMIN_EMAILS` itself set. `e2e/integrasi.spec.ts:138` gives 404 for both signed-in and signed-out visitors. The QA e2e run showed 404 for both paths, with the same `node_ids: [0, 1]` and `error: {status:404,message:"Not Found"}` in the visible part of the diff. The full body check is not confirmed (F1). |
| 26 | PASS | `admin.test.ts` › "no file under src/ or workers/ reads ADMIN_EMAILS". A grep finds it only in tests and in a stale build artifact under the git-ignored `workers/jobs/.wrangler/tmp`. |
| 27 | PASS | `admin-page.test.ts` (count, rows, "Belum ada", the error line while the other status lines still render). `integrasi.test.ts` › "lists pending refunds without any person…" (no payer or owner id, e-mail or name, and `refunds: null` when the table is missing while the other lines remain). |
| 28 | PASS | `test/i18n-coverage.test.ts` passed in run 1. |
| 29 | NOT RUN | `npm run gates` was not run by QA, on the caller's instruction. |
| 30 | PASS | All 65 existing tests in the four specs passed. The only failures were the new QA test (F1). |

## Findings

- **F1 (QA test, not a product defect; Low).** The first version of the QA e2e test compared the admin 404 body with
  an unknown path at a different depth. SvelteKit's asset URLs are relative, so the bodies differed only in
  `./_app/…` against `../../_app/…`. The test now uses `/tidak-ada/sama/sekali`, a path of the same depth. Because
  the caller allowed one e2e run, the corrected test has not been run yet. Run it once with
  `npx playwright test e2e/integrasi.spec.ts -g "admin 404 body"` to close the full-body half of criterion 25.
- **F2 (process; Low).** The PRD says "Each regression test must fail on the unfixed code, and the run must show that
  failure". The ENGINEERING_CHECKLIST says the same under "Fail-before proof". No recorded fail-before run exists in
  the commit or in `docs/features/fn-30-pro-hardening/`. QA did not reproduce one. Most new tests import modules
  that do not exist at `38c5f82` (`claims.ts`, `claim-sweep.ts`, `pendingRefunds`), so they cannot pass on the old
  code, but no run shows it.
- **Note (no action).** `billing_refunds` was added to the account data export as `export: 'json'`.
  `claim_markers` is listed as a system table with no user link. This agrees with the PRD: the export stays
  unchanged for markers, and the refund rows are the user's own data.

## ENGINEERING_CHECKLIST review

- Concurrent writes: the refund insert, the marker `NOT EXISTS` checks and `recordRefundOutcome` are each one guarded
  statement inside a batch. 20-way concurrency tests cover each one (criteria 3, 5 and 17, the last with the QA guard
  test).
- Bounded work: `pendingRefunds` is limited to 100, `refundsForUser` to 20 and the sweep to 500. No `inArray` is
  used on a growing list.
- Migrations: the new file 0030 edits no applied migration, and its backfill is re-runnable with `NOT EXISTS`.
  The RUNBOOK is updated for `ADMIN_ACCOUNT_IDS` and `CLAIM_HASH_KEY`.
- Money: integer `amount_minor` with its currency, shown through `formatMoney`. No sum mixes currencies.
- Dates: refund dates use `formatDateTimeWib`. The test checks 17:30 UTC on 9 Oct → 10 Okt WIB.
- Privacy: neither the user surface nor the operator surface contains a provider reference to another person, a user
  id, an e-mail or a name. Markers hold only a 43-character HMAC.
- i18n: every new phrase has an English entry (criterion 28).
- Keyed lists: `{#each}` is keyed by the row id on both pages.
- Fail-before proof: missing (F2).
- Gates: not run by QA (criterion 29).
