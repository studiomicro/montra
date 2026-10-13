# FN-30 Plans, credits, vouchers and billing

Slug: `fn-30-billing`. Phase 5 (Connect, plans, trust). Catalog entry: `docs/FEATURES.md` › FN-30 (lines
296-303). Tracker: `docs/TASKS.md` › "Payment provider: Xendit (proposed) or Midtrans. Plan prices and credit
name (FN-30, not before Phase 5)" (**You**, unchecked) and "Payment provider sandbox (Phase 5)" (**You**,
unchecked). Risk tier: **Large** (money calculation — an append-only credits ledger in exact integers — plus a
payment-provider abstraction, a webhook endpoint with signature verification and replay protection, and plan
gating: three of the five explicit Large triggers at once, matching `docs/features/fn-25-net-worth/PRD.md`'s
own "new money-bearing tables" reasoning and exceeding it with "payments").

Owner rule applied: no payment provider is chosen yet (Xendit vs Midtrans) and no sandbox account exists
(`docs/TASKS.md` lines 27-28, 45). Per the brief, this pass ships plans/credits/vouchers/gating and the
**provider abstraction with a MOCK implementation only**, clearly labelled "mode uji" (test mode) everywhere it
appears; no real charge is ever possible this pass because no real provider is ever called.

## Goal

FN-22's assistant is free and unlimited by design, but every other AI path (receipt, statement, spreadsheet,
Gmail look-back beyond 7 days, Agent reports) costs real AI Gateway spend per call — the PRD's own risk table
names this directly ("AI cost per user above plan price… Credits, caching… upload limits on Free",
`docs/PRD.md` § 9). Before any of those AI paths can be trusted to run at scale, MONTRA needs the accounting
underneath them: a plan each account is on, an exact and auditable credit balance, a way to grant credits
(starter, monthly, voucher) and spend them, and — even though no provider is chosen yet — a payment path that
is already built, already tested against signature and replay attacks, and ready to point at a real provider
the moment the owner picks one, so that choice is a configuration change, not a new subsystem.

## Scope

1. **Plan catalogue** (`src/lib/shared/billing/plans.ts`, a plain data module like
   `subscriptions-catalogue.ts` — no DB table, since plan *definitions* change by code review, not by an admin
   screen): three plans, **Gratis**, **Pro**, **Agen** (generic Indonesian/English tier words, not
   invented brand terms — safe to use verbatim). Each entry: `id`, `priceMinor` (placeholder
   figure), `currency: 'IDR'`, `billingPeriod` (`weekly` | `monthly`), `monthlyCreditGrant`, `gmailLookbackMaxDays`,
   `maxSpaces`, `agentEnabled: boolean`. **Every `priceMinor` is rendered behind a "harga sementara" / "price
   placeholder" badge everywhere it is shown** (catalogue card, plan-comparison table) — never presented as a
   final, chargeable price, per the brief's explicit instruction and CLAUDE.md "money is never invented" applied
   to a number nobody has approved yet.
