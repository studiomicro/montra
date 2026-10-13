# FN-48 — Categories for imported rows

This PRD has three parts, addable independently (see **Owner decision 14**): **Part A** gives imported rows a
real category instead of a generic fallback and cleans up existing rows; **Part B** (owner addition 2026-10-11)
checks that a wallet's statements connect month to month instead of silently leaving a gap; **Part C** (owner
addition 2026-10-11) finds and merges a transfer between two of the user's own wallets that today imports as two
unlinked rows. All three are deterministic — no AI, no new credential.

## Goal

An imported bank statement is only useful if its rows land in a category the owner recognises at a glance, its
running balance can be trusted month to month, and a transfer between the user's own accounts does not inflate
both "money in" and "money out". Today a real BCA wallet's 33 imported rows show 21 "Lainnya", 11 "Pemasukan
Lain" and 1 "Tagihan" — Indonesian bank mutation jargon ("BIAYA ADM", "TARIKAN ATM", "KARTU KREDIT/PL …", "TRSF
E-BANKING DB/CR", "BI-FAST CR", "SWITCHING …") never matches FN-20's merchant-oriented dictionary; the same
wallet's computed balance (Rp 64.636.204,87) silently disagreed with its statement's own Saldo Akhir (Rp
74.636.204,87) because the June closing balance was never captured; and a transfer the user made between their
BCA and OCBC wallets shows up twice — once as an expense, once as income — in two different places. This feature
fixes all three without ever inventing an amount or silently changing a row's type.

## Scope

1. **Six new preset categories** (migration; see Architecture notes), reusing the existing preset/top-up
   mechanism (`ensurePresetCategories`, `src/lib/server/categories/repo.ts:56-121`) so every space — new or
   years-old — gets them automatically on its next category load, exactly like FN-39's "Ojek Online" top-up:
   - `biaya-bank` (expense) "Biaya Bank"
   - `pajak` (expense) "Pajak"
   - `tarik-tunai` (expense) "Tarik Tunai"
   - `kartu-kredit` (expense) "Kartu Kredit"
   - `transfer` (expense **and** income, two rows sharing one tile — the same pattern `lain` already uses for
     "Lainnya"/"Pemasukan Lain", `src/lib/shared/transactions.ts:92-110`) "Transfer"
   - `bunga` (income) "Bunga"
2. **A deterministic bank-narrative recognition layer**, pure and shared (new module under
   `src/lib/shared/merchants/`), that reads a statement/CSV row's *raw* words — before FN-20's
   `cleanDescriptor` strips payment-channel prefixes such as `trsf`, `tarikan`, `bi fast`, `db`, `cr`
   (`src/lib/shared/merchants/clean.ts:26-52`), which today throws away the very words this layer needs. Wired
   into `resolveDeterministic` (`src/lib/shared/merchants/resolve.ts:77-102`) as a new layer, in the owner-locked
   order (decision 1, FN-20): rule → history → cache → **narrative** → dictionary → keyword → AI. A space's own
   rule, history or AI-cache answer still always wins first — this never overrides a user's own correction.
3. **FN-20 reason chip reused, never duplicated.** The new layer gets its own `MerchantReason` value (e.g.
   `'narrative'`, label `msg('Dari kode mutasi bank')` + English) added to the existing enum and
   `MERCHANT_REASON_LABELS` map (`src/lib/shared/merchants/resolve.ts:12-31`); the existing `<Badge>` chip
   (`src/lib/ui/drafts/DraftSummary.svelte:66`) renders it with no new component. Shown (a) on the new "Rapikan
   kategori" review list per proposed row, and (b) on the transaction edit page (`TransactionForm.svelte`) for a
   non-manual transaction whose stored category still equals what the deterministic resolver computes today for
   its title — recomputed live, read-only, never persisted, exactly like the chip already works for a fresh
   voice/manual entry.
4. **The new layer wired into every import path that assigns a category today**, all of which already share one
   resolver call (`resolvedCategoryNames`, `src/lib/server/imports/csv-import.ts:444-476`, called from
   `importRows`, `csv-import.ts:489-694`) or the FN-20-aware fallback (`categoryNameOf`,
   `csv-import.ts:376-389`, `matchVisibleCategory`, `csv-import.ts:417-433`): FN-16 statement import (BCA PDF/CSV,
   BNI, Mandiri, OCBC — all funnel through `importStatement`/`previewStatement`,
   `src/lib/server/statements/statement-import.ts:156-181`), FN-16g OCR (feeds the same `importRows` via its own
   `PreparedRows`), FN-18 CSV import, and FN-17 spreadsheet import (`createMissing: false` path,
   `csv-import.ts:546-584`, which uses `matchVisibleCategory` only — the new layer still applies, no new
   category is ever created by a spreadsheet import, matching its existing rule).
