# MONTRA — Acceptance Status

Updated 2026-10-07. Legend: **Pass** = verified against the real runtime or provider with the listed check.
**Browser** = Playwright journey on `wrangler dev`. **Automated** = Vitest against local D1 bindings. **Mocked** =
provider replaced by a fake. **Not run** = not yet verified. Evidence: `docs/HISTORY.md` → Test evidence log.

## Required journey (CLAUDE.md)

| Step | Status | Check |
| --- | --- | --- |
| Guest: add wallet → voice "kopi 25rb dan parkir goceng" → 2 drafts → save → reload | Not run | |
| Sign up → guest records upload → second device sees them | Not run | |
| Delete on device A → gone on device B | Not run | |
| Connect Gmail → QRIS receipt → transaction within one check, no duplicate on a second mail | Not run | |
| Gmail look-back 7 days → review → import → undo | Browser (mocked Google) | FN-19b: `e2e/gmail-review.spec.ts` look-back save and undo journey; `test/integration/gmail-followups.test.ts` undo cases on local D1 (2026-10-28). Real Gmail not run. |
| Receipt photo → split per item → total equals receipt | Not run | |
| Statement PDF (password) → balance check → duplicates excluded → import → undo | Not run | |
| Spreadsheet 3,000 rows → totals identical to the file | Automated | FN-17: `test/integration/impor-spreadsheet.test.ts` › "AC 17: 3,000 generated rows, totals identical to the file" (long table and tab per month; generated fictional workbook, real files not run) |
| CSV template and Money Manager import; CSV export round trip | Not run | |
| Budget → safe-to-spend = remaining ÷ remaining WIB days | Not run | |
| Assistant answer figures equal Beranda and Riwayat for the same period | Automated | `test/integration/tanya.test.ts` › "figures equal Beranda/Riwayat/Laporan/Dompet for the same period" (mocked model; real provider not run) |
| Invite to shared space (link, 7 days) → member sees and edits; sixth person refused | Not run | |
| Delete account (in app and on the public page) → server data gone, shared-space records stay | Not run | |

## Security and privacy

| Requirement | Status | Check |
| --- | --- | --- |
| Space isolation on every load, action and sync push/pull | Not run | |
| Session hashing, cookie flags, CSRF/origin check, sign-out revocation | Not run | |
| Uploaded files never written to R2 or D1; partner copy deleted | Not run | |
| Sealed results unreadable without the password-derived key | Not run | |
| Mail text not stored; non-payment mail keeps only id and date | Automated | FN-19: `inbound_mail` CHECKs plus `process.test.ts` / `forwarding.test.ts` retention cases on local D1; Gmail path `test/integration/gmail.test.ts` (no mail text column, non-payment keeps id and date) with a fake Google. |
| Gmail disconnect deletes all mail data, keeps transactions | Automated (mocked Google) | FN-19 Gmail: `test/integration/gmail.test.ts` disconnect cases (106 mail rows, pending drafts discarded, transactions kept, revoke called on the fake) on local D1. Real Google revocation not run. |
| Spoofed or forwarded fake receipt never auto-saves | Automated | FN-19 forwarding: `workers/inbound/src/process.test.ts` spoof cases (forged/failing `Authentication-Results`, look-alike senders) end as flagged drafts or not_payment; no code path writes a transaction. Real mail not run. |
| Assistant tools read-only and space-scoped (prompt-injection test) | Automated | `test/integration/tanya.test.ts` › "two users, two spaces…", "a removed member gets the same 404"; `src/lib/server/tanya/tools.test.ts` › read-only allowlist and model-supplied space id refused; red team FN-22 cycle 1–3 |
| Payment webhook signature + replay protection | Not run | |
| Merchant rules and cache space-scoped; removed member loses access (FN-20) | Automated | `test/integration/merchants.test.ts` (isolation, removed member 404, stale 409) and `merchants-redteam.test.ts` (cache per space, foreign category ids refused); `e2e/fn20-merchants-qa.spec.ts` AC-6 |
| Merchant AI step suggests only existing categories, never amounts (FN-20) | Mocked | `src/lib/server/merchants/ai.test.ts` + red-team probes (stubbed model). Real Anthropic run NOT verified. |
| CSV export formula-injection safe | Not run | |
| Usage statistics hold no account id, amount, typed text or IP; opt-out works | Not run | |

## Money and dates

| Requirement | Status | Check |
| --- | --- | --- |
| Integer minor units; slang and locale vectors parse exactly | Not run | |
| Foreign currency converted at the day's rate, original kept | Not run | |
| Month/day buckets use the WIB date (23:30 WIB on the last day) | Not run | |
| Beranda total = Riwayat total for the same filter | Not run | |

## Design

| Requirement | Status | Check |
| --- | --- | --- |
| Tokens from `docs/design/tokens.css`; AA contrast both themes | Automated | `test/contrast.test.ts` |
| 360 px layout, 44 px touch targets, reduced motion | Browser | `e2e/shell.spec.ts`, `e2e/kit.spec.ts`, `e2e/motion.spec.ts`, `test/motion-css.test.ts` (keyframes transform/opacity only; kit controls 40 px, navigation 44 px) |
