# QA report: fn-19b-gmail-followups (cycle 1, commit fb8939a on main a19d832)

**Verdict: PASS** (no criterion fails; 4 non-blocking findings below). Everything below ran against fakes, the fake
Google, the fake Anthropic and a local D1. Nothing real-Google is verified (see "Unverified").

## Commands run
- `npm run gates` (check, lint, test, build): exit 0; svelte-check `0 ERRORS 0 WARNINGS`; prettier clean; vitest `Test Files 403 passed (403)`, `Tests 6760 passed (6760)`; build ok. Fake/local only.
- `FIN_PERSIST_TO=<fresh dir> npm run db:migrate:local` on an empty local D1: `0050_gmail_followups.sql ✅` (all 0001-0050 applied). Local only.
- same command again: `✅ No migrations to apply!` (no-op rerun). Local only.
- `npx playwright test e2e/gmail-review.spec.ts e2e/gmail.spec.ts e2e/notifikasi.spec.ts --workers=1`: `19 passed (34.2s)` (phone + desktop + setup). Fake Google, no real provider.
- No QA tests added: every criterion already has a covering test (map below). No commit by QA.

## Acceptance criteria
| # | Result | Evidence (test file : test name) |
|---|---|---|
| 1 | PASS | gmail-followups.test.ts "an hourly capture makes one notification and one send_push" |
| 2 | PASS | same test (redelivered read makes none) |
| 3 | PASS | "a look-back and a Baca ulang re-read never notify" |
| 4 | PASS | "7 captures in one WIB day: 5 singles, then one group counting the rest (pushed once)"; "20 concurrent captures" |
| 5 | PASS | "kind turned off ... quiet hours and no VAPID keys: row only"; e2e notifikasi.spec.ts prefs |
| 6 | PASS | same test ("gone" after discard / left space); deliverPush gone check read in triggers.ts |
| 7 | PASS | notifications-gmail.test.ts (parseParams refuses mail fields, texts ID+EN, formatMoney); i18n test in gates |
| 8 | PASS | "off by default: captures stay drafts"; existing gmail.test.ts unchanged except 1 line |
| 9 | PASS | "on, with a confirmed domain: one transaction in the wallet, the draft a tombstone ..." |
| 10 | PASS | 14 per-rule tests under "each rule alone keeps the capture a draft" (AI, fixture/unknown domain, income, cap, duplicate, no category, look-back, 21st/day + 00:00 roll, wallet deleted/non-IDR, switched off, needs_reconnect, owner left); guards read in autosave.ts |
| 11 | PASS | "20 concurrent eligible captures past the cap: exactly 20 saved" |
| 12 | PASS | "the space is at its transaction cap: stays a draft, without the wallet, no error" |
| 13 | PASS | "setAutoSave refuses another space's, a deleted and a non-IDR wallet, a non-member and a stale form; success persists" |
| 14 | PASS | "a 23:30 WIB month-end mail is saved on that WIB date"; counter-roll test; review.test.ts WIB grouping |
| 15 | PASS | "groups per day and scan; states and the day total match the database"; review.test.ts; e2e gmail-review "grouped per day and check" |
| 16 | PASS | "signed out redirects; not connected and a failed load show their states"; e2e "empty and not connected states"; ErrorState retry in +page.svelte |
| 17 | PASS | "undo a scan: pending drafts and unedited saved transactions go, an edited one stays and is counted; balances reconcile; never recreated" |
| 18 | PASS | same + "undo racing a save in another tab" + 409 "Sudah diurungkan" action |
| 19 | PASS | "another user, a removed member and another space get 404 and no rows" |
| 20 | PASS | review.test.ts gmailMessageUrl; e2e asserts `rel="noopener noreferrer"` |
| 21 | PASS | "disconnect deletes the scans (undo state included); saved transactions stay"; migration-0050.test.ts FK SET NULL on `auto_save_wallet_id` |
| 22 | PASS | sender-domains.test.ts "the shipped registry (AC 22)" (empty, host rules, fixture never confirmed); e2e auto-save "belum ada" text |
| 23 | PASS | sender-domains.test.ts parserFor: registry/fixture resolve, look-alikes, shape mismatch reads nothing |
| 24 | PASS | sender-domains.test.ts "30 domains of the longest allowed length stay under GMAIL_QUERY_MAX" |
| 25 | PASS | migration-0050.test.ts (rows, ids, seq, indexes kept; gmail_payment accepted; unknown kind refused; auto_save defaults 0; re-run stops harmlessly); fresh-DB apply and no-op rerun run by QA |
| 26 | PASS | i18n parity test (gates); e2e focus-back after undo dialog; keyed each by id in +page.svelte. Touch targets/heading order not measured by a coarse-pointer test (code review only) |
| 27 | PASS | integer minor units in autosave.ts, review.ts, triggers.ts; logs carry error names only |
| 28 | PASS (gates) | gates clean. "Each regression test shown failing on unfixed code" not re-proven by QA (engineer claim) |

