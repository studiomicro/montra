# QA report — fn-25b-wealth-page (pass 1)

## Verdict: PASS

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0.
- `npm run gates` (check, lint, test, build chained with `&&`) — exit 0; build completed fully (only reachable if
  check/lint/test all passed first); real code path, no mocks beyond the project's existing AI/price stubs.
- `E2E_PORT=9031 npx playwright test e2e/kekayaan-halaman.spec.ts --workers=1` (flock no-op shim on PATH) — 4
  passed, 3 skipped (project-filtered duplicates of the same 3 specs across phone/desktop), exit 0; real dev
  Worker + local D1, mocked AI Gateway (no key configured, unreachable by design).
- Manual Playwright screenshot script against the same local dev server (signed-up fictional user, seeded wallet)
  — 4 screenshots at `/private<scratchpad>`; real local server, no mocks.
- No new migration in this diff, so `npm run db:migrate:local` was not re-run (nothing new to apply) — consistent
  with the PRD's pass-1 scope ("No migration").

## Scope check against PRD

PRD's "Owner decisions — answered 2026-10-11" expands pass 1 beyond the original "Suggested split" to include:
chart, allocation bar + chips (no receivable kind), Belum dihitung suggestions, grouped Dompet/Investasi/Kripto
sections, credit-card 30-day spend cards (no statement/due dates), eye toggle, desktop layout. The diff matches
exactly this scope: no migration file, no `receivable` kind/class anywhere in the diff, no `statement_day`/`due_day`
columns, `CreditCardCard.svelte` has no date UI. Pass-2-only acceptance criteria (6 partially, 8, 12, 13) are
correctly out of scope this pass.

## Checked criteria (pass-1 scope)

1. Trend plots stored snapshots only, date order, partial flagged — PASS. `netWorthTrend` reads `net_worth_snapshots` directly, no interpolation (`src/lib/server/net-worth/trend.ts`). Verified by
   `test/integration/kekayaan-page.test.ts` "plots exactly the stored totals of the range... partial days flagged"
   and `src/lib/shared/wealth.test.ts`.
2. <2 snapshots → empty-state text, both languages — PASS. `test/integration/kekayaan-page.test.ts` "a new user: no points"; `e2e/kekayaan-halaman.spec.ts` asserts the Indonesian text; i18n-en.ts has the English entry.
3. Range switch recomputes from WIB date via server reload — PASS. `trendRangeStart` pure function tested at month/year boundaries (`wealth.test.ts`); route re-fetches via `?rentang=` query param
   read in `load` (`+page.server.ts`), e2e confirms URL changes and empty text re-renders per range.
4. Non-member/removed-member gets same 404 as unknown id — PASS. `kekayaan-page.test.ts` "a removed member and a stranger get the same 404 as an unknown space" — identical status/body for removed member, stranger and unknown id.
5. Snapshot purge via `SPACE_SCOPED_TABLES` — not re-verified by a new test this pass (unchanged FN-25 behaviour); no regression found in the diff (`trend.ts` only reads, no new table).
6. Allocation bar sums exactly to the positive-asset total, BigInt-exact, debts excluded from denominator (receivable not in scope this pass) — PASS. `allocationOf` tested with largest-remainder rounding, overdrawn/too-large classes kept outside (`wealth.test.ts`); integration test
   confirms exact minor sums and `pct` summing to 100 with real DB data.
7. Debt shown as separate minus line, never a bar segment — PASS. `allocationOf` routes `cls === 'debt'` to `outside` unconditionally; e2e asserts `.allocation .outside` contains the debt line and chips never contain "Utang".
9/10. Belum dihitung cards shown/hidden correctly, tap opens add sheet pre-filled, editable, never auto-saved — PASS. `missingSuggestions` unit-tested (gold/pension keyword heuristic, demo rows never hide a card); e2e verifies gold
   card pre-fills `kind=investment_gold`/`priceSource=gold_api`, pension card pre-fills editable name, and saving
   requires the explicit "Tambah aset" submit.
11. Credit-card 30-day spend equals Riwayat filtered to same wallet/period — PASS. `kekayaan-page.test.ts` "sums expenses of the last 30 WIB days... reconciling with Riwayat" computes the same
   figure via `periodTotals` independently and asserts equality; excludes income, transfers, demo rows, outside-window rows.
