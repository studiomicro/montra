# FN-48 Part A (statement categories, "Rapikan kategori"): security review

- Scope: `git diff 81d7d5a..98c5147` (commit 98c5147, reviewed in the detached worktree `montra-worktrees/fn-48-qa`).
- Reviewer: red-team-pentester, 2026-10-11. No source edited. Temporary PoC tests were written, run and deleted
  (`git status` clean in the review tree afterwards).

## Verdict: PASS

No medium or high findings. Three low findings and two informational notes are listed below so they are tracked.

## Findings

### L1 (low): sender- or merchant-controlled text can steer a row's category through the narrative layer

- `src/lib/shared/merchants/bank-narratives.ts:96-110`, used by `src/lib/shared/merchants/resolve.ts` (the narrative
  layer comes before the dictionary).
- Scenario: the payer of an incoming BCA transfer writes "BUNGA" in the transfer note. The row
  `TRSF E-BANKING CR 1407/FTSCY BUNGA DEPOSITO ANDI` (income) is filed as "Bunga" instead of "Transfer masuk".
  The same happens with a merchant whose descriptor contains "BIAYA ADM" or "PAJAK": the card purchase
  `KARTU DEBIT TOKO BIAYA ADM` is filed as "Biaya Bank", and `QRIS TOKO PAJAK` as "Pajak". Fullwidth forms such
  as `ＢＩＡＹＡ　ＡＤＭ` also match, because of NFKC. The PoC confirmed all of these.
- Impact is limited to the category. Nothing else can be influenced: type, amount, wallet, date, the transfer
  link and `source` are never read from the narrative. Only `expense` and `income` rows are touched, and no total
  excludes a category by its tile (checked in `transactions/aggregate.ts`). Fee and tax words never apply to
  income rows. The worst effect is that per-category reports and budgets can be skewed: a merchant's purchases
  could show up as "Biaya Bank" or "Pajak" instead of shopping.
- Mitigations already in place: the user reviews before "Terapkan", the batch can be undone, a space rule still
  wins, the reason chip shows "Dari kode mutasi bank", and the same input existed before FN-48 through the
  dictionary layer.
- Suggested fix (optional): for `CR` (income) narratives, read only the bank's fixed prefix tokens, not the
  free-text tail.

**Resolution (2026-10-13): FIX.** `fix(import): sender and merchant text never picks a statement category; 0037 recovery in RUNBOOK (FN-48A L1, L2)`. A `KARTU DEBIT`/`QRIS` purchase (the merchant's own name follows) gets no narrative tile, and an income row is read only up to its first transfer word (the sender's note follows it), so "… BUNGA DEPOSITO", "… PAJAK", "KARTU DEBIT TOKO BIAYA ADM" and "QRIS TOKO PAJAK" no longer pick Bunga, Pajak or Biaya Bank; the bank's own prefixes ("BUNGA", "PAJAK BUNGA", "SWITCHING DB BIAYA TXN") still do. Test: `bank-narratives.test.ts` "red team L1: a sender’s note or a merchant’s name never picks a fee, tax or interest tile".

### L2 (low): migration 0037 cannot be fully re-run after a partial apply

- `migrations/0037_fn48_categories.sql:285-286` (the two trailing `ALTER TABLE … ADD category_source`).
- Scenario: suppose a remote apply ever stops after line 285 but before wrangler records 0037 in `d1_migrations`.
  A re-run then rebuilds everything again and stops with "duplicate column". 0037 is never recorded, so every
  later migration is blocked until someone fixes it by hand.
- No data is lost in that case. The `__fn48_links` scratch table is created without `IF NOT EXISTS`, so a run
  that stopped mid-rebuild halts at line 22 with its saved links still in place, rather than wiping them.
- This departs from the ENGINEERING_CHECKLIST "Migrations: re-runnable" rule. The migration header acknowledges it.
- Risk is low: wrangler sends one migration file as a single D1 batch, which D1 runs atomically. This review did
  not verify that behaviour against remote D1.
- Suggested fix: add a RUNBOOK recovery line, or mark the migration applied by hand after checking that both
  columns exist. Take the Time Travel bookmark first, as the header says.

**Resolution (2026-10-13): FIX (runbook).** `fix(import): sender and merchant text never picks a statement category; 0037 recovery in RUNBOOK (FN-48A L1, L2)`. 0037 is applied and is never edited; `docs/RUNBOOK.md` now has the recovery: apply only through `wrangler d1 migrations apply` after the Time Travel bookmark; if an apply stops after the ALTERs, check `category_source` on both tables and the six new tiles, record `0037_fn48_categories.sql` in `d1_migrations` by hand and re-run, else restore the bookmark. Documentation only, so no test.

### L3 (low): a client can cut a review short, but cannot widen it

- `src/routes/(app)/impor/rapikan-kategori/+page.server.ts:74-77` and `src/lib/server/categories/cleanup.ts:195`.
- The client chooses the set of ids, but every id is checked again on the server against `eligible(spaceId)`. The
  target category is recomputed on the server and must be a visible category of this space and of the row's kind
  (`stillAsReviewed`). The plan is bound only as a JSON parameter.
