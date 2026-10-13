# FN-30 Plans, credits, vouchers and billing — QA report

**Verdict: PASS**

Reviewed at `bdcb02f` (detached worktree, base `main` 9d3e892). Mock payment provider only ("mode uji"); no real
provider, no `--remote`, no login, no deploy. Diff reviewed: `git diff 9d3e892..bdcb02f` (45 files, +8437/-7) and,
for the cycle-1→cycle-2 fail-first proofs, `git diff 937fde8..bdcb02f`.

## Commands run

- `git switch --detach bdcb02f` — ok, HEAD at bdcb02f.
- `npm ci` — ok (8 pre-existing audit advisories, unrelated to this feature; no code change).
- `npx svelte-kit sync` — ok.
- `npm run db:reset:local` — ok, applied all migrations incl. `0018_billing.sql` and the local seed (`COBA-*`
  vouchers) against a fresh local D1, real wrangler/miniflare D1, no mock.
- `npm run check` — 0 errors, 0 warnings, 1321 files.
- `npm run lint` — prettier + eslint clean.
- `npx vitest run --maxWorkers=4` — 120 files, 1874 tests passed (before QA additions); mocked AI/provider per
  CLAUDE.md, real local D1 (miniflare), no real provider.
- `npm run build` — ok (client + service worker + Cloudflare adapter).
- `E2E_PORT=8865 LD_LIBRARY_PATH=<scratchpad> npx playwright test --workers=2`
  — 238 passed, 15 skipped (pre-existing unrelated skips), 0 failed, real Chromium/headless browser against a real
  local `wrangler dev` + local D1, `BILLING_MOCK_ENABLED=1` with a local-only HMAC secret, no real provider; no
  rerun needed (no failures).
- Fail-first proofs (temporary source reverts, each restored and re-verified clean): `npx vitest run
  test/integration/billing.test.ts -t "L1:|L5:"` on cycle-1 `webhook.ts` — 3 failed as expected; restored, 32/32
  pass. `npx vitest run test/integration/billing.test.ts -t "L2:"` on cycle-1 `vouchers.ts`/`throttle.ts`/
  `messages.ts`/no `voucher-code.ts` — suite fails to import (module not found) as expected; restored, 32/32 pass.
  `npx vitest run test/integration/billing.test.ts -t "L3:"` on cycle-1 trigger text (sed-isolated to the 4
  trigger definitions only) — 1 failed as expected (update that should raise `/append-only/` instead resolved);
  restored, 7 files/63 tests pass.
- New QA tests written this pass (`test/integration/billing-plan-expiry.test.ts`,
  `test/integration/billing-backfill.test.ts`) — `npx vitest run test/integration/billing-backfill.test.ts
  test/integration/billing-plan-expiry.test.ts` — 2 files, 2 tests passed; re-confirmed inside the full
  `npx vitest run --maxWorkers=4` — 122 files, 1876 tests passed (final run, after `npx prettier --write` on the
  two new files and a clean `npm run lint`).
- `npm run build` (final, after QA additions) — ok.
- Ad-hoc `wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc` on 8848,
  real local D1 (fresh persist dir, `migrate-local.ts` + `seed-local.ts` run against it), mock ON (local
  `.dev.vars` in this worktree only, 47-char secret, `BILLING_MOCK_ENABLED=1`) — real HTTP sign-up → checkout
  (`?/checkout`) → mock pay page → `?/pay` → webhook → plan Pro, balance 1.300; voucher `COBA-KREDIT-100` redeemed
  → balance 1.400. Mock OFF (`.dev.vars` with only `DEV_ROUTES=1`, fresh persist dir copied from the ON state) —
  `/pengaturan/paket` HTML has zero occurrences of "Mode uji", "Upgrade ke" or "Perpanjang"; a correctly-shaped
  signed webhook POST still answers fixed `401 {"status":401,"message":"Invalid signature"}`. Both servers
  stopped (`pkill`); `.dev.vars` removed; both ad-hoc persist dirs (`.wrangler/qa-state-8848`,
  `.wrangler/qa-state-8848off`) and the e2e persist dir (`.wrangler/e2e-state-8865`) removed after use.
- `git status --short` (final) — only the two new QA test files untracked; no production file touched.

## Checked criteria (PRD acceptance criteria 1–12)

