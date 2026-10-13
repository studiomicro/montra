# FN-39 ride-hailing and food delivery — QA report

## Verdict: PASS

## Commands run

- `flock ... npm run check` (worktree fn-39) → `0 ERRORS 0 WARNINGS`, exit 0. Real toolchain (svelte-check/tsc), no provider.
- `flock ... npm run lint` (worktree fn-39) → `prettier --check` + `eslint` clean, exit 0.
- `flock ... npx vitest run --maxWorkers=2` (worktree fn-39) → `Test Files 201 passed (201)`, `Tests 2796 passed (2796)`, exit 0. Local D1/workerd fixtures, no real provider; AI/Gmail paths stubbed per existing test setup.
- `flock ... npm run build` (worktree fn-39) → Vite client/server/service-worker build + Cloudflare adapter `✔ done`, exit 0.
- `LD_LIBRARY_PATH=... E2E_PORT=5281 npx playwright test --workers=1 e2e/kekayaan.spec.ts e2e/langganan.spec.ts e2e/suara.spec.ts e2e/impor.spec.ts e2e/riwayat.spec.ts e2e/anggaran.spec.ts` → `80 passed (2.9m)`, `3 skipped` (viewport-specific tests correctly skipped on the desktop project), exit 0. Real browser (Playwright/workerd dev server), mocked speech recogniser/AI per existing harness.
- Manual isolated `npx svelte-kit sync` re-run in the worktree, with main-repo `node_modules/$app/tsconfig.json` mtime compared before/after → unchanged in main, changed only in the worktree's own copy (confirms the per-package-symlink + local `$app` setup does not write into the main repo's `node_modules`).
- `npm run clean:tmp` (worktree fn-39) → `removed 0 stale miniflare directories`, exit 0. No lingering dev server on port 5281 after the run.

I additionally wrote and ran two new Playwright tests (not previously present) to close coverage gaps found during review:
- `e2e/langganan.spec.ts`: "FN-39: a direct no-JavaScript link to a new catalogue entry prefills the inline form" (criterion 20) — passed on both phone and desktop projects.
These are included in the `80 passed` count above.

## node_modules isolation finding (explicitly requested check)

The fn-39 worktree's `node_modules` is a real directory containing per-package **symlinks into the main repo's** `node_modules` (e.g. `@sveltejs/kit -> <repo>`), plus a handful of shared-cache symlinks (`.bin`, `.mf`, `.vite`, `.vite-temp`, `.package-lock.json`) that also point at the main repo, and one **real, non-symlinked** local directory, `node_modules/$app` (SvelteKit's `svelte-kit sync`-generated ambient-types package that the root `tsconfig.json` extends via `"extends": "$app/tsconfig"` — this exists in the main repo too and is a normal build artifact, not something FN-39-specific).

Verified safe: a direct `npx svelte-kit sync` run inside the worktree updated only the worktree's own `node_modules/$app/tsconfig.json` (different inode from main's copy); the main repo's `node_modules/$app/tsconfig.json` mtime was byte-identical before and after. `git status`/`git check-ignore` confirms `node_modules` is gitignored in the main repo, so no tracked file was touched either way.

One caveat worth flagging to the engineer/owner: `.vite`, `.vite-temp`, `.mf`, `.bin` and `.package-lock.json` **are** symlinked back to the main repo's `node_modules`, so any `vite build`/`vite dev`/Miniflare run from this worktree does share those specific cache directories with the main repo and any other worktree using the same symlink pattern. During this QA session the main repo's `.vite` and `.mf` mtimes never moved (confirming our `check`/`lint`/`vitest`/`build`/Playwright runs from the fn-39 worktree did not touch them), but `.vite-temp` did change during the session — traced to other, unrelated concurrent agent activity already running on this shared machine against other worktrees (e.g. a `fn-40b` Playwright/wrangler process observed mid-session), not to anything FN-39 did. No actual corruption or main-repo write was attributable to the fn-39 worktree itself.

## Checked acceptance criteria