- So a forged id from another space, a manual row, a `user` row, a hand-edited legacy row, a transfer, an
  adjustment or a deleted row writes nothing. A forged category id cannot be sent at all. Existing tests and the
  PoC confirmed this.
- Tracked only because the server, not the request, decides which category a row gets. No exploit was found.

### I1 (info): batch ids are globally unique, so a cross-space id reuse returns a different status

- `cleanup.ts:194` checks the batch id within the space. `cleanup.ts:228` checks it across all spaces.
- If space B reuses space A's batch UUID, B gets `stale` instead of `ok`. B writes nothing, and A's batch is
  untouched (tested in `rapikan-kategori.test.ts:685`).
- Using this as an existence oracle requires guessing a 122-bit UUID that only A's page data holds. Not exploitable.

### I2 (info): opening the page can write to the database

- `previewCleanup` → `ensurePresetCategories` (`cleanup.ts:153`): a GET can insert missing presets. This is the
  same pattern as the existing edit page.
- The write is idempotent and does not bump `space_seq` when no preset is missing (PoC: seq 2 → 2 across two
  previews). There is no CSRF impact beyond topping up presets the app would add anyway.

## Attack areas checked with no finding

- **IDOR and membership.** Load, apply and undo all go through `currentSpaceScope`. Every write statement repeats
  `isLiveMember`, so a removed member is refused at once (tests at lines 805 and 787). An undo with another space's
  batch id answers `missing`, the same 404 as an unknown id. Any live member may undo, the same as with import undo.
- **CSRF.** These are form actions. `vite.config.ts` does not override SvelteKit's origin check, and the body goes
  through `readFormBody` (allowed form types only, 32 KiB cap on apply).
- **Replay, stale tokens and races.**
  - PoC: 20 concurrent undos of one batch gave 1 `ok` and 19 `already`.
  - Replaying an old undo token after a re-apply under a new nonce gave `already`, and the rows kept the new
    categories.
  - Running undo(b2) and apply(b3) at the same time left consistent rows.
  - 20 concurrent applies of one review wrote one batch (existing test).
  - An undo with a stale `updatedAt` gives `stale`.
- **Undo after a hand edit.** `nextUpdatedAt` is always greater than `applied_updated_at`, so an edited row never
  matches `i.applied_updated_at = t.updated_at` and is kept. Undo also skips a row whose previous category was
  deleted, and tombstoned rows.
- **Bounds and D1 limits.**
  - At most 500 ids, deduplicated. Writes go in chunks of 250, each with a single JSON parameter. The parameter
    count stays far below 100.
  - The resolver runs at most 3 calls of 200 distinct titles, with `allowAi: false`, so there is no AI cost or
    prompt-injection path.
  - The count is `count(*)` in SQL.
- **Sync.** Each write uses `bumpSpaceSeq` plus `currentSpaceSeq` on rows and on the batch. Only `category_id`,
  `category_source`, `updated_at` and `seq` change.
  - The new tables are in `SPACE_SCOPED_TABLES`, so they are deleted with the space and the account.
  - The export omits `created_by_user_id`.
  - The items hold ids only, no text.
- **`category_source` trust.** The client can never set it:
  - Edit form, API v1, sync push and voice: always `user` (`transactions/repo.ts:301` and `:501`, `MANUAL`
    origin).
  - Imports: `auto` only when the CSV has no category cell.
  - Drafts: `user` after "Atur kategori"; otherwise the stored guess, `auto`.
  - A pre-0037 `null` row counts only while `updated_at = created_at`.
- **Migration 0037 data shape.**
  - Every table with a foreign key to `categories` is handled: transactions, drafts, recurring, budgets,
    merchant_rules and merchant_cache. merchant_cache's composite primary key makes its `json_array` key unique.
  - Every index and the trigger are recreated exactly as in 0020, 0023, 0027 and 0034.
  - No `updated_at` or `seq` changes.
  - Deleted presets are not recreated, because `ensurePresetCategories` ignores `deleted_at` when looking for an
    existing preset.
  - `migration-0037.test.ts` checks rows one by one across all linked tables.
- **ReDoS.** `narrativeWords` caps input at 300 code points, using a slice of 1,200 code units before
  normalisation. PoC timings on 1 to 1.5 MB inputs, including U+FDFA, which NFKC expands: at most 2.6 ms.
- **Output.** No `{@html}` in the changed Svelte files. Titles in the review are passed through
  `maskAccountNumbers`. The only server log is `errorLabel(e)`, with no row text.

## Commands run

- `npx vitest run test/integration/rapikan-kategori.test.ts test/integration/migration-0037.test.ts src/lib/shared/merchants`
  → Test Files 6 passed (6), Tests 77 passed (77).
- Temporary PoC `test/integration/zz-poc-sec.test.ts` (narrative timing and planted words) → 2 passed. Deleted.
- Temporary PoC `test/integration/zz-poc-db.test.ts -t poc-db` (concurrent undo, replay, race, seq on GET, hidden
  target) → 3 passed. Deleted.
- Not run: e2e (not needed for these findings), remote D1 apply (no remote access, and not permitted).