5. **A new "Rapikan kategori" review action** that re-categorises *existing* transactions still sitting in a
   fallback category:
   - **Eligibility** (server-computed, bounded, space-scoped): a live, non-demo-excluded transaction whose
     `source` is not `manual`, whose `category_id` is one of the space's fallback-tile categories (`lain`'s two
     rows today; any of the six new ones too, once they exist, since a row written before this feature can only
     be in `lain`), and whose hand-edit marker (see Architecture notes) says it was never touched by a person.
   - **Preview**: lists up to 500 eligible rows (masked title, date, amount, current category, proposed category,
     reason chip), all pre-selected, user can uncheck any row.
   - **Apply**: writes only `category_id`, `updated_at` and `seq` for the selected rows, in one `db.batch` of
     bounded chunks (reusing the `INSERT_CHUNK` = 250 pattern, `csv-import.ts:54`); records a batch header + one
     row per changed transaction (its previous category id) so the whole batch can be undone in one step, the
     same shape `import_batches`/`undoImportBatch` already uses for a full import undo
     (`src/lib/server/imports/repo.ts:92-153`) — except this undo restores a field, never tombstones a row.
   - **Undo**: one button, restores every row's previous `category_id` exactly (skips, and reports, any row whose
     category changed again since — never clobbers a later edit), touches nothing else.
   - Entry point: a new card on `/impor` (`src/routes/(app)/impor/+page.svelte`), shown only when the space has
     at least one eligible row; its own sub-view for the list, apply and undo.
6. **Transfer vs FN-05 transfer type, decided explicitly**: "Transfer" here is a plain expense/income *category*
   like any other. It never sets `transactions.type = 'transfer'`, never sets `transfer_to_wallet_id`, never
   merges two rows. The row's own type (already decided by the parser's DB/CR direction) is untouched. (Part C
   below is the only part of this PRD that ever sets `type = 'transfer'`, and only after an explicit confirm.)
7. **i18n**: every new category name, the new reason-chip label, and every "Rapikan kategori"/Part B/Part C UI
   string go through `msg()`/`tr()`/`trf()` (`src/lib/shared/i18n.ts`) with an English entry in `i18n-en.ts`.
8. **Design tokens**: one accent colour per new tile (`--cat-biaya-bank`, `--cat-pajak`, `--cat-tarik-tunai`,
   `--cat-kartu-kredit`, `--cat-transfer`, `--cat-bunga`) in every theme block of `docs/design/tokens.css`
   (light, dark, mono, gold, deep-green — grep `--cat-lain` for the full list of blocks to match), plus an entry
   per tile in `src/lib/ui/kit/category.ts` (`CATEGORIES`, line 3-25) with an emoji and `cssVar` (no brand marks).
9. **Part B — statement continuity check per wallet** (owner addition 2026-10-11). `import_batches` gains, for
   `source = 'statement'` only, four nullable columns: `wallet_id`, `period_from`, `period_to` (WIB dates
   spanning the batch's own *written* rows — the min/max `occurred_on` actually imported, not the statement's
   printed text) and `opening_balance_minor`, `closing_balance_minor` (straight from the parser's
   `StatementParse.openingBalanceMinor`/`closingBalanceMinor`, `src/lib/shared/statements/types.ts:22-25`,
   already computed into `reading.balance`/`BalanceCheck` at `statement-import.ts:90-120` but discarded today —
   only the `pass`/`gap`/`omitted` verdict survives). At every statement preview/import, before writing, the
   server checks this wallet's nearest earlier live statement batch (ordered by `period_from`): the new batch's
   `opening_balance_minor` against that earlier batch's `closing_balance_minor`; when there is no earlier batch
   yet, against the wallet's balance computed up to the day before `period_from` (`wallets.opening_balance_minor`,
   `db/schema.ts:381`, plus the signed sum of its live transactions before that date — a new bounded query next
   to `walletBalanceMinor`, `src/lib/server/wallets/balance.ts:6-13`). A mismatch shows which period, both
   figures and the gap — never silently imported — with an offer to close it with one FN-37 balance-adjustment
   transaction (`migrations/0022_balance_adjustment.sql`: "the app records the difference as one transaction
   instead of asking the user to compute and type it"), dated the day before the gap period, for the gap amount;
   declining it still lets the statement's own rows import normally.
10. **Part C — own-transfer matching across two wallets** (owner addition 2026-10-11). A deterministic,
    same-space scan over live "Transfer"-categorised expense and income rows (scope item 1's new `transfer`
    tile) in *different* wallets: an exact `amount_minor` + `currency` match within a ±1-day window (Owner
    decision 10) proposes merging the pair into one FN-05 transfer: the debit row becomes `type = 'transfer'`,
    `transfer_to_wallet_id` = the credit row's wallet, category cleared; the credit row is tombstoned (its
    dedupe key stays, so a later re-import of that file is still recognised as already-imported and never
    recreated). Shown linked on both wallets' history, reviewed and confirmed per pair — never auto-applied —
    with one-step undo per pair restoring both rows exactly. An ambiguous match (more than one same-amount,
    same-window candidate) is never auto-picked: every candidate is listed for the user to choose or skip.

## Out of scope

- Any AI step. Every part of this feature is deterministic; `resolveMerchants` is always called with
  `allowAi: false` from this feature's own code paths (the regular import-time AI step for rows no deterministic
  layer — old or new — can name is unchanged and unaffected).
- Auto-creating a transfer into a cash wallet when an ATM withdrawal is recognised. "Tarik Tunai" is a category
  on the expense row from the bank wallet only; no second transaction, no wallet guess.
