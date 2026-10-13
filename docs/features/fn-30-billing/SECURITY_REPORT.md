# FN-30 Plans, credits, vouchers and billing — security report (cycle 1)

Reviewed: `git diff c401a94..9bfeadb` (detached worktree at 9bfeadb), against `docs/ENGINEERING_CHECKLIST.md`.
Mock provider only; no real provider, no `--remote`, no login, no deploy.

## Verdict: PASS

No critical, high or medium findings. Five low findings below are tracked; L1 and L2 must be resolved before a
real provider (Xendit/Midtrans) or real vouchers go live.

## What was checked and held

- **Webhook signature** (`src/lib/server/billing/mock-provider.ts:87-117`): HMAC-SHA256 over `"<t>." + raw bytes`,
  strict header regex (`t=<13 digits>,v1=<64 hex>`), `equalConstantTime` on equal-length hex before the timestamp
  check, ±5 min tolerance both directions, timestamp inside the MAC. Duplicate headers (merged with `, `) fail the
  regex. Signature failures and "no provider" give one fixed 401; signed-but-unacceptable gives one fixed 400.
- **Payload**: `z.strictObject` (extra keys refused), event types allowlisted, ids `[A-Za-z0-9_.:-]` ≤ 100; the
  account, plan and price come from the stored `checkout_created` row, never the event body; amount and currency
  must equal the checkout's.
- **Replay/idempotency**: unique `(provider, provider_event_id)` + partial unique `(provider, reference) WHERE
  kind='payment_succeeded'`; `ON CONFLICT DO NOTHING` (no target, so both indexes count) and the effect guarded on
  the inserted row id in the same `db.batch`.
- **Body/content type**: JSON only (415), 64 KiB cap via `readRawBody` (413 incl. lying/absent Content-Length).
  No CSRF exemption was added; SvelteKit's origin check still refuses form-type bodies (403), and a JSON webhook is
  not subject to it. Only the webhook route lives outside `(app)`; `/pengaturan/paket/**` stays session-gated.
- **Forging a completion without the secret**: references are 144-bit random, never sufficient alone; the pay action
  re-reads the checkout with `locals.user.id` (other user / unknown / expired = same 404) and the server signs only
  DB-sourced checkout data. Anonymous pay → 401, cross-site pay → 403, double pay → 409.
- **Mock fail-closed**: `activeProvider` is the single switch (`provider.ts:62-68`): exactly `"1"` AND secret ≥ 32
  chars. Checked in the checkout action, the `uji/[ref]` load and both actions, the page load, and the webhook.
  Not referenced by `workers/jobs`, `workers/inbound`, `wrangler.jsonc` vars, `$env/*` or any client module; the
  secret never reaches page data (probe: absent from HTML).
- **Credit ledger**: append-only triggers on all four history tables (only a pure `user_id → NULL` update passes);
  CHECK `typeof(delta)='integer'`, non-zero, |delta| ≤ 1e9; every grant guarded by `balanceStaysSafe`;
  `creditBalance` throws on a non-safe sum. No user-reachable UPDATE/DELETE path exists; no spend path yet, so the
  balance cannot go negative.
- **Vouchers**: SHA-256 of the normalised code only; single guarded `INSERT … SELECT` + count + effect in one batch;
  `(voucher_id, user_id)` unique; CHECK `redemption_count ≤ max_redemptions`; throttle 20/10 min per user.
  Seeded `UJI-*` codes come only from `scripts/seed-local.ts` behind `assertLocalOnly` (refuses `--remote`,
  `--env`, `--preview`); the migration seeds no vouchers; `deploy-staging.ts` does not seed.
- **Plan gating**: server-side reads of `user_plan_state`; expiry compared in UTC epoch ms in both JS
  (`effectivePlan`) and SQL (`notDowngrade`, `newEnd`) — consistent; `isPaidPlan` is an allowlist (no prototype
  keys); client-sent prices or plans are never trusted (price from `PLAN_CATALOGUE`).
- **Audit content**: `billing_events`/`plan_changes` hold ids, plan, amount, currency, timestamps only — no card
  data, no raw body, no e-mail/name. Logs: only `e.name` on load failure; the webhook logs nothing.
- **Account deletion**: `user_plan_state` deleted inside the proof-guarded batch; history keeps rows with
  `user_id` NULL via FK set-null, which the triggers allow; a later webhook for a deleted account's checkout → 400.
- **Backfill** (`0018_billing.sql:107-108`): `NOT IN` subqueries are NULL-safe (`user_id IS NOT NULL` filter on the
  ledger side; PK on the plan side), so a re-run grants nothing twice.
- **Cross-account IDOR**: no route takes a user id; ledger/plan/checkout reads are scoped to `locals.user.id`.

## Findings

### L1 (low) — a paid lower-tier or late payment is accepted and silently swallowed
`src/lib/server/billing/webhook.ts:87-118` with `src/lib/server/billing/plan-state.ts:24-28`. The guard
`notDowngrade` drops the credit grant and the plan change, but the `payment_succeeded` row commits and the webhook
answers `applied`. Scenario (real provider): user opens a Pro checkout, then redeems an Agen voucher or pays Agen;
within the 1 h window pays the Pro checkout → money captured, nothing granted, no flag for refund, and the pay
action reports success (it only reads back the plan). Mock-only today, so no real money is affected.
Fix before a real provider: record such events with an explicit `needs_refund`/`not_applied` outcome (or apply them
as a queued period after the higher plan), surface it to the user and the owner, and have the pay action report it.