1. **PASS** — sign-up batch writes `user_plan_state` (gratis) + one `starter_grant` (+300) row in the same
   `db.batch`: `test/integration/billing.test.ts` ("starter grant" describe, line ~135), reconfirmed passing.
2. **PASS** — `creditBalance` = SQL `SUM(delta)`; zero-delta/non-integer/out-of-range insert attempts rejected by
   the CHECK (`test/integration/billing.test.ts` ledger CHECK test, lines ~170-180), all passing.
3. **PASS** — 20-concurrent single-redemption probe: exactly 1 succeeds, 19 refused (`billing.test.ts`, "20
   concurrent" test), passing; engineer's own ad-hoc HTTP probe recorded the same shape in `ENGINEER_REPORT.md`.
4. **PASS** — same user redeeming twice sequentially refused by the `(voucher_id, user_id)` unique index
   (`L3: a live account's history...` setup path and the dedicated unique-index test), passing.
5. **PASS** — webhook applies a new `provider_event_id` once (plan + credit grant in the same `db.batch`); a
   replay bumps `replay_count`, writes nothing new, answers 200 — `billing.test.ts` "applies a signed payment
   once..." test, passing; also proved live over real HTTP in the ad-hoc server (same signed body, applied then
   replay).
6. **PASS** — missing/malformed/wrong-key signature → fixed 401, no row written, constant-time compare
   (`equalConstantTime`) — `billing.test.ts` "refuses bad signatures" test, passing; reconfirmed live (unsigned
   POST → `401 Invalid signature`, zero new `billing_events` rows).
7. **PASS** — flag off: no `?/checkout` form, no "Mode uji" in rendered HTML, webhook still exists and answers
   401 (never 500) — `billing.test.ts` "flag off: no upgrade..." test and `test/paket-page.test.ts`, both passing;
   reconfirmed live (HTML has zero matches for "Mode uji"/"Upgrade ke"/"Perpanjang"; webhook POST → 401).
