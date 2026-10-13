# QA report: fix-lows-services (bug-fix batch, 2026-10-13)

**Verdict: PASS.** Every gate step is clean, every FIX has its named test and the spot-checked ones fail on the pre-fix code, every ACCEPTED/OWNER rationale matches its finding, migration 0045 is safe. No FAIL finding. Four observations below, none blocking.

Branch `fix/lows-services`, 14 commits on main 5a486bc, worktree `<repo>-worktrees/lows-services`. Nothing committed. QA added one test file (see Added tests).

## Commands run

All local: Vitest uses local D1 (workerd/Miniflare) and AI/provider doubles, Playwright uses a local dev server and the mock checkout. No command hit a real provider (no real Anthropic, Google or payment call).

- `npm run check`: svelte-check 2299 FILES 0 ERRORS 0 WARNINGS, plus the three `tsc -p` projects clean; exit 0 (local, no provider).
- `npm run lint`: "All matched files use Prettier code style!" then eslint clean; exit 0 (local).
- `npm run build`: "site-adapter: 18 prerendered site files bundled into the Worker", "done"; exit 0 (local).
- Touched Vitest files, one at a time (25 files): all passed, e.g. `answer-guard.test.ts` 160 passed, `gmail.test.ts` 50 passed, `agen.test.ts` 49 passed, `agen.qa.test.ts` 9 passed, `streak-plus.test.ts` 25 passed, `beranda.test.ts` 33 passed, `cron.test.ts` 18 passed; exit 0 each (local D1, AI doubles).
- `npm run test` (once): Test Files 2 failed | 358 passed (360), Tests 4 failed | 5872 passed (5876); exit 1. The 4 failures are `test/integration/net-worth.test.ts` (2) and `test/integration/recurring.test.ts` (2), both untouched by this branch, all "Test timed out in 30000ms" under full-suite load (local D1).
- Rerun alone, once: `npx vitest run test/integration/net-worth.test.ts` Tests 16 passed (16), exit 0; `npx vitest run test/integration/recurring.test.ts` Tests 35 passed (35), exit 0. Flake, not a regression.
- `PATH=".../scratchpad/shim:$PATH" E2E_PORT=5413 npx playwright test --workers=1 e2e/photo-picker.spec.ts e2e/beranda.spec.ts e2e/agen.spec.ts e2e/anggaran.spec.ts e2e/kekayaan-halaman.spec.ts e2e/mata-uang-sen.spec.ts e2e/kotak-masuk.spec.ts`: 50 passed, 13 skipped (project-specific skips: phone-only specs on desktop and the reverse), 0 failed; exit 0 (local server, mock checkout). Includes the new hidden-amount checks (`kekayaan-halaman` phone 360 test no `%` in the chips; `beranda` eye test server HTML masked). Then `git checkout -- docs/features/*/shots`; `git status` shows only my added files.
- `FIN_PERSIST_TO=<scratch>/d1 npm run db:migrate:local` on a fresh dir: 0000 through `0045_lows_services.sql` all applied; exit 0 (local D1).
- Same command again: "No migrations to apply!"; exit 0 (no-op rerun).
- `npx drizzle-kit check`: "Everything's fine"; exit 0. `npx drizzle-kit generate`: "No schema changes, nothing to migrate" (schema.ts matches the migration; no file written).
- `node qa-lows/mig.mjs migrations` (my script, node:sqlite, foreign keys ON): 30 seeded `gmail_mail` rows across all statuses before and after 0045, `identical true`; the 5 indexes unchanged; `PRAGMA foreign_key_check` `[]`; `gmail_connections.ai_window_start/ai_reads` default 0/0; `agent_runs.deleted_at` present; `reason='ai_limit'` insert accepted, `'bogus'` rejected; a raw rerun of the file rebuilds the table again (31 rows, no leftover `__new_gmail_mail`) then stops harmlessly at `duplicate column name: deleted_at`.
- Pre-fix spot-check (`/scratchpad/qa-lows/prefix.sh`): restored 13 source files one group at a time to 5a486bc with the branch tests in place, ran the named test, restored with `git checkout HEAD --`. Every one failed (see table). `git status` afterwards clean apart from my added files.
- `npx vitest run src/lib/server/tanya/answer-guard.lows-qa.test.ts` (my test): Tests 12 passed (12); exit 0.

## Pre-fix failures (13 groups, need was 6)

