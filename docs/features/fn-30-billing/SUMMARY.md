# FN-30 Plans, credits and billing (Paket) — summary

**Status: complete with a test-mode provider only** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0018_billing.sql` (plans, append-only credit ledger with triggers, vouchers and redemptions,
  billing events, plan changes; backfill gives existing users Gratis + 300 credits once); `/pengaturan/paket` with
  Gratis/Pro/Agen at placeholder prices (Pro Rp 49.000, Agen Rp 99.000 per 30 days, badged "harga sementara"), 1.000
  credits per paid period; server-side plan gating helper; vouchers (≥10-character Crockford codes, uniform refusal,
  per-user and per-IP throttle that fails closed, race-safe single use); provider interface with a mock "mode uji"
  provider shown only when `BILLING_MOCK_ENABLED` is exactly "1" and its secret is ≥32 characters; webhook with HMAC over
  the raw body, constant-time compare, timestamp tolerance, replay protection by event id and payment reference,
  no-downgrade ordering, checkout expiry, and `paid_not_applied` + `paymentsNeedingRefund` for payments that grant
  nothing.
- **Red team:** PASS (Lows fixed; L4 re-signup re-claiming starter credits accepted for internal use). **QA:** PASS 12/12
  with fail-first proof for each fix.
- **Not yet:** real provider (Xendit or Midtrans, owner), refund flow, spending credits, gate helpers wired into
  FN-03/FN-19/FN-23.
