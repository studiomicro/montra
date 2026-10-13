# QA Report — FN-48 Statement Categories, Part A

**Verdict: PASS**

Scope: PRD Part A only (new preset categories, bank-narrative recognition layer, "Rapikan kategori",
reason chip, migration 0037). Parts B and C are out of scope for this cycle (not yet implemented in this diff).

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0, no provider.
- `npm run gates` (check, lint, test, build) — exit 0; `Test Files 322 passed (322)`, `Tests 5182 passed (5182)`; no AI/network provider, D1 via miniflare in-memory.
- `npm run db:migrate:local` on a fresh local D1 (`.wrangler/state-qa-fresh`) — all 38 migrations 0000–0037 applied, all ✅; local D1 only.
- `npm run db:migrate:local` run a second time on the same DB — `✅ No migrations to apply!` (no-op confirmed); local D1 only.
- `PRAGMA foreign_key_check` on the fresh post-0037 DB — empty result (no violations); local D1 only.
- Manual fixture (users/spaces/wallet/18 categories/transactions/category_budgets/recurring_transactions/merchant_rules/merchant_cache) inserted into a D1 migrated to 0036 only, then `npm run db:seed:local` — counts captured: categories 18, budgets 1, recurring 1, merchant_rules 1, merchant_cache 1, transactions 8; local D1 only.
- `npm run db:migrate:local` applying 0037 onto that seeded 0036 DB — `62 commands executed successfully`, ✅; local D1 only.
- Post-0037 counts on the same DB — identical: categories 18, budgets 1, recurring 1, merchant_rules 1, merchant_cache 1, transactions 8; `PRAGMA foreign_key_check` empty; every fixture row's category reference (`t2`→`c-kopi`, `r1`→`c-tagihan`, `mr1`→`c-gaji`, `merchant_cache`→`c-belanja`, `b1`→`c-kopi`) unchanged byte-for-byte; local D1 only.
- `npx playwright test e2e/riwayat.spec.ts e2e/impor.spec.ts e2e/berulang.spec.ts e2e/anggaran.spec.ts --project=phone` (`E2E_PORT=8981`) — `27 passed (50.6s)`, exit 0; local dev server (wrangler dev + miniflare), no real provider, no flaky test to rerun (0 failures).

flock shim: no system `flock` on this machine; installed a no-op shim (`shift; exec "$@"`) on `PATH` for all commands above, per task instructions.

## Checked criteria (Part A)

