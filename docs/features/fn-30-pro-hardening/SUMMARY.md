# FN-30 Pro plan hardening before a real payment provider — summary

**Status: complete** (2026-10-10), on branch `feat/fn-30-pro-hardening`; not merged, not deployed. Risk tier Large.
PRD: `PRD.md` (15 owner decisions, defaults auto-accepted by owner instruction).

## Goal

Close the open FN-30 and FN-41 items before a real payment provider goes live: record refunds for
`paid_not_applied` payments, stop starter credits and per-user vouchers being re-claimed after delete + re-sign-up
(FN-30 red team L4), and gate the admin page by account id instead of an unverified e-mail (FN-41 red team L1).

## Built

- **Refunds (record only; MONTRA never moves money):** `billing_refunds`, one row per `paid_not_applied` payment,
  written in the same webhook batch, backfilled for existing rows. Status moves once from pending to refunded or
  cancelled (enforced by triggers); rows can't be deleted. The user sees them on `/pengaturan/paket` (no reference
  or id); the operator sees a read-only list on the admin page. `recordRefundOutcome` exists for a later operator
  or provider call; the provider interface gets no refund method.
- **Re-claim prevention:** `claim_markers` stores a keyed HMAC of the normalised address (`CLAIM_HASH_KEY`, plus
  `CLAIM_HASH_KEY_PREVIOUS` during rotation), the kind and a voucher id, with no raw e-mail and no user id.
  Markers are written when an account is deleted, checked inside the sign-up and voucher-redeem batches, and swept
  after 730 days by the jobs Worker (`billing/claim-sweep.ts`). Without the key, the protection is off and the admin
  page shows "Belum dikonfigurasi"; deletion is never blocked.
- **Admin gate:** `ADMIN_ACCOUNT_IDS` replaces `ADMIN_EMAILS`, with no e-mail fallback. Every refusal is the same 404,
  and the page is sent `no-store`. There are no admin writes ("Beri paket" is not built).
- **Privacy copy:** the privacy page now describes the re-claim markers. RUNBOOK documents the new secrets and how
  staging moves to `ADMIN_ACCOUNT_IDS`.
- **Not built:** FN-41 L4 (a re-seal job when rotating the sealing secret) stays open. It needs a runner that holds the
  sealing secrets, which the jobs Worker deliberately lacks.

## Migration

`migrations/0030_billing_hardening.sql` (+ `meta/0030_snapshot.json`, journal). **Number collision:**
`feat/fn-22-tanya` (`0030_tanya_messages`) and `feat/fn-19-forwarding` (`0030_email_forwarding`) also use 0030;
whichever merges later renumbers its file and regenerates `migrations/meta` before any staging apply.

## Files

44 files changed against `38c5f82`. New: `src/lib/server/billing/claims.ts`, `billing/claim-sweep.ts`,
`src/lib/shared/billing/refunds.ts`. Changed: webhook, refunds, vouchers, plan-state, accounts, delete-account,
admin, export tables, the daftar/akun/paket/admin routes, privacy content, i18n-en, jobs Worker. Tests added:
`test/integration/billing-hardening.test.ts`, `billing-hardening-qa.test.ts`, `migration-0030.test.ts`,
`test/admin-page.test.ts`, `claims.test.ts`, `refunds.test.ts`, plus an e2e admin-404 body check in `integrasi.spec.ts`.

## Verification

- Engineer cycle 1 (`ed30002`): gates run 1 EXIT 1 (real failure: export decisions for the new tables, fixed; 4
  timeouts under load), gates run 2 EXIT 0 (241 files / 3639 tests). Playwright paket, integrasi, accounts and site:
  65 passed, 6 skipped. Fail-before: removing the starter-grant guard and the webhook refund insert made 11/17
  billing-hardening tests fail.
- QA cycle 1 (`209a77e`): **PASS**, no product defect. Targeted Vitest 84 passed. The new e2e test
  "admin 404 body equals an unknown path's 404 body", rerun by the orchestrator: 3 passed.
- Red team cycle 1 (`ebd9e5a`): **PASS**, no Critical, High or Medium findings. Six Lows (L1–L6, see
  `SECURITY_REPORT.md`) are deferred to a TASKS.md item.
- Final orchestrator gates on `ebd9e5a`: check and lint passed; test 3639 passed, 3 failed in 2 files this change
  does not touch (`test/integration/net-worth.test.ts` 30 s timeout, `src/lib/ui/offline-queue/sync.test.ts`). The
  machine's load average was about 30–43, with two other pipelines running. `sync.test.ts` rerun alone: 15 passed.
  `net-worth.test.ts` also timed out when rerun alone (1/16) under the same load; its code is unchanged, so it is
  not verified clean. `npm run build` passed.

## Not verified

The real payment provider, refunds through a provider, and the staging secrets. The full e2e suite was not run.
A clean `net-worth.test.ts` run needs an idle machine.
