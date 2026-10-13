# QA report: FN-20 Merchant recognition (cycle 1, commit 6dc5cd7)

**Verdict: PASS** (re-check after cycle 2, 1317ef1) — AC-16 now implemented; AC-25 NOT verified (real Anthropic, expected, not a FAIL). Everything else verified.

## Commands run

Orchestrator override: full `npm run gates` / full `npm run test` NOT run by QA (RAM limit). Engineer's full-gates result (not re-run by QA): check clean, lint clean, build passed, tests 4021/4022 with one failure in test/integration/privacy.test.ts (real-clock export throttle). Orchestrator runs full gates at end of cycle.

- `npx vitest run test/integration/privacy.test.ts` -> 1 file, 28 passed (28), exit 0, local D1 (the one engineer-reported failure passes alone).
- `npm run check` -> svelte-check 1952 files, 0 errors, 0 warnings, tsc service-worker/jobs/inbound clean, exit 0.
- `npm run lint` -> prettier "All matched files use Prettier code style!", eslint clean, exit 0.
- `npx vitest run src/lib/shared/merchants src/lib/server/merchants src/lib/ui/transactions/merchant-suggest.test.ts test/integration/merchants.test.ts test/integration/impor-statements.test.ts workers/inbound/src/process.test.ts src/lib/shared/i18n` -> 9 files, 138 passed (138), exit 0, local D1 + fixtures + stubbed AI provider (MOCK).
- `npx vitest run src/lib/server/imports test/integration/impor.test.ts src/lib/shared/category-keywords src/lib/shared/receipts src/lib/shared/voice-parse` -> 5 files, 133 passed (133), exit 0 (csv-import.test.ts untouched and passing, AC-13).
- `FIN_PERSIST_TO=<scratch>/freshdb npm run db:migrate:local` on a fresh local DB -> 0035_merchant_rules.sql applied, all migrations OK, exit 0; second run "No migrations to apply!" (local only, never remote).
- `E2E_PORT=8941 npx playwright test e2e/fn20-merchants-qa.spec.ts --workers=1` (new QA spec, phone 360 px + desktop, wrangler dev local, no AI gateway configured) -> 7 passed (setup + 3 tests x 2 projects), exit 0.
- Not run by QA: full `npm run gates`, full `npm run test`, AC-24 "regression test fails on pre-fix code" demonstration, real Anthropic run.

## Acceptance criteria