1–11 (bank-narrative vectors, both DB/CR, fee > transfer, tax > interest, unrecognised debit-card purchase left alone) — **PASS**. `src/lib/shared/merchants/bank-narratives.test.ts` runs the PRD's exact masked BCA vectors; I traced the priority logic (fee → tax → interest → cash → card-bill → transfer) by hand against each vector and it matches AC-1…AC-11 exactly, including the AC-11 fee-outranks-transfer case ("SWITCHING DB BIAYA TXN KE 009").
12. Rule/history win over narrative ("TRSF … GAJI" stays Gaji) — **PASS**. `resolve.test.ts` ("a purpose word beats a bare transfer code") and the resolver code: rule/history/cache are checked on the cleaned key before the narrative layer runs at all; a bare `transfer` narrative tile is deliberately ranked *below* the dictionary/keyword layer (`resolveDeterministic`, `if (byNarrative && narrative !== 'transfer') return byNarrative;`), so "GAJI" in the same text is picked by the dictionary layer first.
13. Deterministic repeat — **PASS**. `bank-narratives.test.ts` ("is deterministic") and `rapikan-kategori.test.ts` ("the same rows read twice give the same categories") both assert this at the unit and import level.
14–16. New presets, top-up for old spaces, tile-key constraint — **PASS**. `categories/repo.ts`'s generational `LATER_PRESETS` (FN-39 group, then FN-48 group, each with its own `upTo`) is exercised by `migration-0037.test.ts` ("accepts all 23 tile slots (AC-16) and still refuses an unknown one") and by the categories repo's own tests (not re-read line by line here, but `npm run gates`'s 5182 passing tests include them).
17–30. "Rapikan kategori" preview/apply/undo, idempotence, hand-set rows, two spaces, demo rows, 500 cap — **PASS**. `test/integration/rapikan-kategori.test.ts` (899 lines) covers every one of these by its own AC-numbered `describe`/`it` names, including the 500-cap+bulk-insert test (AC-30/AC-36), the 20-concurrent-apply test, the AC-39 concurrent-hand-edit test, and the AC-27/28 cross-space and removed-member 404 tests. I read the full `cleanup.ts` implementation: apply and undo are each one `db.batch` with guarded `INSERT…SELECT…WHERE NOT EXISTS`/`UPDATE…WHERE` statements (never read-then-write), ids travel as one JSON parameter via `json_each` (never `inArray`), and `isLiveMember` is re-checked inside the write statements, not only at `currentSpaceScope`.
31–33. Reason chip on edit page — **PASS**. `riwayat/[id]/edit/+page.server.ts`'s `categoryReasonOf` recomputes the resolver live (`allowAi: false`, never stored) and only returns a reason when it still matches the stored category; `TransactionForm.svelte` renders the chip only while `categoryId === values.categoryId`. Covered by the test named for AC-31…33 in `rapikan-kategori.test.ts`.
34–35. Money/dates untouched by this feature — **PASS**. Read every write statement in `cleanup.ts`, `csv-import.ts`'s new lines, and `transactions/repo.ts`'s new lines: only `category_id`, `category_source`, `updated_at` and `seq` are ever written by this feature; `amount_minor`, `currency`, `occurred_on`/`occurred_at` are never touched.
36. Bounded eligibility query — **PASS**. `cleanup.ts`'s `eligible()` is one indexed `EXISTS`/equality SQL fragment (`c.tile_key = 'lain'`), no `LIKE`/`GLOB`, no unbounded `inArray`.
37. i18n completeness — **PASS**. `i18n-en.ts` diff adds an English entry for every new Indonesian phrase (category names, "Dari kode mutasi bank", every "Rapikan kategori" UI string); `npm run gates`'s passing test suite includes the i18n-completeness test.
38. Space access on every new load/action — **PASS**. `rapikan-kategori/+page.server.ts`'s `load`/`apply`/`undo` all call `currentSpaceScope` (which 403/404s a non-member or removed member, per the existing shared helper) and the write statements independently re-check `isLiveMember`.
39. Concurrent apply vs. manual edit — **PASS**. Guarded `UPDATE…WHERE t.category_id = prev AND t.updated_at = expected`; `rapikan-kategori.test.ts`'s AC-39 test proves the loser is reported (`changed`/`kept` counts), never silently overwritten.
40. Gates clean, fail-before-proof — **PASS** for gates (`npm run gates` exit 0, 5182 tests). Fail-before-proof itself is an engineering-process check I cannot re-run after the fact; the tests read as regression tests for each AC (named `(AC-n)`), consistent with the practice, but I did not independently verify them failing on pre-feature code.

## Engineering decisions judged

- **History/AI-cache answers that only say "Lainnya" are skipped.** Correct and tested: `resolveDeterministic` skips a history/cache hit when `sources.isFallback(hit.categoryId)` is true (a rule still wins even naming a fallback — a user's explicit choice). `resolve.test.ts` covers both branches.
- **Apply and undo both set `category_source = 'auto'`.** Reasonable: a row "Rapikan kategori" ever touched (forward or reverted) is a machine proposal, not a human pick, so it stays eligible for the next clean-up pass after an undo. Matches the PRD's intent that only a person's own edit/compose/bulk-set action should mark `user`.
- **The `/impor` card's count (`countCleanupCandidates`) is the broader *eligible* count, not the narrower *has-a-better-proposal* count returned by `previewCleanup`.** This is deliberate and tested (`rapikan-kategori.test.ts`: "Eligible: fee, interest, demo, unknown (no better category, so not proposed)" — total 4, only 3 actually proposed). It matches the PRD's own wording for AC-17/AC-30 ("eligible count"), and the review page has a real, non-crashing empty state (`EmptyState`, "Tidak ada transaksi yang perlu dirapikan sekarang.") for the case where the card shows N > 0 but the review has nothing to apply. **Minor advisory finding (non-blocking):** when every eligible row happens to have no better category, the card promises N rows to fix and the review screen shows zero — correct per spec, but could read as confusing to a user. Not a functional defect; no AC requires the counts to match.

## Other notes

- `--cat-biaya-bank`/`--cat-pajak`/`--cat-tarik-tunai`/`--cat-kartu-kredit`/`--cat-transfer`/`--cat-bunga` are defined in exactly the same two theme blocks (`:root` light, `data-theme='mono'`) as the existing `--cat-lain`, matching the file's established pattern (dark/gold/emerald inherit via cascade) — not a gap.
- Orchestrator's rename of the two transfer presets to "Transfer keluar"/"Transfer masuk" is present in `transactions.ts`'s `PRESET_CATEGORIES` and in `i18n-en.ts`.
- `category_source` is correctly defaulted: `auto` for statement/CSV import rows and Gmail/forwarded drafts saved without "Atur kategori"; `user` for manual compose/edit, voice and receipt confirm (both go through the review/confirm form), and any CSV/spreadsheet row whose category cell was filled by the uploader.
- Account-deletion export (`export/tables.ts`) and account-scoped table list (`spaces/spaces.ts`'s `SPACE_SCOPED_TABLES`) both include the two new `category_cleanup_*` tables — no orphaned space data on account deletion.
- No violation of `docs/ENGINEERING_CHECKLIST.md` found: bounded queries, JSON-batched ids, guarded concurrent writes, masked titles in the cleanup preview, no AI call anywhere in this feature's own code (`allowAi: false` throughout), i18n complete, space access re-checked per route and per write.

## Scope note

Part B (statement continuity) and Part C (own-transfer matching) are not present in this diff (`import_batches.wallet_id/period_from/period_to/opening_balance_minor/closing_balance_minor`, `continuity.ts`, `transfer_links`, `transfers/match.ts` — none exist yet) and were not evaluated; they are future build passes per the PRD's Owner decision 14.
