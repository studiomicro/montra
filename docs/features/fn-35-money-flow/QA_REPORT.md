# FN-35 Money-flow chart ("Alur uang") — QA report, cycle 1

**Verdict: FAIL**

One regression (finding 1) in an existing journey test caused by this diff; everything else checked passes.
Fix is small (update a stale node count in `e2e/shell.spec.ts`) and does not touch the feature's own behaviour,
but per the pipeline rule a broken existing test is an automatic FAIL until corrected.

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → `COMPLETED 1491 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0, no provider (static types).
- `flock /tmp/montra-heavy.lock npm run lint` → `All matched files use Prettier code style!`, eslint clean, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` → `Test Files 165 passed (165)`, `Tests 2329 passed (2329)`, exit 0, local D1 fixture (no real provider).
- `flock /tmp/montra-heavy.lock npm run build` → `✔ done` (adapter-cloudflare, service worker built), exit 0, no provider.
- `LD_LIBRARY_PATH=… E2E_PORT=8891 npx playwright test e2e/alur-uang.spec.ts e2e/laporan.spec.ts e2e/shell.spec.ts --workers=1` → `40 passed, 1 failed` — `shell.spec.ts:38` (desktop) fails: nav link count expected 19, got 20; local wrangler dev server (mocked AI/payment, fixture D1), not a real provider.
- `LD_LIBRARY_PATH=… E2E_PORT=8892 npx playwright test e2e/alur-uang-qa.spec.ts --workers=1` → first run `4 passed, 1 skipped, 2 failed` (QA test bug: substring category lookup), local wrangler dev, not a real provider.
- `LD_LIBRARY_PATH=… E2E_PORT=8893 npx playwright test e2e/alur-uang-qa.spec.ts --workers=1` (after fixing the QA test's category lookup) → `6 passed, 1 skipped`, local wrangler dev, not a real provider.
- `npm run db:migrate:local` — not run: this feature adds no migration (`git diff --stat main...HEAD -- migrations/` is empty), confirmed by inspection, consistent with the PRD ("No migration") and the engineer report.

`npm run gates` and `npm test` were not run directly (RAM rule); the four steps above are its exact constituent commands, each run separately and clean. `npm run gates` does not include `test:e2e`, so the shell.spec.ts regression would not be caught by `npm run gates` alone — it only surfaces when the full e2e journey suite runs, which this PRD's "browser journey" clause requires.

## Findings

1. **FAIL — stale node count in `e2e/shell.spec.ts` (desktop sidebar), broken by this diff, not fixed by it.**
   `src/lib/ui/shell/nav.ts` adds a new Fitur-section sidebar entry ("Alur uang"), and the corresponding unit
   test `src/lib/ui/shell/nav.test.ts` was updated correctly. But `e2e/shell.spec.ts:54` still asserts the old
   total (`await expect(links).toHaveCount(5 + 5 + 3 + 6)`, comment "Fitur (Jelajahi fitur + 4 modules)") — the
   Fitur section now has 6 links (Jelajahi fitur + Alur uang + 4 modules), not 5, so the desktop assertion
   fails (`Expected: 19, Received: 20`). Input: load `/` on the desktop project with a signed-in user → expected:
   the test documents and asserts the new total → actual: it still asserts the pre-FN-35 total and fails.
   Evidence: `e2e/shell.spec.ts:38` desktop, `Expected: 19 Received: 20`
   (`test-results/port-8891/shell-phone-shows-the-tab--…-desktop/trace.zip`). The engineer's cycle-1 report only
   ran `e2e/alur-uang.spec.ts` (`9 passed`), not the full shell suite, so this was not caught before handoff.
   Fix: update the `5 + 5 + 3 + 6` sum (and the comment) in `e2e/shell.spec.ts` to `5 + 6 + 3 + 6`. This is a
   one-line test fix, not a behaviour change; QA does not edit it (QA may add tests, not patch an existing
   engineer test), so it is reported back for the fix cycle.

No other findings. No source-code, money, access or i18n defects found.

## Checked criteria

1. **PASS** — three columns, every link a real stored sum. `src/lib/server/reports/money-flow.ts shapeMoneyFlow`
   builds links only from `moneyFlowTotals` rows (exact `CAST(SUM AS TEXT)` → `safeMinor`, never rounded/estimated).
   Unit: `money-flow.test.ts` "builds income → wallet → expense nodes and links, largest first; totals are exact
   sums". E2e: `alur-uang.spec.ts` asserts `Gaji → BCA Rp 9.000.000` as a visible accessible link.
2. **PASS** — income-side link sum into a wallet equals `periodTotals({walletId, type:'income'})`. Integration
   `test/integration/alur-uang.test.ts` "each wallet's links equal its income and expense totals for the same
   filter" computes both sides and asserts equality (BCA, GoPay, two wallets).
3. **PASS** — same test, expense side; also asserts the transfer out of BCA is excluded from `outMinor`
   (`outMinor: 9_800_000`, not `49_800_000`).
4. **PASS** — one currency drawn (favourite wallet's / IDR), other currencies named and counted, never summed.
   Integration "one currency drawn; the other is named and counted, never added in (AC 4)" and "the favourite
   wallet's currency is the one drawn" (flips to USD, IDR becomes the named other). Unit `shapeMoneyFlow` "draws
   one currency only…" with SGD + USD both present and both excluded from totals.
5. **PASS** — empty month shows the defined empty state, no blank SVG. Integration "an empty month: no node and
   no link, honest zeros"; e2e "an empty month shows the empty state; the Fitur entry opens the page" asserts
   `heading 'Belum ada alur uang'` visible and `main svg[role="group"]` count 0.
6. **PASS** — no-flow wallet/category never a node. Integration "demo rows, transfers and nodes without flow are
   left out (AC 6, 11)": idle wallet (`Celengan`) and last-month-only category (`Belanja`) absent from the
   report; `r.links.every(x => x.amountMinor! > 0)`.
7. **PASS** — non-member, removed member, stale `locals.space` all answer exactly like Laporan. Integration "a
   non-member naming the space (cookie or query) only ever sees their own space", "a removed member loses the
   flow at once; a stale locals.space is 404 like every route" — the test literally diffs the flow route's
   answer against Laporan's answer for the same stale space (`expect(flow).toEqual(lap)`).
8. **PASS** — failing query shows the fixed error state, never a 500, no D1 text leaked. Integration "a failing
   query shows the error state with a fixed message, never a 500 or the SQL text" asserts `loadError` is the
   fixed string and the console log never contains `D1_ERROR`.
9. **PASS** — every new phrase has an English entry. `git diff` of `src/lib/shared/i18n-en.ts` shows 15 new
   entries matching every new ID string in the route/component/Fitur-sheet/nav; `test/i18n-coverage.test.ts`
   passed as part of the full vitest run (2329 passed).
10. **PASS** — 360 px, no horizontal scroll, tap targets ≥ 44 px. `flowLayout`'s `FLOW_MIN_NODE = 48` (unit-
    tested in `geometry.test.ts`); e2e `expectNoHorizontalScroll` on phone project for both the seeded and empty
    states, and node `a.hit` bounding boxes asserted `>= 44` on phone. QA also confirmed with 15 categories (well
    past the "many categories" stress case) — `e2e/alur-uang-qa.spec.ts` "many categories (15, past the >= 12
    bar) render without horizontal overflow": 16 accessible nodes, no horizontal scroll, phone and desktop.