| Finding | Source reverted | Failing test on old code |
|---|---|---|
| FN-19 forwarding L3 | `shared/text.ts` | text.test.ts L3 (other joiners, instalments) 1 failed |
| FN-22 S11/S12/FN-47 L4 | `tanya/answer-guard.ts` | answer-guard.test.ts, the S11 vectors ("letters after a figure", perak, rb, jt, noceng, mil ...) failed |
| FN-30 L1 | `billing/claims.ts` | claims.test.ts fullwidth + trailing dot 1 failed |
| FN-30 L5 | `auth/delete-account.ts` | billing-hardening.test.ts "restarts the marker's 730 days" 1 failed |
| FN-19 Gmail L5, L6 | `gmail/read.ts` | gmail.test.ts L6 cap, L5 never verified: 2 failed |
| FN-19 Gmail L7 | `gmail/token.ts` | gmail.test.ts L7 re-seal 1 failed |
| FN-34b L2 | `notifications/triggers.ts` | streak-plus.test.ts "closed before the push" 1 failed |
| FN-20 L2 | `merchants/resolve.ts` | merchants-redteam.test.ts L2 suggestion only 1 failed |
| FN-25b L1 | `kit/HeroAmount.svelte` | HeroAmount.test.ts cookie mask 1 failed |
| FN-25b L2 | `TrendChart` + `AllocationBar` | wealth-ui.test.ts 2 failed |
| FN-23 S5 | `agent/render.ts` | render.test.ts CSP hash 1 failed |
| FN-47 budgets no-JS | `budgets/actions.ts` | beranda.test.ts "refuses a ... amount ..." 4 failed |
| FN-23 S2 | `agent/repo.ts` | agen.qa.test.ts S2 create-delete loop (plus 7 others that touch the new column) failed |

Not reverted (their tests fail trivially on old code through a missing export, or they are e2e): `narrate.ts` (narrativeHasLure), `picker-mode.ts` (dropDecision), `schedule.ts`/`cron.ts` (FN-34b L1, `usersDueCloseReminder`), `releaseResend` (FN-23 S3). Their tests exist and pass.

## Checked criteria (per finding)

