# FN-26b Subscription check — QA Report

**Verdict: PASS**

Worktree `<repo>-worktrees/fn-26b-qa`, detached at `19bfed3`, base `75824e9`.

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0, no provider calls (local npm registry).
- `npm run db:migrate:local` (fresh local D1, journal with 0037/0038 gap) — all migrations incl. `0039_subscription_dismissals.sql` applied ✅, exit 0, local D1/workerd (no remote provider).
- `npm run db:migrate:local` (second run, same DB) — "✅ No migrations to apply!", exit 0, confirms idempotent re-run.
- `npm run gates` (check, lint, test, build) — clean, exit 0, local toolchain only.
- `npx vitest run src/lib/shared/subscriptions-detect.test.ts test/integration/langganan-check.test.ts` — 2 files, 31 tests passed, exit 0, local D1 (workerd) for the integration file, no AI/real provider.
- `E2E_PORT=9041 npx playwright test e2e/langganan.spec.ts --workers=1` (macOS flock shim on PATH) — 19 passed (phone+desktop, incl. both new FN-26b journeys), exit 0, local wrangler dev server (mocked billing/AI keys), no real provider.

## Checked criteria

1. Empty state + check card, no candidates, English entries present — PASS (unit test, e2e test lines 310–316, i18n-en.ts additions).
2. Single-occurrence known-name match (Netflix) with badge — PASS (unit test "one Netflix charge is a candidate…", e2e journey records NETFLIX.COM once and sees it in the card/sheet).
3. Recurring unknown-merchant monthly match vs. non-fitting gaps (10/40 days) excluded — PASS (`subscriptions-detect.test.ts` + integration test "the same amount at an unknown merchant ~a month apart is monthly; 10 and 40 days apart is nothing").
4. Source rows are real, capped at 6, newest first, no invented figures — PASS (`buildCandidates` caps at `SOURCE_ROWS_MAX`; unit test asserts cap; e2e expands "1 transaksi terkait" and sees the real title/amount).
5. "Jalankan pemeriksaan" opens the full list from already-loaded data, no round trip, load failure keeps `ErrorState` — PASS (architecture: `findCandidates` runs inside existing `load`; e2e opens sheet instantly; `loadError` path unchanged, candidates default to `[]` on failure so the card never renders as checked).
6. "Tambah" opens add sheet pre-filled (name/category/amount/currency/cadence/day), saves via existing unchanged `createSubscription` — PASS (`candidateFormValues`, e2e asserts prefilled Nama/Biaya then submits through the existing form; integration test "the prefilled form posts through createSubscription; then the candidate is gone").
7. "Bukan langganan" creates dismissal, candidate never reappears, double-dismiss is not an error — PASS (integration test "dismisses once; the candidate never comes back; a repeat is ok and adds nothing"; e2e reload confirms gone).
8. A subscription later added under a matching key hides the candidate — PASS (integration test "a subscription typed by hand under a known name also hides the candidate").
9. Space authorization: 404 for non-member and removed member on load and `dismissCandidate`, no existence oracle; two users/two spaces scoped correctly — PASS (integration tests "two users, two spaces…", "a non-member and a removed member get 404 on the load and the action; nothing is written").
10. `Data demo`, `transfer`, `income`, deleted rows and rows ≥90 days excluded — PASS (integration test "Data demo rows, transfers, income, deleted rows and rows older than 90 days never count"; boundary explicitly checks day 90 excluded vs. day 89 included).
11. Bounded: ≤300 rows, ≤20 candidates, ≤6 source rows, one indexed query, no extra spinner — PASS (integration test with 300 bulk rows proves the cap; unit test caps candidates/source rows; `findCandidates` is one `Promise.all` added to the page's existing load).
12. Account deletion purges a space's own dismissals via `SPACE_SCOPED_TABLES`, a shared space's dismissals survive — PASS (integration test "account deletion purges the dismissals of a space they were last in; a shared space keeps its own"; `created_by` set null, matches `merchant_rules` convention); `export/tables.ts` and `spaces.ts` both updated correctly.
13. Concurrent double-dismiss leaves exactly one live row — PASS (unit test "20 concurrent dismissals of one key leave exactly one live row, all answered ok"; server uses `onConflictDoNothing` on the partial unique index inside one `db.batch`).
14. i18n English entries, `formatMoney` everywhere, WIB dates, no bundled logos — PASS (all new strings in `i18n-en.ts`; `CandidateList.svelte`/`CheckCard.svelte` use `formatMoney`/`BrandBadge` (no `<img>`, e2e asserts `card.locator('img')` count 0); `occurred_on`/`wibTodayString`/`daysBetween` reused as-is, no new UTC math introduced).
15. FN-12 hidden-module notice still renders around the unchanged convention — PASS (verified unchanged markup at `+page.svelte` hidden-note block; not reopened by this diff).
16. Loading/empty/error/saving/success states present, consistent with existing `busy`/`track()` pattern — PASS (dismiss button shows "Memproses…" while `busy`, success text shown only after `saved === 'dismissed'`/`'created'`; e2e confirms both).

## Migration review

`migrations/0039_subscription_dismissals.sql` is a single new table, `IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, hand-edited to be re-runnable per its own header comment. Fresh local apply succeeds through the 0037/0038 journal gap (held by other in-flight branches); a second run is a clean no-op. Numbering is explicitly flagged for renumbering at merge, consistent with the PRD's own architecture note.

## Engineering-choice judgment

- **`utilitas` → `tagihan` tile**: correct and consistent with every other bill-shaped subscription category (`streaming`/`musik`/.../`belajar` all map to `tagihan` or similar existing tiles); no new tile invented.
- **Brands draw badges only, no PRD-specified `matchBrand` wiring into detection**: the PRD text (line 30) says known-name detection should also match an FN-43 brand entry "in the same shape" (i.e. in a bill-shaped `SubscriptionCategory`). The implementation only calls `catalogueMatch` (`SUBSCRIPTION_CATALOGUE`); `matchBrand`/`BRANDS` is never imported into `subscriptions-detect.ts` or `detect.ts` for detection — it is used only for rendering badges (`BrandBadge`, by cosmetic name match, already existing FN-43 behaviour). Inspecting `brands.ts`, every `BRANDS` entry is a bank, e-wallet or ride/food service; none falls into a bill-shaped subscription category (`streaming`, `musik`, `game`, `telko`, `cloud`, `software`, `belajar`, `utilitas`), and all telco/utility names the PRD cares about (Telkomsel, XL, Tri, IndiHome, PLN, PDAM, …) are already in `SUBSCRIPTION_CATALOGUE`. So the omission is a documentation/spec-wording deviation with no observed functional gap today — flagging it as a minor finding, not a blocking one, since no test scenario or realistic input exposes a missed candidate from this.
- **`test.setTimeout(120_000)` added to the e2e journeys**: reasonable given both new specs do sign-up + wallet + two recorded expenses + multiple sheet round trips; measured run time was ~2.9s/2.3s per spec locally, well under the raised budget, so the timeout is a safety margin, not a sign of flakiness.

## Findings

- **Minor (non-blocking) spec deviation**: PRD text describes known-name detection as matching catalogue *or* FN-43 brand entries; the shipped code only wires the catalogue path. No functional scenario is missed today (see above), but if `brands.ts` ever gains a bill-shaped entry, detection would silently not see it. Recommend a one-line PRD/code-comment reconciliation at the next touch of this file, not a blocking fix now.

No other findings. `npm run gates` is clean; all 16 acceptance criteria verified by existing or newly-run tests; e2e journeys (JS and no-JS) pass at 360 px in both color schemes with zero CSP violations and no horizontal scroll.
