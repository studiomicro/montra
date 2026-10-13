# QA report — FN-48 Part C own-transfer matching (`fn-48c-transfer-matching`)

**Verdict: PASS**

Cycle 1. Branch `feat/fn-48c-transfer-matching`, rebased onto `main` (`a45585f`) before review; reviewed
`git diff a45585f..HEAD` (PRD `115ff51`, cycle 1 `34fec61`; pre-rebase `c876cf1..6f4b420`). No change to `src/`,
`workers/` or `migrations/` by QA. One QA test file added (uncommitted):
`test/integration/cocokkan-transfer.qa.test.ts` (8 tests, formatted with Prettier, ESLint clean, svelte-check clean).

## Commands run

- `git rebase main` — "Successfully rebased and updated refs/heads/feat/fn-48c-transfer-matching" (2 commits replayed on a45585f); exit 0; local git.
- `npm run gates` — check: "COMPLETED 2263 FILES 0 ERRORS 0 WARNINGS"; lint: "All matched files use Prettier code style!" + eslint clean; test: "Test Files 347 passed (347) / Tests 5540 passed (5540)" (release-notes.test.ts passes after the rebase); build: "✓ built"; exit 0; local D1 (miniflare), AI bound to the test stub, no real provider.
- `npx vitest run test/integration/cocokkan-transfer.qa.test.ts test/integration/cocokkan-transfer.test.ts test/integration/migration-0043.test.ts src/lib/server/transfers/match.test.ts src/lib/shared/i18n` — "Test Files 5 passed (5) / Tests 45 passed (45)" (after fixing one QA-test assertion that read a tombstone through `getTransaction`, which hides tombstones by design); exit 0; local D1, no real provider.
- `npx vitest run test/integration/cocokkan-transfer.qa.test.ts` — "Test Files 1 passed (1) / Tests 8 passed (8)"; exit 0; local D1.
- `FIN_PERSIST_TO=<scratch>/fresh-d1 npm run db:migrate:local` on an empty directory — every migration 0001…0043 "✅", `0043_transfer_links.sql ✅`; exit 0; local miniflare D1 only.
- `FIN_PERSIST_TO=<scratch>/fresh-d1 npm run db:migrate:local` again — "✅ No migrations to apply!"; exit 0; sqlite3 lists `transfer_links`, `transfer_links_space_idx`, `transfer_links_debit_live_uq`, `transfer_links_credit_live_uq`.
- `PATH=<scratch>/shim:$PATH E2E_PORT=8831 npx playwright test e2e/cocokkan-transfer.spec.ts --workers=1` (no-op `flock` shim) — "5 passed (14.7s)" (setup + phone + desktop × 2 specs); exit 0; real browser against local wrangler dev, local D1, no real provider.
- `npx prettier --check` / `npx eslint` on `test/integration/cocokkan-transfer.qa.test.ts` — both clean; exit 0.
- `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` with the QA test present — "COMPLETED 2264 FILES 0 ERRORS 0 WARNINGS"; exit 0.

## Checked criteria