- Reconciling a "Kartu Kredit" bill-payment row against a separately imported credit-card statement. The known
  double-count risk (the same spend appears once on the card's own statement and once as a bill payment from the
  bank account) is a pre-existing limitation, unchanged by this feature.
- A full per-row category list/editor on the import *preview* screen ("Tinjau impor"). That UI does not exist
  today (`previewStatement`/`previewCsv` return counts and duplicates only, never a row list,
  `src/lib/server/statements/statement-import.ts:122-137`, `src/lib/server/imports/csv-import.ts:244-263`) and
  building it is a separate, larger PRD; "Rapikan kategori" reviews already-imported rows instead.
- Any new fallback-tile categories beyond the two existing ones (`lain`/expense "Lainnya", `lain`/income
  "Pemasukan Lain") created ad hoc by imports (`insertImportedCategories`, `src/lib/server/categories/repo.ts:
  320-341`). That mechanism is unchanged; the new presets simply give the resolver somewhere better to land
  *before* a row would have reached it.
- Changing `MAX_CATEGORIES_PER_SPACE` (100) or the category list cap; the six new presets count against the
  existing cap like any other category.
- **Part B:** automatically editing `wallets.opening_balance_minor` directly — the fix is always a visible,
  confirmable FN-37 adjustment transaction, never a silent edit to the wallet row; continuity across *different*
  wallets, or between a statement and a non-statement source (manual/voice rows carry no printed balance to
  check against); any guess when the parser reports no opening or closing balance (`BalanceCheck` status
  `omitted`).
- **Part C:** cross-currency transfer matching (amount + currency must match exactly); a matching window wider
  than ±1 day, or a chain across more than two wallets; using the SKN/BI-FAST bank-code table (009/014/028/…) or
  the account holder's name as a *required* matching signal (Owner decisions 11, 12) — amount, currency and date
  are the only required signals.

## Acceptance criteria

### Part A — deterministic recognition (vectors from the owner's sample wallet, masked)

1. Given an imported expense row with description "BIAYA ADM", when the row is categorised (import time or
   "Rapikan kategori"), then its category is "Biaya Bank", with reason `narrative`.
2. Given an imported income row with description "BUNGA", when categorised, then its category is "Bunga" (not
   "Pemasukan Lain").
3. Given an imported expense row with description "PAJAK BUNGA", when categorised, then its category is "Pajak".
4. Given an imported expense row with description "TARIKAN ATM 19/••••0872", when categorised, then its category
   is "Tarik Tunai".
5. Given an imported expense row with description "KARTU KREDIT/PL 0806 WSIDZX••••0100 BCA", when categorised,
   then its category is "Kartu Kredit".
6. Given an imported expense row with description "KARTU DEBIT KACAMATAMOO ••••0872" (an unrecognised merchant),
   when categorised, then its category stays "Lainnya" — proving the new layer never misfires on an ordinary
   debit-card purchase just because the words "kartu debit" are present.
7. Given an imported expense row with description "TRSF E-BANKING DB 10/01 ZQ181 ERWIN PRIA…", when categorised,
   then its category is "Transfer" (expense side).
8. Given an imported income row with description "TRSF E-BANKING CR 1407/FTSCY/WS…", when categorised, then its
   category is "Transfer" (income side) — confirming both the DB and the CR direction are recognised, and the
   row's `type` (expense vs income) is exactly what the parser's own DB/CR reading already produced, unchanged.
9. Given an imported income row with description "BI-FAST CR BIF TRANSFER DR 009 BUDI SA…", when categorised,
   then its category is "Transfer".
10. Given an imported income row with description "SWITCHING CR TRF CIPTA KREASI ABDI…", when categorised, then
    its category is "Transfer".
11. Given an imported expense row with description "SWITCHING DB BIAYA TXN KE 009 …", when categorised, then its
    category is "Biaya Bank", not "Transfer" — the fee signal ("biaya") outranks the generic transfer signal
    when both are present in the same narrative.
12. Given a space whose own rule or history already names a category for an exact cleaned descriptor, when a row
    with that descriptor is categorised, then the rule/history answer wins over the new narrative layer (the
    FN-20 order is unchanged).
13. Given the same raw row text parsed twice (e.g. a re-run or a retried import attempt), when categorised both
    times, then the chosen category is identical both times (no AI, no randomness, no clock dependency).

### Part A — new presets

14. Given a brand-new space, when its categories first load, then it has all 23 presets (17 existing + 6 new
    tiles, 7 new rows) including "Biaya Bank", "Pajak", "Tarik Tunai", "Kartu Kredit", "Transfer" (expense),
    "Transfer" (income) and "Bunga".
15. Given a space created before this migration (already holding the 17 original presets, possibly with some
    renamed, hidden or retiled), when its categories next load, then it receives exactly the missing new presets
    at the end of its list, in the same run-once, concurrency-safe way FN-39's `LATER_PRESETS` top-up already
    works (`src/lib/server/categories/repo.ts:56-91`) — never recreating a preset the space already has under
    that tile, even if the user renamed or hid it.
16. Given the `categories_tile_key_check` constraint, when a category is inserted with one of the six new tile
    keys, then the insert succeeds; an unknown tile key is still refused.