| Finding | Kind | Verdict | Evidence |
|---|---|---|---|
| FN-13b follow-ups (iOS standalone checkout return) | OWNER | PASS | Depends on the provider return flow (Xendit or Midtrans, an owner decision) and a real iPhone; nothing leaks (no session, sign-in asked). Matches the PRD. |
| FN-13b LOW-2 demo password | ACCEPTED | PASS | `.local` account behind the local-only guard; the report says "Nothing to do". |
| FN-19 fwd L3 card mask | FIXED | PASS | text.test.ts L3; fails pre-fix; `Rp150.000*12` stays, `1,250,000.00` stays. |
| FN-19 fwd L4 daily cap | ACCEPTED | PASS | Report itself calls it "deferred, low acceptable"; needs the 128-bit secret, rotatable; 60/hour cap; table rebuild for little. Gmail got the cap instead. |
| FN-19 Gmail L5 never verified | OWNER decision applied | PASS | gmail.test.ts L5; `read.ts` sets `unverified` always; `GMAIL_AUTHSERV_ID` removed from jobs env, RUNBOOK, SELF_HOSTING, `.dev.vars.example`. |
| FN-19 Gmail L6 AI-read cap | FIXED | PASS | gmail.test.ts L6 (cap, no AI call, "Baca ulang" re-queues) and "window resets after 24 h, 20 concurrent claims never pass the cap". `claimAiRead` is one guarded UPDATE, and runs only on the AI path (after the deterministic parsers, gateway and key checks): bank-QRIS/e-wallet mails never count. Normal mailbox unaffected. |
| FN-19 Gmail L7 re-seal | FIXED | PASS | gmail.test.ts L7; guarded on nonce, `updated_at` untouched, best effort. |
| FN-20 L2 AI name | OWNER decision applied | PASS | merchants-redteam L2; kotak-masuk-routes "Pakai nama" test: offered, title unchanged, stale version 409, other user 404, posted title ignored, server re-resolves; typing chip stays tap-to-apply. English entries exist. |
| FN-20 L4 fixed window | ACCEPTED | PASS | Report's first option (accept, document). Note below on the FN-50 wording. |
| FN-22 S11/S12/L4 (lookalikes, re-signed, spaced codes) | FIXED | PASS | answer-guard.test.ts 160 passed, 30 new vectors dropped; ordinary-prose sets (`.qa.test.ts` and the new "keeps ordinary prose") still pass; my 10 extra ordinary answers pass. |
| FN-22 brackets / hyphen between figures | ACCEPTED | PASS | The QA set uses `Indomaret ({A})` and `{A}-{B}` (`answer-guard.qa.test.ts` OK list), still passing. |
| FN-22 multi-line, small-number allowance | ACCEPTED | PASS | Matches the reports ("designed allowance"; `pre-line` shows lines apart, no `Rp` possible). |
| FN-23 S1 lure text | FIXED | PASS | narrate.test.ts narrativeHasLure; agen.test.ts PoC text dropped, report stays complete. |
| FN-23 S2 Hapus frees caps | FIXED | PASS | agen.qa.test.ts S2 (6th create refused); tombstone is contentless, never listed or downloadable (`isNull(deletedAt)` in list and ready); `live` cap ignores tombstones so a normal user is not locked out of slots; run older than 24 h deleted outright. |
| FN-23 S3 re-send | FIXED | PASS | agen.test.ts S3. |
| FN-23 S4 polling | FIXED | PASS | agen.test.ts `/agen/status` (404 signed out, 403 off plan, own runs only); e2e `agen.spec.ts` (phone, desktop, no-JS) passed. |
| FN-23 S5 CSP meta | FIXED | PASS | render.test.ts recomputes the style hash; no `unsafe-inline`. |
| FN-23 S6 removed-member rows | ACCEPTED | PASS | PRD decision 6 as `tanya_messages`; live-membership checks end access at once. |
| FN-23 S7 hapus off plan | OWNER | PASS | PRD AC 1 says every action is refused off the plan; changing it is an owner decision. Rationale matches. |
| FN-25b L1 flash | FIXED | PASS | HeroAmount.test.ts, amount-visibility.test.ts, `beranda.spec.ts` (server HTML masked). Root layout resets the shared state per render, so one request's choice never reaches another; cookie `SameSite=Lax`, `Secure` on https, display only. |
| FN-25b L2 trend/allocation | OWNER decision applied | PASS | wealth-ui.test.ts (2); `kekayaan-halaman.spec.ts` no `%`. |
| FN-30 L1 address variants | FIXED | PASS | claims.test.ts; Cyrillic lookalikes ACCEPTED until e-mail verification (owner). |
| FN-30 L2 oracle | ACCEPTED | PASS | Owner decision; e-mail verification closes it; live-account enumeration already exists. |
| FN-30 L3 privacy copy | FIXED | PASS | content.test.ts L3; English entry updated. |
| FN-30 L4 `CLAIM_HASH_KEY` fail-open | OWNER | PASS | Fail-open is the PRD design; `deploy-staging.ts` cannot see Worker secrets. |
| FN-30 L5 marker age | FIXED | PASS | billing-hardening.test.ts L5. |
| FN-30 L6 payment records copy | FIXED | PASS | content.test.ts L6. |
| FN-34b L1 rotation | FIXED | PASS | streak-plus.test.ts L1 and the updated default-20:00 and turned-off tests; `cron.test.ts` 18 passed. Normal users still get the one 20:00 reminder per day. |
| FN-34b L2 closed-day push | FIXED | PASS | streak-plus.test.ts L2 (fails pre-fix). |
| FN-45 required picker, novalidate | ACCEPTED | PASS | Server refuses a missing photo as before; PRD AC 15 reworded. |
| FN-45 drops (non-photo, several files, busy) | FIXED | PASS | picker-mode.test.ts (10), `photo-picker.spec.ts` PDF drop and two-photo drop passed; phone camera/gallery specs passed. |
| FN-47 follow-ups (queue copy, net-worth hint, budgets no-JS, xlsx flake) | FIXED | PASS | view.test.ts, NetWorthItemForm.test.ts, BudgetForm.test.ts, beranda.test.ts (4 fail pre-fix); `anggaran.spec.ts` no-JS and `mata-uang-sen.spec.ts` passed; xlsx-cpu.test.ts 19 passed (a flake has no fail-before run). |
| FN-47 L4 spaced currency codes | FIXED | PASS | answer-guard.test.ts (R M B, C N Y, U S D). |
| FN-51 shifted "Abaikan" | ACCEPTED | PASS | Needs a second tap on "Ya, abaikan"; discards nothing on a mis-tap. |
| FN-51 interactive during motion | ACCEPTED | PASS | Matches the report ("No action needed"). |
| Migration 0045 | | PASS | See commands: fresh 0000-0045, no-op rerun, rows and indexes kept, FK check empty, drizzle check fine, no schema drift. |

