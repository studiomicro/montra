# FN-53 Period reports — security report (red team, cycle 1)

Scope: `git diff main...HEAD` at 2c0f074 (feat/fn-53-period-reports rebased on main 73694d2). Routes `/alur-uang`
and `/kekayaan/laporan` (and their `__data.json`), `src/lib/shared/report-period.ts`,
`src/lib/server/reports/money-flow.ts`, `src/lib/server/net-worth/period.ts`, `summary.ts` (snapshot writer),
migration 0046, `ReportPeriodNav.svelte`, `PeriodTrend.svelte`, both `+page.svelte`.

## Verdict: PASS

No medium or high findings. Two low findings are tracked below.

## Findings

### L1 (low): `/alur-uang` cannot load any period at the 2000 floor

- File: `src/lib/server/reports/money-flow.ts` (`moneyFlowReport`, the `periodTotals(... previous.from, previous.to)`
  call) together with `src/lib/shared/report-period.ts` `previousPeriodDates` and `aggregate.ts:114-118`
  `assertBounded`.
- Scenario: `/alur-uang?y=2000`, `?k=2000-Q1`, `?p=2000-01`, and every clamped-to-floor input (`?y=0000`,
  `?k=1999-Q4`, `?k=2000-Q1&m=tahun`) yields a previous period in 1999. `isDateString` only accepts 2000–2099, so
  `assertBounded` throws `RangeError('bad period')`. The loader catches it and shows "Alur uang tidak bisa dimuat"
  and logs `alur-uang: report failed` on every request. The stepper (`stepReportPeriod`) lets a user walk back into
  these periods. Before FN-53, `/alur-uang?p=2000-01` loaded, so this is a regression.
- Impact: no 500, no data exposure, no unbounded work. It is an availability and truthfulness bug: the error state
  appears for a valid period, and any signed-in user can trigger the error log line on demand. `/kekayaan/laporan`
  is not affected.
- Reproduction (PoC, deleted): the loader with `?y=2000` returns `loadError` set. Fix: when the previous range falls
  before the floor, skip `periodTotals` and set `hasRows: false`, or clamp `previous.from` to `2000-01-01`. Add a
  regression vector for each kind at the floor.

### L2 (low): direction of change is still visible while amounts are hidden

- Files: `src/routes/(app)/alur-uang/+page.svelte:215,284-285` (the `↑`/`↓` glyph and
  "{jumlah} lebih banyak / lebih sedikit dari {periode}"), `src/routes/(app)/kekayaan/laporan/+page.svelte:58-66`
  (hero label "Naik" / "Turun" / "Tetap") and `:76-80` ("Utang berkurang / bertambah").
- Scenario: with the eye toggled to hidden, a shoulder-surfer sees that net worth went up or down, that spending
  rose, and that debt grew. The figures themselves are masked by `shown()`. AC 33 removes the rising/falling colour
  for exactly this reason, but the words and glyphs still give it away.
- Impact: this is a display screen, not an access control. `__data.json` carries the figures by design, as on every
  page. Suggested: when `amounts.hidden`, use the neutral label ("Perubahan kekayaan bersih"), the `=`-less glyph,
  and a direction-free sentence.

## Checked and found sound

- **Query parameters.** `parseReportPeriod` accepts only `^\d{4}-Q[1-4]$`, `^\d{4}$` and `isMonthString`. Anything
  else falls through to the default. Future periods clamp to the current period and periods before 2000 clamp to
  2000. Repeated parameters use the first value only. A PoC fuzz ran 25 hostile values × 4 parameters × 5 `m`
  values × 4 "today" dates, including Q0/Q5, 0000/99999, SQL quotes, a 100 kB value, Arabic and full-width digits
  and repeats. It found no throw from the parser. Every period was 0–366 days, never before 2000, and `href` only
  matched `[pky]=[0-9Q-]+`. Both loaders were run with these inputs: no exception and no 500. The only failure was
  L1's caught error. Period values reach SQL only as bound parameters (Drizzle `sql` template).
- **Space access.** Both loaders take the space from `currentSpaceScope(locals)` (`requireSpaceAccess` on every
  load) and never read a space id from the URL. The integration suite covers this (period-reports.test.ts AC 31/32):
  a member sees what the owner sees; a stranger who names the shared space in the URL gets only their own data; a
  removed member with a stale `locals.space` gets 404 like `/laporan`; a signed-out user is sent to `/masuk`. Both
  routes are load-only, with no form actions.