2. **Migration `0018_billing.sql`** (renumber at merge — FN-29 proposes 0017 in the same window; coordinate at
   merge like every prior PRD here): four new tables, all **account-scoped** (`user_id`, no `space_id` — billing
   is who pays, like `account_keys`/`sessions`/`feature_flags`, never a shared-space resource; FN-03's "several
   spaces and shared spaces are a Pro feature" reads the *plan*, which lives on the paying user, not on a space):
   - `user_plan_state`: one row per user (like `account_keys`): `user_id` (PK), `plan` (enum `gratis`, `pro`,
     `agen`, default `gratis`), `billing_period` (nullable, set once a non-free plan starts), `current_period_end`
     (nullable epoch ms), `created_at`, `updated_at`. No `deleted_at`/`seq` — not synced space data, deleted with
     the account like `feature_flags`.
   - `credit_ledger`: append-only, **never updated or deleted**, modelled exactly on `goal_contributions`'
     append-only shape (`src/lib/server/db/schema.ts:422-454`) but without a tombstone concept (a ledger entry is
     permanent — "exact integers" per the brief means a grant or a spend is a fact, not a reversible row; a
     mistaken grant is corrected by a second, negative entry, never by editing or deleting the first, so the
     ledger is always a true history). Columns: `id`, `user_id`, `delta` (integer, positive = grant, negative =
     spend; **never zero** — a CHECK), `reason` (enum `starter_grant`, `monthly_grant`, `voucher_redeemed`,
     `gmail_lookback_purchase`, `admin_adjustment`, `ai_capture_spend`), `reference_id` (nullable text — a
     voucher id, a billing-event id, or null for a starter grant), `created_at`. Balance is **never stored
     redundantly**: `creditBalance(db, userId) = SUM(delta)`, computed in SQL, the same "a dashboard figure is
     the SUM of its own rows, not a cached duplicate" rule FN-10's goal progress already established
     (`src/lib/server/goals/progress.ts`).
   - `vouchers`: `id`, `code_hash` (SHA-256 of the code, **never the plaintext code**, same pattern as
     `space_invites.token_hash` — a leaked table row must not be a usable code), `kind` (enum `credits`,
     `plan_days`), `credits_amount` (nullable, required when `kind = 'credits'`), `plan` (nullable enum, required
     when `kind = 'plan_days'`), `plan_days` (nullable, required when `kind = 'plan_days'`), `max_redemptions`,
     `redemption_count` (maintained only by the guarded redeem statement below, never read-then-written outside
     it), `expires_at` (nullable), `created_at`, `updated_at`, `deleted_at` (a revoked/disabled voucher).
   - `voucher_redemptions`: `id`, `voucher_id`, `user_id`, `redeemed_at`; **unique index on `(voucher_id,
     user_id)`** — a user can redeem a given code at most once, enforced by the index itself, not by an
     application-level check that a race could slip past.
   - `billing_events`: append-only, one row per provider interaction: `id`, `user_id` (nullable — a webhook may
     arrive before the user is resolved from the provider's reference), `provider` (enum `mock`, `xendit`,
     `midtrans` — only `mock` is ever exercised this pass), `provider_event_id` (the provider's own idempotency
     key), `kind` (enum `checkout_created`, `payment_succeeded`, `payment_failed`, `replay_ignored`),
     `amount_minor` (nullable), `currency` (nullable), `signature_valid` (boolean), `created_at`. **Unique index
     on `(provider, provider_event_id)`** — this is the replay-protection mechanism itself, not a convenience
     index: a second delivery of the same event cannot insert a second row, so the webhook handler's "already
     processed" check is a single guarded `INSERT … ON CONFLICT DO NOTHING`, never a separate read-then-write.
     The row never stores the raw webhook body (only the fields named above) — minimising what a stored payload
     could leak, the same instinct behind "mail text deleted after reading" (CLAUDE.md).
3. **Sign-up starter grant.** `src/lib/server/auth/accounts.ts`'s `signUp` batch gains one more item: a
   `credit_ledger` insert (`reason: 'starter_grant'`, `delta: 300` per FEATURES.md's own figure) and a
   `user_plan_state` insert (`plan: 'gratis'`) — the same "add one more guarded item to the existing batch"
   pattern FN-21's `insertAccountKey` already uses in the same function (`src/lib/server/account-keys/
   repo.ts:89`, wired into `accounts.ts`). A monthly grant for Pro/Agen is **not** wired to any cron this pass
   (there is no real recurring payment to key it off); the ledger/gate code is ready for a future PRD to call
   once a real subscription-billing cycle exists.
4. **Payment provider abstraction.** `src/lib/server/billing/provider.ts`: an interface `PaymentProvider {
   createCheckout(input): Promise<{checkoutUrl: string; providerReference: string}>; verifyWebhook(request,
   secret): Promise<VerifiedEvent | null> }`. `src/lib/server/billing/mock-provider.ts`: the only implementation
   this pass. Its "checkout" is a same-origin page, clearly labelled **"Mode uji — tidak ada tagihan
   sebenarnya" / "Test mode — no real charge"** in a persistent banner, that completes instantly on a button
   press (no card entry, no redirect to a real payment page) and calls the webhook endpoint itself with an
   HMAC-SHA256 signature over the event body, keyed by a new local secret `MOCK_PAYMENT_WEBHOOK_SECRET` — so the
   signature-verification code path is exercised by a real HMAC computation, not a stub that always returns
   true. A later PRD swapping in the real Xendit or Midtrans SDK implements the same `PaymentProvider` interface
   and wires their own webhook secret; no code outside `mock-provider.ts` needs to know which provider is active.
5. **Mock checkout reachability — dev/staging only.** The entire interactive "Upgrade" → mock-checkout → mock
   webhook flow is gated behind a new var `BILLING_MOCK_ENABLED` (same shape as `DEV_ROUTES`,
   `.dev.vars.example:2-3`): unset or false in production, so a real user is never shown a button that silently
   changes their plan without ever paying anything. When disabled, the "Upgrade" button is hidden entirely
   (not merely disabled — there is no legitimate reason to show an upgrade path that cannot work, unlike the
   `Belum dikonfigurasi` pattern used for *missing-but-eventually-real* capabilities elsewhere). The read-only
   parts (current plan, credit balance, ledger history, voucher redemption) are **not** gated — they are real,
   working functionality regardless of whether a real provider exists, since vouchers and the starter grant
   need no provider at all.
6. **Webhook endpoint** `src/routes/api/v1/billing/webhook/+server.ts` (POST): reads the body capped at 64 KiB
   with a bounded-read helper matching `readCapped`'s shape (`src/lib/server/forms.ts:18-49`, adapted for a raw
   JSON body rather than a form), verifies the mock provider's signature header in constant time
   (`equalConstantTime`, `src/lib/server/auth/password.ts:53-58`), and on a bad or missing signature answers a
   fixed `error(401, 'Invalid signature')` — never a detailed reason, matching the "no existence oracle" spirit
   applied to webhooks. On a valid signature, inserts the `billing_events` row (`ON CONFLICT (provider,
   provider_event_id) DO NOTHING`) and, only when that insert actually added a row (never on a replay), applies
   its effect (a `credit_ledger` grant or a `user_plan_state` update) in the **same `db.batch`** — so a replayed
   or concurrently-retried delivery can never grant credits twice. A replay that finds the row already present
   writes a `replay_ignored` billing event instead and still answers 200 (the provider should not retry
   forever over something already handled).
7. **Plan gating helpers**, `src/lib/server/billing/gate.ts`: `planOf(db, userId)`, `creditBalance(db, userId)`,
   `canUseSharedSpaces(plan)`, `gmailLookbackMaxDays(plan)`, `agentEnabled(plan)` — pure/thin reads over the two
   tables above and the static catalogue. **This pass only builds and unit-tests these helpers; it does not
   retrofit FN-03/FN-19/FN-23's existing or future routes to call them** (FN-03 is built and merged without plan
   gating today; FN-19/FN-23 are themselves blocked on the Anthropic/Google decisions) — wiring an existing
   route to a new gate is each of those features' own follow-up, named explicitly in Tracker impact below so it
   is not silently dropped.
8. **`/pengaturan/paket` settings screen** ("Paket & kredit" — **deliberately not `/langganan`**, which FN-26
   already uses for the user's own tracked bills/subscriptions, a completely different concept; a naming
   collision here would be a real bug, not a style nit). Shows: current plan name, credit balance (exact
   integer, `Rp`-free — credits are not money and must never be formatted with `formatMoney`, to avoid implying
   they are a currency amount), a reverse-chronological ledger list (reason + delta + running context, paged),
   a plan-comparison section (three cards, prices badged "harga sementara"), a "Tukar voucher" form (code input
   → redeem action), and — only when `BILLING_MOCK_ENABLED` — the "Upgrade" → mock-checkout entry point.
9. **Voucher redemption** `src/lib/server/billing/vouchers.ts`: `redeemVoucher(db, userId, code, now)` — hashes
   `code` with SHA-256, looks up the live (`deleted_at is null`, not expired) voucher by `code_hash`, and in one
   guarded statement inserts the `voucher_redemptions` row **and** increments `redemption_count` only while
   `redemption_count < max_redemptions`, exactly the "one guarded statement, not read-then-write" rule
   (ENGINEERING_CHECKLIST › Data access › "Concurrent writes") — proven by the 20-concurrent-redemption probe
   named in the checklist's own "Pre-handoff probes" section. A code already redeemed by this user, expired, or
   at its redemption cap is refused with one of three distinguishable *user-facing* reasons (this is the user's
   own voucher attempt, not another account's data, so a specific reason is fine here — unlike space access,
   there is no cross-user oracle risk in telling someone their own code expired).
10. **i18n**: plan names (generic words, not translated as brand), `harga sementara`/`price placeholder`, `Mode
    uji — tidak ada tagihan sebenarnya`/`Test mode — no real charge`, ledger reason labels, voucher
    success/failure messages, the upgrade/checkout copy.

## Out of scope

- Any real charge, any real Xendit or Midtrans account, SDK, or sandbox call — the provider decision itself is
  still open (`docs/TASKS.md` line 27-28).
- A real monthly credit grant cron for Pro/Agen — there is no real recurring payment to key it off yet; the
  ledger mechanism is ready, the cron trigger is not built.
- Retrofitting FN-03 (shared spaces), FN-19 (Gmail look-back credits), or FN-23 (Agent) to actually call the new
  gate helpers — each is a follow-up task for that feature, listed in Tracker impact.
- An admin screen for granting/adjusting credits by hand — `reason: 'admin_adjustment'` exists in the schema for
  a future direct-D1 or tooling use, not a UI this pass.
- Refunds, proration, cancellation flows, invoices/receipts, tax handling — none of these apply to a provider
  that does not exist yet.
- Any claim, anywhere in the UI, that a real payment can be made — the mock banner and the production-only
  hiding of "Upgrade" (scope item 5) are the two mechanisms that make this true, not just a label.

## Acceptance criteria

1. Given a brand-new sign-up, then the account's `user_plan_state.plan` is `gratis` and its `credit_ledger` has
   exactly one row (`reason: 'starter_grant'`, `delta: 300`), both written in the same `db.batch` as the account
   row itself — proven by an integration test, not by two separate unguarded writes.
2. Given any sequence of ledger entries, then `creditBalance` always equals the SQL `SUM(delta)` of that user's
   rows — never a stored, independently-mutable counter — and every `delta` is a non-zero integer (a DB CHECK
   refuses a zero-delta insert attempt in the test harness).
3. Given 20 concurrent redemption attempts of the same voucher with `max_redemptions = 1`, then exactly one
   succeeds and the other 19 are refused — the exact concurrency probe named in
   `docs/ENGINEERING_CHECKLIST.md` › "Pre-handoff probes".
4. Given a user redeems the same voucher code twice (sequentially), then the second attempt is refused by the
   `(voucher_id, user_id)` unique index, never by an application check a race could bypass.
5. Given a mock-provider webhook delivery with a valid HMAC signature and a `provider_event_id` not seen before,
   then exactly one `billing_events` row and one corresponding `credit_ledger`/`user_plan_state` effect are
   written, in the same `db.batch`; given the identical delivery is replayed (same `provider_event_id`), then no
   second effect is applied, a `replay_ignored` event is recorded instead, and the endpoint still answers 200 —
   proven by an integration test that posts the same signed body twice.
6. Given a webhook delivery with a missing, malformed or wrong-key signature, then it is refused with a fixed
   401 body, in constant time relative to a valid signature of the same length (`equalConstantTime`), and no
   `billing_events` row is written for it.
7. Given `BILLING_MOCK_ENABLED` is unset or false, then the "Upgrade"/mock-checkout UI is absent from
   `/pengaturan/paket`'s rendered HTML (not merely hidden by CSS) and the webhook endpoint still exists (so a
   stray delivery does not 500) but the checkout-creation path that would produce a signed event is unreachable
   from the UI.
8. Given the plan-comparison section, then every price is visibly badged as a placeholder (`harga sementara`)
   in both languages, and no code path anywhere formats a credit balance with `formatMoney`/`formatMoneyCompact`
   (credits are not currency).
9. Given `gate.ts`'s helpers against each of the three plans in the static catalogue, then
   `canUseSharedSpaces('gratis')` is false and true for `pro`/`agen`, `gmailLookbackMaxDays` returns the
   catalogue's own per-plan figure, and `agentEnabled` is true only for `agen` — proven by a table-driven unit
   test covering all three plans.
10. Given every billing route and action, then it reads only `locals.user.id`'s own plan/ledger/vouchers, never
    a client-supplied user id — the "one access rule" (ENGINEERING_CHECKLIST › Access and privacy) applied to
    account-scoped data the way `requireSpaceAccess` applies it to space data; a request for another user's
    ledger is impossible by construction (no route ever takes a user id parameter here), not merely refused.
11. Given a create/update action on `/pengaturan/paket` (voucher redemption, mock checkout), then it shows
    loading → saving → success only once the server confirms, and failure states (expired/used/capped voucher,
    failed mock checkout) are distinguishable and recover without a reload.
12. Every new Indonesian string has an English entry; the account-deletion path removes `user_plan_state` and
    leaves `credit_ledger`/`billing_events`/`voucher_redemptions` rows in place with `user_id` set to null where
    the column allows it (append-only history is not erased by a deletion, matching CLAUDE.md's "used voucher
    codes stay marked used without the account" mirror line for FN-01) while no longer being reachable by any
    route.

## Architecture notes

- **New migration** `migrations/0018_billing.sql` (renumber at merge). Four new Drizzle tables:
  `user_plan_state`, `credit_ledger`, `vouchers`, `voucher_redemptions`, `billing_events`, all **account-scoped**
  (no `space_id`), so **none are added to `SPACE_SCOPED_TABLES`** — they are deleted/nulled directly in
  `src/lib/server/auth/delete-account.ts`'s batch, in the same style as `featureFlags`/`accountKeys` (lines
  70-72 of that file today).
- **New modules:** `src/lib/shared/billing/plans.ts` (pure catalogue); `src/lib/server/billing/{provider,
  mock-provider,gate,vouchers}.ts`; `src/routes/api/v1/billing/webhook/+server.ts`; `/pengaturan/paket` route
  tree.
- **Reused:** `goal_contributions`' append-only pattern (`src/lib/server/db/schema.ts:422-454`) for
  `credit_ledger`'s shape; `space_invites.token_hash`'s hash-not-plaintext pattern for `vouchers.code_hash`;
  `equalConstantTime` (`src/lib/server/auth/password.ts:53`); the bounded-read pattern from
  `src/lib/server/forms.ts:18-49` (adapted for JSON, not form bodies); `batchAssert`/guarded-statement
  concurrency pattern (`src/lib/server/db/assert.ts`, and the wallet-favourite/budget-revive guarded-write style
  already in this codebase) for the voucher redemption cap; the `signUp` batch extension pattern already set by
  FN-21's `insertAccountKey` (`src/lib/server/account-keys/repo.ts:89`, called from `accounts.ts`).
- **New secret:** `MOCK_PAYMENT_WEBHOOK_SECRET` (local/staging only — never set in production, since the mock
  provider itself must not be reachable there per scope item 5). **New var:** `BILLING_MOCK_ENABLED` (boolean,
  like `DEV_ROUTES`). Add both to `src/app.d.ts`'s `Env` interface and `.dev.vars.example`.
- **Real provider secrets are an owner item, not yet named**: once Xendit or Midtrans is chosen
  (`docs/TASKS.md` line 27-28), that PRD names the exact secret (e.g. `XENDIT_SECRET_KEY`/
  `XENDIT_WEBHOOK_VERIFICATION_TOKEN` or `MIDTRANS_SERVER_KEY`) and implements a second `PaymentProvider`; this
  PRD intentionally does not guess those names.
- **Worker boundary:** everything runs in the app Worker (webhook delivery is HTTP, settings are SSR/actions).
  No jobs-Worker change this pass (a future monthly-grant cron is out of scope, per above).
- **No AI** in this feature.

## Prerequisites

- **No payment provider chosen** (Xendit vs Midtrans, `docs/TASKS.md` line 27-28) and **no sandbox account**
  (`docs/TASKS.md` line 45) — both **You** items, both still open. Until either exists, `provider.ts` has
  exactly one real implementation (`mock-provider.ts`), and `BILLING_MOCK_ENABLED` stays unset in every deployed
  environment the owner has not explicitly flagged as a demo/staging environment.
- **New local secrets** `MOCK_PAYMENT_WEBHOOK_SECRET`, `BILLING_MOCK_ENABLED=1` — generate/set locally per
  `docs/RUNBOOK.md`'s existing secret-setup convention; never committed.
- **Plan prices are placeholders** — the owner has not set final prices or confirmed the credit name itself
  (`docs/TASKS.md` line 27: "Plan prices and credit name (FN-30, not before Phase 5)"); this PRD uses "kredit"
  (the plain Indonesian word, not a coined brand name) as a working name, swappable without a schema change
  since `reason`/`delta` carry no brand string.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Plan tier names: Gratis / Pro / Agen** — auto-accepted as generic, safe-to-use words matching FEATURES.md's
   own mirror description; not invented brand terms.
2. **Credit name: "kredit" (plain word), not a coined brand** — auto-accepted as a safe placeholder; a later
   rebrand is a label/i18n change only, no schema impact.
3. **Starter grant: 300 credits, matching FEATURES.md's own figure** — auto-accepted; it is the one concrete
   number FEATURES.md already states, not a guess.
4. **Billing is account-scoped, not space-scoped** — auto-accepted; matches who actually pays, consistent with
   `account_keys`/`sessions`/`feature_flags`. Trade-off: a shared space with members on different plans is
   possible (each member's own plan gates their own actions, e.g. who can add a 6th space), which is also how
   per-account billing must work.
5. **Mock checkout gated behind `BILLING_MOCK_ENABLED`, hidden (not just disabled) outside dev/staging** —
   auto-accepted; a visible-but-disabled "Upgrade" button would be misleading (unlike the `Belum dikonfigurasi`
   convention, which marks a *real, eventually-available* capability — this one cannot become real by itself,
   it needs a provider swap).
6. **Voucher kind `plan_days` grants a time-boxed plan, not credits** — auto-accepted as the simplest two-kind
   model (credits or plan-time) covering the brief's "voucher codes" requirement without inventing a third
   mechanism.
7. **No real monthly credit-grant cron this pass** — auto-accepted; building a cron with no real subscription to
   key it off would either fire for nobody or require guessing a renewal date, neither of which "money is never
   invented" allows.

## Tracker impact

- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-30 Billing: plans/credits/vouchers schema, mock
  payment provider (test mode only), webhook signature + replay protection, gate helpers (not yet wired into
  FN-03/19/23). Real provider choice and sandbox still **You**."
- Adds three explicit follow-up `- [ ] **Claude**` items for when each is next touched: "Wire `canUseSharedSpaces`
  into FN-03's space-creation action", "Wire `gmailLookbackMaxDays` into FN-19's look-back scan once FN-19
  ships", "Wire `agentEnabled` into FN-23's Agent entry point once FN-23 ships" — so the gate helpers are not
  silently unused.
- `docs/ACCEPTANCE.md` gains a new row under "Security and privacy" once checked: "Payment webhook signature +
  replay protection" (the row already exists at line 37 as "Not run" — this PRD is what lets it move to
  **Automated**, tested against the mock provider only; it stays "Not run" for a real provider until one is
  chosen and its own webhook is implemented).
