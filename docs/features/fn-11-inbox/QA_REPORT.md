# FN-11 Drafts inbox (Kotak masuk) — QA report

**Verdict: PASS**

Checked out `git switch --detach 7c1867f` (base `main` 01cc53d). Note for FN-11's own slice (`docs/ACCEPTANCE.md`):
drafts inbox verified; no real capture writer exists yet (by design, FN-14 onward land later).

## Commands run

- `npm ci` — installed 245 packages, exit 0, local only (no provider).
- `npx svelte-kit sync` — generated `.svelte-kit` types, exit 0, local only.
- `npm run db:reset:local` — wipes + migrates + seeds local D1 (fictional seed), exit 0, local D1 only (no
  ERR_MODULE_NOT_FOUND seen on this branch; the bb1336f regression does not apply here).
- `npm run db:migrate:local` — "No migrations to apply!" (already applied by the reset above, incl. `0008_drafts.sql`), exit 0, local D1 only.
- `npm run gates` — check (svelte-check 0 errors, workers tsc clean) + lint (prettier/eslint clean) + test (Vitest 58 files / 547 tests passed) + build (vite build ✓), exit 0, local/mocked only.
- `E2E_PORT=8825 LD_LIBRARY_PATH=<scratchpad> npx playwright test` — 113 passed, 12 skipped, 0 failed, exit 0, local wrangler dev (DEV_ROUTES=1) + local D1, no real provider.
- `E2E_PORT=8825 … npx playwright test --reporter=json` (re-run, warm server, for skip-list comparison) — 113 passed, 12 skipped, 0 failed, exit 0, local only.
- `npx vitest run src/lib/shared/i18n.test.ts` — 1 file / 12 tests passed, exit 0, local only.
- Ad-hoc `wrangler dev --persist-to .wrangler/qa-8809 --port 8809` (no `DEV_ROUTES`), `curl` probes signed-in — GET `/kotak-masuk` 200 with no dev buttons in HTML, POST `?/seedDemoDrafts` 404, POST `?/clearDemoDrafts` 404, POST `/kotak-masuk/periksa?/save` with JSON content-type 415; server then `pkill`'d and `.wrangler/qa-8809` removed, exit 0, local only.

## 12 skipped e2e vs main

All 12 skipped tests are the pre-existing viewport-only skips (desktop-side skip of a phone-only 360 px/44 px
check) in `accounts.spec.ts` (6), `kekayaan.spec.ts` (3), `kit.spec.ts` (1), `ruang.spec.ts` (2) — none in
`kotak-masuk.spec.ts`. Same pattern as the project's existing `test.skip(testInfo.project.name !== 'phone', …)`
convention used before this feature; no new or different skips introduced.

## Checked criteria

1. PASS — `/kotak-masuk` lists pending drafts grouped by WIB day (`groupByDay` on `occurred_on`), amount via
   `formatMoney` (`DraftSummary.svelte`), source `Badge`, "Perlu dilengkapi", "Mungkin duplikat", header
   `trf('{n} draf menunggu', …)`. e2e `seeded drafts: badges, mixed-kind refusal, …`.