Owner answers 2026-10-28: 1-4 (off by default, opt-in wallet, deterministic, expense only, Rp 5.000.000 / 20 per day) PASS (AC 8-11);
5-6 (default-on pref, merchant+amount text, 5/day then group, hourly only, quiet hours) PASS (AC 1-7);
8 (registry ships empty, no domain invented) PASS (`SENDER_DOMAINS = []`); 9 (history.list deferred) PASS (not in diff);
7, 10, 11 defaults (7-day window, Simpan semua included, 90-day retention) PASS with finding F1 for 10.

## Engineer deviations judged
1. Extra columns `auto_save_day`, `auto_saves`: ACCEPTABLE. Needed for a race-safe cap (AC 11 proven). A slot used by a refused save is not returned: safe (cap stays an upper bound; extra captures stay drafts). Migration 0050 and snapshot include them.
2. `GMAIL_QUERY_MAX` 1000 to 2000, entries capped at 40 chars: ACCEPTABLE. The guard is our own, AC 24 requires 30 domains to fit; the registry rule test enforces the 40-char cap.
3. Registry domains OR'd into `from:`: ACCEPTABLE. PRD says name words "stay as the wide net"; AND would narrow it. Registry is empty, so the query is unchanged today.
4. Chip "Dari Gmail" on every Gmail row, none on detail: ACCEPTABLE. `source='gmail'` also covers drafts the user saved by hand, so "(otomatis)" would be false. PRD allows "list/detail". See F3.
5. "Simpan semua" without bulk wallet/category: ACCEPTABLE AS BUILT, but weaker than PRD text. See F1.
6. "Baca ulang" flag on the queue message: ACCEPTABLE with note F2.