| AC | Result | Evidence |
| --- | --- | --- |
| 1 Owner pair proposed A→B (same or next day) | PASS | `cocokkan-transfer.test.ts` "proposes the owner's BCA → OCBC pair once, titles masked…" (debit 10 Jul, credit 11 Jul, masked `••••7890`); "a credit the day before the debit pairs too". |
| 2 Merge: debit → `type='transfer'`, `transfer_to_wallet_id=B`, no category; credit tombstoned; amounts unchanged | PASS | "merges the pair into one transfer: amounts untouched…" — byte-for-byte compare of the debit row (`{...was, type:'transfer', transfer_to_wallet_id: B, category_id: null, category_source: null}`), credit tombstone keeps `id`, `dedupe_key`, `created_at`, `source`. |
| 3 Shows once; no double counting in totals/history | PASS | QA test "after the merge the real periodTotals/monthlyTotals count one transfer…" — `periodTotals` in=0 out=650.000 transferCount=1; `monthlyTotals` 2026-07 same; `listTransactionsByDay` wallet B shows one `transfer` row with `toWallet=B`, wallet A shows `['expense','transfer']`; wallet balances unchanged. e2e: Riwayat shows the debit title once and the credit title 0 times. |
| 4 Undo restores both rows exactly (same id, same `created_at`) | PASS | "restores both rows exactly (same id, same created_at), once…" — every column equals the pre-merge row except `updated_at`/`seq`; row count stays 3; link `undone_at` set; pair offered and mergeable again. |
| 5 Ambiguous group listed whole; skip; nothing auto-picked | PASS | `match.test.ts` (5 grouping vectors); integration "an ambiguous set … is one group of every candidate"; QA "a 2×2 chain is one ambiguous group of four; after one confirm the other pair is a plain group". e2e "Lewati" hides for the visit, back after reload, nothing written. |
| 6 Re-import after merge: "already imported", not recreated | PASS | "re-importing wallet B's file after the merge finds its credit row already imported…" — `importRows` → `{imported: 0, already: 1}`, one row with the dedupe key. |
| 7 Two spaces never compared | PASS | "another space sees none of it, and two spaces never pair with each other" — counts 0/0 across two users. |
| 8 Merged debit never offered again | PASS | `countTransferMatches` = 0 after merge (merge test); AC-13 ordering test shows only eligible rows. |
| 9 Currency mismatch never paired | PASS | USD-wallet credit excluded (proposal test); QA "same integer amount in a different currency is never paired, even inside IDR wallets". |
| 10 FN-48B continuity unaffected; wallet B balance unchanged | PASS (with a documented edge, see Findings 1) | "FN-48B continuity still reconciles after a merge…" — `continuityBreaks` `[]` before and after, batch balances unchanged, `import_batch_id` kept on the tombstone, `readWalletBalance(B)` = 5.000.000 before and after. |
| 11 "BIAYA TXN" fee never a candidate | PASS | Fee row (`biaya-bank`, Rp 6.500) untouched and uncounted in every proposal test. |
| 12 One-sided category never proposed | PASS | Debit side: `belanja` narrative "TRSF E-BANKING DB BELUM DIRAPIKAN" excluded; QA credit side: `lain` income excluded. |
| 13 200-pair cap, true total on card | PASS | "lists the newest 200 pairs and still counts every pair" — `{total: 205, shown: 200}`, newest first (`2025-07-25` first, `2025-01-02` absent); page shows "Ditampilkan {shown} … dari {total}"; `/impor` card uses `countTransferMatches`. |
| 14 Membership re-checked on load/merge/undo; removed member and non-member 404; cross-space link id 404 (no oracle) | PASS | Integration "another space's pair or link id answers 404 like any unknown id" (`toEqual` of cross vs unknown responses); "a removed member gets 404 on load, merge and undo"; QA "a user who was never a member … 404" on all three; write statements repeat `isLiveMember` (`match.ts`). |
| 15 Resubmit idempotent ("already merged"/"already undone") | PASS | Resend returns `already`, rows and `transfer_links` unchanged; routes return `{done:'already', message}`; 20 concurrent merges → 1 ok/19 already, one link, one tombstone; 20 concurrent undos → 1 ok/19 already. |
| 16 Concurrent edit vs merge: one winner, loser reported | PASS | "a row edited between review and confirm is never merged: stale, nothing written" → route 409 `TRANSACTION_CHANGED`; undo after edit/delete → `stale`, link stays live; all writes in one `db.batch` with `updated_at` guards. |
| 17 Loading / error / saved-after-confirm / true empty state | PASS | `+page.svelte`: `Skeleton` while navigating/refreshing, `ErrorState` with `onretry` when `loadError`, `EmptyState` when no groups; success text derives from the server's `form.done` only; e2e: card absent when count 0 and after merge. Load error path returns `TRANSFER_MATCH_LOAD_FAILED`, never a stack trace. |
| 18 i18n English entries | PASS | i18n completeness test in `npm run gates` (5540 passed); `i18n-en.ts` block "FN-48 Part C own-transfer matching". |
| 19 Integer `amount_minor` + `currency`; `occurred_on` only for the window | PASS | SQL `c.amount_minor = d.amount_minor and c.currency = d.currency … c.occurred_on between date(d.occurred_on,'-1 day') and date(d.occurred_on,'+1 day')`; QA "23:30 WIB on 31 July and 00:30 WIB on 1 August … paired" and "two WIB days apart is never paired even when the UTC days of occurred_at are adjacent". |
| 20 Fail-before proof; gates clean | PASS | Gates clean (above). Fail-before: the suite imports `#lib/server/transfers/match` and the new route, which do not exist on the PRD commit, so every test fails there by construction; QA did not re-run that state. |
| 21 360 px, no horizontal scroll, ≥44 px targets | PASS | e2e at 360×780 (Pixel 7, touch): `expectNoHorizontalScroll` before and after merge; "Cocokkan", "Lewati", "Urungkan" bounding-box height ≥ 44. |