8. **PASS** — all 3 plan cards show "harga sementara" (`test/paket-page.test.ts`, exactly 3 matches, both
   languages via the i18n coverage test); a repo-wide static check (`test/paket-page.test.ts`, "credits are never
   formatted as money") asserts every `formatMoney`/`formatMoneyCompact` call in the billing UI/server/shared
   files only ever receives `priceMinor`/`amountMinor`, never a credit value — passing. Live HTML showed
   `Rp 49.000` / `Rp 99.000` for Pro/Agen and the credit balance rendered as a plain `1.300`/`1.400`.
9. **PASS** — table-driven test over all 3 plans (`src/lib/shared/billing/plans.test.ts`, "gate helpers,
   table-driven over every plan"): `canUseSharedSpaces` false only for gratis, `gmailLookbackMaxDays`
   7/365/365, `agentEnabled` true only for agen — matches the catalogue exactly, passing.
10. **PASS** — every billing load/action reads only `locals.user.id`; no route takes a user id parameter (grep
    confirms); cross-account probes in `billing.test.ts` ("loads only the signed-in user's own...",
    "Cross-account" probes in `ENGINEER_REPORT.md`) show another user's checkout/reference get the same 404 as
    an unknown one — passing, no existence oracle.
11. **PASS** — e2e `e2e/paket.spec.ts` (full Playwright run, both tests passed): voucher refusal shows inline
    without reload and keeps the typed code; a failed mock payment shows "Pembayaran uji gagal (simulasi)" and
    recovers (the next action, paying, still works); success ("Pembayaran uji berhasil...") only renders after
    the webhook answered and the plan was read back from the server.
12. **PASS** — i18n coverage test (`test/i18n-coverage.test.ts`, repo-wide, passing) covers every new FN-30
    string. `describe('account deletion (AC12)')` in `billing.test.ts` confirms `user_plan_state` removed and
    `credit_ledger`/`billing_events`/`voucher_redemptions`/`plan_changes` rows kept with `user_id` null,
    unreachable by any route after deletion — passing.

## Additional end-to-end and boundary verification (beyond the PRD's explicit AC list, per QA brief)

- **Checkout → mock pay → webhook → plan + credits, live over real HTTP** (not just Vitest route simulation):
  verified above against an ad-hoc `wrangler dev` server with a real local D1; Pro checkout paid → plan "Pro",
  balance 1.300 (300 starter + 1.000 plan grant); voucher `COBA-KREDIT-100` redeemed afterwards → 1.400. Matches
  `e2e/paket.spec.ts`'s own browser-level proof of the same journey (desktop + phone projects).
- **Plan expiry after 30 days via controlled time**: new test
  `test/integration/billing-plan-expiry.test.ts` drives a real webhook `payment_succeeded` through
  `processWebhook` at a fixed instant, then reads `planOf`/`planStateOf` at `boundary - 1` (still Pro),
  `boundary` and `boundary + 1 day` (both lapsed to Gratis, per `effectivePlan`'s `currentPeriodEnd > now` rule) —
  passing. Confirms credits granted while paying are **not** clawed back once the plan lapses (`storedPlan`
  stays "pro" for the UI's "ended" note; `creditBalance` unchanged).
- **Gating helper refusals**: AC9's table-driven test (above) plus the direct-POST gating-bypass probes in
  `billing.test.ts` (`?/checkout` with the flag off → 404; `plan=gratis` → 400; a plan below the one in force →
  409) — all passing.
- **Backfill migration gives existing users Gratis + 300 credits exactly once**: new test
  `test/integration/billing-backfill.test.ts` reads the real `INSERT INTO user_plan_state` / `INSERT INTO
  credit_ledger` statements out of `migrations/0018_billing.sql` itself (not a re-implementation), inserts a
  `users` row directly (simulating a pre-FN-30 account with no plan/ledger rows), runs the backfill once (gets
  exactly one Gratis row and one 300-credit `starter_grant` row) and runs it again (no second row either table) —
  passing.
- **`paymentsNeedingRefund`**: `billing.test.ts` "L1: a paid event that grants nothing..." exercises
  `paymentsNeedingRefund(db)` directly: count increments by exactly 1 per genuinely unapplied payment, a replay
  of that same payment does not double-count, and the returned row shape is the documented content-free set
  (`provider`, `reference`, `amountMinor`, `currency`, `id`, `createdAt`) — passing.
- **Seeded `COBA-*` vouchers, local-only**: `scripts/demo-vouchers.test.ts` proves only the SHA-256 is ever
  written to SQL (never the plaintext code) and that `scripts/seed-local.ts` refuses `--remote`/`--preview`/
  `--env`/`-e` before running anything — passing; confirmed live (`npm run db:reset:local` seeded them; the live
  server at 8848 could redeem `COBA-KREDIT-100` for +100 credits).
- **Mock UI absent and webhook 401 when the flag is off**: confirmed both in Vitest (`billing.test.ts`,
  `test/paket-page.test.ts`) and live over real HTTP (ad-hoc server with mock off, above).
- **Amounts formatted `Rp 49.000`**: confirmed live (HTML `Rp 49.000`/`Rp 99.000` for the Pro/Agen cards) and by
  the static formatMoney-usage test (AC8, above).
- **i18n EN, no-JS, 360 px**: i18n — repo-wide coverage test, passing. No-JS — `e2e/paket.spec.ts`'s
  "without JavaScript a voucher refusal still shows" test, passing. 360 px — `expectNoHorizontalScroll` on both
  `/pengaturan/paket` and `/pengaturan/paket/uji/[ref]` in the phone Playwright project, passing.

## Fail-first evidence for the cycle-2 fixes (reverted, confirmed failing, restored)

All four reverts were done with `git checkout 937fde8 -- <file>` (or a scoped `sed` edit isolating just the
trigger clauses for L3, to avoid an unrelated schema mismatch), the named test(s) run, then `git checkout bdcb02f
-- <file>` to restore exactly; `git status --short` was empty before and after each revert/restore pair; the
whole billing suite was re-run green after every restore.

- **L1 (`paid_not_applied` / `paymentsNeedingRefund`) and L5 (checkout-expiry / replay-row-reuse)** — both fixes
  live in the same `webhook.ts` block. Reverting `src/lib/server/billing/webhook.ts` to its cycle-1 version
  (`937fde8`) and running `-t "L1:|L5:"`: **3 failed** — the lower-tier-while-higher-plan payment silently
  answered `applied` instead of `ignored_paid` (L1 PRD-level test), the past-expiry payment also silently applied
  instead of `ignored_paid` (L5 PRD-level test), and the mock pay action reported success instead of the 409
  "needs refund" message (L1 UI-level test). Restored: `32/32` pass.
- **L2 (uniform voucher answer + IP throttle + fail-closed)** — fix spans `vouchers.ts`, `throttle.ts`,
  `messages.ts` and the new `voucher-code.ts` module. Reverting the first three to `937fde8` and deleting
  `voucher-code.ts`/`voucher-code.test.ts` (the cycle-1 code has its own inline `normalizeVoucherCode` and never
  imported this module) and running `-t "L2:"`: the whole suite **fails to load** —
  `Error: Cannot find module '#lib/shared/billing/voucher-code' imported from
  src/routes/(app)/pengaturan/paket/+page.server.ts` — proving the route itself now depends on the fixed module
  (the uniform answer, the generated-code helper and the `≥10`-symbol floor all live there). Restored: `32/32`
  pass.
- **L3 (tightened append-only trigger)** — reverting the whole migration broke columns the L1/L5 fix also needs,
  so the revert was scoped with `sed` to remove only the ` AND NOT EXISTS (SELECT 1 FROM users WHERE id =
  OLD.user_id)` clause from the four trigger definitions (restoring the pre-fix trigger text exactly, keeping
  every other column/index as-is). Running `-t "L3:"`: **1 failed** —
  `AssertionError: promise resolved ... instead of rejecting` on
  `update credit_ledger set user_id = null where user_id = <live account>`: the old trigger let a live account's
  row be detached by a bare UPDATE, exactly the finding. Restored (`git checkout bdcb02f --
  migrations/0018_billing.sql`): 7 files / 63 tests pass.

## Engineering checklist (`docs/ENGINEERING_CHECKLIST.md`) — no violations found

Concurrent writes: guarded batch statements + unique indexes, concurrency-tested (20x probes). Bounded work: 64
KiB webhook cap, 20-row ledger page, per-user/per-client throttles. Migrations: new file, re-runnable, not an edit
of an already-applied migration (0018 is unreleased; cycle-2's in-place edit is explicitly flagged as such in
`ENGINEER_REPORT.md` and is acceptable pre-merge). Integers only: `delta`/`amount_minor` CHECKs, confirmed by
test. One access rule: every billing route reads only `locals.user.id`; grep confirms no route parameter ever
carries a user id; uniform 404s. Untrusted text: webhook payload `z.strictObject`, ids bounded ≤100 chars/regex;
voucher codes normalised and length-bounded. Svelte keyed lists: `{#each PLANS as plan (plan)}`,
`{#each ... as feature, i (i)}`, `{#each data.ledger as row (row.id)}` — all keyed correctly, never by free text.
Redirects: every `redirect()` in the billing routes targets a fixed internal path or a server-constructed
same-origin `checkoutUrl` (`/pengaturan/paket/uji/<ref>`), never a client-supplied value. CSP/no inline styles:
confirmed in `SECURITY_REPORT.md` and the e2e CSP-violation collector (`collectCspViolations`, zero violations in
`paket.spec.ts`). i18n: repo-wide coverage test passes. Currency display: only `formatMoney` with
`priceMinor`/`amountMinor`, confirmed by a dedicated static test; credits never pass through it. Truthful state:
success shown only after the webhook/server confirms (checked in `paket.spec.ts` and via the live ad-hoc probe).
Fail-before proof: all four cycle-2 fixes reproduced failing on their own, shown above.

## Findings

None. No criterion failed; no engineering-checklist item was violated; `npm run gates` ran clean twice (before and
after the two new QA test files were added); the full Playwright suite passed with zero failures; every
cycle-2 red-team fix was independently reproduced as a failing test on the unfixed code, then restored to the
fixed state with the suite green again. L4 (accepted, no code — re-sign-up re-enabling vouchers/starter grant)
remains correctly documented as an accepted risk for internal use in `SECURITY_REPORT.md` and is out of scope
for a code fix this pass; it is not a QA failure.

## New test files added by QA (tests only, no production code touched)

- `test/integration/billing-plan-expiry.test.ts` — end-to-end webhook→plan-grant→30-day-boundary proof with
  controlled time (not wall-clock).
- `test/integration/billing-backfill.test.ts` — exercises the migration's own backfill SQL against a directly
  inserted legacy user row, proving exactly-once Gratis + 300 credits, including on a second run.
