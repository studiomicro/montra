# FN-25 Net worth: security report (cycle 1)

Reviewed: `git diff e2780ce..513861f` (detached worktree at 513861f). Reviewer: red-team-pentester, 2026-10-08.

## Verdict: FAIL

Two medium findings (cross-tenant availability and integrity of the cron work). No high findings. The SSRF, parsing,
KV, money arithmetic, authorization and tombstone parts hold.

## Findings

### M1 (medium): spaces past the first 100 by id never get a snapshot

`src/lib/server/net-worth/summary.ts:263-272` (`spacesDueForSnapshot`, `order by s.id limit 100`) with
`SNAPSHOT_REFRESH_MS = 30 min` (`summary.ts:251`) and the hourly cron (`workers/jobs/wrangler.jsonc:7`,
`0 23,0-16 * * *`).

A snapshot written at tick T has `updated_at = T`. At T+60 min it is older than 30 minutes, so the same space is due
again. Every tick therefore re-selects the same lowest-id 100 spaces and overwrites their snapshot. Space number 101
and later never gets one, so its 30-day change never appears. This is the same class as FN-24 L3, and this time the
starvation is total. Spaces whose total is "too large" (`summary.ts:330`, skipped) or that fail keep no fresh
snapshot. They stay due forever and also hold slots. Any user can make their own space too large by entering a
quantity of 10^15 coins.

PoC (temporary Vitest, run then removed): 105 accounts, each with one manual item. After 18 hourly
`writeSnapshots` calls, fewer than 105 distinct spaces have a snapshot (assertion `< 105` passed).

Fix: order by "least recently snapshotted first". For example, give missing snapshots priority, then
`order by coalesce(n.updated_at, 0) asc, s.id`. Or keep a rotating cursor in KV/D1 as in the FN-24 L3 fix. Also
record a skipped or failed attempt (for example `last_attempt_at`) so a permanently skipped space moves to the back.
Add a test with 101+ spaces over several ticks in which every space gets a snapshot.

### M2 (medium): any user can push real coins out of price refresh (cross-tenant)

`src/lib/server/net-worth/repo.ts:230-233` (`select distinct price_symbol … order by price_symbol limit 500`) with
`src/lib/server/net-worth/validation.ts:250,362-365`, which accepts any `[a-z0-9]{1,15}` code, listed on Indodax
or not.

An attacker opens 3 free accounts and adds 200 crypto items to each personal space with codes `a0000…a2199`
(600 distinct codes, all sorted before `btc`). `pricingDemand` returns only the first 500, so `btc`, `eth`,
`usdt` and the rest are never requested. After `PRICE_MAX_AGE_MS` (3 days), every other user's coin items drop to
their manual fallback or "Belum ada harga". `refreshPrices` also rebuilds `price:indodax` only from the demanded
coins (`prices.ts:371-376`), so real coins' last-good entries are dropped on the next successful write, and the
outage starts immediately rather than after 3 days. A failure here is invisible to the victims.

PoC (temporary Vitest, run then removed): one victim item `btc` plus 600 junk codes from 3 accounts gives
`pricingDemand(db).coins.includes('btc') === false` (passed).

Fix: since `ticker_all` already returns every pair in one request, drop the symbol cap from the fetch path. Cache
every valid `<coin>_idr` pair from the answer, bounded by the response itself (about 75 KB, under the 512 KB cap).
Or at least validate codes on save against the cached ticker list, and order the demand by number of distinct
spaces holding each code (`group by price_symbol order by count(distinct space_id) desc`), not alphabetically.
Add a regression test with 501+ junk codes.

### L1 (low): no jump check on Indodax prices

`src/lib/server/net-worth/prices.ts:189-192`. Each coin is checked only against `0 < price ≤ 10^13 IDR`. A single
bad or manipulated `last` on a thin pair (for example 1000× the previous value) goes straight to KV, then into the
values and today's snapshot. Gold and FX have tight bounds. Fix: compare with the previous cached value and keep
the old one, flagged, when the ratio is beyond a set factor (for example ×10 or ÷10).

### L2 (low): snapshots store partial totals without marking them

`summary.ts:320-341` and `upsertSnapshot`. The stored total leaves out unconverted foreign amounts and items with
no price. Each tick overwrites the day, so the 23:00 WIB tick wins. If that tick hits a KV or rate outage, the
day's snapshot is understated, and in 30 days the "change" shows a gain or loss that never happened. Fix: skip or
flag the snapshot when `unconverted.length > 0` or `missingCount > 0`, or keep the earlier complete figure for
that day.

### L3 (low): `pricingDemand` includes wallets of deleted spaces

`repo.ts:236-241`. The wallet currency query does not join live spaces (the coin query does). This causes extra FX
fetches only, with no data exposure. Fix: add the same `join spaces s … s.deleted_at is null`.

## Checked and holding

- **SSRF:** the three URLs are constants. The only user-derived path segment (`currency`) is checked against
  `WALLET_CURRENCIES` before the URL is built (`prices.ts:233`). `getJson` re-checks https, the exact host
  allow-list, no port or userinfo, and `redirect: 'manual'` (a 3xx is refused). The 8 s `AbortSignal.timeout`
  is set. The body is capped by Content-Length and again by streaming bytes before `JSON.parse`. Response
  bodies are never logged. The coin code only selects a key in the parsed answer (`Object.hasOwn`; the regex
  excludes `_`, so `__proto__` is impossible).