11. **PASS** — demo rows excluded. `moneyFlowTotals` filters `t.is_demo = 0` in SQL; integration test's seeded
    123,000,000 demo expense in Hiburan never appears in `r.expense`.
12. **PASS (fail-before proof present)** — transfer and a CHECK-bypassed `adjustment` row contribute to no link.
    Integration "a row of any other type (a transfer, or a future balance adjustment) contributes to no link":
    inserts a transfer and an `adjustment` row via `PRAGMA ignore_check_constraints`, asserts only the one real
    expense row appears. Engineer report records the required fail-before proof (swapping to `type <>
    'transfer'` makes the test fail) — verified present in the diff's query (`t.type in ('income', 'expense')`
    by name, not by exclusion).

### Space authorization (explicit re-check)

- Cross-space: a member of a shared space sees its flow; a non-member supplying the space id via cookie/query
  still only sees their own space (never the named space's data) — `test/integration/alur-uang.test.ts`.
- Removed member: loses access at once (links empty), and a stale `locals.space` reference answers 404
  identically to Laporan's own 404 for the same stale space (byte-for-byte object equality asserted in the
  test, not just same status code) — satisfies "One access rule" / no existence oracle.
- Sync push/pull: N/A — this feature is read-only (no new writable rows), confirmed by the diff (no new table,
  no new write path).

### Contrast (measured, not eyeballed)

Computed WCAG 2.1 relative-luminance contrast ratios from `docs/design/tokens.css` for every text/background
pair the chart and its surrounding page use:

| pair | light | dark | needs |
|---|---|---|---|
| `--ink` text on `--panel` (node name/amount text, list rows) | 16.47:1 | 15.63:1 | 4.5:1 |
| `--muted` text on `--panel` (node amount sub-line) | 4.66:1 | 6.61:1 | 4.5:1 |
| `--accent` strip on `--panel` (wallet node colour strip, non-text) | 4.12:1 | 5.49:1 | 3:1 (graphic) |
| `.link` (`--ink`) on page `--bg` | 17.93:1 | 17.33:1 | 4.5:1 |
| `.muted` caption on page `--bg` | 5.07:1 | 7.34:1 | 4.5:1 |

All text pairs pass WCAG AA (≥ 4.5:1) in both themes; the light-theme `--muted` on `--panel` is the tightest
margin (4.66:1) but still clears the bar. Decorative band strokes (`stroke-opacity: 0.45`) are not text and are
backed by the accessible-name list ("Rincian alur") as the real information channel, matching the component's
own comment ("the list is the text alternative").