14. Grouped section subtotals equal exact sum of their rows — PASS. `sectionTotals` is exact BigInt per currency (`sections.ts`); integration test cross-checks wallet
   balances and investment subtotal against individually computed values.
15. Eye toggle masks every new figure, restores on toggle off — PASS. `AllocationBar`, `TrendChart`, `CreditCardCard`, grouped-section rows, `NetWorthSection`'s `money()` helper
   all route through `shown()`; e2e toggles the eye and asserts none of chips/wallets/cards/outside line contain "Rp",
   then restores and re-checks the exact figure.
16. Tambah header action opens same add sheet, no duplicate implementation — PASS. `+page.svelte` binds `NetWorthSection`'s exported `openAdd()`; no-JS fallback is a plain link to `?aset=baru`
   (verified in code; same sheet/validation/error states as the existing flow).
17. No-JS forms work (credit-card dates are pass-2, so only trend-range GET form and suggestion links apply here) — PASS. `e2e/kekayaan-halaman.spec.ts` "without JavaScript" test: suggestion link opens inline pre-filled form, saves,
   range picker is a GET form that reloads with `?rentang=`.
18. Data demo rows never move chart/bar/sections/cards — PASS. `kekayaan-page.test.ts` creates a demo item and a demo transaction after taking a baseline snapshot and
   asserts identical allocation/sections/credit-card totals before and after.
19. 20 concurrent receivable creates at cap — N/A this pass (receivable kind deferred to FN-25c); not applicable, correctly not attempted.
20. Every new Indonesian string has an English entry; money via shared formatters; new class-colour tokens pass contrast test — PASS. Diffed `i18n-en.ts` entries cover all new strings (range labels, suggestion cards, empty/partial text);
   reused keys ("Kartu kredit", "Lihat semua", "Tidak bisa dimuat") already had English entries. `test/contrast.test.ts`
   extended with `--nw-{wallets,cash,investment,crypto,gold,property}` × `{--bg,--panel}` for all themes — part of
   the green `npm run gates` run (includes Hitam-putih, light, dark, Pro themes programmatically).
21. 360 px one column, ≥1024 px two columns, no horizontal scroll, 44 px targets — PASS. `e2e/kekayaan-halaman.spec.ts` desktop test asserts `aside.side` is right of `.hero-area` at 1280 and stacks
   below it at 1000 (just under the 1024 breakpoint); phone test asserts `expectNoHorizontalScroll` and ≥44 px
   touch targets on range pill, card link and suggestion link; manual screenshots at 360 (light/dark/mono) and
   1280 (light) visually confirm the layout and legible contrast in every theme, matching the reference's layout
   intent (two-column: hero/chart/lists left, bar/suggestions/cards right) without reusing its colours, mascot or copy.

## Additional verification

- Cross-space isolation and bound-parameter safety: `kekayaan-page.test.ts` "never reads another space's card;
  101+ ids bind once" — confirms `walletExpenseTotals` uses `json_each` binding (not `inArray`), tested with 121
  ids, and a foreign space's card list never appears.
- Money-sum exactness and single-currency-per-sum: all totals (`allocationOf`, `sectionTotals`, `walletExpenseTotals`)
  use BigInt arithmetic and group by currency; verified in both unit and integration tests.
- WIB month-boundary coverage for the underlying `wibTodayString`/date helpers (23:30 WIB last day of month, etc.)
  is pre-existing and unchanged in `src/lib/shared/dates.test.ts`; `trendRangeStart` (new) is tested separately for
  month-clamping and year-crossing in `wealth.test.ts`.
- Svelte keyed lists: all new `{#each}` blocks key by a stable class/currency/index from a server-fixed-order
  array, never by merchant text or user input (ENGINEERING_CHECKLIST.md).
- `shownBalance`/`walletBalanceMinor` reuse in `summary.ts`'s refactor is behaviour-preserving (the helper already
  existed in `wallets/balance.ts`, unchanged by this diff).
- No new migration, matching the PRD's pass-1 note ("No migration"); `receivable` kind, `statement_day`/`due_day`
  columns are absent from the diff as expected.

## Findings

None. No ENGINEERING_CHECKLIST.md violations found in the diff.
