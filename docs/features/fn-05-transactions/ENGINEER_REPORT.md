# FN-05 Transactions and history + FN-06 Categories — engineer report (cycle 1)

Branch `fn-05-transactions`, rebased onto FN-04 head `9c004eb` (FN-03 final on main). Not pushed. Migration
`0004_transactions_categories.sql`.

## What works

- `/riwayat`: header `N transaksi · keluar Rp X` (Pemasukan chip: `· masuk`), chips Semua / Pengeluaran /
  Pemasukan with counts (links, work without JS), month navigation (‹ Oktober 2026 ›) or a custom date range,
  GET search (title + note, `instr()`), Filter (sheet with JS, inline `?filter=1` without) with single-select
  category and wallet radios, day groups (`DayHeader` with whole-day in/out per currency, "Hari ini"/"Kemarin"),
  transfers styled unsigned, 50 rows per page with keyset cursor "Muat lebih banyak" (appends with JS, opens the
  next page without), skeleton while filtering, `ErrorState` with retry, two distinct empty states.
- `/riwayat/baru` (compose) and `/riwayat/[id]/edit`: type Segmented, `AmountInput` (wallet currency), wallet
  select, destination select for transfers, category tile grid of the type's kind with "Kelola kategori" link,
  title, note, native date (default WIB today), optional time in `<details>`. Type-dependent fields switch with
  CSS `:has()`, so the form also works without JS. Success = redirect to `/riwayat?saved=…` after the write.
  Edit: stale `updated_at` → FN-04's exact phrase (409); delete with confirm (tombstone, title/note cleared).
- `/pengaturan/kategori`: presets seeded on first use, grouped Pengeluaran/Pemasukan, rename + change tile
  (stale-guarded), hide/show (hidden in a collapsed "Disembunyikan (n)"), add custom (kind, name, one of 15 tiles).
  Linked from the compose form and (new) from `/pengaturan`.
- `/kekayaan` balance = opening + `walletTransactionsSums` (FN-04 seam filled). A wallet's currency can no longer
  be changed once it has live transactions (pre-check field error + guard in the `updateWallet` statement).
- Add sheet: "Ketik manual" is now a real link to `/riwayat/baru`; the other four stay "Segera hadir".

## Files

- New: `src/lib/server/transactions/{aggregate,repo,form,validation,messages,wallet-sum}.ts`,
  `src/lib/server/categories/{repo,validation,messages}.ts`, `src/lib/server/spaces/current.ts`,
  `src/lib/shared/{transactions,riwayat-query}.ts`, `src/lib/ui/transactions/{TransactionForm,CategoryForm}.svelte`,
  routes `riwayat/+page.server.ts`, `riwayat/baru/*`, `riwayat/[id]/edit/*`, `pengaturan/kategori/*`.
- Changed: `db/schema.ts` (+`categories`, `transactions`), `shared/dates.ts` (WIB date helpers),
  `spaces/access.ts` (+`SpaceScope`), `spaces/spaces.ts` (`SPACE_SCOPED_TABLES` += transactions, categories —
  before wallets for FK order), `wallets/repo.ts` + `wallets/validation.ts` (`walletFormValues`) +
  `wallets/messages.ts` (currency lock), `kekayaan/+page.server.ts`, `riwayat/+page.svelte`, `pengaturan/+page.svelte`,
  kit `Segmented` (native radios), `Chip` (+`href`), `TransactionRow` (+`kind`), `AddSheet`/`nav.ts` (+`href`),
  `i18n-en.ts` (~85 entries).
- Tests: `test/integration/transactions.test.ts` (25), `test/integration/riwayat-routes.test.ts` (19),
  `src/lib/server/transactions/validation.test.ts` (13), `src/lib/server/categories/validation.test.ts` (4),
  `src/lib/shared/{transactions,riwayat-query}.test.ts`, `src/lib/shared/dates.test.ts` (+8),
  `src/lib/ui/kit/kit-fn05.test.ts` (5).

## Decisions (owner defaults plus auto-accepted ones)