### Part A — "Rapikan kategori"

17. Given a signed-in member of a space with eligible rows, when they open `/impor`, then a "Rapikan kategori"
    card appears showing the eligible count; given a space with zero eligible rows, then the card does not
    appear (a true empty state, not a hidden button pretending to be one).
18. Given the review list is loading, then a loading state shows; given the server call fails, then an error
    state shows with a retry, never a stack trace or a silent empty list.
19. Given the preview list, when the user unchecks a row and presses "Terapkan", then only the checked rows'
    `category_id` change; the unchecked row's category is untouched.
20. Given the apply action, when it is confirmed, then it is shown as saved only after the server confirms the
    write (CLAUDE.md: success only after a confirmed write) and the page offers "Urungkan" for that batch.
21. Given a successfully applied batch, when the user reloads the page or opens it on a second device, then
    every changed transaction still shows its new category (persisted, not a client-only change).
22. Given an applied batch, when the user presses "Urungkan", then every row in that batch reverts to its exact
    previous `category_id`, its `amount_minor`, `currency`, `wallet_id`, `type`, `title`, `occurred_on` and
    `occurred_at` are byte-for-byte unchanged, and `updated_at`/`seq` bump exactly once more.
23. Given a row whose category was changed again (by hand) after a "Rapikan kategori" batch applied but before
    its undo, when that batch is undone, then that one row is left alone (reported, not reverted) and every
    other row in the batch still reverts.
24. Given an apply or undo request is resubmitted (double click, browser retry, replayed form), when it is
    processed a second time, then nothing changes further and the response says "already applied"/"already
    undone" — never a second category change, never a duplicate batch (same guarded-statement pattern as
    `undoImportBatch`, `src/lib/server/imports/repo.ts:92-153`).
25. Given a transaction whose `category_id` was ever set by the user — directly on an edit form, or by bulk
    "Atur kategori" before a capture was saved — when "Rapikan kategori" previews, then that row never appears,
    whether it currently holds a fallback category or not.
26. Given a transaction written before this feature shipped (no hand-edit marker column yet), when "Rapikan
    kategori" previews, then it is eligible only if its category is still one of the fallback-tile categories
    **and** `updated_at = created_at` (never edited since creation) **and** its source is not `manual`; a row
    that was edited for any reason (even a title fix, not the category) is excluded — a deliberately
    conservative, safe-side rule.
27. Given two spaces, each with eligible rows, when a member of space A runs "Rapikan kategori", then only space
    A's rows are listed, changed or undone; a request naming space B's batch id from space A's session gets the
    same 404 every other cross-space check gets (CLAUDE.md: one access rule, no existence oracle).
28. Given a removed member of a shared space, when they call the preview, apply or undo route for that space,
    then they get the same 404 a non-member gets.
29. Given a demo transaction (`is_demo = 1`) in a fallback category, when "Rapikan kategori" previews, then it
    appears in the list badged "Data demo" like every other demo row, and applying changes its category exactly
    like a real row's — but it is still excluded from every real total (unchanged behaviour).
30. Given up to 500 eligible rows and a space with more than that, when the preview runs, then it lists the
    first 500 (bounded, newest or oldest first — document the order) and the card's count still shows the true
    total so the user knows to run it again.

### Part A — reason chip

31. Given a captured (non-manual) transaction whose current category exactly matches what the deterministic
    resolver computes today for its stored title, when its edit page loads, then the reason chip shows (e.g.
    "Dari kode mutasi bank", "Dari daftar pedagang", "Dari kata kunci" as appropriate).
32. Given a captured transaction whose category was changed by the user to something the resolver would not
    pick, when its edit page loads, then no reason chip shows (same as today's `reason === 'none'` behaviour).
33. Given a manually created transaction, when its edit page loads, then no narrative-layer chip is shown unless
    the user's own typed title happens to match a narrative/dictionary word (existing, accepted FN-20 suggestion
    behaviour, unchanged by this feature).

### Part A — money, dates, i18n, access (CLAUDE.md and the engineering checklist)

34. Given any row this feature touches (import-time categorisation, "Rapikan kategori" apply or undo), then
    `amount_minor`, `currency`, `original_amount_minor`/`original_currency` (if present) are never read or
    written by this feature's own code — only `category_id`, `updated_at` and `seq` change.
35. Given any row's `occurred_on`/`occurred_at`, then this feature never reads or writes them; WIB month/day
    bucketing used by Beranda, Laporan and budgets is unaffected by any category change this feature makes.
36. Given the eligibility scan (fallback-category rows in a space), then it is one bounded, indexed query (no
    unbounded `LIKE`/`GLOB` over free text, no `inArray` growing past 100 bound parameters — ids travel as one
    JSON parameter via `json_each`, matching every other bulk write in this codebase).