Other checks from the QA brief:

- Server-side authorization on new endpoints: `/agen/status` (404 signed out, 403 off plan, own runs in the current space only, live membership in the same statement); `useName` (current space scope, other user 404, `renameDraft` guarded on `isLiveMember` and `updated_at`).
- Money and dates: no new money arithmetic; the Gmail window and agent tombstone use UTC ms (`created_at` + 24 h), not calendar buckets.
- Captured data shows source and review state: Gmail captures are always `unverified` with the review flag.
- Indonesian strings have English entries: "Nama draf diganti.", "Pakai nama {nama}", "Perkiraanmu sendiri, boleh dengan sen.", "Batas baca AI harian Gmail tercapai. Baca ulang besok.", the privacy paragraph; the i18n coverage test passes in the full run.
- Loading/empty/error states: "Pakai nama" button shows "Memproses…" and `done`/error banners; the Gmail `ai_limit` reason shows on the settings page.
- Checklist (`docs/ENGINEERING_CHECKLIST.md`): json_each used for the new id lists (`REREAD_REASONS`, `releaseResend`); concurrent claims are one guarded statement with a concurrency test; migration re-runnable with RUNBOOK bookmark note; no new CSP `unsafe-inline`; no violated item found.

## Added tests

- `src/lib/server/tanya/answer-guard.lows-qa.test.ts` (new, 12 tests, all pass): ten ordinary Indonesian/English answers still return prose under the tightened guard, plus a recorded behaviour for observation 1 below.

## Findings

No FAIL. Observations for the record:

1. **S12 now refuses "kurang {angka}" and "minus {angka}"** (`Kamu kurang {1} lagi dari anggaran.`, `Saldo minus {1} bulan ini.`): the answer drops to figures-only. This is the safe fallback and is what the fix intends for sign words, but "kurang Rp ... lagi" is common Indonesian, so a normal user may see figures-only more often for shortfall questions. Pinned by the new QA test. Pre-existing and unchanged: a `Q3 2026` token also drops prose (same on 5a486bc).
2. **A Gmail look-back scan on a very busy mailbox could use the 200 AI reads/day** if many payment-like mails have no deterministic parser. Over the cap they become `unreadable/ai_limit`, say so on the settings page, and "Baca ulang yang tertunda" re-queues them. A normal mailbox (bank/e-wallet mails parsed by rule) never touches the cap.
3. **FN-20 L4 rationale is stale on one point**: it says `auth/throttle.ts` "belongs to the FN-50 passkeys work", but FN-50 is already on main (0be8711, migration 0044). The ACCEPTED decision still matches the report's first option; only the sentence could be reworded.
4. **Cosmetic**: the doc comment above `requeueRereadable` in `src/lib/server/gmail/repo.ts` has one line without the ` * ` prefix (valid code, Prettier and eslint pass).

Flake note: `net-worth.test.ts` and `recurring.test.ts` time out only under full-suite load; both pass alone.

Missing credentials or untested integrations: real Anthropic (AI reads), real Google OAuth/Gmail, real push and a real iPhone for the FN-13b follow-up were not exercised; all AI/provider paths ran on doubles.

## Resolution (cycle 2, 2026-10-13)

In `fix(lows): cycle 2: masking, guard and lure normalisation, Gmail re-seal sweep, sliding AI cap, page-level amount mask`:

1. "kurang [[f]] lagi" stays prose now (a shortfall, still the positive server figure); "kurang [[f]]" alone and
   "minus [[f]]" still fall back to figures only. `answer-guard.lows-qa.test.ts` pins both.
2. Unchanged (accepted): the 200 AI reads per connection per day; over it a mail is `ai_limit` and can be re-read.
3. FN-20 L4: FN-50's sliding counter is on main, so the merchant AI cap now slides over the hour (FIXED; the
   resolution note in `fn-20-merchants/SECURITY_REPORT.md` is rewritten).
4. The ` * ` prefix above `requeueRereadable` is restored.


## Cycle 2 (final re-check, HEAD ec73820 on main 22191cd)

**Verdict: PASS.** N1 to N5, FN-20 L4 (sliding hour) and cycle-1 observations 1, 3 and 4 are verified. Every new test fails on the parent commit's source (HEAD~1) and passes now. No FAIL finding.

### Commands run (cycle 2)

All local: Vitest uses local D1 and AI/provider doubles; Playwright uses a local dev server and the mock checkout. No real provider was hit.