Also verified: `transfer_links` added to `SPACE_SCOPED_TABLES` (space deletion) and `SPACE_TABLE_DECISIONS`
(export, `json`); migration 0043 is `CREATE … IF NOT EXISTS` only and re-runs without change
(`migration-0043.test.ts` + fresh-DB re-run above); unique partial indexes allow one live link per debit and per
credit row; no change to `aggregate.ts`/`wallet-sum.ts`; titles masked with `maskAccountNumbers`; `{#each}` keyed by
ids; forms read through `readFormBody`; no `inArray`, no `LIKE`.

## Engineer-declared departures — judgement

1. **Patungan-bill debits and credits with a kept receipt photo are not proposed.** Acceptable, conservative: a
   Patungan bill must stay an expense (its split links require it) and the tombstone nulls `photo_key`, so a kept
   R2 photo could not be restored exactly on undo. Covered by "a debit that is a Patungan bill or a credit with a
   kept photo is not offered". Not an AC violation; worth one line in the parent FEATURES note so the owner knows
   such a pair must be merged by hand (edit the debit to a transfer, delete the credit).
2. **Merged transfer keeps the debit's date.** Acceptable; see Finding 1 (Low) for the one edge it leaves.
3. **`merge` returns `{ done: 'merged' }`.** PRD fixes no response shape; the page shows the success text only from
   this server answer, so "saved only after a confirmed write" holds. Acceptable.
4. **"Lewati" is client-side only.** Matches owner decision 3 (nothing written besides `transfer_links` and the
   two rows) and AC-5 ("the user can skip that proposal"). The page labels it as per-visit; e2e proves the group is
   back after reload. Acceptable.

## Findings

