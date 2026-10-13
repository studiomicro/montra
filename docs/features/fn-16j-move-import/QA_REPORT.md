# QA Report — FN-16j: Move an import batch to another wallet

## Verdict: PASS

Reviewed `git diff de86268..234cb27`, the PRD (incl. "Owner decisions — answered 2026-10-11"), ran `npm run gates`,
a fresh-DB migration apply, the full Vitest suite, and the touched + QA-added Playwright specs. Every acceptance
criterion (AC-1 to AC-23) is covered by a passing test; no server-side authorization gap found.

## Commands run

- `npm run gates` (check, lint, test, build) — first full run: clean, exit 0, all steps passed, local only.
- `npm run test` (rerun to confirm) — 344 files / 5515 tests passed, exit 0, local D1 (Miniflare), no real provider.
- `npx vitest run test/integration/account-keys.test.ts -t "per client: the 21st attempt"` — 1 passed in isolation, local, confirms the one failure seen in an interleaved rerun of `npm run test` was a pre-existing timing flake unrelated to this diff (file untouched by `git diff de86268..234cb27`).
- `FIN_PERSIST_TO=.wrangler/state-qa-fresh npm run db:migrate:local` on a fresh empty local D1 — all 42 migrations incl. `0042_import_batch_moved.sql` applied ✅, exit 0, local only, cleaned up after.
- `E2E_PORT=38217 npx playwright test e2e/impor.spec.ts --workers=1` (with a no-op `flock` shim on PATH) — 45 passed (phone+desktop), exit 0, local Wrangler dev server, no real provider.

## Checked criteria (all PASS)

1. AC-1/2/16/23 — PASS: `imports-move.test.ts` "moves every live row and the continuity wallet, then back; amounts and dates untouched" — moved count = live row count, `import_batches.wallet_id` follows, money/date columns (`amount_minor`, `currency`, `occurred_on`, `occurred_at`, `title`, `category_id`) byte-identical before/after, wallet balances (`readWalletBalance`) confirm persisted state, move-back works.
2. AC-3/4 — PASS: "an edited row moves with its edits; a deleted row stays a tombstone, untouched" — edited title/amount survives the move; tombstoned row's `wallet_id`/`deleted_at` untouched.
3. AC-5 (mixed wallets, server) — PASS: "a batch whose rows sit in more than one wallet is refused whole" and "(decision 3) one row moved by hand blocks the batch" — `mixed_wallets`, nothing written.
4. AC-5 (UI) — PASS (QA-added e2e): "FN-16j AC-5: a batch whose rows sit in more than one wallet shows the move control disabled with its reason" — reason text shown, no `<select>`/summary rendered, `Urungkan` still works.
5. AC-6 — PASS: "only the source side of a transfer moves; a transfer that would point at itself is skipped" — 2 moved, 2 skipped, skipped rows byte-identical to before.
6. AC-7/8/9 — PASS: "a different currency, an archived, unknown or other-space wallet, or the same wallet is refused" — one answer shape for archived/unknown/other-space (`wallet_not_found`), `currency_mismatch`, `same_wallet` all refuse with nothing changed.
7. AC-10 — PASS: "an undone batch is refused as already undone" (repo: reason `already`; route maps to 409 `MOVE_BATCH_UNDONE` — the declared, PRD-anticipated departure from literally reusing `undo`'s 200/"already" shape; PRD's own Scope text says the new message only reuses `BATCH_ALREADY_UNDONE`'s *wording*, not its result shape, and AC-10 itself says "refused"; writing nothing is proven).
8. AC-11 — PASS: "a stale page is refused; 20 concurrent moves of one version: exactly one wins" and a second test racing a hand-edit between read and write — both resolve to `stale`, exactly one winner, one audit row.
9. AC-12 — PASS: "another space's batch or wallet answers exactly like a missing one" — identical `{status, data}` for foreign/unknown/overlong ids.
10. AC-13 — PASS: "a member removed after the page loaded is refused; nothing changes" — `missing`, nothing written.
11. AC-14 — PASS: "one content-free audit row per move" — exactly one `import_batch_moved` row, no transaction id/amount, a repeat refusal adds none.
12. AC-15 — PASS: "the continuity check follows the moved statement to its new wallet" — `continuityBreaks`/`checkStatement` show `gap` before, `pass`/empty after.
13. AC-17 (loading/busy/success/error states) — PASS: `+page.svelte` shows `Memindahkan…` while busy, success line or `fail()` error otherwise (code read); exercised live by the e2e "touch screen" and "without JavaScript" specs (success line renders after confirm) and the route-level test's `fail()` mappings.
14. AC-18 (i18n) — PASS: every new Indonesian string has an English entry (`src/lib/shared/i18n-en.ts` diff reviewed); `test/i18n-coverage.test.ts` (in the 5515 passing tests) enforces this project-wide.
15. AC-19 (360 px, touch) — PASS: e2e "FN-16j at 360 px on a touch screen…" — summary/select/confirm all ≥44 px, no horizontal scroll, before and after a reload.
16. AC-20 (no-JS) — PASS: e2e "without JavaScript: … moves as a plain form post" — move posts and renders success from the server response alone.
17. AC-21 (no other same-currency wallet) — PASS (QA-added e2e): "FN-16j AC-21: with no other same-currency wallet, the move control shows the reason instead of a select" — reason text shown, no `<select>` and no "Pindahkan ke dompet lain" summary rendered.
18. AC-22 — PASS: `npm run gates` clean (see Commands run).
19. AC-23 — PASS: covered together with AC-1/2 above; the departure ("limited to columns that exist") is correct — `original_amount_minor`/`original_currency` do not exist yet on `transactions` (grepped `schema.ts`: no match), so the check is vacuously complete over the real schema.
20. Migration 0042 — PASS: `test/integration/migration-0042.test.ts` (existing audit rows survive, `import_batch_moved` now accepted, unknown actions still refused, re-run is a no-op) plus my own fresh-DB `db:migrate:local` run above.
21. Server-side authorization — PASS: every new path (`moveImportBatch`, `importBatchMoveStates`, the `move` action) re-checks `isLiveMember` in the guarded write itself (not just at page load); AC-12/13 prove a non-member and a removed member get the same "missing" answer with no body/timing difference; sync-equivalent scope (space-scoped `db.batch`) matches the rest of the repo's pattern.
22. Engineering checklist — no violations found: bound batch ids via `json_each` (tested with 120 ids), guarded `UPDATE…RETURNING` inside one `db.batch` (concurrency-tested), migration rebuild matches the `0016` precedent and is re-runnable, `{#each}` lists keyed by id, form bodies via the shared `readFormBody`/`textField` guard, touch targets ≥44 px, truthful state (success only after `done: 'moved'` from the server).

## QA-added tests (production code untouched)

Two criteria had no direct test (server-side `moveBlocked` logic was integration-tested but the resulting UI state
was not); added to `e2e/impor.spec.ts` (already touched by this diff) and run above:
- `FN-16j AC-21: with no other same-currency wallet, the move control shows the reason instead of a select`
- `FN-16j AC-5: a batch whose rows sit in more than one wallet shows the move control disabled with its reason`

Both pass on phone and desktop projects (45/45 total in the file).

## Findings

None. No FAIL.