### Accessible text alternative and keyboard focus (QA-added, `e2e/alur-uang-qa.spec.ts`)

- Every link/node in the SVG is a real `<a href>` with `aria-label` (not only a `<title>` on a path), confirmed
  by role-based Playwright queries (`getByRole('link', { name: … })`) matching the exact text and amount.
- `e2e/alur-uang-qa.spec.ts` "a chart link is reachable and activatable by keyboard, with an accessible name":
  `.focus()` on the chart's income→wallet link, then asserts `toBeFocused()` and that the element is a native
  `<a>` (keyboard-reachable without a script-managed tabindex workaround) — passed on desktop (skipped on phone,
  a coarse-pointer project where `pointer-events: none` on bands is deliberate per the component's own comment,
  and the touch path is the list below).
- On a coarse pointer the bands have `pointer-events: none` (CSS, verified in `FlowChart.svelte`); the touch
  path is the "Rincian alur" list, each row a `GroupRow` link ≥ 44 px tall (per `GroupRow`'s existing contract,
  reused unchanged).

### Many categories (QA-added)

`e2e/alur-uang-qa.spec.ts` seeds all 15 preset categories (10 expense + 5 income) with flow in one wallet in one
month (comfortably past the ">= 12" bar), and asserts: 16 accessible chart nodes, no horizontal scroll (phone
and desktop), and the page still renders correctly. Screenshots added:
`docs/features/fn-35-money-flow/shots/360-many-categories-dark.png` and
`docs/features/fn-35-money-flow/shots/1440-many-categories-dark.png`. Visually confirmed (one screenshot
reviewed): all 16 nodes draw distinctly with truncated names, the "Rincian alur" list below enumerates every
link with its exact amount, and the floating tab bar's mid-page overlap in the full-page phone capture is the
same known full-page-capture artifact the engineer already noted (a fixed element, not a scroll/layout bug).

### Other checks

- **Money exactness / no currency mixing**: `moneyFlowTotals` groups by `(type, category_id, wallet_id,
  currency)` and sums in SQL with `CAST(SUM AS TEXT)` → `safeMinor` (exact, no float); `shapeMoneyFlow` only
  ever sums rows that already match the one drawn currency. A too-large sum is `null`, never rounded — unit
  "a too-large sum is null and everything built on it is null, never rounded".
- **WIB month boundary**: integration "23:30 WIB on 31 October and 00:30 WIB on 1 November flow in their own
  month" — 300 stays in October, 500 moves to November.
- **No fabricated figures**: every number on the page traces to a `moneyFlowTotals` row; the page's own copy
  states "Transfer antardompet tidak dihitung" (honest about scope) and the "too large" fallback never
  approximates.
- **No other-product names**: a case-insensitive grep of `git diff main...HEAD` for the reference product's name — no matches.
- **Entry points**: sidebar Fitur section (`nav.ts`, new `/alur-uang` row, `nav.test.ts` updated), Fitur sheet
  "Buka fitur" list (always shown, no toggle — owner decision B, correctly unimplemented), and a "Lihat alur
  uang" link from Laporan's month view (`laporan/+page.svelte`, `view.mode === 'bulan'` only) — all three present
  and exercised by e2e (`alur-uang.spec.ts` reaches the page from Laporan; the empty-state test reaches it from
  the Fitur sheet on phone and the sidebar on desktop).
- **Loading/empty/error states**: `+page.svelte` has a `loading` skeleton (`aria-busy`), an `ErrorState` with
  retry on `loadError`, and the dedicated empty-state section — all present and distinct from each other.
- **Deviations from PRD noted by the engineer** (FlowChart under `src/lib/ui/charts` not `ui/kit`; no `today`
  argument on `moneyFlowReport`; touch users reach links through "Rincian alur" rather than the bands) are all
  cosmetic/organisational, don't change behaviour the acceptance criteria describe, and are consistent with the
  rest of the chart family (`src/lib/ui/charts/geometry.ts` already holds `MonthLines`/`BarChart`/`CategoryBar`
  geometry) — no objection.

## Engineering checklist spot-check

No violations found: one access rule (`requireSpaceAccess` via `currentSpaceScope`, same as Laporan); one
currency per sum with grouping by currency in SQL; WIB dates via `occurred_on`/`monthRange`; totals reconcile
(explicitly tested against `periodTotals`/`categoryTotals`/`laporanReport`); i18n entries present; touch targets
≥ 44 px; headings don't skip (`h1` via `ScreenTitle` → `h2` section headings → `h3` sub-lists); `{#each}` lists
keyed by stable ids (`rect.key`, `b.index`, `w.key`, `row.key`), never by user text; no upload/log persistence
touched by this diff (grep confirms no R2/D1 writes added beyond the read-only aggregate); user copy
(`FLOW_LOAD_FAILED`) is a fixed string, never SQL text or a path.