1. **Low — AC-10 edge (declared):** when wallet B's *first* statement starts on the credit's day and the debit is
   the day before, the merged transfer (dated on the debit's day) moves Rp 5.000.000 into B before that
   statement's `period_from`, so FN-48B reports a `gap` (`expectedMinor: 5.000.000`, `openingMinor: 0`) until undo.
   Shown truthfully, never hidden; undo clears it (test "a pair straddling wallet B's first statement's first day…").
   Owner's real case (monthly statements, 10/11 July) is not affected. Suggest a follow-up: let the user pick which
   side's date the merged row keeps, or note it in the review copy.
   - **Resolution (2026-10-13): FIX.** `fix(import): transfer-match lows: deleted merge stays deleted on import undo, older links page, no straddle gap (FN-48C L3, QA lows)`. FN-48B's window sum (`walletWindowSql`) now leaves out a merged transfer whose credit row came from the statement being checked (or the earlier one it is compared with): that money is already inside the statement's printed balances. The pair straddling wallet B's first statement now passes without a gap; the undo still restores everything. Test: `cocokkan-transfer.test.ts` "a pair straddling wallet B’s first statement’s first day leaves no gap: the credit was in that statement (QA low)".
2. **Low — undo list capped at 50:** `listTransferLinks` returns the 50 newest live links; an older live link is
   not undoable from the UI (no AC covers this; the link row is still intact in D1).
   - **Resolution (2026-10-13): FIX.** `fix(import): transfer-match lows: deleted merge stays deleted on import undo, older links page, no straddle gap (FN-48C L3, QA lows)`. The links list is paged, 50 per page, newest first: "Lihat yang lebih lama" (`?sebelum=<created_at>.<id>`, a plain link that works without JavaScript) and "Kembali ke yang terbaru", so every live link stays reachable to undo. A forged cursor reads as the first page. Test: `cocokkan-transfer.test.ts` "QA low: every live link stays reachable to undo, 50 per page, newest first, via ?sebelum".
3. **Info — write-level refusal for a lost membership is `stale` (409 "changed meanwhile"), not 404:** only
   reachable if the route-level `currentSpaceScope` 404 were bypassed; nothing is written either way (test "a
   removed member gets 404 …" last assertion).
4. **Info — screenshots:** none kept; the e2e spec attaches one 360 px screenshot only on failure/attachment
   retention, and every assertion in this run was a DOM assertion.

No ENGINEERING_CHECKLIST item violated in the diff.

---

# Cycle 2 (fix of red team M1/M2; `git diff 34fec61..b995b39`)

**Verdict: PASS on the cycle-2 change (every AC and M1/M2/move check verified). `npm run gates` was NOT reproduced as one clean run: the host was saturated (load 40-90, swap 9-11 GB of 10-12 GB, other sessions' vitest/wrangler running), so unrelated D1/miniflare suites died with `TypeError: fetch failed` / `ECONNRESET` / timeouts. Re-run `npm run gates` once on a quiet host before `/ship`.**

## Commands run

- `npm run gates` (run 1) — check "COMPLETED 2264 FILES 0 ERRORS 0 WARNINGS", lint clean, test "Test Files 4 failed | 344 passed (348) / Tests 4 failed | 5550 passed (5554)", exit 1; the 4 failures are `langganan-check`, `rapikan-kategori` (both `fetch failed ECONNRESET`), `xlsx-cpu` (1168 ms vs 1000 ms), `answer-guard` (79 ms vs 50 ms) — none touched by the diff; local D1, no real provider.
- `npx vitest run` on those 4 files — "Test Files 4 passed (4) / Tests 177 passed (177)"; exit 0; local D1.
- `npx vitest run test/integration/cocokkan-transfer.qa.test.ts test/integration/cocokkan-transfer.test.ts test/integration/migration-0043.test.ts src/lib/server/transfers/match.test.ts src/lib/shared/i18n test/integration/impor` — "Test Files 12 passed (12) / Tests 174 passed (174)"; exit 0; local D1 (includes the 6 new regression tests, `imports-move`, `impor`, the i18n English-entry test).
- `npm run gates` (runs 2, 3) — check/lint clean, test failed on `koleksi`, `net-worth` (run 2: 3 tests, `fetch failed` + 30 s timeout) and on 51 files (run 3: `fetch failed` in `applyMigration`, `dispose is not a function`, i.e. miniflare died); exit 1 each; host out of memory, not a code failure (those files are untouched by the diff).
- `npx vitest run --maxWorkers=4` — 25 files failed with the same miniflare errors under swap pressure; exit 0 of the shell wrapper, not a pass; a `--maxWorkers=2` retry of those files was killed by me after more of the same.
- `npm run build` — "site-adapter: 18 prerendered site files bundled into the Worker / ✔ done"; exit 0; local.
- `PATH=<scratch>/shim:$PATH E2E_PORT=8847 npx playwright test e2e/cocokkan-transfer.spec.ts e2e/cocokkan-transfer-move.qa.spec.ts --workers=1` (no-op `flock` shim) — "7 passed (29.1s)" (setup + phone + desktop x 3 specs); exit 0; real browser against local wrangler dev, local D1, no real provider.
- `npx prettier --check` + `npx eslint` on `e2e/cocokkan-transfer-move.qa.spec.ts` — both clean; exit 0.

## Checked criteria

| Check | Result | Evidence |
| --- | --- | --- |
| AC-1..AC-20 still hold | PASS | Feature suites above (qa + cocokkan-transfer + match unit + migration-0043 + i18n): 174 passed; e2e `cocokkan-transfer.spec.ts` (360 px touch, reload persistence, undo, skip, no-JS posts): passed. Cycle-2 refactor of `undoTransferMatch` (snapshot-based `debitRestore`/`creditRestore`, shared guards) leaves the cycle-1 undo tests green. |
| M1 (undo of a match must not revive a row of an undone import) | PASS | `M1 guard: a link whose row's import is undone can never revive that row (stale, nothing written)`; SQL guard `rowImportLive` on both rows in `undoTransferMatch`. |
| M1/M2 (undoing an import batch settles live links in the same `db.batch`) | PASS | `M2: undoing the debit's import restores the other import's credit row exactly and settles the link`; `M1: undoing the credit's import settles the link and gives the debit its expense back; the credit stays a tombstone`; `both rows in one import: its undo tombstones both and settles the link without restoring either`; `a debit edited since the merge stays as edited when the credit's import is undone; the link is still settled`. Settling is guarded by the batch's own `seq` (`undoneNow`), so a refused/stale undo writes nothing. |
| FN-16j move refuses a batch with a live link | PASS | `FN-16j: an import with a row in a live link cannot move (either side) until the match is undone` (409 `transfer_linked`, nothing written, moves after the match is undone); the write-time guard `not batchHasLiveTransferLink` sits in the batch-row UPDATE, so a race between the check and the write still refuses. |
| Blocked-move note shows on /impor | PASS | New QA e2e `QA cycle 2: /impor shows the transfer_linked note while the match is live, and not after undo` (phone + desktop): before merge the "mixed wallets" note shows; after merge the "Ada transfer dari impor ini yang sudah dicocokkan…" note shows, the mixed note and the "Pindahkan ke dompet lain" control are gone; after undo the linked note is gone. DOM assertions only, no screenshots. |
| Indonesian string has English entry | PASS | `i18n-en.ts` entry added; the i18n test passes. |
| Space authorization / money / WIB | PASS (unchanged) | All new SQL is scoped by `space_id` on `transfer_links`, `transactions` and `import_batches`; the QA test "a user who was never a member … 404" and the WIB 23:30/00:30 tests still pass. |
| ENGINEERING_CHECKLIST | PASS | No item violated in `34fec61..b995b39` (parameterised, bounded, single `db.batch`, no interactive transaction, no fabricated figures). |

## Findings

1. **Medium (environment, not code): `npm run gates` not clean in any single run on this host.** Scenario: three full runs and a throttled `--maxWorkers=4` run all failed with miniflare `fetch failed` / `ECONNRESET` / timeouts in files the cycle does not touch, with the machine at load 40-90 and swap nearly full; every failed file passes when run alone (run 1's four, verified). Expected: one clean run. Action: re-run `npm run gates` on a quiet machine before shipping; if any failure then names a cycle-2 file, treat as FAIL.
2. **Low (carried): cycle 1 Findings 1-4 unchanged.** The 50-link undo cap remains.
3. **Info:** one QA file added, uncommitted: `e2e/cocokkan-transfer-move.qa.spec.ts` (1 test x 2 projects, Prettier and ESLint clean). Cycle-2 behaviour worth the owner's note: after an import undo settles a link, the link leaves the "Urungkan" list (as designed), and an edited debit is left as the user edited it.

---

# Cycle 3 (fix of red team M3/L1/L2; `git diff 0478c20..3bcbe23`, rebased onto main 3265fb6)

**Verdict: PASS.** M3, L1 and L2 verified; every AC and the cycle-2 behaviour (M1, M2, FN-16j `transfer_linked`) still hold. Host was quiet this run (load 2-8).

## Commands run

- `npm run check` — "COMPLETED 2268 FILES 0 ERRORS 0 WARNINGS"; exit 0; local.
- `npm run lint` — "All matched files use Prettier code style!", eslint silent; exit 0; local.
- `npm run build` — "site-adapter: 18 prerendered site files bundled into the Worker / ✔ done"; exit 0; local.
- `npx vitest run test/integration/cocokkan-transfer.test.ts` — "Test Files 1 passed (1) / Tests 25 passed (25)"; exit 0; local D1 (includes the new M3 test).
- `npx vitest run test/integration/cocokkan-transfer.qa.test.ts` — "Tests 8 passed (8)"; exit 0; local D1.
- `npx vitest run src/lib/server/transfers/match.test.ts` — "Tests 5 passed (5)"; exit 0.
- `npx vitest run test/integration/migration-0043.test.ts` — "Tests 2 passed (2)"; exit 0; fresh local D1.
- `npx vitest run test/integration/impor.test.ts` — "Tests 28 passed (28)"; exit 0; local D1.
- `npx vitest run test/integration/imports-move.test.ts` — "Tests 16 passed (16)"; exit 0; local D1.
- `npx vitest run src/lib/shared/i18n.test.ts` — "Tests 12 passed (12)" (English-entry coverage); exit 0.
- `npm run test` — "Test Files 1 failed | 348 passed (349) / Tests 5679 passed | 6 skipped"; the one failure `test/integration/offline-forms.test.ts` (file-level, no test failed; untouched by the diff); `npx vitest run test/integration/offline-forms.test.ts` alone — "Tests 6 passed (6)", exit 0, so a transient collection failure under parallel load, not code.
- `PATH=<scratch>/shim:$PATH E2E_PORT=5397 npx playwright test e2e/cocokkan-transfer.spec.ts e2e/cocokkan-transfer-move.qa.spec.ts e2e/impor.spec.ts --workers=1` — "51 passed (1.0m)"; exit 0; real browser, local wrangler dev, local D1, no real provider.
- Same with `e2e/cocokkan-transfer-move.qa.spec.ts` after adding the L2 test — "5 passed (17.5s)"; exit 0; Prettier and ESLint clean on the file.
- `git checkout -- docs/features/*/shots` — restored rewritten PNGs.

## Checked criteria

| Check | Result | Evidence |
| --- | --- | --- |
| M3: credit restored into a wallet archived since the undo; visible after restore | PASS | `M3: undoing the debit’s import restores the credit into its wallet archived since; restoring the wallet shows it`: credit row equals its pre-merge snapshot, link settled, `undoTransferMatch` after `restoreWallet` answers `already`, credit live, wallet B balance = Rp 5.000.000. Code: `creditWalletLive` removed from the restore path. |
| L1: restores driven from the batch's rows, same behaviour | PASS | New statements start from `transactions_import_batch_idx` and the live-link indexes (`+space_id` steering, `cross join`); all 25 + 8 cocokkan tests (M1, M2 edited-debit, both-in-one-import cases) unchanged and green. Plan not re-measured by QA (red team did, SECURITY_REPORT cycle 3). |
| L2: `ok_transfer_kept` path + note + English entry | PASS | Integration: edited debit, credit's import undone returns `ok_transfer_kept`, debit stays as edited, link settled. `impor/+page.server.ts` returns `{done:'undone', batchId, transferKept}`; `+page.svelte` `done` derived shows the note when `form.transferKept`, else "Impor diurungkan."; the only other `undoImportBatch` caller is that action. English entry present in `i18n-en.ts`, i18n test passes. New QA e2e `QA cycle 3 (L2)` (phone + desktop): two imports, merge, edit the transfer's note in Riwayat, undo the credit's import: the note text shows. DOM assertion only. |
| Rebase conflict in undo action | PASS | `batchId` is unused by the page template (only `done`/`transferKept` read); plain `?/undo` still shows "Impor diurungkan." (e2e `impor.spec.ts` undo step passes). |
| M1/M2 and FN-16j move refusal `transfer_linked` | PASS | Existing M1/M2 tests and `FN-16j: an import with a row in a live link cannot move...` pass; `imports-move` 16 passed; e2e `QA cycle 2` passes. |
| AC-1..AC-20 | PASS | Feature suites and `cocokkan-transfer.spec.ts` (360 px touch, reload persistence, undo, skip, no-JS) all pass. |
| FN-51 motion rebase | PASS | `impor.spec.ts` and `cocokkan-transfer.spec.ts` pass on the rebased tree. |
| ENGINEERING_CHECKLIST | PASS | No item violated in the cycle-3 diff: parameterised, bounded (batch-driven) SQL, one `db.batch`, no interactive transaction, space-scoped, no fabricated figures, Indonesian string has an English entry. |

## Findings

1. **Low (carried from red team L3, not a regression, not blocking):** import undo of the debit's batch revives the credit after the user deleted the merged transfer (the credit restore does not check the debit). The row is real, visible and deletable. Tracked in SECURITY_REPORT; owner may defer.
2. **Low (carried):** cycle 1 Findings 1-4 unchanged (50-link undo cap).
3. **Info:** `test/integration/offline-forms.test.ts` failed once as a file-level collection error in the full run and passed alone; unrelated to the diff.
4. **Info:** QA file `e2e/cocokkan-transfer-move.qa.spec.ts` now has two tests (cycle 2 note, cycle 3 L2 note); uncommitted, Prettier and ESLint clean.
