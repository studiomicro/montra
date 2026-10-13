# FN-30 / FN-41 hardening before a real payment provider

Slug: `fn-30-pro-hardening`. Branch `feat/fn-30-pro-hardening`. **Risk tier: Large** (payments, money, access
control). Catalog entries: `docs/FEATURES.md` › FN-30 (line 338) and FN-41 (line 412). Earlier work:
`docs/features/fn-30-billing/*` (red team L1, L4, L5) and `docs/features/fn-41-integrations-byok/*` (red team L1, L4).

The payment provider (Xendit or Midtrans) is still an open owner decision (`docs/TASKS.md:29`). This pass stays on
the existing provider interface (`src/lib/server/billing/provider.ts:40-68`) and the mock provider. It adds no
provider SDK, creates no account and calls no real provider.

## Goal

Three things must hold before any real money passes through MONTRA:

1. A payment that was verified but granted nothing (`paid_not_applied`) must not stay a silent row. Each one needs
   a recorded refund obligation. The user must see it, and the operator must see a list to act on. MONTRA never
   moves money itself. A refund is a record that a person, or a later provider integration, closes.
2. The 300 starter credits and per-person vouchers must not be re-claimable by deleting the account and signing up
   again with the same address. Doing this must not keep any raw e-mail address after deletion.
3. The admin page must stop trusting an unverified e-mail address before any admin write (such as a future
   "Beri paket") exists.

## Scope

### A. Refund records for `paid_not_applied` payments (FN-30 red team L1 follow-up)

Current behaviour:
- The webhook decides inside SQL whether a verified payment applies. If it does not apply, it stores
  `kind = 'paid_not_applied'` (`src/lib/server/billing/webhook.ts:77-106`) and answers `ignored_paid`
  (`:160`).
- `paymentsNeedingRefund` (`src/lib/server/billing/refunds.ts:14-43`) is an owner query with no caller in `src`.
- The mock pay action reports `CHECKOUT_NOT_APPLIED` ("… Perlu refund.",
  `src/lib/server/billing/messages.ts:25-27`; `src/routes/(app)/pengaturan/paket/uji/[ref]/+page.server.ts:53-54`).
- Nothing records whether a refund happened.

Build:
1. **New table `billing_refunds`** (migration, see Architecture notes). One row per `paid_not_applied` event:
   - `id` text PK.
   - `billing_event_id` text NOT NULL UNIQUE, FK → `billing_events.id`.
   - `user_id` text, FK → `users.id` ON DELETE SET NULL.
   - `provider`, `reference`, `amount_minor`, `currency`, copied from the event.
   - `reason`: one of `checkout_expired`, `plan_higher` or `unknown`. `unknown` is for backfilled rows only.
   - `status`: one of `pending`, `refunded` or `cancelled`.
   - `provider_refund_id` text NULL, at most 100 characters of `[A-Za-z0-9_.:-]`.
   - `created_at`, `updated_at`, `resolved_at` NULL.
   - CHECK constraints for the enums and the amount range, the same as `billing_events`
     (`migrations/0018_billing.sql:16-20`). `resolved_at` is set exactly when `status <> 'pending'`.
   - Triggers in the 0018 style (`migrations/0018_billing.sql:102-110`):
     - Every DELETE is refused.
     - An UPDATE is allowed only in two cases. (a) The FK sets `user_id` to null after the user row is gone.
       (b) One transition from `pending` to `refunded` or `cancelled` that sets `resolved_at`, `updated_at` and,
       optionally, `provider_refund_id`, and changes nothing else.
   - Index `(status, created_at)` and index `(user_id, created_at)`.
2. **Webhook writes the refund row in the same `db.batch`** as the event insert (`webhook.ts:137`). It is an
   `INSERT … SELECT … FROM billing_events e WHERE e.id = <eventRowId> AND e.kind = 'paid_not_applied'`, so the
   stored kind and the refund row can never disagree. A replay inserts no event row, so it adds no refund row.
   `reason` is `checkout_expired` when the TTL branch fired (`webhook.ts:79-81`), otherwise `plan_higher`.