- `npm run check`: svelte-check 2302 FILES 0 ERRORS 0 WARNINGS and the three `tsc -p` projects clean; exit 0.
- `npm run lint`: Prettier "All matched files use Prettier code style!" then eslint clean; exit 0. (My two new files were also checked with `npx eslint` and `prettier --write`.)
- Touched Vitest files, one at a time, all passed: `narrate.test.ts` 26, `answer-guard.lows-qa.test.ts` 12, `answer-guard.test.ts` 180, `answer-guard.qa.test.ts` 33, `text.test.ts` 25, `HeroAmount.test.ts` 5, `gmail.test.ts` 51, `merchants-redteam.test.ts` 10, `merchants.test.ts` 26, `sign-in.test.ts` 13, `fix-lows-imports.qa.test.ts` 3; exit 0 each.
- `FIN_PERSIST_TO=<scratch>/d1c2 npm run db:migrate:local` on a fresh dir: 0000 to `0045_lows_services.sql` all applied; exit 0. Run again: "No migrations to apply!"; exit 0. (Cycle 2 changed no schema or migration.)
- `npm run test` (once): Test Files 363 passed (363), Tests 5984 passed (5984); exit 0. No flake this time, so no rerun was needed.
- `PATH="<shim>:$PATH" E2E_PORT=5413 npx playwright test --workers=1 e2e/beranda.spec.ts e2e/kekayaan-halaman.spec.ts e2e/anggaran.spec.ts e2e/dompet.spec.ts e2e/laporan.spec.ts e2e/kotak-masuk.spec.ts e2e/agen.spec.ts e2e/hidden-amounts.qa.spec.ts`: 39 passed, 4 skipped (project-specific), 2 failed. The 2 failures were only my new `hidden-amounts.qa.spec.ts`, whose precondition was wrong (it looked for `25.000` on Dompet, which prints the `75.000` balance). There is no `e2e/dompet.spec.ts` in the repo, so Dompet is covered by my spec only. After fixing my spec: `npx playwright test --workers=1 e2e/hidden-amounts.qa.spec.ts` 3 passed (setup, phone, desktop); exit 0. `git checkout -- docs/features/*/shots` after each run.
- Pre-fix spot-check (`prefix2.sh`: source files restored to HEAD~1 with the branch tests kept, then restored): see table. `git status` afterwards shows no source change.

### Pre-fix failures (cycle 2)

| Finding | Source reverted to HEAD~1 | Result on old code |
|---|---|---|
| N1 masking | `shared/text.ts` | `text.test.ts` cycle 2 tests fail (10-digit account with `,NN`, card with `,00`, joiners `  `, `·`, `‒`, `―`, `・`, `~`, `+`, `|`, ` _ `); my `text.lows-qa.test.ts` 5 failed, 10 passed |
| N2 guard | `tanya/answer-guard.ts` | `answer-guard.test.ts` cycle 2 vectors fail (`R–p`, `R—p`, `I.D.R`, `U.S.D.`, `r b`, `j t`, `r.b.`, `l OOO OOO`, `SOO OOO`, `lOOOOOO`, ...) |
| N3 lure | `agent/narrate.ts` | `narrate.test.ts` cycle 2 fails (`montra-bantuan .com`, `(.)`, `[.]`, `.cöm`, `titik com`, `dot com`, `kata-sandi`, `katasandi`, `sandi`, `passcode`) |
| N4 re-seal sweep | `gmail/token.ts` | `gmail.test.ts` "N4 (cycle 2)" fails (no `resealGmailTokens`) |
| FN-20 L4 sliding hour | `merchants/resolve.ts` | `merchants-redteam.test.ts` "L4 (cycle 2)" fails (the next-clock-hour call was allowed) |
| N5 page-level mask | `laporan/+page.svelte` (unit); five route pages (e2e) | `HeroAmount.test.ts` "every route page ... applies the choice" fails; my `hidden-amounts.qa.spec.ts` fails with `Expected: false, Received: true` (a figure in the server HTML despite the cookie) |

### Checked criteria (cycle 2)

