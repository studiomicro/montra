# FN-35 Alur uang (money-flow chart) — Security report (phase review)

Reviewed: `git show e8b856c` (on main at 2246744), against `docs/ENGINEERING_CHECKLIST.md`. Read-only worktree.

## Verdict: PASS

No medium or high findings.

## What was checked

- **Loader space access** (`src/routes/(app)/alur-uang/+page.server.ts:11-23`): `currentSpaceScope(locals)` re-runs
  `requireSpaceAccess(user, locals.space)` on every load; no space id read from the URL or form. Integration tests
  cover non-member (cookie/query), removed member and stale `locals.space` (404).
- **Query params** (`src/lib/shared/money-flow.ts:10-14`): only `?p`; accepted only if `isMonthString`, not in the
  future and ≥ 2000-01, otherwise this WIB month. `monthRange` cannot throw on accepted input. No currency, wallet
  or year parameter is read; the drawn currency comes from the favourite wallet on the server.
- **SQL** (`src/lib/server/transactions/aggregate.ts`, `moneyFlowTotals`): Drizzle `sql` template with bound values
  via the shared `filterWhere(spaceId, …)`; category and wallet joins are constrained to `t.space_id`, so another
  space's wallet/category name can never be joined in. Grouped in SQL; types limited to `income`/`expense`; demo
  rows excluded.
- **Output escaping**: no `{@html}`, `innerHTML` or `javascript:` in the diff. Names, amounts and labels are Svelte
  text/attribute expressions. SSR probe (temporary test, deleted) rendering `FlowChart` with
  `"><script>…</script><img onerror>` in name/amount/label and a quoted `series` produced no `<script>`, no `<img`,
  no attribute break-out. `series` is a server tile key, used only in a class name.
- **Link hrefs**: built by `riwayatHref` with `URLSearchParams` from server-generated category/wallet ids; always a
  same-origin `/riwayat?…` path; uncategorised rows get no link.
- **Errors**: failure returns the fixed `FLOW_LOAD_FAILED` message and logs `errorLabel(e)` only (no SQL text or
  bound values); tested.
- **Page data**: report holds only the caller's space's category/wallet ids, names and sums; no secrets, no user ids.

## Findings

1. **Low — `moneyFlowTotals` has no explicit row LIMIT** (`src/lib/server/transactions/aggregate.ts`,
   `moneyFlowTotals`). The checklist asks for a row cap on every scan. The result is grouped and implicitly bounded
   (≤ 100 categories + 1 × 50 wallets × currencies × 2 types per space), and the scan is limited to one month of one
   space, so no practical DoS; tracked so a future cap change does not make it unbounded. Repro: a member creates 100
   categories and 50 wallets and spreads one month of rows across them → ~10k groups returned in one response.

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/streak.test.ts
  src/lib/server/streak src/lib/server/reports/money-flow.test.ts src/lib/shared/money-flow.test.ts
  src/lib/ui/charts/geometry.test.ts src/lib/server/export` → 6 files, 49 tests passed.
- `npx vitest run --maxWorkers=2 test/integration/alur-uang.test.ts` → 14 passed; SSR escaping probe → 1 passed (probe deleted).
- `npm run gates` / `npm test` not run (RAM limit).