3. **Migration backfill:** every existing `paid_not_applied` event without a refund row gets one, with
   `reason = 'unknown'` and `status = 'pending'`. The backfill is re-runnable (`NOT EXISTS`).
4. **`src/lib/server/billing/refunds.ts` rewritten:**
   - `pendingRefunds(db)` returns the exact count plus up to `REFUND_LIST_LIMIT` (100) pending rows, newest first.
     Each row has id, provider, reference, amount, currency, reason and created_at. No user id, e-mail or name.
   - `refundsForUser(db, userId)` returns the user's own rows, newest first, capped at 20.
   - `recordRefundOutcome(db, refundId, outcome: 'refunded' | 'cancelled', providerRefundId | null, now)` is one
     guarded `UPDATE … WHERE id = ? AND status = 'pending' RETURNING`. It returns
     `'done' | 'already_resolved' | 'not_found'`.
   - **No route or UI calls `recordRefundOutcome` in this pass** (Owner decision 3). It exists, with tests, for
     the real-provider integration or a later admin action.
   - `paymentsNeedingRefund` is removed or becomes an alias of `pendingRefunds`. Nothing in `src` uses it.
   - No function in `refunds.ts` calls `fetch`, a provider or the `PaymentProvider` interface. The interface gains
     no refund method this pass.
5. **User surface, `/pengaturan/paket`:** the load (`src/routes/(app)/pengaturan/paket/+page.server.ts:41-76`)
   also reads `refundsForUser`. When there is at least one row, a "Pengembalian dana" group lists each row:
   - the amount with the shared formatter, the WIB date and the plan;
   - the status: "Menunggu diproses", "Sudah dikembalikan" or "Dibatalkan";
   - under the mock provider, a "Mode uji — tidak ada uang yang berpindah" note.

   With no rows, the group is absent, not shown empty. A load failure keeps the existing `BILLING_LOAD_FAILED`
   path.
6. **Mock pay action copy:** `CHECKOUT_NOT_APPLIED` becomes "Pembayaran uji tercatat tetapi tidak diterapkan ke
   paketmu. Pengembalian dana dicatat dan bisa kamu lihat di Paket & kredit.", with an English entry. The action
   keeps its 409.
7. **Operator surface, `/pengaturan/integrasi/admin`** (read-only, behind the new gate in C):
   - a "Pengembalian dana menunggu" section showing the exact pending count;
   - up to 100 rows, each with the provider, the full provider reference (the operator needs it in the provider
     dashboard), the amount, the reason and the WIB date. Nothing identifies a person;
   - "Belum ada" when the count is 0;
   - an error line when the query fails, while the rest of the page still renders (the same pattern as `keyCount`,
     `+page.server.ts:28-33`).

### B. Stop re-claiming starter credits and per-person vouchers (FN-30 red team L4)

Current behaviour:
- Sign-up always inserts a 300-credit `starter_grant` (`src/lib/server/billing/plan-state.ts:138-156`, called from
  `src/lib/server/auth/accounts.ts:105`).
- Account deletion nulls `user_id` on `voucher_redemptions` and `credit_ledger`
  (`src/lib/server/auth/delete-account.ts:37-39`). After that, the unique `(voucher_id, user_id)` index
  (`migrations/0018_billing.sql:79`) no longer matches the new account.

Build:
1. **New module `src/lib/server/billing/claims.ts`:**
   - `canonicalClaimEmail(email)`:
     - Apply `normalizeEmail` (trim, lower-case; `src/lib/server/auth/password.ts:185`).
     - Split at the last `@`.
     - In the local part, drop everything from the first `+`, on every domain.
     - For `gmail.com` and `googlemail.com`, also remove every `.` from the local part and map the domain to
       `gmail.com`.
     - An address with an empty local part after this keeps its normalised form unchanged.
   - `claimHashes(env, email)` returns `{ current, previous } | null`:
     - The HMAC-SHA256 (WebCrypto) of `"montra-claim-v1\0" + canonical`, base64url.
     - `current` uses `CLAIM_HASH_KEY`. `previous` uses `CLAIM_HASH_KEY_PREVIOUS` when that is set. Each key is
       32 bytes, base64url, parsed like the existing sealing keys (`src/lib/server/server-seal.ts`).
     - It returns `null` when the current key is unset or malformed. It never falls back to a default key.
   - `isClaimHashConfigured(env)`, for the admin page.