2. PASS — empty state "Tidak ada draf yang menunggu.", no "Periksa draf" link (`+page.svelte` `{#if data.drafts.length > 0}`). e2e `openInboxWithDemo` asserts this before seeding.
3. PASS — skeleton while `navigating`, `ErrorState` + retry on `loadError` (load wrapped in try/catch, never throws past the route). Not independently re-tested live (same pattern FN-05 already uses); code inspection confirms.
4. PASS (live-verified) — ad-hoc `wrangler dev` without `DEV_ROUTES`: dev buttons absent from HTML, `?/seedDemoDrafts`/`?/clearDemoDrafts` → 404 while signed in. Integration `kotak-masuk-routes.test.ts` "criterion 4" also covers this.
5. PASS — `seedDemoDrafts` inserts 4 fictional rows (both types, one ready, two needs-setup, one `flag='duplicate'`), dates via `wibTodayString`/`wibDateString`; `clearDemoDrafts` tombstones `is_demo=1` rows. Integration test + e2e.
6. PASS — "Abaikan" confirm (`<details>`) → `discard` action tombstones (content-free, verified by direct-SQL assertion in `drafts.test.ts`), row disappears after redirect/reload. e2e `Abaikan asks to confirm, …`.
7. PASS — `/kotak-masuk/periksa` checkbox `GroupList`, all pre-selected, "{n} dipilih", "Pilih semua"/"Kosongkan pilihan". e2e.
8. PASS — mixed expense/income → "Pilih draf dengan jenis yang sama untuk mengatur kategori sekaligus", no sheet opens (`page.getByRole('dialog')` count 0). e2e + integration + `drafts.test.ts` unit (`selectionKind`).
9. PASS — same-kind selection + matching-kind category → one `db.batch` update, sheet closes, rows update without reload, focus returns to opener (`await expect(opener).toBeFocused()`). e2e.
10. PASS — "Atur dompet" updates any kind in one batch; wallet kind-agnostic. e2e + integration.
11. PASS — foreign wallet/category id answers the same `WALLET_NOT_FOUND`/`CATEGORY_NOT_FOUND` as an unknown id (no oracle); cross-space integration test "a non-member sees nothing and every action finds nothing" exercises exactly this with the shared space's real ids.
12. PASS — `capturedTransactionInput` (FN-05's `fieldsSchema` extracted, no second schema) + `insertTransactions` (FN-05's one write path) called with the draft's `source`/`dedupeKey`; draft tombstoned with `saved_transaction_id`; summary shown only after redirect confirms. `test/integration/drafts.test.ts` "criterion 12" asserts the full transaction row and tombstone by direct SQL.
13. PASS — incomplete drafts left untouched, complete ones save, `trf('Disimpan {saved} dari {total} transaksi · {incomplete} belum lengkap', …)`. Integration "criterion 13" + e2e.
14. PASS — `DRAFT_BATCH_MAX=50`; integration "criteria 14, 15" seeds 56 drafts, saves 50, leaves 6, summary cookie `50.50.0.6`, `remaining` shown on `/kotak-masuk`.
15. PASS — duplicate checkbox token for the same id de-duplicated by `parseSelection` (`Map` keyed by draft id); same integration test doubles a token and confirms exactly 50 saved, not 51.
16. PASS — a saved draft replayed answers `{ ok: false, reason: 'none' }` (not found) for save/discard/bulk actions; "criterion 16" integration test.
17. PASS — partial unique `(space_id, source, dedupe_key)` with no `deleted_at` condition; discard-then-reinsert rejected with `UNIQUE` constraint error, "criterion 17" integration test (regression test present and green).
18. PASS — every amount renders via `formatMoney` in `DraftSummary.svelte`; no hand-built `Rp` string found in the two route `+page.svelte` files or `DraftSummary.svelte` (grep confirms only `formatMoney` is used).
19. PASS — `occurredAt`/`occurredOn` copied verbatim onto the saved transaction (`origin.occurredAt` in `insertTransactions`, test asserts `occurred_at` equals the draft's original instant exactly); dev seed dates come only from `wibTodayString`/`wibDateString`.
20. PASS — every load/action resolves scope via `currentSpaceScope(locals)` → `requireSpaceAccess`; no route param trusted as a space id (code inspection of both `+page.server.ts` files; no `params.space` or similar used).
21. PASS (live cross-space) — `test/integration/kotak-masuk-routes.test.ts` "pre-handoff cross-space probe": a non-member (404/409/400, never 200) and a removed member (404/409) both return nothing for list, discard, setCategory, setWallet and save; dev seed for a removed member lands in their own space, never the shared one.
22. PASS — 20 concurrent `saveDrafts` over overlapping selections of 6 drafts: exactly 6 transactions, 6 distinct `saved_transaction_id`, no 500 (`drafts.test.ts` "criterion 22").
23. PASS (live-verified) — oversized body → 400 (integration "criterion 23"); JSON content-type → 415, reproduced live against `wrangler dev` with a real HTTP POST.
24. PASS — `{#each}` lists keyed by `draft.id`/`category.id`/`wallet.id`/`day.date` throughout both route files (grep confirms no title/merchant key).
25. PASS — `npm run test` / `i18n.test.ts` green (12/12); every new phrase has an English entry (coverage test would otherwise fail the build).
26. PASS — e2e asserts focus returns to the "Atur kategori" opener button after the sheet closes; `GroupRow`'s new checkbox is a 22 px visual control inside a `min-height: 44px` row (existing row sizing unchanged) — touch target verified via the 360 px e2e (`expectNoHorizontalScroll`, button role checks).
27. PASS — all user-facing messages (`DRAFT_NOT_FOUND`, `SELECTION_GONE`, `MIXED_KIND`, etc., `drafts/messages.ts`) are plain Indonesian sentences with no id, path or stack trace; spot-checked by grep and by reading `messages.ts`.
28. PASS — `npm run gates` clean (see Commands run); fail-before proof described and matches the rule (engineer report lists 5 reverted-code fail-before runs: assert removed → 2 tests fail, index without `deleted_at` filter → criterion 17 test fails, de-dup removed → 3 tests fail, mixed check removed → 2 tests fail, space filter removed → 17 tests fail); not independently re-run this cycle (first pass, no prior QA cycle to diff against).

## FN-05 regression (insertTransactions rewrite)

`createTransaction`'s one call site in `src/routes/(app)/riwayat/baru/+page.server.ts` is byte-for-byte unchanged
(`git diff 01cc53d..7c1867f -- src/routes/\(app\)/riwayat/` is empty) and still calls it with 4 args (default
`origin = { source: 'manual', dedupeKey: null }`). `refsHold` was generalised to take either bound values or SQL
expressions (for the multi-row `json_each` insert) but the logic per field is identical; `underCap` changed from
`count < MAX` to `count + rows.length <= MAX`, equivalent for the single-row case. Full Vitest suite (547 tests,
includes FN-05's transaction/category/riwayat tests) and the full Playwright suite (includes `riwayat.spec.ts`,
all passing, e.g. "Muat lebih banyak" pagination, category management, filters/totals) are green with no
behaviour change. Amount cap, CHECK constraints, archived/hidden refs, transfers and tombstones are exercised
unchanged by FN-05's own existing tests, all passing.

## Engineering checklist

No violations found: bound JSON lists for multi-row ids (no 100-param limit), guarded `INSERT…SELECT…WHERE`/
`UPDATE…RETURNING` patterns inside `db.batch` for every concurrent-write path, `batchAssert` used for genuine
all-or-nothing multi-statement batches, `readFormBody`/`FORM_BODY_MAX_BYTES` reused (no second body guard),
`formatMoney` reused (no hand-built Rp string), WIB dates reused unchanged, one space-access helper
(`currentSpaceScope`/`requireSpaceAccess`) on every load/action, foreign ids answer identically to unknown ids
(no existence oracle), `{#each}` keyed by id, i18n coverage test green, dedupe partial unique index mirrors
`transactions_dedupe_uq` exactly (no `deleted_at` condition).

## Findings

None. No FAIL criteria.
