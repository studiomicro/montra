# Security report: FN-30 / FN-41 hardening before a real payment provider (red team cycle 1)

**Verdict: PASS.** No Critical, High or Medium finding. Six Low findings are listed below. Each may be deferred, but
each should be tracked.

Scope: `git diff 38c5f82..HEAD` on `feat/fn-30-pro-hardening` (HEAD `209a77e`, QA cycle 1 PASS). The review read the
PRD, the QA report, `CLAUDE.md` and `docs/ENGINEERING_CHECKLIST.md`. No product code was changed.

## Commands run

- `npx vitest run src/lib/server/billing/claims.test.ts src/lib/server/admin.test.ts src/lib/server/billing/refunds.test.ts test/integration/migration-0030.test.ts test/integration/billing-hardening.test.ts`:
  `Test Files 5 passed (5)`, `Tests 35 passed (35)`. Local D1 and the mock provider only.
- One throwaway PoC (`src/lib/server/billing/zz-poc.test.ts`, deleted after the run, not committed). It printed
  `isPlausibleEmail` and `canonicalClaimEmail` for address variants. It failed on purpose to print its output. The
  results are in L1.
- Not run: `npm run gates`, the full suite and e2e (caller's resource limit). The caller must still run
  `npm run gates` before merge (QA criterion 29).

## What was checked and holds

### Refunds

- **No money moves.** `src/lib/server/billing/refunds.ts` has no `fetch`, provider or `PaymentProvider` reference
  (the static test passes). `PaymentProvider` gains no refund method.
- **No user trigger or edit.** `recordRefundOutcome` has no caller in `src` or `workers`. No route takes a refund
  id or a user id. `refundsForUser` reads only `locals.user.id` (`src/routes/(app)/pengaturan/paket/+page.server.ts`).
  The operator list is behind the admin gate and has no action.
- **Webhook writes.** The refund row is an `INSERT … SELECT` from the event row this call inserted
  (`webhook.ts:142-160`), filtered on `kind = 'paid_not_applied'`. The insert is in the same batch, and
  `billing_event_id` is UNIQUE. A replay inserts no event row under the fresh `eventRowId`, so it adds no refund.
  A refund row needs a signed, verified payment, so a user cannot create one without paying.
- **Status transitions.** The `billing_refunds_no_update` trigger allows only two updates. (a) FK `SET NULL` of
  `user_id` once the user row is gone, with every other column unchanged. (b) One move from `pending` to `refunded`
  or `cancelled`, with `user_id` unchanged and `resolved_at` set. A resolved row cannot move again. `user_id`
  cannot be re-pointed to another account. DELETE is always refused. The CHECK ties `resolved_at` to
  `status <> 'pending'`. `recordRefundOutcome` is one guarded `UPDATE … WHERE status = 'pending' RETURNING`, and
  the 20-way concurrency test passes.
- **IDOR.** The user list is filtered by `locals.user.id` and capped at 20. The account export filters
  `billing_refunds` by its `user_id` column.

### Re-claim

- **No raw address is stored.** Markers hold only the 43-character HMAC. There is no `user_id` column. Nothing new
  logs the address.
- **Key handling.** `keyBytes` takes exactly 32 bytes. An unset or malformed key gives `null`, and there is no
  default key. `_PREVIOUS` is checked on both claim paths. Markers are written under the current key only.
- **Race safety.** The `NOT EXISTS` guard sits inside the guarded insert itself: the starter grant in
  `plan-state.ts:167` and the voucher in `vouchers.ts:166-168`. The QA test with a stale pre-read shows that the
  guard alone decides.
- **Deletion.** Marker steps are guarded on `proof` and run before the user row is deleted, so
  `voucher_redemptions.user_id` is still set when it is read. Only one deletion path exists
  (`pengaturan/akun` › `deleteAccount`). Only one sign-up path exists (`daftar`). There is no e-mail change feature
  that could move a marker to another address.
- **Sweep.** One bounded delete (at most 500 rows, oldest first, after 730 days) in the jobs Worker, inside
  try/catch, with no key needed.

### Admin gate

- `ADMIN_ACCOUNT_IDS` is parsed like this: split on `,`, at most 20 raw entries, trim, lower-case, then a strict
  UUID regex. Empty entries, whitespace-only entries, newline-joined lists and e-mails are dropped. The gate fails
  closed.
- The own id comes from the session (`locals.user.id`) and must also be a UUID (`newId` is `crypto.randomUUID`).
  Entries are compared as SHA-256 hashes in constant time, and the loop does not stop at a match.
- No e-mail fallback: `ADMIN_EMAILS` and `isAdminEmail` are not read anywhere in `src` or `workers`. The only
  remaining mentions are in `.wrangler/tmp` build output and in the RUNBOOK's removal note.
- The 404 is raised before `setHeaders`, so it matches the root 404. A 200 response carries
  `cache-control: no-store`. The page has no `actions` export and no admin write.

### Migration 0030

- Both triggers are present. The backfill is `INSERT … SELECT … WHERE NOT EXISTS` and uses the unique
  `billing_event_id` index as a second guard, so a re-run adds nothing (tested).
- Indexes: `(status, created_at)` and `(user_id, created_at)` on refunds; the unique expression index
  `(email_hmac, kind, ifnull(voucher_id,''))` and `(created_at)` on markers. Lookups use the leading `email_hmac`
  column. Sweeps use `created_at`. `ON CONFLICT DO NOTHING` without a target covers the expression index.
- No applied migration is edited.

## Findings

### L1 (Low): address variants bypass the re-claim marker, though unverified sign-up already allows any fresh address

`src/lib/server/billing/claims.ts:364-377`, with `isPlausibleEmail` in `src/lib/server/auth/password.ts`. The PoC
showed that each of these addresses passes sign-up validation and keeps a canonical form that differs from
`ab@gmail.com`:

| Address | Kind of variant |
|---|---|
| `ａb@gmail.com` | fullwidth `ａ` |
| `аb@gmail.com` | Cyrillic `а` |
| `ab@gmail.com.` | trailing-dot FQDN, the same mailbox in DNS |
| `a.b@googlemail.com.` | trailing dot: the googlemail mapping and dot stripping are both skipped |

Exploit: delete the account, then sign up again with `ab@gmail.com.` to get 300 starter credits again.

Severity is Low because sign-up does not verify the address, so any never-used string gets the credits anyway.
The PRD accepts multi-account farming as residual. Suggested fix: apply NFKC and strip one trailing `.` from the
domain in `canonicalClaimEmail`. The real fix is e-mail verification before any claim, which is an owner decision.

- **Resolution (2026-10-13):** FIXED (the report's suggested fix) in `fix(billing): fold address variants, restart marker age on re-deletion, honest privacy copy` (bd1166a). `canonicalClaimEmail` caps and NFKC-folds the
  address and drops trailing dots from the domain, so `ａb@gmail.com`, `ab@gmail.com.` and `a.b@googlemail.com.` hit
  the `ab@gmail.com` marker. Test: `src/lib/server/billing/claims.test.ts` › "red team L1: fullwidth letters and a
  trailing dot on the domain count as the same address" (failed before). Cross-script lookalikes (Cyrillic `а`)
  stay distinct: ACCEPTED by owner decision (2026-10-13): e-mail verification comes later as its own feature, and it
  closes them.

### L2 (Low): oracle for a deleted account

Files: `src/lib/server/billing/plan-state.ts:167` and `src/lib/server/billing/vouchers.ts:676,696`. Sign-up does
not verify the address. Anyone can sign up with a victim's address while that address has no live account. A
starting balance of 0 instead of 300 shows that the address had a MONTRA account deleted in the last 730 days.
With a known voucher code, `already_redeemed` shows that the deleted account redeemed that code.

Live-account enumeration already exists through `emailTaken` (`accounts.ts:117`), so this adds little. The
privacy copy does not mention it. It is closed by the same e-mail verification as L1.

- **Resolution (2026-10-13):** ACCEPTED by owner decision (2026-10-13): e-mail verification before sign-up or any claim comes later
  as its own feature and closes this oracle; live-account enumeration through `emailTaken` already exists.

### L3 (Low): the privacy copy calls the marker "random"

`src/routes/(site)/site/[legal=legal]/content.ts:150` and `src/lib/shared/i18n-en.ts:187-188` say "sidik acak" /
"a random fingerprint". The marker is a deterministic keyed HMAC. Anyone holding `CLAIM_HASH_KEY` can test a
candidate address against it. Under UU PDP it is pseudonymous personal data, not random or anonymous data.

The copy also does not say that markers are kept for every redeemed voucher, shared codes included. Suggested
wording: "sidik satu arah (HMAC) dari alamat emailmu" / "a one-way keyed fingerprint".

- **Resolution (2026-10-13):** FIXED in `fix(billing): fold address variants, restart marker age on re-deletion, honest privacy copy` (bd1166a). The privacy section "Menghapus akun dan data" now says "sidik satu arah berkunci
  (HMAC)", names the starter credits and every voucher redeemed, says it is pseudonymised personal data, and counts
  2 years from the last deletion (English entry updated). Test: `src/routes/(site)/site/[legal=legal]/content.test.ts`
  › "L3: calls the marker a keyed one-way fingerprint (HMAC), never random, and names vouchers" (failed before).

### L4 (Low): fail-open when `CLAIM_HASH_KEY` is missing, and key rotation silently forgets markers

`src/lib/server/billing/claims.ts:388-400`. This behaviour is by design (PRD B.1, B.3). The admin page shows
"Belum dikonfigurasi", and the RUNBOOK says the key is required in production before a real provider. But no deploy
step or gate enforces it. A production deploy without the key silently grants every re-claim. Rotating without
`_PREVIOUS` forgets every marker. Suggested fix: add a release-checklist or deploy-time check.

- **Resolution (2026-10-13):** OWNER. Fail-open without the key is the PRD's design (B.1, B.3) and the admin page shows "Belum
  dikonfigurasi". `scripts/deploy-staging.ts` cannot see Worker secrets (they live in Cloudflare, not in its
  environment), so a deploy-time check would need an extra remote `wrangler secret list` step, not a trivial
  refusal. The owner must set `CLAIM_HASH_KEY` on staging and production before a real payment provider goes live (a
  credential; RUNBOOK already says so).

### L5 (Low): marker age counts from the first deletion

`src/lib/server/auth/delete-account.ts:149-178` uses INSERT OR IGNORE, so an existing marker keeps its
`created_at`. Exploit:

1. Delete the account at T0. This writes the starter marker.
2. Sign up again at T0+1y. The balance starts at 0.
3. Delete the account again. The marker is not refreshed.
4. At T0+730d the sweep removes the marker.
5. Sign up again to get 300 credits, only one year after the last deletion.

Severity is Low. The copy ("2 tahun setelah akun dihapus") is still not exceeded, which favours privacy. The abuse
window is two years.

- **Resolution (2026-10-13):** FIXED in `fix(billing): fold address variants, restart marker age on re-deletion, honest privacy copy` (bd1166a). Deleting the same address again first moves its existing markers' `created_at`
  to this deletion (one guarded UPDATE before the INSERT OR IGNORE), so the 730 days count from the last deletion.
  Test: `test/integration/billing-hardening.test.ts` › "red team L5: deleting the same address again restarts the
  marker’s 730 days" (failed before: the first deletion's time was kept).

### L6 (Low): privacy copy omits refund and billing rows kept after deletion

`billing_refunds` rows (amount, currency, provider reference, status) survive account deletion with `user_id`
NULL (`migrations/0030_billing_hardening.sql:45`; criterion 10). The rows from FN-30 billing that were already
kept before this change survive the same way. The privacy section "Menghapus akun dan data" says nothing about
payment records kept for refund or accounting. Suggested fix: add one sentence before a real provider ships.

- **Resolution (2026-10-13):** FIXED in `fix(billing): fold address variants, restart marker age on re-deletion, honest privacy copy` (bd1166a). The same privacy paragraph now says payment and refund records (amount, currency,
  provider reference, status) are kept without a link to the account, for refunds and bookkeeping. Test:
  `content.test.ts` › "L6: says payment and refund records are kept after deletion" (failed before).

## ENGINEERING_CHECKLIST

- Concurrent writes: guarded single statements; 20-way tests for refunds, markers and outcome.
- Bounded work: 100, 20 and 500 caps; no growing `inArray`.
- Migrations: new file only; backfill re-runnable; RUNBOOK updated.
- Money: integer `amount_minor` with currency; shown through `formatMoney`.
- WIB: dates use `formatDateTimeWib`.
- Privacy: no person data on either refund surface. Markers hold an HMAC only (see L3 for the copy).
- i18n: entries are present.
- Keyed lists: both lists are keyed by id.
- Fail-before proof: still missing (QA F2).
- Gates: not run (QA criterion 29).