2. **New table `claim_markers`:**
   - Columns: `email_hmac` text NOT NULL (43 characters), `kind` (`starter_grant` | `voucher`), `voucher_id` text
     NULL (set only for `voucher`), `created_at` integer NOT NULL.
   - Unique index on `(email_hmac, kind, ifnull(voucher_id, ''))`.
   - CHECK constraints for kind/voucher consistency and the hash length.
   - **No `user_id` column:** a marker cannot be linked to a live account.
3. **Written at account deletion only.** `deleteAccount` (`delete-account.ts:48-136`) takes an optional
   `claimHash: string | null`. The caller, `src/routes/(app)/pengaturan/akun/+page.server.ts:175`, computes it from
   `locals.user.email`. Two steps are added inside the proof-guarded batch, before the user row is deleted:
   - `INSERT OR IGNORE` one `starter_grant` marker;
   - `INSERT OR IGNORE … SELECT voucher_id FROM voucher_redemptions WHERE user_id = ?` for each voucher the
     account redeemed.

   Both steps are guarded on `proof`, like every other step. With `claimHash = null` (key not configured), these
   steps are left out and **deletion proceeds unchanged**. Deletion is never blocked.
4. **Sign-up check:** `signUp` (`accounts.ts:70`) takes the claim hashes. The starter-grant insert in
   `signUpBillingSteps` becomes an `INSERT … SELECT … WHERE NOT EXISTS` (a `starter_grant` marker equal to the
   current or previous hash). The account, the plan state and everything else are still created. When the marker
   exists, the balance starts at 0. No extra message is shown at sign-up (Owner decision 7). When hashes are
   `null`, the grant is unconditional, as today.
5. **Voucher check:** `redeemVoucher` (`src/lib/server/billing/vouchers.ts:73`) takes the claim hashes. It adds
   `NOT EXISTS` (a `voucher` marker for this `voucher_id` and the current or previous hash) to the `extra` guard of
   the guarded insert (`:145-160`). That keeps it race-safe inside the one batch.
   - The fallback reason read (`:184-195`) must report `already_redeemed`, never `used_up` or `plan_higher`, when a
     marker matches. A pre-read of the marker is fine for naming the reason. The guard in the insert decides.
   - The paket route passes hashes from `locals.user.email` (`+page.server.ts:89`).
6. **Retention:** the jobs Worker cron (`workers/jobs/src/index.ts:84-85`, next to `sweepNotifications`) deletes
   markers older than 730 days. Each tick is a bounded batch of at most 500 rows, oldest first. The jobs Worker
   needs no key for this.
7. **Privacy copy:** the `privasi-hapus` paragraph (`src/routes/(site)/site/[legal=legal]/content.ts:146-152`) gains
   one sentence, with an English entry: "Agar kredit awal dan voucher tidak bisa diklaim ulang, kami menyimpan
   sidik acak dari alamat emailmu (bukan alamatnya) selama 2 tahun setelah akun dihapus." The account data export
   is unchanged. Markers have no user link, so a live account has none to export.

### C. Admin gate by account id (FN-41 red team L1)

Current behaviour: `isAdminEmail` (`src/lib/server/admin.ts:16-32`) admits whoever holds a listed `users.email`.
Sign-up never verifies the address. The page calls it at
`src/routes/pengaturan/integrasi/admin/+page.server.ts:25`.

Build:
1. Replace `isAdminEmail` with `isAdminAccount(env, userId)`:
   - It reads `ADMIN_ACCOUNT_IDS`, a comma-separated list of `users.id` values (UUIDs from `crypto.randomUUID`,
     `src/lib/server/util.ts:1`).
   - It trims and lower-cases each entry and drops entries that are not a UUID. It reads at most 20 entries.
   - It compares every entry in constant time without stopping at a match, keeping the current loop shape.