- **Aggregates.** `moneyFlowTotals`, `monthlyTotals` and `periodTotals` all go through `filterWhere` (`space_id`,
  `deleted_at is null`, a bounded date range) and use `MONEY_ROWS` or `type in ('income','expense')` with
  `is_demo = 0`. Transfers, adjustments, deleted rows and demo rows add nothing (AC 15/16 test). Other currencies are
  named and counted but never added in. Sums are exact BigInt; a total that is too large is null.
- **`classes` column.** It is built only in `snapshotClasses()` from `netWorthSummary().classes`. The keys are
  `NetWorthClass` enum members and the values are safe integers, passed through `JSON.stringify`. No wallet name or
  user text reaches it. The reader (`parseClasses`) uses a `Map`, rejects non-objects and non-safe-integers, and
  folds unknown keys into `other`. Prototype keys are harmless.
- **Snapshot writer.** The upsert is one `db.batch`. Its insert selects from the live space row, so a space deleted
  mid-run writes nothing. On conflict it never lets a partial figure replace a complete one, and `classes` follows
  the same rule. Concurrent runs are idempotent. Space purge hard-deletes `net_worth_snapshots`, and no code
  tombstones a row with `classes` set, so the new CHECK cannot block account or space deletion.
- **Migration 0046.** A single `ALTER TABLE … ADD` of a nullable column with a CHECK. No rebuild, no backfill and no
  data loss. Existing rows are null and pass. The migration-0046 test passes.
- **Bounded work.** `/alur-uang` runs 4 aggregate statements for any period; the 20,000-row year test passes.
  `/kekayaan/laporan` runs 2 snapshot statements for a past period (`limit 400`, primary key range). A period that
  contains today reads only the KV price cache.
- **Output.** Neither page uses `{@html}`. `{#each}` lists are keyed by id, month or class. Errors show fixed text,
  and the log carries `errorLabel` only. Signed-in responses get `cache-control: private, no-store` from
  `hooks.server.ts:128`. The period switcher is a GET form; there are no new mutations, so there is no CSRF surface.
  `FOLDED_ID` `*` never becomes a Riwayat link.

## Commands

- `npx vitest run src/lib/shared/report-period.test.ts` — 17 passed
- `npx vitest run src/lib/server/net-worth/period.test.ts` — 17 passed
- `npx vitest run test/integration/period-reports.test.ts` — 26 passed
- `npx vitest run test/integration/migration-0046.test.ts` — 3 passed
- PoC `src/lib/shared/poc-rt.test.ts` (parser fuzz): failed only on 1999 previous-period dates (L1). Deleted.
- PoC `test/integration/poc-rt.test.ts` (both loaders, hostile params): `/alur-uang` returned `loadError` for the 6
  floor vectors and nothing else; `/kekayaan/laporan` was clean. Deleted.

## Resolution (cycle 2)

- **L1 fixed.** `previousPeriodDates` (`src/lib/shared/report-period.ts`) now returns null when the previous period
  would start before 2000. `moneyFlowReport` then skips the previous-period `periodTotals` call and sets
  `comparison: null`, and `/alur-uang` shows "Tidak ada periode sebelumnya" instead of the error state. The stepper
  already returned null below 2000. Above 2099 it returns null because the current period is the ceiling (`today`
  is a valid 2000–2099 date); a vector pins that. Regression tests, each failing before the fix:
  `src/lib/shared/report-period.test.ts` › "the 2000 floor" (every kind, plus the clamped inputs `y=0000`,
  `k=1999-Q4`, `k=2000-Q1&m=tahun`, `p=2000-01&m=kuartal`), and `test/integration/period-reports.test.ts` › "the
  2000 floor". The loader test covers `?y=2000`, `?k=2000-Q1`, `?p=2000-01`, `?y=0000`, `?k=1999-Q4` and
  `?k=2000-Q1&m=tahun`: before the fix it got `loadError`; now it loads with `comparison: null`.
