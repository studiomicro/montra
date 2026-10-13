# Security report — fn-07-budgets-beranda

Reviewed: `git diff bb1336f..c97640f` (budgets table and repo, Beranda loader and actions, `dailyTotals` /
`categoryTotals`, Beranda figures math, BarChart currency prop). Reviewer: red-team-pentester, 2026-10-08.

## Verdict: PASS

No critical, high or medium findings. Four low findings are recorded below for tracking.

## What was checked and held

- **Overflow / DoS (FN-05 regression).** `dailyTotals` and `categoryTotals` reuse `filterWhere` (bounded period,
  `assertBounded`) and `foldTotals` (SQL `cast(sum(...) as text)` → BigInt → `safeMinor`). `berandaFigures`
  sums in BigInt (`sumExact`, `cumulative`) and propagates `null`; `safeToSpend` maps `spent = null` to
  `{ kind: 'over', overMinor: null }`; `diffMinor` goes through `safeMinor`. Svelte only calls `formatMoney` on
  values guarded non-null; charts are replaced by "too large" when any plotted value is null.
  Live probe (wrangler dev, local D1): budget `9.999.999.999.999`, then 1000 × 10^13 IDR rows today →
  `GET /` 200 with three "terlalu besar untuk ditampilkan" notices and "Sudah melebihi anggaran.";
  `/riwayat` 200; `/__data.json` 200. Integration tests cover 1000 × 10^13 on one day and 2 × 600 × 10^13
  (each day safe, month past 2^53).
- **Division.** `perDayMinor = floor(remaining / days)`, `days = daysRemainingInclusive(today) ≥ 1` (1 on the
  last WIB day; `today` is always inside its own month, so there is no "after month end" case);
  `avgPerDayMinor = floor(toDate / n)`, `n ≥ 1`. No zero division, no negative per-day figure.
- **Budget validation.** Probed live: `1,5`, 14 digits, `-5`, `1e5`, `0`, `Infinity`, full-width digits → 400;
  `currency=__proto__` → 400 (allow-list); max budget 13 whole digits × 10^2 < 2^53 (zod `isSafeInteger`
  backs it); DB `CHECK` keeps live amounts > 0.
- **One budget per space under concurrency.** Guarded `INSERT … SELECT … WHERE isLiveMember AND NOT EXISTS`
  plus partial unique index `budgets_one_live_per_space_uq` and `onConflictDoNothing`; updates/deletes keyed on
  `updated_at`. Test "20 concurrent first budgets" and "20 concurrent edits" pass; live second create → 409.
- **Authorization / IDOR.** No budget or space id is read from the client; `currentSpaceScope` →
  `requireSpaceAccess` on every load and action, and every write repeats `isLiveMember` in the statement, so a
  member removed between check and write is refused. Unauthenticated POST → 401. Tests cover cross-space
  cookie probe, removed member, shared-space member.
- **Demo rows.** `is_demo = 0` in both new aggregates (and in `periodTotals`); test asserts every Beranda
  figure excludes them.
- **Currency mixing.** Hero sums only the favourite wallet's currency; other currencies listed separately,
  never added; safe-to-spend uses spending in the budget's own currency.
- **CSRF / body caps.** Built Worker (wrangler dev): cross-origin form POST → 403 "Cross-site POST form
  submissions are forbidden" (vite dev skips this check by SvelteKit design). 3 MB body → 400;
  `application/json` → 415; malformed `updatedAt` → 409, never 500.
- **Rendering untrusted text.** No `{@html}` in the diff; category names, titles and wallet names render as
  escaped text; `{#each}` keyed by category key / row id.
- **Deletion.** `budgets` added to `SPACE_SCOPED_TABLES`; tests show space purge and account deletion remove
  budget rows including tombstones.
- **Secrets / PII.** Page data carries only the space's own figures, rows and budget `updatedAt`; the loader's
  `console.error` logs the error object only, no figures or user text.

## Findings

### L1 — Unbounded budget tombstones per space (low)
`src/lib/server/budgets/repo.ts:51-70` (create insert) and `:99-127` (delete). Each set → delete cycle leaves a
new tombstone row and bumps `space_seq`; nothing caps or compacts them. Exploit: a signed-in member scripts
`?/setBudget` (updatedAt empty) then `?/deleteBudget` in a loop → unbounded rows in one space and in its sync
change log (later sync pulls grow). Bounded only by request rate. Fix: on create, revive the space's latest
tombstone (`UPDATE … SET deleted_at = null`) instead of inserting, or purge tombstones older than the sync
retention; add a rate limit on budget writes.

### L2 — Budget amount parser is a second copy, cap differs from transactions (low)
`src/lib/server/budgets/validation.ts:8-33`. `parseBudgetForm` uses its own regex (`/^[\d. ]*$/`, spaces
allowed) and digit cap instead of the shared `wholeAmountMinor` (`src/lib/server/forms.ts:93`); for 2-decimal
currencies the budget cap is ~10^15 minor while one transaction is capped at `MAX_AMOUNT_MINOR = 10^13`
(`src/lib/server/transactions/validation.ts:39`). No overflow today (both < 2^53, safe-to-spend uses BigInt),
but the two parsers can drift. Fix: call `wholeAmountMinor` and apply one shared cap.

### L3 — Budget currency is taken from a hidden client field (low)
`src/routes/(app)/+page.svelte:178` → `src/lib/server/budgets/validation.ts:41-46`. A member can post any
allow-listed currency (e.g. `currency=JPY` in an IDR-only space); safe-to-spend then compares against zero
spending and shows the full budget as "Sisa …" every day. Only the poster's own space is affected and no figure
is invented from nothing, but a shared-space member can make the household's line misleading. Fix: accept only
the budget's current currency or the currency of a live wallet in the space.

### L4 — Removed member on the update path answers 409 "changed" instead of 404 (low, informational)
`src/lib/server/budgets/repo.ts:92` returns `'stale'` whenever the guarded update matches nothing, including
when `isLiveMember` fails, while the create path distinguishes `'gone'`. No access is granted (the write is
refused); only the message is wrong. Fix: on zero rows, re-check membership and return `'gone'`.

## Engineering checklist

Bounded work (≤ 62-day `dailyTotals` period, SQL aggregation), one currency per sum, tombstones (content-free,
amount cleared, `seq` advanced), shared form-body guard, 20-way concurrency, cross-space and removed-member
probes: all satisfied. L1 is the only checklist-adjacent gap (no cap on tombstone growth).

## Commands run

- `npx vitest run test/integration/beranda.test.ts src/lib/server/budgets` → 3 files, 54 tests passed.
- `npm run db:reset:local` → ok; `npm run build` → done.
- `npx wrangler dev --local --port 8813` (built Worker): probe script — signup 303, CSRF cross-origin 403,
  set 200, second create 409, invalid amounts 400 (×8), bad currency 400, 3 MB body 400, JSON 415,
  unauthenticated 401; overflow probe (1000 × 10^13 rows via `wrangler d1 execute --local`) — `/` 200 with
  "too large" states, `/riwayat` 200, `/__data.json` 200. Servers stopped. No `--remote`, login or deploy.