2. **`ADMIN_EMAILS` is no longer read anywhere.** Remove it from `src/app.d.ts:63`, `.dev.vars.example:34-35`,
   `test/integration/integrasi.test.ts:71` and the RUNBOOK (`docs/RUNBOOK.md:91,149,153`). Add `ADMIN_ACCOUNT_IDS`
   in its place.
3. The admin page behaviour is otherwise unchanged:
   - Signed out, not listed, unset, or listed but the id belongs to no live session user: the same root 404.
   - `no-store` cache control.
   - No actions. **No "Beri paket" or any other admin write is built in this pass.**
4. The admin page gains two status lines: `CLAIM_HASH_KEY` configured (plus `_PREVIOUS` present), and the pending
   refunds section from A.7.

### D. FN-41 L4 (re-seal job when rotating the sealing secret) — **stays open**

This pass does not include it. A re-seal needs a runner that holds `AI_KEYS_ENCRYPTION_KEY` and
`CONNECTED_APPS_ENCRYPTION_KEY`. The jobs Worker deliberately does not hold them (RUNBOOK). The runner would also
need a bounded, resumable loop over two tables, and almost certainly an admin-triggered write. That is a medium
change of its own, not a small add-on. The `docs/TASKS.md:138` item stays open for its L4 half.

### i18n

Every new Indonesian string gets an English entry in `src/lib/shared/i18n-en.ts`:
- the refund group title, the three status labels and the mode-uji note;
- the two reason labels on the admin page and the admin section titles;
- "Belum ada", the new `CHECKOUT_NOT_APPLIED`, the privacy sentence and the `CLAIM_HASH_KEY` status line.

## Out of scope

- Any real provider (Xendit or Midtrans) SDK, API call or account. No refund API call and no `refund` method on
  `PaymentProvider`.
- Any admin write action: "Beri paket", marking a refund refunded or cancelled from the UI, voucher creation UI.
- E-mail verification at sign-up (Owner decision 1 picks the account-id allowlist instead).
- Multi-account farming with live alias addresses (`a.b@gmail.com` and `ab@gmail.com` both live). Markers exist
  only for deleted accounts. This is noted as residual, not fixed.
- FN-30 red team L2 (voucher entropy floor, per-IP voucher throttle) and L5 (replay row growth). Both remain as
  tracked.
- FN-41 L4 re-seal job (section D).
- Spending credits, or wiring gate helpers into FN-03/FN-19/FN-23.

## Acceptance criteria

All are **Automated** (Vitest with local D1) unless marked otherwise. Each regression test must fail on the unfixed
code, and the run must show that failure.

### Refunds

1. Given a Pro checkout whose user then holds an active Agen plan, when the signed mock webhook delivers
   `payment_succeeded`, then exactly one `billing_events` row with kind `paid_not_applied` and exactly one
   `billing_refunds` row (`pending`, `plan_higher`) exist, with the same amount and currency. No credit or plan row
   is written.
2. Given a checkout older than `CHECKOUT_TTL_MS`, when it is paid, then one refund row with reason
   `checkout_expired` exists.
3. Given criterion 1, when the same delivery is replayed, and also when a new event id with the same reference is
   sent, then the refund row count stays 1. 20 concurrent deliveries of new event ids for one reference also leave
   exactly 1 refund row.
4. Given a successful (applied) payment, then no refund row exists.
5. `recordRefundOutcome`:
   - `pending` → `refunded` with a provider refund id gives `done` and sets `resolved_at`.
   - A second call gives `already_resolved` and changes nothing.
   - An unknown id gives `not_found`.
   - 20 concurrent calls give exactly one `done`.
6. Direct SQL against `billing_refunds` is refused by its trigger in each of these cases:
   - a `DELETE`;
   - changing `amount_minor`;
   - moving `refunded` back to `pending`;
   - nulling `user_id` while the user row still exists.
7. Migration backfill: given a `paid_not_applied` event inserted before 0030, after applying the migration it has
   one `unknown`/`pending` refund row. Applying the backfill statement a second time adds nothing.