### L2 (low) — voucher guessing: no entropy floor, per-user throttle only, existence oracle
`src/lib/server/billing/vouchers.ts:16,65-66,170-173`; throttle `src/lib/server/auth/throttle.ts:151-156`. Codes
may be 4 characters; the throttle is per user (20/10 min) and accounts are cheap (sign-up throttle is per IP, 20/10
min), so N accounts × 20 guesses scale linearly; `expired`/`used_up` confirm that a guessed code exists; and
`overUserAttemptLimit` fails open on a D1 error. Repro: script 20 sign-ups, 20 guesses each → 400 guesses / 10 min
per IP. Fix when vouchers become real: generate codes with ≥ 80 bits (e.g. 16 Crockford base32 chars) and reject
shorter ones in `createVoucher`; add a per-IP `voucher` budget; consider one generic refusal for codes not
redeemable by anyone.

### L3 (low) — append-only triggers allow nulling `user_id` on a live account
`migrations/0018_billing.sql:98,100,102,104`. The trigger cannot tell the FK set-null action from an ordinary
`UPDATE credit_ledger SET user_id = NULL WHERE …`; once spend rows exist (FN-19/FN-20), a buggy or future code path
nulling a negative row raises the balance. Not user-reachable now. Fix: allow the null update only when the parent
user row no longer exists (`WHEN NOT (… AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id))`), or keep a
grep/test rule that no app code updates these tables.

### L4 (low) — deletion and re-sign-up re-enables per-user vouchers and the starter grant
`src/lib/server/auth/delete-account.ts` + `voucher_redemptions_voucher_user_uq`. After deletion the redemption row
has `user_id` NULL, so the same e-mail signing up again can redeem a multi-use voucher again and receives another
300 starter credits. Scenario (code-read, not run): redeem multi-use code → delete account → sign up with same e-mail → redeem again →
success. Fix (when credits gain value): key the per-person limit on a retained e-mail HMAC (salted, not the
address) or accept and document it.

### L5 (low) — webhook does not enforce checkout expiry; replay rows unbounded
`src/lib/server/billing/webhook.ts:43-65,130-151`. The 1 h TTL is enforced only by the mock pay page
(`checkout.ts:90`); a signed event for an old checkout still applies. Every signed replay writes a new
`replay_ignored` row forever (append-only). Both need the secret, so no external exploit. Fix with the real
provider: decide expiry semantics (provider-side expiry is acceptable if documented) and cap or coalesce replay rows.

### Informational
- Gate helpers are not yet wired into FN-03/FN-19/FN-23 (PRD out of scope): a Gratis user can still create shared
  spaces today. Track as each feature's follow-up.
- `checkout_created` uses `provider_event_id = "checkout:<ref>"` in the same unique namespace as provider event ids
  (the id regex allows `:`); harmless for the mock, prefix-separate for a real provider.
- The fixed e2e HMAC key in `playwright.config.ts` is local-only; never reuse it for staging.

## Engineering checklist

Concurrent writes (guarded batches + unique indexes, concurrency tests) ok; bounded work (64 KiB, page size 20,
throttles) ok; integers only ok; one access rule (account-scoped `locals.user.id`, uniform 404) ok; no secrets in
loaders ok; raw SQL only through drizzle `sql` templates with bound values (demo seed escapes `'` and uses
constants) ok; migration new file and re-runnable ok.

## Commands and probes run

- `npm ci`, `npx svelte-kit sync`, `npm run db:reset:local`: ok. `npm run build`: ok.
- `npx vitest run --maxWorkers=2 test/integration/billing.test.ts src/lib/server/billing src/lib/shared/billing
  scripts/demo-vouchers.test.ts test/paket-page.test.ts`: 6 files, 52 tests passed.
- Ad-hoc `wrangler dev` on 8845 (fresh local persist dir, removed afterwards; servers stopped), mock ON with a local
  test secret: unsigned / wrong key / empty key / duplicate header → 401; ±6 min → 401; wrong amount, extra key,
  unknown type → 400; text/plain or no content type → 403; 70 KiB → 413; GET → 405; signed success → `applied`;
  same delivery → `replay`; new event id same reference → `replay`; 10 parallel new ids → all `replay`; balance
  1.300 (one grant); B viewing/paying A's checkout → 404; anonymous pay → 401; cross-site pay/redeem → 403; paid
  checkout pay → 409; 20th voucher guess → 429; JSON body to action → 415; `plan=gratis`/`__proto__` → 400.
  DB: 1 `checkout_created`, 1 `payment_succeeded`, 12 `replay_ignored`, ledger 300 + 1000.
- Mock fail-closed: flag `1` + 12-char secret, and flag `true` + valid secret: no upgrade form or "Mode uji" in
  HTML, `?/checkout` → 404, validly signed webhook → 401.
- Not run: full Playwright (machine load, per instruction); any real provider.