Owner: 50/page + "Muat lebih banyak"; single-select filters; hide-only categories; search title+note;
same-currency transfers only; omitted time = save instant (edit: kept); `/pengaturan/kategori` linked from compose.
Auto-accepted (recorded here):
1. Sign convention: `amount_minor > 0` (CHECK), direction from `type`; transfers counted as rows, never as money.
2. `periodTotals` returns per-currency `totals[]` plus per-type counts instead of a single `{inMinor,outMinor}` —
   one-currency-per-sum rule. Header joins currencies with " + ".
3. Chips labelled Pengeluaran/Pemasukan (`Masuk` already means "Sign in").
4. Period control: "Per bulan" with ‹ › month navigation (any past month) or "Rentang tanggal" (≤ 366 days),
   instead of the ambiguous "Bulan ini/Periode ini" (no budget cycle exists yet).
5. Category and wallet pickers are inline (tile grid / native select) rather than Sheets: they work without JS;
   the filter keeps a Sheet with an inline no-JS fallback.
6. One `updateCategory` (name + tile, stale-guarded) instead of separate rename/icon functions; hide/show idempotent.
7. Category cap 100 per space; `category_id` nullable in schema for future "Tanpa kategori" captures (form requires it).
8. Delete clears title/note (content-free tombstone; amount stays because of the CHECK).
9. `/pengaturan` index (now real since FN-01) gets a "Kategori" row.
10. Wallet currency locked once the wallet has live transactions (FN-04 touch; otherwise balances would mix currencies).
11. Segmented reimplemented on native radios: arrow keys/roving focus by the browser, posts without JS (closes the
    FN-00 deferred item).

## Gates

`npm run gates` exit 0: svelte-check 1047 files 0 errors 0 warnings; prettier + eslint clean; Vitest 51 files /
475 tests passed; build ✔ done.

## Fail-before proof (mutation runs, each reverted)

seed without NOT EXISTS → 1 fail (20-concurrent seed); search via LIKE → 1 fail (60+ char term, local D1 rejects
the pattern); no `updated_at` guard → 2 fail; cross-currency transfer allowed → 2 fail; transfers summed as
expense → 2 fail; UTC date instead of WIB → 4 fail; `getTransaction` without space filter → 2 fail.

## Pre-handoff probes

- Cross-space: Vitest probe as non-member and removed member — edit load, update, delete, list, category
  hide/show/update all 404 with the same body as a missing id; nothing written. Live HTTP (vite dev, local D1):
  B on A's `/riwayat/<id>/edit` 404 = missing id 404; B's delete 404.
- 101+ ids: no `inArray` anywhere; day lists bound once via `json_each`; 130 distinct days paged → 130 rows.
- 60-char search: 67-char term returns the one match, no D1 error (route + aggregate).
- Stale edit: second tab → 409 "Berubah sejak terakhir dimuat…" (Vitest + live HTTP).
- Concurrent edit/delete: exactly one wins, the other 409/404, no 500. 20 concurrent creates: 20 rows, 20 distinct
  seq, exact sum. 20 concurrent first loads: exactly 15 categories.
- WIB boundaries: 23:30 WIB 31 Oct → October totals/group; 00:30 WIB 1 Nov (still 31 Oct UTC) → November.
- Beranda/Riwayat totals: `periodTotals` equals the manual sum of all paged rows for 6 filters, per currency.
- No-JS forms (live HTTP, `accept: text/html`, no enhance): create → 303 `/riwayat?saved=created`, row and header
  `1 transaksi · keluar Rp 25.000` shown; amount 0 → 400 with field error in HTML; `?filter=1` renders the inline
  filter; JSON body → 415; `/kekayaan` shows Rp 75.000 (100.000 − 25.000).
- Not run: 360 px visual probe, two-device sync (no sync layer).

## Concerns / follow-ups