8. Given user A with a pending refund and user B with none:
   - A's `/pengaturan/paket` load returns A's refund (amount `Rp 49.000` through the shared formatter, WIB date,
     status "Menunggu diproses").
   - B's load returns an empty list, and the page has no "Pengembalian dana" group.
   - No route takes a refund id or user id.
9. Given the mock pay action for a not-applied payment, then it answers 409 with the new `CHECKOUT_NOT_APPLIED` text
   (Indonesian and English).
10. Given account deletion of a user with a pending refund, then the refund row survives with `user_id` NULL and
    still appears in `pendingRefunds`.
11. `pendingRefunds` returns the exact count with 101+ pending rows, and at most 100 rows.
12. Static test: `src/lib/server/billing/refunds.ts` does not reference `fetch`, `PaymentProvider` or
    `activeProvider`.

### Re-claim prevention

13. `canonicalClaimEmail` vectors:
    - `" A.B+x@GMail.com "` → `ab@gmail.com`.
    - `a.b@googlemail.com` → `ab@gmail.com`.
    - `a.b+x@contoh.id` → `a.b@contoh.id`.
    - `+x@contoh.id` keeps `+x@contoh.id`.
    - Two different addresses on a non-Gmail domain stay distinct.
14. `claimHashes` is deterministic for one key, differs between keys, and returns `null` for an unset, empty,
    31-byte or 33-byte key. The output never contains the address.
15. Given user A (`ab@gmail.com`) who got 300 starter credits, when A deletes the account and signs up again as
    `a.b+1@gmail.com`, then:
    - the new account exists with plan Gratis and balance 0;
    - exactly one `claim_markers` row for `starter_grant` exists;
    - no column of `claim_markers` contains the raw or canonical address (asserted by a scan of every column).
16. Given a multi-use credits voucher redeemed by A, when A deletes and re-signs up, then redeeming the same code
    answers `already_redeemed` (`VOUCHER_ALREADY_REDEEMED`) and writes no ledger row. Another fresh user can still
    redeem it.
17. Given the marker from 16, when 20 concurrent redeems run for the re-signed-up account, then none succeeds.
18. Key rotation: given a marker written under key K1, with `CLAIM_HASH_KEY = K2` and
    `CLAIM_HASH_KEY_PREVIOUS = K1`, then sign-up and redeem are still refused. With only K2 set, they are allowed.
    This is the documented loss of protection on rotation without `_PREVIOUS`.
19. Given `CLAIM_HASH_KEY` unset:
    - deletion succeeds and writes no marker;
    - sign-up grants 300;
    - redeem works as today;
    - the admin page shows the key as not configured.
20. Deletion with a wrong proof writes no marker (the proof guard holds).
21. Retention: given markers created 731 days and 729 days ago, then the sweep deletes only the older one, and at
    most 500 per call.
22. A live account has no `claim_markers` row: sign-up and redeem write none.

### Admin gate

23. `isAdminAccount`:
    - It admits a listed id, also with surrounding spaces or upper-case.
    - It refuses an unlisted id, the empty string and non-UUID entries.
    - It refuses everyone when `ADMIN_ACCOUNT_IDS` is unset, empty or `","`.
    - It reads only the first 20 entries.
24. Given `ADMIN_ACCOUNT_IDS` listing user A's id, then A gets 200, with `cache-control: no-store`.
25. Each of these gets an identical 404 to A's request on an unknown path (status and body): user B, whose e-mail
    equals a value an operator might put in the old `ADMIN_EMAILS`; a signed-out visitor; and everyone while the
    variable is unset.
26. Grep test: no file under `src/` or `workers/` reads `ADMIN_EMAILS`.
27. The admin page renders the pending-refund count and rows, with no user id, e-mail or name in the HTML. A failing
    refund query shows the error line while the other status lines still render.

### Cross-cutting

28. Every new Indonesian string has an English entry (`test/i18n-coverage.test.ts` passes).
29. `npm run gates` is clean.
30. **Browser:** the e2e specs listed under Architecture notes pass.

## Architecture notes