- **Numeric parsing:** decimal text is read by `parseDecimal` into BigInt. It refuses signs, exponents, NaN and
  more than 24+24 digits. JSON numbers go through `String()` and are refused in exponent form. Zero and negative
  values are refused. Gold and FX have exact bounds, and the FX date window is −14/+1 days.
- **KV:** 3 fixed keys, written only by the jobs Worker and only after full validation. A failed source keeps
  its last good value. Reads are re-validated by zod and age-filtered (3 days for prices, 7 for FX), with
  future `at` refused. The stale label comes from the stored fetch time.
- **Valuation:** exact BigInt rationals with one rounding step. Each currency sum is converted once at a cached
  rate, and the rate and date are shown. Without a rate, amounts are listed apart and never summed. Overflow
  gives `null` ("too large"), never a wrong figure.
- **Authorization:** every load and action goes through `requireSpaceAccess`. Writes are guarded by
  `isLiveMember` in the same statement, so a removed member writes nothing. Another space's id and an unknown id
  both answer `missing`. The 200-item cap is enforced in one guarded `INSERT … SELECT` (concurrency test
  passes). The jobs Worker exposes no route.
- **Tombstones and purge:** delete leaves no content (enforced by a DB CHECK). Items and snapshots are in
  `SPACE_SCOPED_TABLES` (account-delete purge, integration test) and have FK cascades.
- **Wording, output and CSP:** a "not investment advice" notice is shown. There is no `{@html}`, and `{#each}`
  is keyed by id or enum. CSP is unchanged (`hooks.server.ts` is not in the diff, and the browser does no fetch).
  Logs contain only counts, reasons and space ids.

## Commands

- `npx vitest run src/lib/server/net-worth src/lib/shared/net-worth.test.ts test/integration/net-worth.test.ts test/integration/net-worth-routes.test.ts --maxWorkers=2`:
  Test Files 6 passed, Tests 66 passed.
- Temporary PoC `test/integration/zz-redteam-fn25.test.ts` (M1, M2), `--maxWorkers=2`: Tests 2 passed (both
  attacks confirmed). File removed afterwards.
- Not run: wrangler dev `--test-scheduled` probe (the machine was overloaded; the cron path is covered by the
  stubbed-fetch integration tests), Playwright, and real provider requests (none made).

## Cycle 2 re-check (d0ef4fc): PASS

Scope: `git show d0ef4fc` only. No medium or high findings remain.

| Finding | Status | Evidence |
| --- | --- | --- |
| M1 snapshot starvation | FIXED | `summary.ts` `nextSnapshotBatch`: a cursor in `app_meta` rotates through the spaces (ids after the cursor, then wraps round). A skipped or failed space falls behind the cursor. Re-run PoC: 105 spaces all have a snapshot after 2 hourly ticks. |
| M2 coin-code crowding | FIXED | `fetchIndodaxPrices` caches every valid `<coin>_idr` pair (at most 2,000, under the 512 KB body cap). The demand is now a yes/no flag, so user codes no longer choose which pairs are fetched. Unknown codes are refused when a ticker is cached. Codes accepted on a cold cache only produce an "unlisted" item in the attacker's own space, so M2 does not come back. Re-run PoC: 600 junk codes from 3 accounts, and btc is still priced (`basis: 'price'`). |
| L1 price jumps | FIXED | `isPriceJump` (exact BigInt, more than ×1.5 or less than ÷1.5) holds the jump as `pending`. It is accepted only when the next tick confirms it. The input is provider data only, and the cache key is not user-controlled. Probe: a 1000× spike followed by a return to normal never reached the price book. |
| L2 partial snapshots | FIXED | New `partial` column. `setWhere` stops a partial figure overwriting a complete one for the same day. Partial days are left out of both change queries. |
| L3 deleted-space wallets | FIXED | Both currency queries and both existence queries join live spaces. |

New low findings (tracked, not blocking):

- **L4 (low), capacity:** 18 ticks × 100 spaces gives at most 1,800 snapshots per WIB day. Beyond that number of
  active spaces, every space misses some days. None is starved, but the exact 30-day base (`days30`) is often
  missing, so the comparison falls back to `since`. Fix when needed: a per-tick budget, or queue fan-out.
- **L5 (low), snapshots that are not flagged:** a priced item whose price aged out (more than 3 days) and falls
  back to its manual value is not counted in `missingCount`. That snapshot is stored as complete, so the change
  can compare a price-based figure with a manual one. Fix: treat `basis === 'fallback'` as partial.
- Note: migration `0013_net_worth.sql` was edited in place. The engineer report states it is not applied
  anywhere, and the staging evidence (fa58797) predates FN-25. Confirm before any remote apply.

Commands (cycle 2):

- `npx vitest run <temporary PoC file> src/lib/server/net-worth src/lib/shared/net-worth.test.ts test/integration/net-worth.test.ts test/integration/net-worth-routes.test.ts --maxWorkers=2`:
  Test Files 7 passed, Tests 77 passed. That is 74 feature tests plus 3 red-team probes (PoC1, PoC2, L1). The
  PoC file was removed afterwards.
- Not run: Playwright, wrangler dev, and real provider requests.