| Item | Verdict | Evidence |
|---|---|---|
| N1 masking: account glued to `,NN`, double space and extra joiners | PASS | `text.test.ts` "maskAccountNumbers cycle 2 (red team N1)" (25 tests pass) and my `text.lows-qa.test.ts` (15 pass): `Rek 1234567890,12` shows `••••9012` (4 digits at most), `4111 1111 1111 1111,00` shows `••••1100`, `4111  1111  1111  4321`, `·`, `~` joined cards masked to `4321`. |
| Legitimate amounts still readable | PASS | My test: `Rp 1.234.567,89`, `Saldo Rp1.234.567,89 hari ini`, `1.234.567,89`, `IDR 1234567,89`, `Rp 12345678,90`, `1,234,567.89 USD`, `Rp 25.000,00 pada 2026-10-13 pukul 18:05`, `Cicilan Rp150.000*12`, `Transfer Rp 10.000.000` all come out unchanged. |
| N2 guard variants refused | PASS | `answer-guard.test.ts` 180 pass. |
| Ordinary Tanya answers still pass | PASS | `answer-guard.qa.test.ts` OK lists (33), the "keeps ordinary prose" set, and my 10 ordinary answers (`answer-guard.lows-qa.test.ts` 12 pass). Observation 1 resolved: "Kamu kurang {1} lagi dari anggaran." stays prose (engineer changed my expectation, in line with the finding that it is a positive server figure); "Saldo minus {1}" still falls back to figures only. |
| N3 lure variants | PASS | `narrate.test.ts` 26 pass; the cycle-1 PoC and the new spellings are skipped. |
| N4 hourly re-seal sweep | PASS | Wired in the jobs Worker's scheduled handler (`workers/jobs/src/index.ts`, after `sweepGmail`, inside its own try/catch, logged as a count `gmailResealed`; one batch of 100 per tick). Idempotent: the test loops until 0, then a further call returns 0; the update is guarded on the nonce, rows already under the current key are not selected (`token_key_id <> current`), an unopenable token is left alone, and nothing calls Google. Paused, needs-reconnect and checks-off connections are covered and still open with only the current key. RUNBOOK rotation note updated (no row with the old `token_key_id` and 7 days). |
| FN-20 L4 sliding hour | PASS | `merchants-redteam.test.ts` L4: 20 calls at 10:59:30 UTC+7 leave none one minute later; the budget is back after 62 minutes. `merchants.test.ts` 26 pass. |
| 10-minute statement upload throttle unchanged | PASS | `windowMs` defaults to `THROTTLE_WINDOW_MS` (10 min); `sign-in.test.ts` (13, incl. "overUserSlidingLimit (FN-16a red team L5)") and `fix-lows-imports.qa.test.ts` (3, burst of 30 per 10 min) pass; `/impor` callers pass no window. The cleanup bound became 61 minutes so the 60-minute window's older bucket is kept. |
| N5 hidden amounts on all six hero pages | PASS | `HeroAmount.test.ts` greps `src/routes` for `<HeroAmount` / `<NetWorthSection` and requires `applyAmountsHiddenAtLoad();`: Beranda, Dompet, Laporan, Anggaran, Kekayaan and `dev/ui` all have it; the harness test masks a figure placed before the hero. My e2e `hidden-amounts.qa.spec.ts`: with the `montra-amounts-hidden` cookie the server HTML of `/`, `/dompet`, `/laporan`, `/anggaran`, `/kekayaan` has no `25.000` or `75.000`, `/riwayat` still prints the amount; fails when the five pages are reverted. `beranda.spec.ts` and `kekayaan-halaman.spec.ts` pass. |
| Normal flows unchanged | PASS | `anggaran`, `laporan`, `kotak-masuk` and `agen` e2e specs passed (phone and desktop). |
| Cycle-1 observation 3 (stale FN-50 wording) | PASS | The FN-20 L4 note is now FIXED (sliding window); `throttle.ts` change is the optional `windowMs` argument only. |
| Cycle-1 observation 4 (doc comment) | PASS | `requeueRereadable` comment reformatted in `gmail/repo.ts`. |
| Cycle-1 observation 2 (Gmail look-back and the 200/day cap) | Unchanged | Still a fixed 24-hour window by design (SECURITY_REPORT "Accepted fixed window"); over-cap mails are `ai_limit` and re-queueable. |

### Added tests (cycle 2)

- `src/lib/shared/text.lows-qa.test.ts` (new, 15 tests, pass): legitimate amounts stay readable, accounts and cards show at most 4 digits.
- `e2e/hidden-amounts.qa.spec.ts` (new, phone and desktop pass): server HTML of five hero pages is masked with the cookie.

### Findings (cycle 2)

None. Notes: (1) `docs/features/fix-lows-services/SECURITY_REPORT.md` shows as modified in this worktree; I did not touch it (red team). (2) No `e2e/dompet.spec.ts` exists, so Dompet's hidden-amount path is covered only by the new QA spec.