- **Modules touched:**
  - `src/lib/server/billing/{webhook,refunds,vouchers,plan-state,messages}.ts`, and new `claims.ts`;
  - `src/lib/server/auth/{accounts,delete-account}.ts`;
  - `src/lib/server/admin.ts`;
  - `src/lib/server/db/schema.ts` (new tables next to `billingEvents`, line 1497);
  - `src/routes/(app)/pengaturan/paket/+page.server.ts` and `+page.svelte`;
  - `src/routes/(app)/pengaturan/paket/uji/[ref]/+page.server.ts`;
  - `src/routes/(auth)/daftar/+page.server.ts` (passes hashes, `:48`);
  - `src/routes/(app)/pengaturan/akun/+page.server.ts:175`;
  - `src/routes/pengaturan/integrasi/admin/+page.server.ts` and `+page.svelte`;
  - `src/routes/(site)/site/[legal=legal]/content.ts`;
  - `src/lib/shared/i18n-en.ts`, `src/app.d.ts`;
  - `workers/jobs/src/index.ts` (marker sweep, no secret needed).
- **Reuse:**
  - `creditGrantStep` and `balanceStaysSafe` (`plan-state.ts`);
  - the 0018 trigger pattern;
  - the key parsing in `server-seal.ts`;
  - `constantTimeEqual` (`src/lib/server/auth/api-tokens.ts`);
  - `normalizeEmail`, the shared currency formatter, `readFormBody` and `errorLabel`.
- **Migration `0030_billing_hardening.sql`:**
  - It creates `billing_refunds` with its triggers and indexes, and `claim_markers` with its index.
  - It backfills refund rows for existing `paid_not_applied` events.
  - It changes no existing table and edits no applied migration. It is re-runnable (backfill guarded by
    `NOT EXISTS`). The `migrations/meta` journal and snapshot are regenerated.

  **Collision:** `feat/fn-22-tanya` has `0030_tanya_messages.sql`, and `feat/fn-19-forwarding` has
  `0030_email_forwarding.sql`. This migration depends on neither. Whichever branch merges to `main` second renumbers
  its file to the next free number, then regenerates `migrations/meta/_journal.json` and the snapshot before
  merging. Renumbering is allowed only before any remote apply. The RUNBOOK Time Travel bookmark step applies before
  the staging apply.
- **Concurrency:** every new guard (refund insert, marker `NOT EXISTS`, `recordRefundOutcome`) sits in one statement
  inside the existing `db.batch`. No read-then-write decides state.
- **E2E specs to run (only these):**
  - `e2e/paket.spec.ts` (billing page, voucher, mock upgrade);
  - `e2e/integrasi.spec.ts` (admin 404 test at `:138`);
  - `e2e/accounts.spec.ts` (sign-up and account deletion);
  - `e2e/site.spec.ts` (privacy page copy).

  `playwright.config.ts:35` gains `--var CLAIM_HASH_KEY:<fixed local test key>`. The value is local only and never
  reused for staging.
- **Vitest files:**
  - `test/integration/billing.test.ts`, `test/integration/delete-account.test.ts`,
    `test/integration/integrasi.test.ts`;
  - `src/lib/server/admin.test.ts`, `src/lib/server/billing/*.test.ts`;
  - new `src/lib/server/billing/claims.test.ts`;
  - `test/paket-page.test.ts`, `test/i18n-coverage.test.ts`;
  - `workers/jobs/src/cron.test.ts`, if the sweep is tested there.

## Prerequisites

- **New secret `CLAIM_HASH_KEY`** (32 random bytes, base64url:
  `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`), plus optional `CLAIM_HASH_KEY_PREVIOUS` during a rotation.
  - Add it to `.dev.vars.example`, `src/app.d.ts` and the RUNBOOK › Secrets.
  - Missing or malformed: no markers are written or checked (fail open), and the admin page shows
    "Belum dikonfigurasi".
  - It must be set on staging and production before a real provider goes live. Add a **You** item to TASKS.
