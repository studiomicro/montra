# FN-30 Plans, credits, vouchers and billing — engineer report (cycles 1–2)

Branch `fn-30-billing` from `main` c401a94. Mock payment provider only ("mode uji"); no real provider, charge,
sandbox or provider account. Nothing deployed, no remote D1 touched.

## What works

- **Plans** (`src/lib/shared/billing/plans.ts`): Gratis / Pro / Agen catalogue; every price is a placeholder and
  is rendered with the "harga sementara" / "price placeholder" badge (catalogue cards and the test checkout).
  `effectivePlan`: a paid plan whose period ended is Gratis again (features stop, data stays).
- **Sign-up**: the `signUp` batch also writes `user_plan_state` (`gratis`) and one `credit_ledger` row
  (`starter_grant`, +300) — same transaction as the account row.
- **Credit ledger**: append-only (DB triggers refuse every DELETE and every UPDATE except the account
  deletion's `user_id → null`); `delta` CHECK: integer, non-zero, |delta| ≤ 1e9. Balance =
  `SUM(delta)` in SQL (`creditBalance`), never stored; throws rather than show a non-safe-integer sum. Every
  grant is guarded so the balance after it stays within ±2^53−1. Credits are never formatted as money.
- **Vouchers**: only SHA-256 of the code is stored. `redeemVoucher` = one `db.batch`: redemption row selected from
  the live/unexpired/under-cap voucher → `redemption_count + 1` → effect (credits or plan days + audit), each
  guarded on the redemption row existing; `(voucher_id, user_id)` unique index refuses a second redemption by
  the same account; CHECK keeps `redemption_count ≤ max_redemptions`. Refusals are distinct: not found,
  expired, used up, already redeemed, plan higher. Per-user throttle (20 / 10 min, the existing
  `auth_attempts` budget, new scopes `voucher`, `billing-checkout`).
- **Provider boundary** (`billing/provider.ts`): `PaymentProvider { createCheckout, verifyWebhook }`;
  `activeProvider(env)` is the only place that picks one (mock iff `BILLING_MOCK_ENABLED === '1'` and
  `MOCK_PAYMENT_WEBHOOK_SECRET` ≥ 32 chars). Xendit/Midtrans = a second implementation + its secret there.
- **Webhook** `POST /api/v1/billing/webhook`: JSON only (415), 64 KiB cap via the shared bounded reader
  (`readRawBody` in `forms.ts`, 413/408), HMAC-SHA256 over `"<t>." + raw body` with `equalConstantTime`, ±5 min
  timestamp tolerance (timestamp inside the MAC), fixed `401 Invalid signature` for every signature problem or
  when no provider is active, fixed `400 Invalid event` for signed-but-unacceptable events (unknown type, extra
  keys, unknown checkout, amount/currency not the checkout's). Insert `ON CONFLICT DO NOTHING` on
  `(provider, provider_event_id)` and on a partial unique `(provider, reference) WHERE kind='payment_succeeded'`;
  effect (credits + plan period + `plan_changes` audit) in the same batch guarded on that row; a replay writes
  `replay_ignored` and answers 200. Raw body never stored.
- **Plan gating** (`billing/gate.ts`): `planOf`, `planStateOf`, `creditBalance`, `canUseSharedSpaces`,
  `gmailLookbackMaxDays`, `agentEnabled`. Plan changes never downgrade (a lower plan while a higher one runs is
  refused at checkout and by the SQL guard) and every change is audited in `plan_changes`.
- **UI** `/pengaturan/paket` ("Paket & kredit", linked from Pengaturan): balance, plan + period end/lapsed note,
  voucher form, plan cards, paged ledger with running balance; loading (skeleton on retry), empty, error,
  saving and success states. Upgrade form and banner only when the mock is active (absent from the HTML
  otherwise). `/pengaturan/paket/uji/[ref]`: persistent "Mode uji — tidak ada tagihan sebenarnya" banner, "Bayar
  (mode uji)" and "Simulasikan gagal"; both sign an event and POST it to the app's own webhook via
  `event.fetch`; success is shown only after the webhook answered `applied` and the plan is read back.
- **Account deletion**: `user_plan_state` deleted in the guarded batch; `credit_ledger`, `billing_events`,
  `voucher_redemptions`, `plan_changes` keep their rows with `user_id` null (FK `on delete set null`); a used
  voucher stays used.

## Migration

`migrations/0018_billing.sql` (+ `meta/0018_snapshot.json`, journal tag `0018_billing`, chained to 0014's
snapshot; renumber/re-chain at merge if FN-27/28/29 land first). Tables `user_plan_state`, `credit_ledger`,
`vouchers`, `voucher_redemptions`, `billing_events`, `plan_changes`; hand-written append-only triggers; backfill
of existing users (Gratis + 300 starter credits, re-runnable). All account-scoped: none added to
`SPACE_SCOPED_TABLES` (no `space_id`; PRD architecture notes).

## Decisions taken (recorded, not asked)

1. Placeholder prices Pro Rp 49.000 / Agen Rp 99.000 per month, Gratis Rp 0 — all badged; plan period = 30 days
   (weekly = 7). Pro/Agen: 1,000 credits per paid period, Gmail look-back 365 days, max 10 spaces (Gratis 1).
2. Added `plan_changes` (audit) and `billing_events.reference` / `.plan` columns: the brief requires plan changes
   audited, and the webhook resolves the account from the stored checkout, never from the event body.
3. A successful payment grants the plan's credits (`monthly_grant`) once per checkout — no cron (PRD scope 3).
4. Failed payments never change the plan; a late lower-tier success while a higher plan runs is recorded but
   applies nothing (no downgrade; no refund flow — out of scope).
5. Webhook with no active provider answers 401 (exists, never 500). Unknown reference → 400 (provider retries).
6. Existing accounts get the starter grant via the migration backfill, matching a new sign-up.
7. Local review vouchers seeded by `db:seed:local` only: `COBA-KREDIT-100`, `COBA-PRO-7-HARI` (hashes stored;
   renamed from `UJI-*` in cycle 2 because U is not in Crockford base32).
8. e2e server runs with `BILLING_MOCK_ENABLED=1` and a fixed local-only HMAC key (playwright.config.ts).
9. `PaymentProvider` has one implementation by explicit PRD/brief requirement (not a speculative abstraction).

## Checks run

- `npm run check` 0 errors 0 warnings; `npm run lint` clean; `vitest run --maxWorkers=4`: 114 files, 1770 tests
  passed; `npm run build` ok. (The gates' four steps, run individually so vitest could take `--maxWorkers=4`.)
- e2e full (`E2E_PORT=8860 --workers=2`): 226 passed, 2 failed, 15 skipped — both failures were the new
  `paket.spec.ts` (strict-mode locator: "Kredit awal" also matched "300 kredit awal"); fixed with `exact: true`;
  `paket.spec.ts` rerun alone: 5 passed.
- New tests: `src/lib/shared/billing/plans.test.ts`, `src/lib/server/billing/{mock-provider,vouchers}.test.ts`,
  `scripts/demo-vouchers.test.ts`, `test/integration/billing.test.ts` (24), `test/paket-page.test.ts` (render),
  `e2e/paket.spec.ts`.

## Pre-handoff probes

Integration (local D1) and HTTP (ad-hoc `wrangler dev` on 8841, local state, stopped and removed afterwards):

- Webhook replay: PASS — same signed body twice → 200 `applied`, 200 `replay`; balance 1.300 both times; one
  `payment_succeeded`, one `replay_ignored`. Same payment under a new event id → `replay`, no second grant.
- Bad signature: PASS — wrong key / missing / malformed / tampered body / re-dated → 401 `Invalid signature`, no row.
- Stale timestamp: PASS — 6 min old → 401; ±5 min edge accepted (unit).
- Reordered events: PASS — failure after success → `recorded`, plan stays Pro; Agen paid then late Pro success →
  plan stays Agen, no Pro audit row, no extra credits; failure before success does not block it.
- 20-concurrent webhook deliveries of one event: PASS — exactly one `applied`, balance 1.300.
- 20-concurrent voucher redemption (max 1): PASS — HTTP `{"success":1,"failure":19}`, `redemption_count` 1, one
  redemption row; integration: 1 ok / 19 `used_up`; same user ×20 on a multi-use code: 1 ok / 19 `already_redeemed`.
- Gating bypass via direct POST: PASS — `?/checkout` with flag off → 404; `plan=gratis` → 400; plan below the one in
  force → 409; test page/pay with flag off → 404; webhook with flag off → 401.
- Mock hidden when flag off: PASS — no `?/checkout` form and no "Mode uji" in the rendered HTML (HTTP and Vitest render).
- Cross-account: PASS — another user's checkout page and an unknown reference → same 404; paying another
  user's checkout → 404; loads only read `locals.user.id` (no route takes a user id).
- Oversized body: 413; `text/plain` body: 403 from SvelteKit's CSRF check before the handler (415 in-handler, Vitest).
- No-JS forms: PASS — voucher refusal shows without JavaScript (e2e).
- 360 px: PASS — no horizontal scroll on both pages (e2e phone project).
- User copy: no paths or internal ids; checkout reference only in the URL.
- Not applicable: money-parsing vectors (no money input), WIB month boundaries (no date bucketing; timestamps shown
  WIB), two devices/sync (account data, not synced), stale-form `updated_at` (no editable rows).

## Engineering checklist items applied

Concurrent writes (guarded batch statements + unique indexes, concurrency tests); bounded work (64 KiB body,
paged ledger 20, per-user throttles, checkout TTL 1 h); migrations (new file, re-runnable backfill); integers
only / no money from credits; one access rule (account-scoped by `locals.user.id`, 404 without oracle);
no secrets in loaders; form bodies via `readFormBody`, raw body via the shared bounded reader; i18n (EN entries,
coverage test); currency via `formatMoney` for prices only; truthful state (success after server confirmation);
no inline styles / CSP; Svelte keyed lists by id/index; no real providers in tests.

## Gaps / follow-ups

- Real provider (Xendit/Midtrans) and sandbox: owner items; nothing real exists or is callable.
- Gate helpers are not yet wired into FN-03 space creation, FN-19 look-back or FN-23 Agent (PRD tracker items).
- No credit spend path yet (`ai_capture_spend`, `gmail_lookback_purchase` reasons exist for FN-19/FN-20).
- A late lower-tier payment while a higher plan runs grants nothing (refund handling out of scope).
- Migration number 0018 must be re-chained at merge after FN-27/28/29.

## Cycle 2 — red team lows (SECURITY_REPORT.md), rebased onto main 9d3e892 (FN-27)

Migration 0018 edited in place (unreleased), re-generated against the 0015 snapshot and renamed to 0018.
Failing tests were written first: the new `billing.test.ts` cases failed (module `billing/refunds` missing, old
codes/answers), and `voucher-code.test.ts` failed before `voucher-code.ts` matched it.

- **L1** — a verified payment that grants nothing (lower tier while a higher plan runs, or checkout past expiry)
  is inserted as `billing_events.kind = 'paid_not_applied'` (kind decided in SQL inside the insert, so stored
  kind and effect cannot disagree), answers 200 `ignored_paid`, and is the content-free audit row (ids,
  reference, amount, currency, time; no body, no user content). `billing/refunds.ts paymentsNeedingRefund(db)`
  gives the owner's "perlu refund" count and the latest 100 rows. The mock pay action answers 409 "…tidak
  diterapkan… Perlu refund." instead of success. `replay_ignored` kind removed.
- **L2** — `src/lib/shared/billing/voucher-code.ts`: Crockford base32; generated codes 16 symbols (80 bits),
  `XXXX-XXXX-XXXX-XXXX`; typed codes normalised (case, spaces, dashes, O→0, I/L→1), ≥ 10 symbols;
  `createVoucher` refuses shorter codes and generates when none is given. Not found / revoked / expired / used
  up / malformed → one answer "Kode tidak valid atau sudah tidak berlaku." (404, 400 for malformed). Second
  budget per client address (CF-Connecting-IP, IPv6 /64, stored only as SHA-256) next to the per-user one, 20
  per 10 min each; `voucherAttemptLimited` fails CLOSED on a D1 error. Seed refuses `--remote/--preview/--env/-e`
  before running anything (test spawns it).
- **L3 (choice: tighten the trigger, keep retention)** — `user_id` may become NULL only when no `users` row with
  the old id exists, i.e. only through the FK `on delete set null` after the account row is deleted; history is
  kept (PRD AC12). Test: nulling `user_id` on a live account's rows is refused on all four tables; account
  deletion still nulls them.
- **L4 (accepted, no code)** — re-sign-up with the same e-mail gets a new starter grant and can re-redeem a
  multi-use voucher. Accepted for internal use (no real money). **Pre-launch item:** key per-person limits on a
  retained salted e-mail HMAC before credits gain value.
- **L5** — payments for a checkout past its 1-hour expiry are `paid_not_applied`. Replays insert no rows: the
  original row (or the checkout's payment row for a re-sent payment under a new event id) gets
  `replay_count + 1` and `last_seen_at`, the only update its trigger allows besides L3's.

**TASKS-ready note:** "- [ ] **Claude** FN-30: refund flow for `paid_not_applied` payments
(`paymentsNeedingRefund`) — required before any real payment provider is enabled."

Cycle 2 checks: `npm run check` 0/0; `npm run lint` clean; `npm run test -- --maxWorkers=4`: 120 files,
1868 passed, 6 failed in goals/ruang-routes/kekayaan-routes (untouched, load timeouts) — those three files rerun
alone: 61/61 passed; `npm run build` ok. e2e `paket.spec.ts` (`E2E_PORT=8860 --workers=2`): 5 passed.