1. clean vectors: PASS (shared/merchants/clean.test.ts).
2. dictionary/keyword, kind check, whole-token: PASS (dictionary.test.ts, merchants.test.ts "dictionary and keyword layers").
3. layer order: PASS (merchants.test.ts "rule beats history beats cache beats keyword").
4. history most-frequent/ties/tombstone/transfer/other space: PASS (merchants.test.ts history test).
5. learning, hits+1, one row under 20 concurrent: PASS (integration tests; e2e: correction on a saved tx creates rule "1 koreksi", next typed title shows "Dari aturanmu").
6. two-space isolation, removed member same 404: PASS (integration "removed member"; e2e second user sees 0 rules).
7. hidden category skipped, rule listed "Kategori tidak tersedia": PASS (integration AC-7 test).
8. no key / no gateway: no network call, deterministic works, key hint: PASS (integration; draft "Isi kategori otomatis" returns hint). Browser hint not screenshot-checked.
9. 60 keys -> 2 requests, cached, no digits/amounts in body: PASS but MOCKED (stub).
10. bad provider output: PASS (ai.test.ts, integration) MOCKED.
11. 21st call falls back: PASS (integration).
12. voice sentence -> cleaned title + category + reason, amount unchanged: PASS for no-JS action (integration). JS voice page not browser-tested by QA.
13. CSV/statement explicit cell wins, totals unchanged: PASS (integration + untouched csv-import.test.ts).
14. forwarded capture: PASS (integration; workers/inbound process.test.ts).
15. manual form chip: PASS (e2e: no request under 3 chars, one request after debounce, chip shows merchant, category and reason, applies both, a category picked first is not overwritten; chip height >= 44 px).
16. one-tap category change on any draft or import review row: **FAIL** (finding 1).
17. rules page lists own space only, persists on reload, delete, no-JS delete, empty state: PASS (e2e + integration incl. stale 409, delete-all). Loading/error states exist in source, not browser-triggered.
18. json_each binding, instr search: PASS (150 keys in one call; 60-char search test).
19. 200-item cap, history 12 months / 5,000 rows: PASS (item 201 test; constants in repo.ts).
20. money untouched: PASS (diff grep: no float math on money; amounts only passed through).
21. privacy, cascade on account delete: PASS (integration "deleting the account removes its space rules and cache"); cache/rule CHECKs store only key and name.
22. migration 0035: PASS (fresh local apply, re-run, unique live index and tombstone re-add test).
23. i18n: PASS (i18n test in the 138). 360 px no horizontal scroll and 44 px chip and Hapus targets: PASS (e2e phone). AA contrast light/dark/mono: not independently run (engineer's full run includes test/contrast.test.ts).
24. gates: NOT confirmed by QA (override). Engineer reports 4021/4022; the single failure passes alone.
25. real Anthropic through AI Gateway: **NOT verified** (mocked only; expected, not a FAIL by itself).

## Findings

1. **FAIL AC-16.** Scenario: on `/kotak-masuk/periksa`, user wants to change one draft's category. Expected (PRD scope 4, AC-16): tap the row's category, pick another, done in one tap. Actual: only the bulk flow exists (`src/routes/(app)/kotak-masuk/periksa/+page.svelte`): drafts are all pre-selected, so user must deselect the others, tap "Atur kategori", pick, tap "Terapkan ke N draf". No per-row control. Fix: per-row category control posting `?/setCategory` for that single draft.
2. Engineer gap (b), import review rows with reason chip: PRD scope 4 says "Statement review rows show the reason chip". CSV and statement imports (`/impor`) write transactions directly and have no per-row review UI, so there are no such rows to chip; the chip is shown on draft rows (Kotak masuk and periksa) via `DraftSummary`. Judged: PRD wording cannot be met without new UI; not a FAIL by itself, but PRD owner should confirm it was meant for drafts only.
3. Low: the AI step's browser path (hint UI, "Isi kategori otomatis" with a key) is covered only by integration tests with a stub; no real-provider evidence (AC-25).

## Checklist
No `docs/ENGINEERING_CHECKLIST.md` item found violated in the changed code reviewed (space scope from session, parameterised json_each, no interactive transactions, resolve before write, bounded queries). Added file by QA: `e2e/fn20-merchants-qa.spec.ts` (kept for the pipeline).

## Re-check after cycle 2 (1317ef1)

Scope: `git diff 6dc5cd7..1317ef1` (PRD, GroupRow, kotak-masuk/periksa page, merchants integration test, QA e2e spec). Source read only; no full tests run (orchestrator override).

- Finding 1 (AC-16): **PASS**.
  - Each draft row has a "Ubah kategori" `<details>` listing the visible categories of the draft's kind (current one excluded); each option is a `<button form="row-<id>" name="categoryId">` posting `?/setCategory` with that one draft token (`id:updatedAt`). One form per draft sits outside the bulk form, so the bulk selection is not involved.
  - Server: same `setCategory` action as bulk -> `currentSpaceScope` -> `setDraftsCategory` (category must be visible, same space, same kind; guarded update with `isLiveMember`; stale token -> 409). Learning via `learnFromCorrections` only after the confirmed write and only if the category changed.
  - No-JS: plain `<details>` and native `form=` buttons work without JS; with JS, `use:enhance` shows "1 draf diperbarui." only after success. Rows are keyed by id+version, so the changed row re-renders closed with the new category and no stale reason chip.
  - 44 px: `summary` and option buttons `min-height: 44px`; e2e asserts button height >= 44 and no horizontal scroll at 360 px.
  - i18n: "Ubah kategori" already in `i18n-en.ts`; category labels via `categoryLabel(..., tr)`.
  - Tests: integration "AC-16 per-row category change" (one draft changed, others untouched, rule created hits=1, stale token 409 with no second hit, stranger in another space fails and draft unchanged); e2e "AC-16: one tap on a draft row category..." (only that row changes, rule "1 koreksi" on /pengaturan/pedagang).
  - Note: "one tap" is open the row's "Ubah kategori" (1 tap) then pick a category (1 tap), matching PRD scope 4 ("tapping the category opens the picker; choosing a different category is the one-tap change").
  - Note: engineer edited PRD AC-16 and scope 4/CSV wording to say drafts only (imports have no review rows). This resolves Finding 2 as a doc change; PRD owner should still confirm.
- Finding 2 (import review rows chip): **PASS** (PRD now states drafts only; no import review rows exist). Owner confirmation advised.
- Finding 3 / AC-25 (real provider): **NOT verified**, not a FAIL (mocked only).
- Regression: `npx playwright test e2e/fn20-merchants-qa.spec.ts` run by orchestrator after the change: 9 passed (58.4s).