- **New secret `ADMIN_ACCOUNT_IDS`** replaces `ADMIN_EMAILS`. Unset: nobody is admin (404 for all).
  - **Staging migration:** `ADMIN_EMAILS` is not yet set on staging (open You item, `docs/TASKS.md:134`). The owner
    signs up on staging, then reads their id with a read-only query:
    `npx wrangler d1 execute montra-staging --env staging --remote --command "SELECT id FROM users WHERE email = '<address>'"`.
    Then they run `npx wrangler secret put ADMIN_ACCOUNT_IDS --env staging`.
  - If `ADMIN_EMAILS` was set meanwhile, run `npx wrangler secret delete ADMIN_EMAILS --env staging`.
  - The TASKS item at `:134` is reworded to name `ADMIN_ACCOUNT_IDS` instead.
- No provider credentials. `BILLING_MOCK_ENABLED` and `MOCK_PAYMENT_WEBHOOK_SECRET` stay as they are.

## Owner decisions (the proposed defaults are used)

1. **Admin gate method:** allowlist of account ids in `ADMIN_ACCOUNT_IDS` (default). Alternative: e-mail
   verification flow. Rejected for now because it needs outbound e-mail, which has no provider yet.
2. **`ADMIN_EMAILS` after this change:** removed entirely, with no transitional e-mail path (default).
3. **Who closes a refund:** no UI action this pass (default). `recordRefundOutcome` exists for the real-provider
   integration or a later admin "Tandai dikembalikan" action. Until a real provider exists, no real money can need
   a refund.
4. **Refund statuses:** `pending`, `refunded` and `cancelled`, all terminal except `pending` (default). No automatic
   refund. MONTRA never moves money.
5. **Refund row retention:** kept indefinitely like the rest of the FN-30 billing history. Rows are content-free of
   the person, and `user_id` is nulled on deletion (default).
6. **Operator view shows the full provider reference but no person** (default). The operator refunds by reference
   in the provider dashboard.
7. **Re-sign-up with a marker:** the account is created with 0 starter credits and no special message (default).
   Alternative: a notice "Kredit awal sudah pernah dipakai untuk alamat ini", rejected because it reveals that a
   deleted account existed.
8. **Key source:** a new dedicated secret `CLAIM_HASH_KEY` with `_PREVIOUS` rotation (default). Reusing
   `AI_KEYS_ENCRYPTION_KEY` or `CONNECTED_APPS_ENCRYPTION_KEY` would tie their rotation to claim protection.
9. **Missing key:** fail open, which grants as today, and the admin page shows it (default). Fail closed would block
   sign-up credits and break local development.
10. **Normalisation:** trim and lower-case; strip `+tag` on all domains; strip dots only for gmail.com and
    googlemail.com (default). False positives cost a stranger only the starter credits.
11. **When markers are written:** only at account deletion (default). This means no backfill, and live accounts
    hold no marker. Residual: live alias accounts are not linked (out of scope).
12. **Marker retention:** 730 days from deletion, then swept by the jobs Worker (default).
13. **Privacy copy:** add one sentence to "Menghapus akun dan data" (default). Markers are not part of the data
    export, because there is no user link.
14. **FN-41 L4 re-seal job:** stays open (default; see section D).
15. **Migration number:** `0030_billing_hardening.sql`. Whichever branch merges second renumbers (default).

## Tracker impact

- Closes `docs/TASKS.md:103`: "FN-30 before a real provider: refund flow for `paid_not_applied` payments; stop
  starter credits and per-user vouchers being re-claimed after delete + re-sign-up (red team L4)." The real-provider
  refund API call stays with the provider task.
- Closes the L1 half of `docs/TASKS.md:138`: "FN-41 red team L1: admin trusts an unverified e-mail; before any admin
  write ("Beri paket"), gate admin by account id or add e-mail verification." The item is rewritten to keep only
  "L4: one sealing secret opens every stored key (re-seal job when rotating)".
- `docs/TASKS.md:134` (You): `ADMIN_EMAILS` is replaced by `ADMIN_ACCOUNT_IDS`. Add a You item to set
  `CLAIM_HASH_KEY` on staging and production.
- `docs/ACCEPTANCE.md` has no FN-30 or FN-41 rows today. Add none unless the owner asks.