## Findings (non-blocking)
- F1 (medium, scope gap): PRD C says "Simpan semua yang lengkap" reuses `setDraftsWallet`/`setDraftsCategory` with the user's choices. Built: only `saveDrafts`. Gmail drafts are captured with `wallet_id` null, so on a fresh look-back the button saves 0 and reports all as "belum lengkap" until the user sets wallets in Kotak masuk. Honest and safe, but owner decision 10 is nearly hollow. Suggest a wallet picker on the scan or owner confirmation of the weaker behaviour.
- F2 (low): `reread` lives only on the queue message. If the Baca ulang enqueue fails (the action's own catch path: "the sweep enqueues them within the hour") the sweep re-sends without the flag; if that scan is `hourly` the read can push once and, if every auto-save rule holds, auto-save. AC 3 holds on the normal path. Persisting the flag on the ledger row would close it.
- F3 (low): no "Dari Gmail" chip on the transaction detail/edit page (list only).
- F4 (low): the screen groups by scan id, so several hourly scans of one day show as separate groups with the same label "Pemeriksaan otomatis <date>", each with its own undo, not one collapsed group as PRD C reads. Undo semantics are per scan as specified.

## Unverified (needs owner's Google setup)
Real Gmail mailbox and real bank mail; real sender domains and real parser output (registry empty by design); real web push on a phone; "Buka di Gmail" deep link in the Gmail app; `/privasi` wording. Fixtures and fakes do not count as a working capture path.

## Engineering checklist
No violated item found in the diff review (guarded single statements, session-scoped authorization, throttles `gmail-undo`/`gmail-autosave-setting` added, form-body guard used, counts-only logs). Not exhaustively walked line by line.

---

# Cycle 2 (fix commit 633085f on fb8939a)

**Verdict: PASS.** Every PRD criterion still holds; F1, F2, F3 verified fixed; F4 left open is acceptable.

## Commands run (cycle 2)
- `npm run gates`: exit 0; svelte-check `0 ERRORS 0 WARNINGS`; prettier clean; vitest `Test Files 403 passed (403)`, `Tests 6774 passed (6774)` (cycle 1: 6760); build ok. Fake/local only.
- `FIN_PERSIST_TO=<fresh dir> npm run db:migrate:local` (fresh local D1): `0050_gmail_followups.sql ✅` (now includes `gmail_mail.reread_at`). Local only.
- same command again: `✅ No migrations to apply!`.
- `npx playwright test e2e/gmail-review.spec.ts e2e/gmail.spec.ts e2e/notifikasi.spec.ts --workers=1`: `21 passed (39.0s)` (includes QA's added edit-page assertion). Fake Google.
- QA added one assertion to the engineer's e2e (see F3) and committed it as `wip(fn-19b-gmail-followups): qa cycle 2`.

## Criteria 1-28
Unchanged PASS. The cycle-2 diff touched criteria 1-7 (push text, `reread`), 9-11 (auto-save rule 8), 22-25 (migration) and 16-19 (review/save), and their tests were re-run in the gates (6774 pass):
- 1-3: `reread` message flag removed; a re-read is now `gmail_mail.reread_at` (set by `requeueRereadable`, read in `processGmailRead`). Test "reread" asserts `reread_at` is set and no notification; a sweep re-send is covered because the mark is on the row, not the message. AC 3 PASS.
- 7: params now allow `merchant`/`amountMinor` null (generic notice); `parseParams` still refuses any other shape; no sender/subject/Gmail id in params. PASS (notifications-gmail.test.ts "a generic notice names nothing").
- 9/10: new rule `senderAuthenticated` (topmost `mx.google.com` Authentication-Results, DMARC pass with `header.from` = domain, aligned DKIM). Tests "red team M1" (one per failing variant: stays a draft, no claim counted) and one positive case (saved). The positive path is the only way AC 9 passes now; it still passes. Mail headers are read in memory only, nothing stored.
- 25: migration test updated for `reread_at` (null for old rows); fresh apply and no-op rerun by QA.

## Previous findings
- F1 FIXED: "Simpan semua yang lengkap" now has a wallet picker and an expense-category picker ("Biarkan" default), applied through `setDraftsWallet`/`setDraftsCategory` (only to drafts without one; IDR wallet, expense category) and then `saveDrafts`; stale/invalid wallet or category answer 409/400. Evidence: gmail-followups.test.ts "QA F1 ... fills the chosen wallet and expense category ... then saves the complete ones"; e2e "look-back: Simpan semua yang lengkap with a wallet and a category saves the fresh drafts" (2 saved, rows "Dari Gmail" in Riwayat, button height >= 44).
- F2 FIXED: see criteria 1-3 (`reread_at`, migration 0050, no queue flag).
- F3 FIXED: edit page shows the "Dari Gmail" tag (`fromGmail` from `source === 'gmail'`). Evidence: the engineer had no test for it; QA added `expect(page.getByText('Dari Gmail')).toBeVisible()` on `/riwayat/<id>/edit` to the F1 e2e: passes on phone and desktop.
- F4 OPEN, ACCEPTABLE: several hourly scans of one day still appear as separate groups with the same label. Undo is per scan by PRD ("Urungkan pemindaian"), so collapsing groups would hide which scan an undo hits. No criterion requires collapsing; data is correct and the label includes the date. Cosmetic only.

## Red-team items checked
- M1 PASS (above). L1 PASS: a non-deterministic capture or unconfirmed sender gets title "Pembayaran baru dari Gmail" with body "Tersimpan otomatis"/"Perlu ditinjau"; tests "red team L1" (generic) and confirmed sender keeps merchant+amount; English entries present (i18n parity test in gates). L2 PASS. L3 PASS: notify toggle uses the `gmail-autosave-setting` throttle and a version check (409 on stale or malformed), test "red team L3".

## New findings (non-blocking)
- F5 (informational, owner decision): L1 means that while the registry is empty (now, until samples arrive) every Gmail push is generic ("Pembayaran baru dari Gmail"), because no sender is confirmed. Owner answer 5 ("merchant and amount shown") therefore applies only to confirmed senders. This is the safer reading of the red-team finding; tell the owner so the lock-screen text is not a surprise.
- F6 (low): the notify toggle shares the `gmail-autosave-setting` throttle bucket with the auto-save setting (10 per window combined). Harmless.

## Unverified (unchanged)
Real Gmail mailbox and real bank mail; real DMARC/DKIM headers (tests use fake `Authentication-Results`); real sender domains and parser output; real web push; "Buka di Gmail" deep link in the Gmail app; `/privasi` wording.

---

# Cycle 3 (fix commit 32a2ef8 on 9df7046)

**Verdict: PASS.** Every PRD criterion still holds; F6 fixed; M2 and L4 verified; forwarding/inbound behaviour unchanged.

## Commands run (cycle 3)
- `npm run gates`: exit 0; svelte-check `0 ERRORS 0 WARNINGS`; prettier clean; vitest `Test Files 404 passed (404)`, `Tests 6795 passed (6795)` (cycle 2: 6774); build ok. Fake/local only.
- `FIN_PERSIST_TO=<fresh dir> npm run db:migrate:local`: `0050_gmail_followups.sql ✅` (migration unchanged since cycle 2). Rerun: `✅ No migrations to apply!`. Local only.
- `E2E_PORT=8911 npx playwright test e2e/gmail-review.spec.ts e2e/gmail.spec.ts e2e/notifikasi.spec.ts e2e/email-forwarding.spec.ts e2e/kotak-masuk.spec.ts e2e/gmail-configured.spec.ts --workers=1`: `31 passed`, `8 skipped` (46.9s). The 8 skips are all `gmail-configured.spec.ts`, which needs a configured Google app (not run, not verified). Own port so the parallel red-team server was not reused.
- No test added by QA this cycle; no QA commit.

## Checked
- M2: `auth-results.ts` now splits Authentication-Results with an RFC 8601 tokenizer (`;` only outside quotes/comments; quoted/comment text that looks like a result sets `suspicious`). `gmailSenderAuthenticated` additionally requires the exact authserv-id `mx.google.com`, no unexpected token, exactly one `dmarc` result and it a pass, `header.from` = domain, aligned DKIM. New `gmail-auth.test.ts` (baseline pass/fail, per-variant "not authenticated" cases, DKIM from its own resinfo and aligned, a fuzz that quoted `smtp.mailfrom` never flips a `dmarc=fail`): pass.
- Shared parser / forwarding: `parseAuthResults` is now `parseStrict(...)?.result`; the new `unexpected` flag is ignored there, so inbound only changes where a header is malformed (unbalanced quote/comment now reads as no result, so the label falls to `unverified`, the safe side). `auth-results.test.ts` and the inbound worker tests were NOT edited and pass unchanged (gates); e2e `email-forwarding.spec.ts` (2 phone + 2 desktop) and `kotak-masuk.spec.ts` (3 + 3) pass. Real-world Gmail/forwarded header shapes (comments like `(p=NONE sp=NONE dis=NONE)`, `header.b=` values with `=`/`+`) are covered by the parser regexes by reading; real headers are unverified.
- L4: `detail` in `afterCapture` now also needs `senderAuthenticated`. Test "red team L4: a forged registry From never names merchant and amount" (dmarc=fail on a registry domain gives `merchant: null, amountMinor: null`, no mail text in params): pass. L1 and the confirmed+authenticated positive case still pass.
- F6 fixed: `gmail-notify-setting` is its own bucket (`GMAIL_NOTIFY_SETTING_PER_WINDOW = 10`, in `THROTTLE_SCOPES`, used by the `notify` action). Test "is throttled per user in its own bucket (QA F6): the auto-save setting stays usable": pass.
- Criteria 1-28: unchanged PASS (full suite 6795 green; auto-save positive path AC 9, AC 10 per-rule tests, push AC 1-7, migration AC 25 all re-run). F4 stays open and acceptable (cycle 2).

## Remaining (non-blocking)
F4 cosmetic (see cycle 2); F5 owner heads-up: pushes stay generic until a sender is confirmed AND authenticated. Unverified: real Gmail, real DMARC/DKIM headers, real domains and parsers, real web push, Gmail deep link, `/privasi` wording, `gmail-configured.spec.ts` (skipped, needs Google config).
