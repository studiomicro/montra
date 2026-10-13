# FN-05 Transactions and history + FN-06 Categories — QA report

**Verdict: PASS**

Commit under test: `e744c98` (detached, rebased onto main `98df284`). Engineer report: cycles 1–2.

## Commands run

- `npm ci` — dependencies installed, exit 0.
- `npx svelte-kit sync` — generated types, exit 0.
- `npm run gates` — `check` (svelte-check 1050 files, 0 errors, 0 warnings; tsc workers/jobs and workers/inbound clean), `lint` (prettier + eslint clean), `test` (Vitest 52 files / 478 tests passed), `build` (vite build done) — exit 0.
- `npm run db:reset:local` — fresh local D1 recreated, exit 0 (real local D1 via wrangler, not a mock).
- `npm run db:migrate:local` — "No migrations to apply!" immediately after reset, confirming migration 0004 applies cleanly to a fresh DB — exit 0.
- `npm run db:seed:local` — ran twice (once before any space existed — no-op per script's own precondition, once after a wallet existed — added 6 `is_demo` rows) — exit 0 both times, real local D1.
- `npx drizzle-kit generate --name=qa-drift-check` — "No schema changes, nothing to migrate" — confirms `schema.ts` and `migrations/0004_transactions_categories.sql` have no drift.
- `LD_LIBRARY_PATH=... npm run test:e2e` — Playwright, 107 passed, 12 skipped (51.8s), exit 0 — real local Workers runtime (workerd via wrangler), local D1, no mocks, no remote.
- Manual live verification: `npx vite dev --port 8804` against the same local D1 (`.wrangler/state`) — signed up two real users, created a wallet, a manual expense transaction, ran `db:seed:local` to add demo rows, and confirmed cross-space 404s, search with a 70-char term, and the demo-row/header-count behaviour below, all via direct HTTP (no JS) against the real dev server — server stopped afterward, port confirmed free.

## Checked criteria (PRD `docs/features/fn-05-transactions/PRD.md`)

**Categories (1–9):** all PASS.
1. PASS — `PRESET_CATEGORIES` (`src/lib/shared/transactions.ts:65-79`) lists exactly 10 expense + 5 income rows matching `docs/FEATURES.md:72-75` verbatim, including `lain` → `'Pemasukan Lain'` (income). Verified by `test/integration/transactions.test.ts` "seeds the 15 presets once" and live: first `/riwayat/baru` load rendered 15 category radios.
2. PASS — `ensurePresetCategories` is one guarded `INSERT…SELECT…WHERE NOT EXISTS` in one `db.batch` (`src/lib/server/categories/repo.ts:42-72`); `test/integration/transactions.test.ts` "20 concurrent first loads … seed exactly 15 rows, never 30, never an error".
3. PASS — `/pengaturan/kategori` groups by kind with `CategoryTile`; loading/retry states present (`test/integration/riwayat-routes.test.ts` "/pengaturan/kategori … lists 15 presets on first load").
4. PASS — `createCategory` inserts `is_preset=false, is_hidden=false`; appears in list and compose picker (same `listCategories` call both places) — "creates a custom category" test.
5. PASS — `updateCategory` updates in place, no denormalised name on `transactions` (join at read time in `aggregate.ts`); "renames and re-tiles in place" test.
6–7. PASS — `setCategoryHidden` is idempotent and reversible; `test/integration/riwayat-routes.test.ts` "keeps a now-hidden category selectable for the transaction that uses it" proves the edit page still offers it.
8. PASS — `cleanText`/`CATEGORY_NAME_MAX_LENGTH` strip control/zero-width and cap at 40 (`src/lib/server/categories/validation.ts`, `validation.test.ts`).
9. PASS — no code path sets `categories.deleted_at`; `setCategoryHidden` only ever touches `is_hidden`.

**Create a transaction (10–19):** all PASS.
10. PASS — `amount_minor` stored as positive magnitude via `digitsToMinor`, CHECK constraint `amount_minor > 0` in migration; `currency` copied from the wallet; `source='manual'`, `dedupe_key=null`; redirect `/riwayat?saved=created`. Verified live: no-JS POST to `/riwayat/baru?/create` → 303 → row shown, header "1 transaksi · keluar Rp 25.000".
11. PASS — reload confirmed live (`GET /riwayat` after create shows the row and correct day group); also `test/integration/riwayat-routes.test.ts` "the row is there on reload".
12. PASS — transfer writes `category_id=null`, excluded from `inMinor`/`outMinor` (`aggregate.ts foldTotals` skips `type==='transfer'`); `wallet-sum.ts` debits/credits both sides in one grouped query. e2e `riwayat.spec.ts` "transfer between two wallets" journey passed.
13. PASS — `resolveTransactionInput` refuses a cross-currency transfer with `TRANSFER_CURRENCY`; DB-level `refsHold` also requires the destination wallet's currency to match (race-safe). Test "refuses a same-wallet or cross-currency transfer".
14. PASS — same-wallet transfer refused (`TRANSFER_SAME_WALLET`) plus a CHECK constraint `transfer_to_wallet_id <> wallet_id` at the schema level.
15. PASS — `digitsToMinor`-based parsing, never `parseFloat`; zero/non-numeric rejected with field error, no row (schema also CHECKs `amount_minor > 0`).
16. PASS — `refsHold` requires the wallet/category to belong to the space; a crafted other-space id is refused with the uniform error, never a 500. Verified live cross-space probe (user B, user A's transaction id) → 404 on both load and `?/update`, nothing written.
17. PASS — omitted time ⇒ `occurred_at = now` (save instant), `occurred_on` is the form's WIB date, independent (owner decision F); `createTransaction` repo code and its test "a missing time is the save instant".
18. PASS — `cleanText` strips/caps title (80) and note (500) before storage.
19. PASS — compose form uses native radios/selects/date/time inputs; integration tests POST directly (no JS) and the live manual check above also did a pure `curl` POST with no `Sec-Fetch`/XHR headers and it completed as a normal form submission (303 redirect). `TYPE_INVALID` returned a normal 400 field error for a bad `type` value during manual testing (wallet `type` case), proving the no-JS failure path too.

**Edit and delete (20–23):** all PASS. `updateTransaction`/`deleteTransaction` guard on `expectedUpdatedAt`, return `'stale'`→409 "Berubah sejak terakhir dimuat" (FN-04's exact phrase, reused via `WALLET_CHANGED`-equivalent message, not re-keyed) — `test/integration/transactions.test.ts` "edit: guarded by updated_at" and `riwayat-routes.test.ts` "saves an edit, then refuses a second tab's stale save". Delete tombstones (`deleted_at` set, title/note cleared, `seq` advances) and leaves every total immediately — "delete: a content-free tombstone…" test plus e2e "delete with confirm". `source`/`dedupe_key` are never in any `update(...).set({...})` call (repo.ts confirmed by reading).

**Riwayat list, filters, search, totals (24–33):** all PASS.
24. PASS — header built from one `periodTotals` call per request (`+page.server.ts:27-28`), never a client resum; `test/integration/transactions.test.ts` "Beranda total = Riwayat total: periodTotals equals the sum of the listed rows, per currency". Per `docs/features/fn-05-transactions/PRD.md`'s note, this is the shared aggregate FN-08 must reuse — Beranda itself does not exist yet, consistent with the "Tracker impact" note (row should stay "Not run" overall for FN-08, "aggregate module verified").
25–26. PASS — `foldTotals` excludes transfers from `inMinor`/`outMinor`; Keluar/Masuk chips set `filter.type`, which also drops transfer rows from the list (same `filterWhere`). Tests "never sums across currencies; transfers count as rows but never as money".
27–28. PASS — `walletTransactionsSums` is one grouped SQL query (`UNION ALL` + `GROUP BY wallet_id`), confirmed by reading `wallet-sum.ts`; `/kekayaan` plugs it into `walletBalanceMinor` unchanged. Live check: opening 100.000 − one real 25.000 expense = Rp 75.000 shown on `/kekayaan`, 6 demo rows (which sum to a much larger net) correctly excluded.
29. PASS — `filterWhere` uses `instr(lower(coalesce(title,'')),?) > 0 or instr(lower(coalesce(note,'')),?) > 0`, never LIKE/GLOB. Live check: a 70-character search term returned `200` with "0 transaksi" (no D1 pattern-length error); also `aggregate.ts`'s own 60+ char test and `riwayat-routes.test.ts` "a long search term (60+ characters) never errors".
30. PASS — every query includes `space_id`, a bounded `occurred_on` range (`assertBounded`, max 366 days) and a page `LIMIT`.
31. PASS — keyset cursor (`occurred_on, occurred_at, id`) pagination; e2e "'Muat lebih banyak' appends the 51st row without repeating any" and unit test "pages through more than 101 distinct days and ids without any parameter limit".
32. PASS — WIB boundary vectors are an explicit regression suite in `src/lib/shared/dates.test.ts` (23:30 WIB last day → that month; 00:30 WIB first day → next month, both checked against the raw UTC date to prove no off-by-one) and `transactions.test.ts` "WIB month boundaries".
33. PASS — two distinct `EmptyState` copies (`hasAny` false vs. filtered-empty) confirmed in `riwayat-routes.test.ts` "true-empty and filtered-empty are told apart" and in `+page.svelte`.

**Cross-cutting (34–43):** all PASS.
34–35. PASS — every repo write/read scopes by `space_id` via `isLiveMember`/`requireSpaceAccess`/`currentSpaceScope`; `riwayat-routes.test.ts` "one access rule across spaces" section (non-member, removed member, same 404 as a missing id) plus my own live cross-space probe (user B against user A's transaction: load 404, `?/update` 404, nothing written).
36. PASS — `transactions.test.ts` "20 concurrent creates against one wallet: 20 rows, 20 distinct seqs, the sum exact" and "20 concurrent first loads … seed exactly 15 rows".
37. PASS — all actions use `readFormBody` (FN-01's shared guard); `riwayat-routes.test.ts` "refuses a non-form or oversized body with 415/400, never 500".
38. PASS — `{#each}` keyed by `row.id` / `category.id` (`+page.svelte`, `pengaturan/kategori/+page.svelte` — confirmed by reading).
39. PASS — `npm run test` includes `i18n.test.ts`, which is part of the clean gates run; spot-checked specific new keys (`Data demo`, `Berubah sejak terakhir dimuat…`, `Transfer ke/dari {wallet}`, `'{n} transaksi · keluar {out}'`, `'{n} transaksi · masuk {in}'`) all have English entries in `i18n-en.ts`.
40. PASS — currency rendering goes through `formatMoney`/`formatMoneyCompact` only (grep found no hand-built `Rp` string in the new routes); dates go through `src/lib/shared/dates.ts` helpers only.
41. Not independently re-verified beyond the existing `Sheet` component (unchanged this pass) and the e2e phone project (360×780 viewport) which passed every journey including the compose form and filter sheet without horizontal overflow — the engineer report notes an overflow bug found and fixed by the e2e run this cycle. Treated as PASS on that evidence.
42. PASS — read through `messages.ts` files for categories/transactions/wallets; no file path, stack trace or row id appears in any user-facing string.
43. PASS — `npm run gates` is clean (see Commands run); engineer report documents fail-before proof for every new regression class (seed race, LIKE vs instr, stale-updated_at, cross-currency transfer, transfer-as-expense, UTC-vs-WIB date, missing space filter).

## `is_demo` / "N transaksi" count — judged against "Totals reconcile"

Reproduced live: after seeding 6 `Data demo` rows into a space with one real Rp 25.000 expense, `/riwayat` showed
`"1 transaksi · keluar Rp 25.000"` in the header while 6 additional rows rendered below it, each badged "Data demo".
`periodTotals`, the day totals and `walletTransactionsSums` all filter `is_demo = 0` (`aggregate.ts:155`, `:254`,
`wallet-sum.ts:21,25`); `listTransactionsByDay`'s row query does not filter `is_demo`, so demo rows are listed but
never counted or summed, anywhere.

This is a literal mismatch between the header figure and the number of rows rendered under it, which is what
`docs/ENGINEERING_CHECKLIST.md`'s "Totals reconcile" item is generally guarding against. However `CLAUDE.md` ›
Verification explicitly requires: "Deterministic fictional seed data for local review, badged `Data demo`, excluded
from real totals" — i.e. the header's "N transaksi" is correctly read as *the real count*, and every demo row is
unambiguously marked so a reviewer never mistakes 7 shown rows for 7 real transactions. The checklist item's intent
(a dashboard figure must equal the sum of the *real* list it links to, for the same filter) is satisfied: the header
equals the sum of the non-demo rows in the same list. I judge this **by design, not a defect** — CLAUDE.md's explicit
demo-data rule takes precedence over a literal reading of "sum of the list" that would otherwise force demo data into
real totals. No fix required.

## Findings

None that block PASS. Two small observations, not required for this pass:
- Criterion 41 (focus-return/touch-target/contrast) was not independently probed with a dedicated axe/contrast
  check this cycle; relied on the e2e phone-viewport run plus the fact that `Sheet.svelte` itself is unchanged
  from the already-accepted FN-00/FN-04 baseline.
- The engineer's own "Concerns/follow-ups" (non-ASCII case folding in search, whole-unit-only `AmountInput`,
  offline write queue deferral) are pre-existing, owner-acknowledged limitations, not defects against this PRD's
  accepted scope.

## Gates / e2e summary lines (for `docs/HISTORY.md`)

- `npm run gates`: exit 0 — svelte-check 1050 files/0 errors/0 warnings; prettier+eslint clean; Vitest 52 files/478 tests passed; build done.
- `npm run db:reset:local` + `npm run db:migrate:local`: fresh local D1, migration 0004 applies with no drift (`drizzle-kit generate` reports no schema changes) — real local D1.
- `npm run test:e2e`: 107 passed, 12 skipped (51.8s), exit 0 — real local Workers runtime (workerd/wrangler), local D1, no mocks.