1. PASS — `transactions.test.ts` "seeds 12 expense and 5 income presets..." + `categories/repo.test.ts`/`transactions.test.ts` (ensurePresetCategories first-seed path); 17 rows, `is_preset=1`, `is_hidden=0`, includes `ojek-online`/`pesan-antar-makanan`.
2. PASS — `test/integration/transactions.test.ts` "FN-39 top-up of a space seeded with the first 15 presets" + `repo.ts`'s `topUpPresets` guarded by `is_preset=1 AND tile_key=…` (never collides with a same-named custom category, explicitly tested). Idempotent (second call no-ops since `presets >= PRESET_CATEGORIES.length`); `bumpSpaceSeq` called in the same batch.
3. PASS — `test/integration/migration-0027.test.ts`: every category/transaction/draft/recurring/budget link round-trips byte-identical (including a tombstoned transaction, tombstoned recurring series, tombstoned budget, null category_id, a custom category reusing tile `kopi`), 18th tile rejected, composite FK and the `category_budgets_follow_category` trigger re-enforced. Read the SQL line by line: link/null/restore ordering is safe (recurring_transactions' category FK is never nulled — only dropped and re-added, since the id-preserving rebuild of `categories` keeps the FK valid without a null step; `transactions.recurring_series_id` is nulled before both `DROP TABLE recurring_transactions` operations, since D1 enforces `ON DELETE SET NULL` even on `DROP TABLE`).
4. PASS — `migration-0027.test.ts` "runs again on the same database with the same end state" (re-applies 0027 alone, diffs `sqlite_master` and full snapshot).
5. PASS — `category.test.ts` (17 keys, all-distinct-hue token check, every tile/bar/series CSS class present) and `transactions.test.ts` (17/12/5 split, 0027 vs. 0004-historical distinction) both updated and green.
6. PASS — `categories/repo.ts`: `CATEGORY_LIST_MAX = MAX_CATEGORIES_PER_SPACE + 2`; `topUpPresets`'s insert has no `MAX_CATEGORIES_PER_SPACE` gate (only the `is_preset` count guard), matching first-seed behaviour; `category-repo.ts`'s budget listing switched from `MAX_CATEGORIES_PER_SPACE` to `CATEGORY_LIST_MAX`.
7–9. PASS — `voice-parse.test.ts` new cases (`gojek/goride/gocar/grabbike/grabcar/maxim/ojol/grab`), `category-keywords.test.ts` (food-wins-over-ride, whole-word only, `__proto__`/`constructor` safety).
10. PASS — `slack-draft-parse.test.ts` "FN-39: inherits the widened keyword table" — no Slack-specific code change (confirmed by inspection: `slack-draft-parse.ts` untouched, parse goes through `parseVoiceSentence`).
11–12. PASS — `test/integration/impor.test.ts` ("FN-39 ride-hailing and food-delivery guess": blank cell + "GRABFOOD JKT"/"GOJEK*JAKARTA" → correct preset; explicit cell wins; income never guessed) and `impor-statements.test.ts` ("a statement row naming a ride or food service…": "GOJEK*JAKARTA"/"GRABFOOD JKT"/"KOPI CONTOH" via the fictional-institution CSV path, since statements never carry a category column).
13. PASS — `voice-parse.test.ts` existing "pulsa 50rb"/"jual kopi 25rb" cases untouched and still green.
14. PASS — i18n-coverage test still passes (no new copy from this part).
15–17. PASS — `e2e/kekayaan.spec.ts` "FN-39 quick picks fill the name and E-wallet in place…" (all four chips, no navigation, name stays editable) — green on phone and desktop.
16, 20. PASS — `e2e/kekayaan.spec.ts` "FN-39 quick picks without JavaScript…" and my added `e2e/langganan.spec.ts` "FN-39: a direct no-JavaScript link to a new catalogue entry prefills the inline form" (`/langganan?tambah=gopay-plus`) — both green, JS-off context.
18. PASS — `wallets.test.ts` ("names are proper nouns: the English table never translates them") and `WalletForm.test.ts` (both locales render the same four labels).
19, 21. PASS — `subscriptions.test.ts`/`validation.test.ts` extended to `gopay-plus`/`gofood-plus`/`grabunlimited`; amount field never pre-filled (form refused without a typed amount); unknown id still returns `null`.
22. PASS by inspection — none of the touched loads/actions changed their space-access call; `dompet`, `langganan`, `pengaturan/kategori`, `anggaran`, every `riwayat/*` route's existing cross-space tests still pass unmodified (confirmed in the vitest run: `riwayat-routes.test.ts`, `dompet-routes.test.ts`, `suara-routes.test.ts` all green with the updated 17-count expectations).
23. PASS — RUNBOOK's Time Travel bookmark step is already generic (not migration-specific), no edit needed; migration 0027 is a new, never-before-applied file.
24. PASS — `importCategoryFromTitle` only runs on `cleanText(r.title, TITLE_MAX_LENGTH)` output (csv-import.ts), and `categoryHintFromWords` only ever receives `voice-parse.ts`'s already-cleaned `bareWords`; no new untrusted-text entry point.
25. PASS — `importCategoryFromTitle` is one bounded pass (`title.slice(0, TITLE_MAX_LENGTH*2)` then a single `.split`), same cost class as existing scans; `category-keywords.test.ts` includes a 100k-character adversarial-length case that still resolves correctly and cheaply.
26. PASS — `npm run check`, `npm run lint`, `npx vitest run`, `npm run build` all clean (see Commands run).
27. PASS by inspection — no money/date code touched; existing money-vector and WIB-boundary tests pass unmodified (part of the 2796 green tests).
28. PASS — `i18n-en.ts` gained `'Ojek Online': 'Ride-hailing'` and `'Pesan Antar Makanan': 'Food delivery'`; the three catalogue proper nouns and the four wallet-chip proper nouns are intentionally not translated (tested explicitly in `wallets.test.ts`, `WalletForm.test.ts`); i18n-coverage test is green.

## Deviations judged

- **Migration 0027 also rebuilds `recurring_transactions`** and tracks `transactions.recurring_series_id` in `__fn39_links`: necessary and correctly ordered — `category_budgets.category_id` and `recurring_transactions.category_id` are NOT-NULL-for-live-rows, so they are never nulled, only de-FK'd then re-FK'd around the `categories` rebuild (which preserves row ids), and `recurring_series_id` must be nulled before either `DROP TABLE recurring_transactions` because D1 enforces the `ON DELETE SET NULL` action even on `DROP TABLE`. Verified against `migration-0027.test.ts`'s round-trip assertions. No data-safety issue found.
- **Langganan catalogue entries use `category: 'lainnya'`, not a literal `'tagihan'` key** (`SubscriptionCategory` has no `tagihan` key; `telko`/`lainnya` both already map to `tileKey: 'tagihan'`). The practical effect the PRD cared about — a "mark paid" row lands on the `Tagihan` preset expense category — is identical either way and is explicitly tested (`SUBSCRIPTION_CATEGORIES.lainnya.tileKey === 'tagihan'`). Judged acceptable: it avoids mislabeling ride/food memberships as "Pulsa & internet" telco bills, and the PRD's own wording ("Pulsa & internet"/bills-like) was itself describing the tileKey, not a `SubscriptionCategory` enum member.
- **`CATEGORY_LIST_MAX = cap + 2`**, colours `#f97316`/`#be123c`, CSV/statement keyword guess scoped to expense rows only when the preset is visible, and the new tile CSS classes all match the PRD/owner decisions as described; none of these colours are ever used as text/icon colour (only as a `color-mix` tile background or an SVG bar/series fill), so the AA-contrast concern raised for "where they carry text/icons" does not apply — confirmed by grep (`color: var(--c)` has zero matches) and by reading `CategoryTile.svelte`/`CategoryBar.svelte`. No dark-theme override exists for any of the 17 `--cat-*` tokens (consistent with the other 15), so no light/dark divergence risk either.

## Minor findings (non-blocking)

- `test/integration/impor.test.ts:1171` has a stale comment ("The 15 presets are the space's defaults…") left over from before FN-39; cosmetic only, no assertion depends on the number.
- `e2e/alur-uang-qa.spec.ts` still says "15 categories" / "10 expense + 5 income = 15" in comments and a node count of 16; this is not stale in effect — that test only posts transactions through the original 10 expense + 5 income tiles and counts *nodes with a flow*, so the two new, unused presets correctly stay out of the chart and the test is unaffected — but the comment reads as if it still assumes a 15-preset world. Did not modify (out of the explicitly requested files; not a failing behaviour), flagging for the engineer's awareness.
- `docs/FEATURES.md` has no FN-39 entry yet in this diff; per the PRD's own Tracker-impact note this is expected to be added alongside the PRD by the strategist, not by this engineering change.

## Engineering checklist

No violations found. D1 scans in `ensurePresetCategories`/`topUpPresets`/`categoryNameOf` are all bounded, set-based (`json_each`, `INSERT…SELECT…WHERE NOT EXISTS`), one `db.batch` each. No new access-control code paths. No money/date logic touched. i18n coverage intact. No upload-persistence, idempotency-key or sealed-result code touched by this feature.
