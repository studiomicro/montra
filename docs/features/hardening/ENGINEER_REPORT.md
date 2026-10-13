# Hardening batch — engineer report

Branch `hardening` (from main 0478484). One commit per item. No migration added. No i18n keys added (no new
user-facing text). Trackers not edited.

| # | Item | Status | Files | Regression test | Fail-before |
|---|------|--------|-------|-----------------|-------------|
| 1 | FN-31 L1 export re-checks membership before each photo GET and member list | done | `src/lib/server/export/account-export.ts` (photo rows carry `spaceId`; `stillMember` via `isLiveMember` before `files.get` and `listMembers`) | `test/integration/privacy.test.ts` "a removal while the download runs ends that space's photos and member names" | photo bytes 5000 written after removal (expected 0) |
| 2 | FN-31 L2 throttle fails closed on D1 error | done | `src/lib/server/auth/throttle.ts` (`THROTTLE_SCOPES`, `failClosed` with per-scope rationale; every scope incl. sign-in/sign-up/account-password fails closed; vouchers already did) | `src/lib/server/auth/throttle.test.ts` "throttle on a database error" (each scope, client + user) | 5/5 returned `false` (fail open) |
| 3 | FN-31 L3 per-user limit on `/api/v1/track` | done | `src/routes/api/v1/track/+server.ts`, `src/lib/server/analytics/track.ts` (`TRACK_MAX_PER_WINDOW = 120` / 10 min), scope `track` | privacy.test.ts "per-user rate limit: past the window budget the beacon still answers 200 and writes nothing" | 121 writes (expected 120) |
| 4 | FN-36 L3 recurring budget subtracts other jobs' statements | done | `src/lib/server/db/statement-count.ts` (counting D1 proxy), `src/lib/server/recurring/repo.ts` (`recurringBudget(usedByOthers)`, `D1_STATEMENTS_PER_INVOCATION`, `recurringChecker`), `workers/jobs/src/index.ts` | `test/integration/recurring.test.ts` "FN-36 L3: other jobs used 750 statements …" | 1045 statements (expected ≤ 1000) |
| 5 | FN-37 low: `transactions.json` excludes Data demo rows | done | `src/lib/server/export/tables.ts` (`realRowsOnly` on transactions, in page and count queries), account.json note | privacy.test.ts "transactions.json leaves out Data demo rows" | demo row present |
| 6 | Unknown currency codes | done | `src/lib/shared/money-format.ts`: full ISO 4217 List One exponent table (0/2/3/4); unknown code → `RangeError`, never a guessed 2. IDR default unchanged; stored currencies are validated against `WALLET_CURRENCIES` before save | `src/lib/shared/money-format.test.ts` (CLP/ISK/UGX 0, TND/IQD 3, CLF 4; XYZ/BTC/XAU/prototype keys refused) | CLP gave 2; XYZ did not throw |
| 7 | Riwayat "Ekspor CSV" 44 px | done (kit, not the riwayat route) | `src/lib/ui/kit/Button.svelte`: `size="sm"` is 44 px under `(pointer: coarse)`; riwayat route file untouched | `e2e/kit.spec.ts` "small pill buttons are 44 px touch targets on phone" | height 40 |
| 8 | Langganan names truncate at 360 px | done | `src/routes/(app)/langganan/+page.svelte`: name clamps at 2 lines; first line wraps so a long name takes the full width and the amount moves below, right-aligned; short names keep the two-line row | `e2e/langganan.spec.ts` "360 px: a long name wraps to a second line instead of being cut" | name box 60 px wide, cut |
| 9 | Test infra miniflare cleanup | done | `scripts/clean-miniflare-tmp.ts`, `package.json` (`posttest`, `clean:tmp`), `docs/RUNBOOK.md` Tests section | `scripts/clean-miniflare-tmp.test.ts` (only own, old, directory entries) | module missing (new tool) |

Skipped: FN-34 `day_closures.closed_on` CHECK (needs a migration, out of scope). Nothing needed the FN-02 files
(`transactions/repo.ts`, riwayat routes, push endpoint); none were edited.

## Checklist items applied

- Access: one access rule (`isLiveMember`) reused for the export re-checks; removed-member crawl covered by test.
- Bounded work / D1 cap: recurring budget derived from counted statements; 750 + recurring ≤ 1,000 proven.
- Concurrency: throttle unchanged in its guarded upsert; existing 20-concurrent export test still exact (5 answered).
- Money: integer exponents from one table; no float; unknown codes refused.
- Data demo excluded from export totals/rows.
- UI: 44 px touch targets on coarse pointers; 360 px no horizontal scroll (e2e).
- Tests: fail-before shown for each item (table above).

## Pre-handoff probes

- Concurrency: privacy.test.ts "20 concurrent export requests: exactly the window's 5 are answered" — pass.
- Cross-space: export as removed member (rows, photos, member names) — pass.
- 360 px: kit + langganan e2e (phone 360 px, `expectNoHorizontalScroll`) — pass.
- Money vectors: money-parse + money-format suites — pass (full run).
- User copy: no new user-facing strings.
- Two tabs / no-JS / two devices / month boundaries: not applicable (no forms or dates changed).

## Gates (each step separately under `flock /tmp/montra-heavy.lock`)

- `npm run check`: svelte-check 1521 files, 0 errors, 0 warnings; tsc (service worker, jobs, inbound) exit 0.
- `npm run lint`: "All matched files use Prettier code style!", eslint clean, exit 0.
- `npx vitest run --maxWorkers=2`: Test Files 171 passed (171); Tests 2442 passed (2442).
- `npm run build`: "✔ done", exit 0.
- Playwright `--workers=1` (port 8823) `e2e/kit.spec.ts e2e/langganan.spec.ts`, phone + desktop: 21 passed, 2 skipped (phone-only tests on desktop).