- **L2 fixed.** While amounts are hidden, nothing on either page shows a direction, from the first server render.
  `applyAmountsHiddenAtLoad()` runs before the markup, and every text below reads `amounts.hidden`.
  - `/alur-uang`: each comparison line reads "•••• dibanding {periode}" with a neutral `•` glyph. The ↑/↓/= glyphs
    and "lebih banyak / lebih sedikit / sama dengan" are gone, and the net line has no colour.
  - `/kekayaan/laporan`: the hero label is the neutral "Perubahan kekayaan bersih" (no Naik/Turun/Tetap). The
    `HeroAmount` `signed` mode masks the sign with the figure (`Rp••••`). Group rows read "••••" with no "Utang
    berkurang/bertambah" and no colour.
  - Regression test, failing on the cycle-1 code: `e2e/period-reports.spec.ts` › "hidden amounts hide every
    direction word, sign and glyph from the server HTML". It failed on both projects, passes now.
- **QA lows fixed in the same cycle.**
  - The hero shows the change once: the separate signed line is removed and the colour sits on the hero figure.
  - A negative change reads `−Rp 124.900.000`, with U+2212 before the symbol, through the new `signed` prop of
    `HeroAmount`. Other heroes are unchanged.
  - Regression tests: `src/lib/ui/kit/HeroAmount.test.ts` › "HeroAmount signed" (failed before the prop existed)
    and `e2e/period-reports.spec.ts` › "a fall: the hero shows the change once, as −Rp". The latter received
    `Rp−124.900.000` on the cycle-1 code.

## Cycle 2 (re-check of `git diff 2c0f074..cd3822f`): PASS

Both low findings are fixed. No new finding.

- **L1 fixed.** `previousPeriodDates` returns null when the previous period would start before 2000.
  `moneyFlowReport` then skips the `periodTotals` statement: 3 statements instead of 4, all still bounded aggregates.
  It sets `comparison: null`, and the page says "Tidak ada periode sebelumnya". The page null-guards every
  `r.comparison` use (`previousName`, the `{#if}` chain). No other caller of `previousPeriodDates` exists.
  - Parser fuzz PoC (deleted): 23 hostile values × `k`/`y`/`p` × 4 `m` values × 6 "today" dates (including
    2000-01-01, 2000-03-31 and 2000-04-01). Nothing threw. Every current and previous range is a valid date range of
    0–365 days. Null comes only for a period starting in 2000, and only where `stepReportPeriod(-1)` is also null.
  - Loader PoC (deleted): both routes were loaded with 16 vectors (`?y=2000`, `?k=2000-Q1`, `?p=2000-01`,
    `?k=1999-Q4`, `?y=0000`, `?y=99999`, repeated Q0/Q5, `?p=2026-13&p=2026-01`, SQL quote, a 50 kB value,
    `?k=2000-Q1&m=tahun`, …). There was no `loadError` and no throw. `comparison` is null exactly at the floor
    periods. 2000-Q2, 2000-02 and a year switched to its last month or quarter correctly keep a comparison.
- **L2 fixed.** While amounts are hidden, no sign or direction is shown:
  - Alur uang: the glyph is a neutral `•`. The words are "•••• dibanding {periode}"; the masked amount comes from
    `maskAmount`, which replaces the whole text, sign included. The `up`/`down` classes were already guarded.
  - Kekayaan laporan: the hero label is "Perubahan kekayaan bersih". `groupText` returns only the masked amount, so
    neither "Utang berkurang" nor "Utang bertambah" appears. The hero and row colour classes are guarded by
    `!amounts.hidden`, and the old `.change` line is gone.
  - New `signed` prop of `HeroAmount`: while hidden it renders `moneyParts(0).symbol` (no sign) and a fixed
    `n8` length class, so neither the figure length nor the sign leaks. The SSR test asserts there is no
    `[−+]Rp` while hidden.
  - The trend chart still draws no line, dots or `down` class while hidden. Its aria `valuetext` read-out is masked.
    `__data.json` carries the figures by design, as on every page (the eye is a display screen, not an access
    control).
- **Commands.**
  - `npx vitest run src/lib/shared/report-period.test.ts` — 19 passed
  - `npx vitest run src/lib/ui/kit/HeroAmount.test.ts` — 7 passed
  - `npx vitest run test/integration/period-reports.test.ts` — 27 passed
  - `npx vitest run test/integration/period-reports-qa.test.ts` — 5 passed
  - Both PoCs ran clean (the loader PoC's 4 extra assertion hits were over-broad expectations for periods that
    really have a previous one). Both were deleted.