- Search lower-cases ASCII only (SQLite `lower()`); non-ASCII case-insensitive search would need a stored folded column.
- Amounts are whole units only (AmountInput); sen-bearing captured rows would display truncated in the edit form.
- `Data demo` seed for transactions not added (seed script untouched).
- e2e journeys needed (not added): compose expense → appears in Riwayat and Kekayaan balance; transfer between two
  wallets; edit + stale second tab; delete; filter by category/wallet + search; "Muat lebih banyak" with 51+ rows;
  manage categories (add, rename, hide → gone from picker, still on old row); Ketik manual from the add sheet.
- Offline write queue remains a tracker follow-up (owner decision).

## Cycle 2

- Rebased onto main `98df284` (FN-04 final). The 0004 snapshot was regenerated on top of main's 0003 snapshot
  (the old one predated FN-03's `ownership_transferred` audit action); `drizzle-kit generate` now reports no drift.
- `Data demo`: new `transactions.is_demo` column (in 0004, not yet applied anywhere remote). `scripts/demo-seed.ts`
  (used by `npm run db:seed:local`) adds 6 fictional rows to every local space with an IDR wallet: deterministic
  ids, re-runnable, deleted demo rows are not recreated. Riwayat lists them with a "Data demo" badge; `periodTotals`,
  day totals and `walletTransactionsSums` leave them out (`scripts/demo-seed.test.ts`).
- The wallet currency lock is covered by `test/integration/riwayat-routes.test.ts` (`/kekayaan with transactions`);
  its copy is in `i18n-en.ts`.
- e2e `e2e/riwayat.spec.ts` (8 journeys × phone/desktop); `e2e/shell.spec.ts` now expects "Ketik manual" to be a
  link. The e2e run found and this cycle fixed: "Muat lebih banyak" showed duplicate rows (Svelte
  `each_key_duplicate`) and then only the new page — earlier pages are now tied to the cursor they lead to; the
  compose form overflowed 360 px (Segmented with three options, AmountInput in a grid track) — fixed in the kit.
- Gates: svelte-check 1050 files 0/0; lint clean; Vitest 52 files / 478 tests; build done.
  `npm run test:e2e`: 107 passed (37.6 s).

## Cycle 3 (red-team findings)

Each regression test below was run before its fix and failed (4 repo tests, 2 route tests, 1 unit test).

- **M1 sum overflow:** fixed.
  - (a) One amount is capped at 10^13 minor units (Rp 100.000.000.000), with the field error "Jumlah terlalu besar
    untuk satu transaksi." The repro (9.999.999.999.999 in a USD wallet) is now refused over the route.
  - (b) A space holds at most 100.000 live transactions; the insert is guarded and refuses with
    "Ruang ini sudah punya 100.000 transaksi, batas terbanyak.".
  - (c) The SQL sums come back as `CAST(SUM(...) AS TEXT)` and are converted with `BigInt`. A total past 2^53 is
    `null` and shows "Total terlalu besar untuk ditampilkan" in the header, the day group or the wallet row.
  - Test: 1000 rows of 10^13. `/riwayat` loads with its 50 rows and `/kekayaan` loads; the overflowing wallet
    shows null and the other wallets show their balances.
- **M2 tombstones:** fixed. In 0004 the content columns are now nullable, and `transactions_content_check` holds:
  a live row has its full content, a tombstone has none. Delete clears every content column in the same
  statement. `source` and `dedupe_key` are kept, so a re-capture with the same key still hits UNIQUE. A
  tombstone that gets content back is refused by the CHECK.
- **L1 archived wallet race:** fixed. `refsHold` requires a live wallet, counter-wallet and visible category
  inside the write. An edit may keep the archived wallet or hidden category that row already uses.
- **L2 no transaction cap:** covered by M1(b).
- **Migration:** the 0004 snapshot is regenerated; `npm run db:reset:local` ok.
- **Gates:** svelte-check 1050 files 0/0; lint clean; Vitest 52 files / 485 tests passed; build done.
- **e2e:** `npm run test:e2e` gave 107 passed (40.1 s). The first run had 1 failure, in FN-01's account-deletion
  journey; it passed when that file ran alone and in the full rerun.