37. Given every new Indonesian phrase this feature adds (category names, the new reason label, "Rapikan
    kategori"/Part B/Part C UI copy, empty/error/success states), then each has an English entry in
    `i18n-en.ts`; the existing i18n completeness test fails otherwise.
38. Given every load and action this feature adds (`/impor`'s new preview/apply/undo endpoints, Part B's and
    Part C's), then each re-checks space membership through `requireSpaceAccess`/`currentSpaceScope` and repeats
    `isLiveMember` inside its own write statements — never trusting a cached role from an earlier request.
39. Given a concurrent apply and a concurrent manual category edit on the same row, then exactly one of them
    wins per CLAUDE.md's "Concurrent writes" rule (a guarded `UPDATE … WHERE …` inside one `db.batch`, never a
    read-then-write split across two round trips); the loser is reported, not silently overwritten.
40. Given this feature's own Vitest suite, then every regression test is shown failing on the unfixed code
    first (checklist "Fail-before proof"), and `npm run gates` is clean before hand-off.

### Part B — statement continuity per wallet

41. Given a wallet's first-ever statement import with printed Saldo Awal matching the wallet's
    `opening_balance_minor` plus the signed sum of its live transactions before the statement's earliest date,
    when previewed, then no continuity warning shows.
42. Given the owner's real numbers (wallet opening balance Rp 0, imports from 2026-07-01, computed balance up to
    that date Rp 64.636.204,87, the next statement's own Saldo Akhir Rp 74.636.204,87 for the period it covers),
    when the continuity check runs, then it reports a gap of Rp 10.000.000,00 attributed to before 2026-07-01 (the
    missing 30 June closing balance) — never silently imported.
43. Given two statements of the same wallet imported in either order (a later month first, then an earlier one),
    when both are live, then the continuity check between them still runs correctly by date, not by import order.
44. Given a continuity gap, when the user accepts "set the opening balance", then exactly one FN-37
    balance-adjustment transaction is created, dated the day before the gap period starts, for the gap amount,
    visible and undoable like any other adjustment (FN-37's own undo, unchanged by this feature).
45. Given a continuity gap, when the user declines the adjustment offer, then the statement's own rows still
    import normally; the gap is shown again next time that wallet's imports are reviewed, until resolved.
46. Given a statement whose parser reports no opening or no closing balance (`BalanceCheck` status `omitted`),
    when previewed, then no continuity claim is made for that batch (never guessed from missing data).
47. Given an undone statement import batch, when the continuity check next runs for that wallet, then the undone
    batch is excluded, as if it had never been imported.
48. Given two different wallets in the same space, when one's statements are checked for continuity, then the
    other wallet's batches never affect the result (continuity is per wallet, never per space).

### Part C — own-transfer matching

49. Given a debit row like "SWITCHING DB TRF BUDI SANTOSO 009 BANK CENTRA…" of Rp 5.000.000 on 2026-07-10 in
    wallet A (category "Transfer") and a credit row of Rp 5.000.000 on 2026-07-10 or 2026-07-11 in wallet B
    (category "Transfer") of the same space, when the transfer-matching review runs, then the pair is proposed
    as one transfer from A to B.
50. Given the user confirms a proposed pair, when the merge applies, then wallet A's row becomes
    `type = 'transfer'` with `transfer_to_wallet_id = B` and no category, wallet B's row is tombstoned, and
    every `amount_minor` involved is unchanged from what each statement originally printed.
51. Given a merged pair, when either wallet's history or Beranda/Laporan's totals are viewed, then the transfer
    shows once, linked, not as a separate expense and a separate income (no more double-counting of that pair in
    the space's income and expense totals).
52. Given a merged pair, when the user presses undo, then wallet A's row reverts to its original `type` and
    category and wallet B's row is restored with its exact original content (amount, title, wallet, date,
    category) — restored, not recreated as a new row with a new id.
53. Given two same-amount, same-window "Transfer" rows in two other wallets that are not actually a matching
    pair (coincidence), when the review lists them among several ambiguous candidates, then the user can skip
    that proposal; nothing merges without an explicit confirm, and no candidate is auto-picked.
54. Given wallet B's statement is re-imported after its credit row was merged (and tombstoned) into a transfer,
    when the re-import runs, then the dedupe key still marks that row "already imported" and it is not
    recreated (checklist: idempotent capture).
55. Given wallets A and B belonging to two different spaces (not shared), when the matching review runs for a
    user who is a member of only one, then only that space's own wallets are ever compared; no cross-space match
    is proposed or possible.
56. Given a debit row already merged into a transfer, when the review runs again, then it is never offered again
    as an unmatched "Transfer" row (it is no longer a plain expense).
57. Given a currency mismatch between two candidate rows (e.g. one wallet is USD), when the review runs, then
    they are never proposed as a pair — amount and currency must both match, never amount alone.

## Architecture notes

**Part A — shared (`src/lib/shared/`)**
- `merchants/bank-narratives.ts` (new): a pure function reading a row's lightly-normalised raw words (lower-case,
  split on non-letters, digits dropped) — *before* `cleanDescriptor`'s prefix/trailing stripping
  (`merchants/clean.ts:26-141`) removes the channel words (`trsf`, `tarikan`, `bi fast`, `db`, `cr`, …) this layer
  needs to see. Exposes the tile for a `(words, kind)` pair, or `undefined`. Pattern priority inside the module
  matters (checklist: test it): a fee signal ("biaya", "adm", "admin") must outrank a bare transfer signal
  ("trsf", "transfer", "bi fast", "bifast", "kliring", "rtgs", "switching") so AC-11 holds.
- `merchants/resolve.ts:12-31` — add `'narrative'` to `MERCHANT_REASONS` and `MERCHANT_REASON_LABELS`; wire the
  new module into `resolveDeterministic` (`resolve.ts:77-102`) as a layer between `cache` and the existing
  `tileFromWords` (dictionary/keyword) call, reading from the row's raw text, not the already-cleaned `key`.
- `merchants/dictionary.ts:77-83` — redirect the existing `['bunga', 'lain']`, `['interest', 'lain']`, `['jasa
  giro', 'lain']` entries to the new `bunga` tile (keep `refund`/`cashback`/`pengembalian`/`dividen` on `lain` —
  out of scope, not in the evidence).
- `transactions.ts:92-134` — extend `PRESET_CATEGORIES` and `TILE_KEYS` with the six new tiles (one new row each
  for `biaya-bank`, `pajak`, `tarik-tunai`, `kartu-kredit`, `bunga`; two rows — expense and income — for
  `transfer`). A locked test ties `TILE_KEYS` to `src/lib/ui/kit/category.ts`'s `CategoryKey`s: update both.

**Part A — server (`src/lib/server/`)**
- `categories/repo.ts:14-21` — widen the `LATER_PRESETS`/`CATEGORY_LIST_MAX` filter (or add a second top-up
  group) to include the six new tiles, reusing `ensurePresetCategories`/`topUpPresets` unchanged
  (`categories/repo.ts:56-121`).
- `imports/csv-import.ts:444-476` (`resolvedCategoryNames`) and `:376-433` (`categoryNameOf`,
  `matchVisibleCategory`) need no logic change — they already call `resolveMerchants`, which now carries the new
  layer. `importRows` (`csv-import.ts:489-694`) is otherwise unchanged.
- New `transactions.category_source` column (`'auto' | 'user'`, nullable) on the `transactions` table
  (`db/schema.ts:489-`), threaded through `NewTransaction`/`insertTransactions` (`transactions/repo.ts:231-298`)
  and `updateTransaction` (`transactions/repo.ts:472+`): every capture/import write sets `'auto'`; every write
  from the manual compose/edit form and every review step where a human explicitly picks a category before
  confirming (FN-11 bulk "Atur kategori", FN-15 split-per-item, FN-19 Gmail review, a voice draft's category chip
  tapped before "Simpan") sets `'user'`. This is the real fix for "how is that known" — the heuristic in AC-26
  only covers rows written before this column exists.
- New module `src/lib/server/categories/cleanup.ts` (name indicative): `previewCleanup(db, spaceId)` (eligible
  rows, bounded, AC-26's rule), `applyCleanup(db, scope, transactionIds, now)` (one `db.batch`: category update +
  cleanup batch header + per-row previous-category items, chunked like `csv-import.ts:644-646`'s `INSERT_CHUNK`),
  `undoCleanup(db, scope, batchId, expectedUpdatedAt, now)` (mirrors `imports/repo.ts:92-153`'s guarded-statement
  shape, but restores a field instead of tombstoning a row).
- New route: `src/routes/(app)/impor/rapikan-kategori/+page.server.ts` (or a sheet inside `/impor`) — `load`
  calls `previewCleanup` through `currentSpaceScope`; `actions.apply`/`actions.undo` call the above, guarded the
  same way every other `/impor` action already is (`impor/+page.server.ts:1-60`).
- `src/lib/ui/kit/category.ts:3-25` and every theme block of `docs/design/tokens.css` (grep `--cat-lain` for the
  full list) gain the six new tile entries.

**Part B — server**
- `db/schema.ts:444-478` (`importBatches`): add nullable `wallet_id` (references `wallets.id`), `period_from`,
  `period_to` (text, WIB dates), `opening_balance_minor`, `closing_balance_minor` (integer), populated only when
  `source = 'statement'`. `period_from`/`period_to` come from the min/max `occurred_on` of the batch's own
  written rows (computed in `importRows`, `imports/csv-import.ts:489-694`, not from each bank parser's internal
  `StatementPeriod`, which stays exactly as it is — `bca.ts:70`, `bni.ts:101`, `mandiri.ts:295`, `ocbc.ts:326` —
  used only to resolve a day/month cell's year). `opening_balance_minor`/`closing_balance_minor` come straight
  from `StatementParse` (`shared/statements/types.ts:22-25`), already threaded as far as
  `reading.parse`/`reading.balance` in `statements/read.ts:70-89` and `statement-import.ts:90-120` — just add
  them to what `createImportBatch` (`imports/repo.ts:44-56`) writes.
- New `src/lib/server/statements/continuity.ts`: `walletBalanceBefore(db, spaceId, walletId, beforeDate)` — one
  bounded, indexed query (signed sum of live transactions with `occurred_on < beforeDate` for that wallet,
  reusing the shape `walletBalanceMinor` expects, `wallets/balance.ts:6-13`); `continuityCheck(db, spaceId,
  walletId, candidateBatch)` — compares against the nearest earlier live statement batch for the same wallet, or
  this new helper when there is none. Called from `previewStatement`/`importStatement`
  (`statements/statement-import.ts:127-181`) before the write.
- The "set the opening balance" offer reuses FN-37's existing balance-adjustment write path unchanged
  (`migrations/0022_balance_adjustment.sql`) — a pre-filled adjustment form/action, not new transaction-writing
  code.

**Part C — server**
- New module `src/lib/server/transfers/match.ts` (indicative): `proposeTransferMatches(db, spaceId)` — one
  bounded query over live, non-demo `type in ('expense','income')` rows whose category tile is `transfer`,
  grouped by `amount_minor` + `currency`, matched to a *different* `wallet_id` within the ±1-day window (ids and
  candidate sets bound once as JSON via `json_each`, like every other bulk read in this codebase — never
  `inArray` past 100 parameters); `applyTransferMatch(db, scope, debitId, creditId, now)` — one `db.batch`:
  update the debit row's `type`/`transfer_to_wallet_id`/`category_id`, tombstone the credit row with
  `TOMBSTONE_CONTENT` (`transactions/repo.ts:420-442`, dedupe key kept — AC-54), write a `transfer_links` row
  snapshotting both rows' previous content (JSON) for undo; `undoTransferMatch(...)` mirrors
  `imports/repo.ts:92-153`'s guarded-statement shape, restoring both rows from the snapshot instead of deleting.
- New table `transfer_links` (space-scoped: `id`, `space_id`, `debit_transaction_id`, `credit_transaction_id`,
  a JSON snapshot column per side, `created_at`, `updated_at`, `undone_at`, `seq`) — append-only history of one
  merge each, no tombstone column needed (an undone link stays, marked `undone_at`).
- New route/section (same `/impor` area or its own `/dompet/transfer`): `load` calls
  `proposeTransferMatches`; `actions.merge`/`actions.undo` call the above, guarded like every other space action.

**Migration**: needed, and why. `categories_tile_key_check` is a `CHECK` constraint; SQLite cannot `ALTER` one,
so `categories` (and every table whose foreign key depends on it — `transactions.category_id`,
`drafts.category_id`, `recurring_transactions.category_id`, `category_budgets.category_id`) must be rebuilt with
every row and index kept, exactly as migration `0027_ride_food_categories.sql` already did for FN-39's two tiles
— that migration is the template to copy. The same (or a follow-up) migration adds `transactions.category_source`,
the two new `category_cleanup_batches`/`category_cleanup_items` tables (Part A), the four new `import_batches`
columns (Part B) and the new `transfer_links` table (Part C). Propose **migration 0037** for whichever part ships
first: confirm it is still free at merge time — the owner's note says FN-47 (currencies/decimals) is in progress
on another branch and may also want 0037; renumber whichever merges second, per this repo's established practice
(see `docs/TASKS.md`'s many "renumbered at merge" notes, e.g. migration 0030, 0032, 0034). If Parts B and C ship
as later passes (Owner decision 14), each takes the next free migration number at that time instead of all
three contending for 0037 at once.

## Prerequisites

None. Every part of this feature is entirely deterministic (no AI Gateway key, no Anthropic key, no new
provider, no new `.dev.vars.example` entry). FN-20's own AI step (BYOK, optional) is untouched and still only
runs for rows no deterministic layer — old or new — can name.

## Tracker impact

No existing `docs/TASKS.md` line names FN-48 (it is a new owner request, 2026-10-11); add
`[ ] **Claude** — FN-48 categories for imported rows` to the Phase 2 — Capture section when work starts. This PRD
extends, rather than duplicates, the done item `**Claude** — FN-20 Merchant recognition (2026-10-10, branch
feat/fn-20-merchants, migration 0034 …)` (`docs/TASKS.md:131-132`) and its open low finding `FN-20 low findings …
L4 fixed-window AI cap` (`docs/TASKS.md:133-135`, unaffected — this feature adds no AI call). It also builds on
FN-37 (`docs/TASKS.md`'s done balance-adjustment item) for Part B's gap-closing offer.

`docs/ACCEPTANCE.md` rows this can move once verified:
- "Statement PDF (password) → balance check → duplicates excluded → import → undo | Not run" (`ACCEPTANCE.md:17`)
  — add a note that imported rows now get real categories (Part A), and that a cross-statement balance gap is
  surfaced, not silently imported (Part B).
- "Merchant rules and cache space-scoped; removed member loses access (FN-20) | Automated" (`ACCEPTANCE.md:38`)
  — extend its Vitest reference to cover the new narrative layer and the cleanup batch's space isolation (AC-27,
  AC-28).
- Add new rows: "Imported bank-narrative rows get a specific category, not a generic fallback; hand-categorised
  rows are never touched by the clean-up action (FN-48 Part A)"; "A statement's opening balance is checked
  against the prior statement or the wallet's own balance before it; a gap is shown, never silently imported
  (FN-48 Part B)"; "A transfer between two of the user's own wallets is proposed and merged into one FN-05
  transfer row, never double-counted (FN-48 Part C)" — each Automated once this PRD's Vitest vectors pass.

## Risk tier

**Part A: Medium.** A schema change that rebuilds `categories` and every table with a foreign key into it (the
same shape as migration 0027, already done once safely), plus a new column and two new small tables, a new
shared deterministic module, and a new space-scoped write-and-undo action — every piece reuses an existing,
already-tested pattern (FN-39's preset top-up, FN-18's import-batch undo, FN-20's resolver order).

**Part B: Medium.** New columns on an existing table, one new bounded balance-before-date query, and reuse of
FN-37's existing write path for the fix — but it changes what "importing a statement" shows the user and can
surface gaps in real financial history, so it deserves its own careful review of the balance arithmetic.

**Part C: Medium-Large.** The first feature in this codebase that converts two already-written rows into one
FN-05 transfer after the fact, with a snapshot-and-undo table; money-adjacent (it changes `type` and removes a
row, even though no amount changes) and worth its own focused red-team pass on the matching/merge/undo logic
before it ships, independent of Parts A and B.

## Owner decisions (defaults proposed; pick to change)

1. **New presets vs mapping onto existing categories.** Default: add the six new preset tiles/seven rows named
   above (Biaya Bank, Pajak, Tarik Tunai, Kartu Kredit, Transfer×2, Bunga) via a migration, reusing the existing
   top-up mechanism. Alternative: map these narratives onto existing presets instead (e.g. all bank fees into
   "Tagihan", ATM withdrawals into "Belanja") — loses the specific, at-a-glance signal the owner's evidence asks
   for.
2. **"Transfer" semantics (Part A).** Default: a plain expense/income category, never FN-05's
   `type = 'transfer'`/`transfer_to_wallet_id` by itself; only Part C's explicit merge ever sets those, after a
   confirm.
3. **ATM withdrawal vs cash wallet.** Default: category-only ("Tarik Tunai" expense from the bank wallet); no
   automatic cash-wallet transfer. A future feature could offer "log the withdrawn cash in your Tunai wallet
   too", but guessing which cash wallet and whether the user actually spent/kept it is out of scope here.
4. **Credit-card bill payments.** Default: category-only ("Kartu Kredit" expense); no reconciliation with a
   separately imported credit-card statement. The known double-count risk is unchanged, not solved here.
5. **Detecting a hand-set category without an existing marker.** Default: add `transactions.category_source`
   (`'auto'|'user'`) now, going forward; for rows written before this migration, use the conservative heuristic
   in AC-26 (`updated_at = created_at` and category still a fallback tile and source ≠ manual) — accepting that
   any pre-migration row ever touched by any edit, even unrelated to its category, is skipped even if its
   category was in fact never hand-picked (safe-side false negative, not a false positive).
6. **Scope of "Rapikan kategori".** Default: every non-manual source (statement, csv, spreadsheet, gmail, voice,
   receipt) — the same fallback-category problem and fix apply identically to all captured sources, not only
   statement imports.
7. **Where the new dictionary/narrative words apply.** Default: inside FN-20's one shared resolver, so they also
   improve voice's and manual entry's live category suggestion chip (`/riwayat/saran`), not statement-import
   only — accepting that typing something like "bayar pajak kendaraan" may now also suggest "Pajak" (a
   suggestion only; the user still confirms before saving, same as every other FN-20 suggestion today).
8. **Demo rows in "Rapikan kategori".** Default: included in preview and apply, badged "Data demo" like every
   other list; still excluded from every real total (unchanged).
9. **Batch size.** Default: "Rapikan kategori" preview lists up to 500 eligible rows per run (re-run to clear
   more); apply/undo write in bounded `db.batch` chunks of 250, matching the existing import chunk size.
10. **Day window for transfer matching (Part C).** Default: same day or ±1 day (BI-FAST/SKN clearing can post a
    day apart). A wider window raises false-match risk and is not proposed.
11. **Bank-code table as a matching signal (Part C).** Default: not used to decide a match — only amount,
    currency and the date window decide; a verified code table (009/014/028/…, as the owner listed, unverified)
    could later appear as explanatory text on the confirm screen only, never to silently pick between ambiguous
    candidates. The owner's codes need independent verification before any UI states them as fact.
12. **Account holder name as a signal (Part C).** Default: not used — Montra does not store the user's legal
    name against transactions to compare against narrative text; out of scope this pass.
13. **Where the continuity-gap fix lands (Part B).** Default: one FN-37 balance-adjustment transaction dated the
    day before the gap period, never a direct, invisible edit to `wallets.opening_balance_minor`.
14. **Scope split.** Default: ship as up to three build passes under this one PRD — Part A (new presets +
    narrative layer + "Rapikan kategori", medium risk, no cross-wallet logic) first, then Part B (continuity) and
    Part C (transfer matching) each as their own `/build-feature` pass with their own migration and red-team
    cycle, since both touch money-adjacent logic (a wallet's running balance, a row's `type`) that deserves
    focused review separate from Part A's category work.

## Owner decisions — answered 2026-10-11

All defaults accepted. Asked explicitly: (1) add the six new preset categories; (10) transfer match window same day
or ±1 day; (13) a continuity gap is fixed with one visible FN-37 balance-adjustment row after the user confirms;
(14) three build passes, Part A (categories) first. Decisions 2–9, 11 and 12 take the proposed defaults.
Orchestrator risk tier: Large for each pass (each adds a migration). Migration numbers start at 0037 (no other open
branch adds one).
