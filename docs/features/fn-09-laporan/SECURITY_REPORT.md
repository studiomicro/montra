# FN-09 Laporan — Security report

Reviewed: `git diff c97640f..9172505` (detached worktree at 9172505). Tier: Medium, read-only aggregates.

## Verdict: PASS

No critical, high or medium findings. Two low/informational items are listed so they are tracked.

## Scope checked

| Area | Result |
| --- | --- |
| Cross-space exposure | `src/routes/(app)/laporan/+page.server.ts:11` calls `currentSpaceScope(locals)`, which re-runs `requireSpaceAccess(user, locals.space.id)` on every load (`src/lib/server/spaces/current.ts`). No space id is read from the URL. A `space` cookie for a space the user is not in falls back to the personal space in `hooks.server.ts` (`resolveCurrentSpace`). Removed member: loses figures at once; membership removed between hook and load: 404. Integration tests at `test/integration/laporan.test.ts:457-512` cover all four cases. Ad-hoc: `?space=<uuid>` and a bogus space cookie both returned the caller's own empty report (200). |
| Period/range tampering | `parseLaporanQuery` (`src/lib/shared/laporan-query.ts:15-24`) is an allowlist (`bulan-ini`/`bulan-lalu`/`tahun-ini`, `arah=masuk` or default). The date range is computed server-side from WIB today only; `from`/`to`/`period[]`/NUL bytes/20 kB values fall back to defaults. `filterWhere` still enforces `assertBounded` (< 366 days); year-to-date on 2028-12-31 (leap year, 365-day span) and the month-before window (at most 62 days) stay under the cap (probe passed). |
| Merchant grouping | `merchantTotals` (`src/lib/server/transactions/aggregate.ts:432-454`) uses `trim`/`lower`/`min` with equality grouping; no LIKE/GLOB, no regex (no ReDoS). Every value is a bound parameter (Drizzle `sql` template); `limit` is clamped to 1..10. Probe with titles `%`, `_`, `[a-z]*`, zero-width, Turkish dotted I, NUL, a SQL-injection string, `<script>` and a 5000-char raw title: no error, correct grouping by equality. Titles render as Svelte text (`+page.svelte:211`), no `{@html}` anywhere in the route. |
| Overflow DoS | Per-row cap 10^13 and per-space row cap keep every SQL `sum` within int64; sums travel as text into BigInt and `safeMinor` turns > 2^53 into null ("too large") — test `laporan.test.ts:420-455` (1000 x 10^13) shows null in stats, net, category, percent, merchants, lines and bars; never 0, never 500. |
| Demo/transfer exclusion | Applied in SQL (`is_demo = 0`, `type <> 'transfer'` / `type = expense|income`, which `merchantTotals` enforces with a throw). No parameter reaches those clauses. Probe with `?demo=1&type=transfer` and a demo row of 999 000 000 and a transfer of 777 000 000: neither figure appears in any report. |
| Oracles | Non-member and member-of-nothing paths produce the same personal-space report; no response differs by the existence of another space's id. Load failure returns a fixed message (`LAPORAN_LOAD_FAILED`), never the D1 error. |
| GET only / CSRF | No form actions; `POST /laporan` returned 405. The load performs only SELECTs (`listWallets`, aggregates). Response carries `Cache-Control: private, no-store`. Signed-out GET is 303 to `/masuk?next=%2Flaporan`. |
| Secrets/PII in page data | Page data holds only aggregates, titles and the currency; wallet list is used for the favourite currency only and not returned. |

## Findings

1. **Low (informational) — merchant groups split on non-ASCII case and invisible characters.**
   `src/lib/server/transactions/aggregate.ts:443-446`. SQLite `lower()` folds ASCII only and `trim` strips only
   space/tab/CR/LF, so `İSTANBUL`/`istanbul` or a title containing U+200B stay separate groups. Normal writes pass
   `cleanText` (zero-width stripped, 80-char cap), so this needs a raw/legacy row. Impact: display fragmentation
   of the top-10 list only; no exposure, no error. Fix: leave to FN-20 merchant normalisation (already out of
   scope per PRD).
2. **Low (informational) — full error object logged on load failure.**
   `src/routes/(app)/laporan/+page.server.ts:18` logs `e` from D1. D1 errors carry SQL text but not bound
   values, so no financial data or ids leak today; keep it that way if a future aggregate interpolates values.
   Fix (optional): log `e instanceof Error ? e.message : 'unknown'`.

## ENGINEERING_CHECKLIST

LIKE/GLOB: none added (equality grouping, `instr` unchanged). Bounded work: every new query goes through
`filterWhere` (period cap) and groups/limits in SQL. Money: integer minor units, BigInt sums, null past 2^53.
Access: one helper (`currentSpaceScope` → `requireSpaceAccess`). No secrets serialised in page data.

## Commands run

- `npm ci`, `npx svelte-kit sync`, `npm run db:reset:local` — OK.
- `npx vitest run test/integration/laporan.test.ts src/lib/server/reports src/lib/shared/laporan-query.test.ts` — 3 files, 33 tests passed.
- Temporary adversarial probe (hostile titles, tampered params, demo/transfer, leap-year range) — 2 tests passed; file removed afterwards.
- `npm run build` — done. `wrangler dev --port 8818 --local`: signed-out 303; signed-in `/laporan` with 6 tampered query/cookie variants all 200 with the caller's own data; `POST /laporan` 405; no errors in the log. Server stopped. No `--remote`, login or deploy.
