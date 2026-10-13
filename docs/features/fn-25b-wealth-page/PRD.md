# FN-25b Wealth page parity (`/kekayaan`)

Slug: `fn-25b-wealth-page`. Phase 4 (Wealth), extends FN-25. Owner request 2026-10-11: bring `/kekayaan` up to the
reference app's Wealth page (`.superpowers/ref/wealth-reference-2026-10-11.png`, viewed for behaviour only — no
name, mascot, logo, illustration or copy is reused; CLAUDE.md). Risk tier: **Large** — two migrations that rebuild
existing tables (`wallets`, `net_worth_items`), a new chart, a new allocation widget, new credit-card fields, and a
suggestion UI. See **Suggested split into passes** below; this PRD scopes the whole parity gap, but the engineer
may ship it as FN-25b (chart + bar + groups + eye toggle + credit-card spend) and FN-25c (receivable kind +
statement/due dates + Belum dihitung suggestions) if a single pass is too large for one `/build-feature` cycle.

## Goal

A wealth-tracking user (`docs/PRD.md` § 3) opens `/kekayaan` to see one number and *trust* it — not just today's
figure (FN-25 built that) but whether it is going up, where it sits across cash/investment/crypto/property/debt,
and what is missing from the picture. FN-25 shipped the total, the per-class split and the item list; it is
missing the shape over time (a trend line), a reason to trust an incomplete picture (visible debts, "not counted
yet" classes), and the everyday accounts (wallets, credit cards) the user actually opens this page to check. This
pass closes that gap using only data Montra already stores or can store honestly — no invented figures, no
screenshot-reading AI path (that stays deferred, see Out of scope).

## Scope

### 1. Net-worth trend chart

- **No new table.** `net_worth_snapshots` (`migrations/0014_net_worth.sql:38`) already holds one row per space
  per WIB day, written by the existing hourly cron tick (`workers/jobs/src/net-worth.ts:23`,
  `src/lib/server/net-worth/summary.ts:356` `writeSnapshots`) and never pruned — confirmed no retention sweep
  touches it (`workers/jobs/src/queue.ts`, `index.ts` searched). History accumulates for as long as the space
  exists; it is purged with the space like every `SPACE_SCOPED_TABLES` row.
- New `src/lib/server/net-worth/trend.ts`: `netWorthTrend(db, spaceId, range, now)` reading
  `net_worth_snapshots` between a start date and today (bounded by range; see below), ordered by date, excluding
  rows this space's own tombstone marks deleted. A `partial` snapshot (FN-25's existing flag, set when a price or
  rate was missing that day) is still plotted — the chart shows the real recorded total, not a gap — but the
  point is visually marked (a lighter dot) so "flat" is never confused with "no data that day".
- Ranges: `1M`, `3M`, `1Y`, `All` (reference's four tabs, our own pill control matching the existing segmented
  control pattern already used for Laporan's period picker). `1M`/`3M`/`1Y` compute the start date with
  `addDays`/WIB month arithmetic already in `src/lib/shared/dates.ts`; `All` is the space's oldest snapshot.
- **New user / short history:** fewer than 2 snapshot points cannot draw a line. The chart area shows
  `EmptyState` text ("Grafik tampil setelah beberapa hari pencatatan" / English equivalent) instead of a
  one-point line or an invented flat line before day one. Exactly 2 points draw a two-point line (honest, no
  interpolation beyond the stored days).
- Rendering: a hand-drawn SVG path (CLAUDE.md "simple SVG charts, no chart library"), same approach as FN-35's
  flow diagram (`src/lib/ui/` money-flow component) and Laporan's existing trend/heatmap SVGs — a new
  `src/lib/ui/net-worth/TrendChart.svelte`. Y domain from the plotted range's min/max total (not forced to zero,
  matching how Laporan's cumulative trend already scales); X axis shows the range's first/last date only (reference's
  "12 Sep … 11 Oct"), `formatShortDay`. Up vs down colour follows the same `--money-in`/`--money-up` tokens the
  30-day change pill already uses (`src/lib/ui/net-worth/NetWorthSection.svelte:514-524`).
- The route: `netWorthTrend` is called from `/kekayaan`'s load for the default range (`1M`); switching ranges
  re-fetches via a small `+page.server.ts` endpoint or a `load` dependency (`depends`/`invalidate`) the same way
  Laporan already re-queries on period change — reuse that exact pattern, not a new client-side cache.

### 2. Stacked allocation bar + legend chips

- Replace today's plain `GroupList` "Pembagian" rows (`NetWorthSection.svelte:404-417`) with a horizontal
  stacked bar (one coloured segment per class holding a positive amount: Dompet, Kas, Investasi, Kripto, Emas,
  Properti & aset, and the new Piutang — see item 3) plus legend chips below it, each chip showing the class
  name, its `formatMoney`/`formatMoneyCompact` amount and its percent of the **positive total** (assets only;
  CLAUDE.md "rupiah not percent" governs the headline figures, but a proportion-of-whole percent on a legend chip
  is not a headline figure — same exception Laporan's existing donut/percent chips already use).
- **Debts are never folded into the bar or its percentages.** `summarizeNetWorth` already returns the `debt`
  class as a *negative* minor figure (`src/lib/server/net-worth/summary.ts:91-129`, `isLiabilityKind`). The new
  widget renders debt as a separate red-toned line directly under the bar ("Utang −Rp …"), not as a bar segment
  — so a debt-heavy space can never be visually minimised to a sliver. This is the FN-25b default; see Owner
  decisions.
- `src/lib/shared/net-worth.ts`'s `NET_WORTH_CLASSES`/`CLASS_OF_KIND`/`NET_WORTH_CLASS_LABELS` gain the new
  `receivable` class (item 3). No other class changes.
- New `src/lib/ui/net-worth/AllocationBar.svelte`, pure presentational (array of `{cls, minor, pct}` in, already
  computed server-side so the component never does money arithmetic itself — matching the project rule that
  totals are computed once and reused, `transactions/aggregate.ts` pattern).

### 3. "Piutang" (receivable) and honest debt handling

- Montra does not track receivables today — `NET_WORTH_KINDS` has no asset kind for "money owed to you"
  (`src/lib/shared/net-worth.ts:9-18`), only `debt` as a liability. The reference's "Owed to you" chip is a
  counted asset class, not a "not counted yet" suggestion.
- Add kind `receivable` (manual value only — same treatment as `investment_stock`, no automated price source) to
  `NET_WORTH_KINDS`, `NET_WORTH_KIND_LABELS` (`msg('Piutang')`), `CLASS_OF_KIND` → new class `receivable` →
  `NET_WORTH_CLASS_LABELS` (`msg('Piutang')`). Requires rebuilding `net_worth_items`'s CHECK constraint (same
  technique as migration `0022_balance_adjustment.sql` rebuilding `transactions`, or `0027_ride_food_categories.sql`
  rebuilding `categories`' `tile_key` CHECK) — new migration, see Architecture notes for the number.
- `netWorthValueMinor` (`src/lib/shared/net-worth.ts:158`) and `summarizeNetWorth` need no new branch: a
  manual-only kind already flows through the existing `priceSource === 'manual'` path unchanged.
- Scope note: this is deliberately minimal — no counterparty name/contact field, no due date, no partial
  repayment tracking (CLAUDE.md "Montra does not track loans or lending" governs *the product's own* lending;
  recording that a friend owes the user money is the user's own record, same as a manual debt item already is).

### 4. "Belum dihitung" suggestion cards (Emas, Dana pensiun)

- New `src/lib/ui/net-worth/MissingSuggestions.svelte` on `/kekayaan`, below the allocation bar: one card per
  class the space has zero live items in, from a fixed, owner-approved list of two (reference parity):
  - **Emas** ("By the gram, at the spot price" — our wording, not theirs): shown when no live
    `investment_gold` item exists. Tapping opens the existing add-item sheet
    (`NetWorthSection.svelte`'s `openAdd`) pre-filled with `kind: 'investment_gold'`,
    `priceSource: 'gold_api'` — a small addition to `blank()`'s signature (an optional partial override), no
    server change.
  - **Dana pensiun** ("BPJS JHT, DPLK"): shown when no live item's `name` matches a small fixed keyword list
    (`bpjs`, `jht`, `dplk`, `pensiun`/`pension`) case-insensitively — a presentation heuristic only, never
    stored or matched server-side, so a false negative (user already has one under a different name) just shows
    an extra suggestion card, never hides real data. Tapping opens the add sheet pre-filled with
    `kind: 'other_asset'`, `name: 'Dana pensiun BPJS JHT/DPLK'` (editable) — **no new DB kind** for pension (see
    Owner decisions, this keeps the migration to one new kind, not two).
- Both cards are dismissible for the session only (no "don't show again" flag stored — CLAUDE.md gives no
  precedent for per-suggestion dismissal state here, and persisting it is unnecessary complexity for a two-card
  list); dismissal is local component state, lost on reload by design (safe default, nothing hidden server-side).

### 5. Credit cards section

- One card per live `kartu_kredit` wallet (`WALLET_TYPES` includes it, `src/lib/shared/wallets.ts:4`), each
  showing: the wallet's name/last-four (existing `wallets.last_four`, `schema.ts:383`), "Spent in the last 30
  days" computed the same way FN-05's history already sums a wallet's expense transactions over a window — a new
  bounded query in `src/lib/server/net-worth/credit-cards.ts` reusing the existing transactions table and
  `occurred_on` WIB-date bucketing (CLAUDE.md "month and day buckets use `occurred_on`, never the UTC date"), and
  a "Tambah tanggal" prompt when the wallet has no stored statement/due day.
- **New wallet columns** (migration, see Architecture notes): `statement_day` and `due_day`, nullable
  `INTEGER CHECK (... between 1 and 31)`, meaningful only for `kartu_kredit` wallets (CHECK: non-`kartu_kredit`
  wallets must keep both null, matching the existing `wallets_last_four_check` / `wallets_type_check` style at
  `schema.ts:391-398`). A day-of-month only (no month/year) — the reference's "Tiap tanggal 12" pattern Langganan
  (FN-26) already uses for billing days (`src/lib/shared/subscriptions.ts`), reused here rather than inventing a
  second date convention.
- `src/routes/(app)/dompet/+page.svelte`'s wallet edit sheet (`WalletForm.svelte`'s sibling pattern, already read)
  gains two optional number fields, shown only when `type === 'kartu_kredit'`; `/kekayaan`'s "Tambah tanggal" link
  opens that same sheet via `/dompet?ubah=<id>` (existing query-param convention, `dompet/+page.svelte:347`) —
  no second place to edit a wallet.
- No due-date reminder, no statement-balance tracking, no minimum-payment math — a flat two-day-of-month field
  and the already-computed 30-day spend figure. Debt owed on the card (if the user also records it as a manual
  `debt` net-worth item) is unrelated data, not auto-derived from the wallet balance (CLAUDE.md "money never
  invented" — a card wallet's balance in FN-04 is the *spending ledger*, not a stated payable; conflating them
  would be a guess).

### 6. Grouped sections: Dompet, Investasi, Kripto

- Below the credit-card cards, three new grouped lists mirroring the reference's per-class rows:
  - **Dompet**: every live wallet (not just `kartu_kredit`) with its name, type label and
    `walletBalanceMinor` (`src/lib/server/wallets/balance.ts`, already computed for FN-04), a section total, each
    row linking to `/dompet?ubah=<id>` (existing pattern). This duplicates `/dompet`'s own list by design — the
    reference shows wallets directly on Wealth, and `/dompet` stays the place to add/archive/favourite them; this
    page's rows are read-mostly (edit opens the same sheet, nothing new to maintain).
  - **Investasi**: live `investment_stock` + `investment_gold` items (today's "Aset dan utang" grouping already
    does kind-by-kind sections; this renames/re-groups two of those kind headings under one "Investasi" umbrella
    with its own subtotal, matching the reference). Each row unchanged from today's item row.
  - **Kripto**: live `investment_crypto` items, same treatment, its own subtotal.
  - `property`, `vehicle`, `debt`, `other_asset`, `receivable` items keep today's per-kind grouping under "Aset
    dan utang" (unchanged) — only the two priced classes (gold/crypto, already visually distinct in the reference)
    and stocks move into named sections; this avoids inventing section names for every kind.
  - Barang (FN-27) and Koleksi (FN-28) links stay exactly as built (`+page.svelte:35-93`), unchanged, placed
    after the new sections as today.

### 7. Eye toggle (hide amounts)

- **Mostly already built.** `src/lib/ui/kit/amounts.svelte.ts`'s `amounts` state + `shown()` helper and
  `HeroAmount`'s eye button (`HeroAmount.svelte:79-89`, already wired on `/kekayaan`'s total,
  `NetWorthSection.svelte:365-370`) already hide the hero figure and persist the choice via
  `localStorage` (`amount-visibility.ts`) for the page it is mounted on, resetting on navigation away — a safe,
  per-device, no-account-data default.
- This pass extends `shown()`/`amounts.hidden` to every other money figure the new and existing sections print on
  `/kekayaan`: the allocation bar's segments and legend chips, the trend chart's Y-axis labels and hover figure,
  credit-card "spent" figures, and the new Dompet/Investasi/Kripto row amounts (today's item-list amounts already
  render through plain `formatMoney`, not `shown()` — they get the same treatment for consistency). No new
  storage key; same `amounts.hidden` module state the hero already drives.

### 8. Header actions

- **Tambah** (in scope): a header button opening the existing add-item sheet (`openAdd()`,
  `NetWorthSection.svelte:133`) — purely a second entry point to code that already exists, no server change.
- **"Impor tangkapan layar" (portfolio screenshot import):** **proposed deferred**, not built this pass — see
  Owner decisions and Out of scope. It is a new AI/OCR read path (parsing a brokerage/crypto-wallet app
  screenshot into asset rows), structurally like FN-16g's on-device OCR screenshot parsers
  (`src/lib/server/ocr/`, `docs/features/fn-16g-ocr/PRD.md`) but for a *different* document family with no
  layout fixtures or redacted samples yet, and FN-25's own PRD already deferred this exact feature
  (`docs/features/fn-25-net-worth/PRD.md:100-103`) pending the on-hold Anthropic key / OCR calibration. Building
  it now would require new fixtures, a new parser family and real-sample calibration — out of proportion to this
  layout-parity pass.

### Desktop layout, themes, i18n

- Desktop: a two-column layout reusing Laporan's existing `grid-template-columns: minmax(0, 37fr) minmax(300px,
  21fr)` breakpoint (`src/routes/(app)/laporan/+page.svelte:442`, `min-width: 1024px`) — hero + trend chart +
  grouped sections in the wide column, allocation bar + missing-suggestions + credit cards in the narrow column
  (matching the reference's layout intent, not its pixels). Phone first down to 360 px: every new component
  stacks to one column, 44 px touch targets, no horizontal scroll (`docs/ENGINEERING_CHECKLIST.md` "360 px").
- All four themes (light, dark, Hitam-putih mono, the two Pro themes FN-46 added) apply via existing design
  tokens only — the trend chart's stroke/fill and the allocation bar's segment colours come from the existing
  `--money-in`/`--money-up`/category-free semantic tokens plus a small new fixed palette of up to 7 class
  colours added to `tokens.css`, each AA-contrast-checked against `--panel` in every theme
  (`test/contrast.test.ts`, extended with the new tokens) — never a brand-matched hue copied from the reference.
- Every new Indonesian string gets an `i18n-en.ts` entry (`tr()`/`trf()`), including the two suggestion cards'
  copy, the credit-card prompt, the range-picker labels and the receivable/kind labels.
- `Data demo` rows stay excluded from the chart, the bar and every new total exactly as FN-25 already excludes
  them from the grand total (`summary.ts:123-124`) — a demo item never moves the bar or the trend line.
- Every new or touched load/action keeps going through `requireSpaceAccess`/`pageScope`
  (`src/routes/(app)/kekayaan/+page.server.ts:34-41`) — no new route bypasses it.

## Out of scope

- Portfolio screenshot import (header action 7) — proposed deferred to its own future PRD (FN-25c or later),
  needs redacted sample screenshots and a new parser family; already deferred once in FN-25's own PRD.
- Any per-wallet detail route (`/dompet/[id]`) — none exists today; new Dompet rows on this page link to the
  existing `/dompet?ubah=<id>` edit sheet, not a new page.
- Receivable counterparty tracking (who owes it, contact, due date, partial repayment) — a flat manual value
  only, same as every other manual kind.
- Credit-card due-date reminders, minimum-payment math, statement-balance import — only the two day-of-month
  fields and the existing 30-day spend figure.
- Automated pension-value pricing (BPJS JHT/DPLK) — no public API exists; it is a manual `other_asset` item like
  every unlisted asset today.
- Any investment, trading or "should I buy/sell" guidance — unchanged CLAUDE.md boundary.
- Changing FN-25's existing price sources, snapshot cadence or item cap — unchanged this pass.

## Acceptance criteria

1. Given a space with at least 2 `net_worth_snapshots` rows, when `/kekayaan` loads, then the trend chart plots
   every snapshot in the selected range (default `1M`) in date order, using the stored `total_minor` values
   exactly (no interpolation, no invented points), and a `partial` day's point is visually distinguished from a
   complete day's point.
2. Given a space with fewer than 2 snapshot rows, when `/kekayaan` loads, then the chart area shows explanatory
   empty-state text instead of a flat or single-point line, in both languages.
3. Given the user switches between `1M`/`3M`/`1Y`/`All`, then each range's start date is computed from the
   current WIB date (`addDays`/WIB month arithmetic, not a client-side guess) and the chart re-renders with that
   range's snapshots only, read via a server reload (no client-cached stale range).
4. Given a space the user is not a live member of, the trend endpoint/action answers exactly as
   `requireSpaceAccess` does elsewhere for unknown or foreign ids — no existence oracle, same status/body/timing.
5. Given the account-deletion or space-purge path runs, every `net_worth_snapshots` row of a space the user was
   the last live member of is purged via `SPACE_SCOPED_TABLES` (unchanged FN-25 behaviour, reconfirmed by a test
   once this pass adds a new reader of the table).
6. Given a space with wallets, cash, investment, crypto, gold, property and a receivable item, when `/kekayaan`
   loads, then the allocation bar's segments and legend-chip percentages sum to the positive-asset total exactly
   (BigInt-exact, matching `summarizeNetWorth`'s existing convention), and every segment's percent is computed
   from assets only (debts never included in the denominator).
7. Given a space with one or more live `debt` items, then the debt amount is shown as a separate negative line
   below the allocation bar, in no case rendered as a bar segment or folded into any class's percentage.
8. Given a `receivable` item is created, edited or archived, then it goes through the same
   `requireSpaceAccess`/guarded-insert/`writable`-vs-`stale` path as every other net-worth item kind
   (`src/lib/server/net-worth/repo.ts`'s existing pattern), survives a reload, counts in the grand total as a
   positive asset, and appears under its own "Piutang" class in the allocation bar and item groups.
9. Given a space with zero live `investment_gold` items, when `/kekayaan` loads, then the "Emas" suggestion card
   is shown; given the user adds a live gold item, then on the next load the card is gone. The same for the
   pension-keyword heuristic and its card.
10. Given the user taps a suggestion card, then the add-item sheet opens pre-filled with that suggestion's kind
    (and price source where applicable), editable before saving — never auto-saved.
11. Given a live `kartu_kredit` wallet with transactions in the last 30 WIB days, when `/kekayaan` loads, then its
    card shows the exact sum of that wallet's expense transactions in that window (same WIB-bucketing convention
    as Beranda/Riwayat), reconciling with what `/riwayat` filtered to that wallet and period would show.
12. Given a `kartu_kredit` wallet with no `statement_day`/`due_day` set, then its card shows "Tambah tanggal"
    linking to the wallet's edit sheet; given both are set, then the card shows them instead, with no invented
    next-due date computed from them (a day-of-month is shown as stored, never projected into a calendar date).
13. Given a `statement_day`/`due_day` value outside 1–31, or either set on a non-`kartu_kredit` wallet, then the
    write is refused server-side (CHECK constraint plus the form's own validation), matching the project's
    "never trust the client" rule.
14. Given the Dompet/Investasi/Kripto grouped sections, each section's subtotal equals the exact sum of its own
    listed rows (BigInt-exact per currency, converted only where FN-25's existing conversion already applies),
    and each row's figure matches what `/dompet` or the existing item list already shows for that same
    wallet/item.
15. Given the eye toggle is switched on, then every money figure newly in scope (allocation bar, legend chips,
    trend chart labels, credit-card spend, grouped-section rows and subtotals) is masked identically to how the
    hero figure already masks, and switching it off restores every one of them; the choice is a device-local
    default (no account field, no sync), consistent with FN-25's existing `HeroAmount` behaviour.
16. Given the "Tambah" header action, tapping it opens the same add-item sheet `?aset=baru` already opens, with
    identical validation, loading, error and success states as the existing sheet (`NetWorthSection.svelte`'s
    `track()` pattern) — no duplicate implementation.
17. Given JavaScript is disabled, every new write (credit-card dates, receivable item create/edit) still works
    through a plain form POST and shows its refusal or success without JavaScript (CLAUDE.md "no-JS forms"
    checklist item).
18. Given `Data demo` rows exist in a space, then none of them move the trend chart's plotted totals (those come
    from `net_worth_snapshots`, which FN-25 already computes excluding demo items — reconfirmed by a test), the
    allocation bar, the grouped-section subtotals or the credit-card figures (demo transactions, if any exist for
    a demo wallet, are excluded the same way FN-05 already excludes them from real totals).
19. Given 20 concurrent `receivable`-item creates in one space at `MAX_ITEMS_PER_SPACE` (200, unchanged), then
    exactly the room available succeeds and the rest are refused with the existing limit message — no over-by-one
    (same concurrency probe style as FN-25's AC 10).
20. Given every new Indonesian string on this page (chart range labels, suggestion cards, credit-card prompt,
    Piutang labels, section headings), each has an English entry; every money figure uses
    `formatMoney`/`formatMoneyCompact`; the new class-colour tokens pass `test/contrast.test.ts` in light, dark
    and Hitam-putih.
21. Given the 360 px and 1024 px+ breakpoints, the page shows one column below 1024 px and the described
    two-column layout at and above it, with no horizontal scroll and 44 px touch targets throughout
    (`e2e/shell.spec.ts`/`e2e/kit.spec.ts` pattern, extended to this page).

## Architecture notes

- **Migrations.** This worktree and `main` both end at `migrations/0036_agent_runs.sql`; `docs/TASKS.md` records
  that `feat/fn-48-import-categories` is expected to take **0037** and `fn-34b` may take **0038** on branches not
  yet in this tree. This PRD's migration(s) must therefore be numbered **0039 at the earliest candidate**, and
  the engineer re-numbers at merge time to whatever is the next free contiguous number once those branches land
  first — the same renumber-at-merge note FN-24/FN-25's own PRDs already carry. Two rebuilds are needed (can be
  one migration file or two):
  - `net_worth_items`: rebuild to add `'receivable'` to the `kind` CHECK list (`migrations/0014_net_worth.sql:19`)
    and to `net_worth_items_content_check`'s per-kind clauses (receivable behaves exactly like
    `investment_stock` — manual-only, no symbol/quantity) — same table-rebuild technique as
    `migrations/0022_balance_adjustment.sql` (transactions) or `migrations/0027_ride_food_categories.sql`
    (categories' `tile_key`).
  - `wallets`: add nullable `statement_day INTEGER`, `due_day INTEGER`, with a CHECK that both are null unless
    `type = 'kartu_kredit'`, and when set are `between 1 and 31` — rebuild following
    `migrations/0003_wallets.sql`'s existing CHECK style (`schema.ts:391-398`).
  - No migration needed for the trend chart (reads existing `net_worth_snapshots`) or for the Dompet/credit-card
    sections' balances/spend (reads existing `wallets`/`transactions`).
- **New modules:** `src/lib/server/net-worth/trend.ts` (snapshot range query), `src/lib/server/net-worth/
  credit-cards.ts` (30-day spend per `kartu_kredit` wallet); `src/lib/ui/net-worth/{TrendChart,AllocationBar,
  MissingSuggestions,CreditCardCard}.svelte`; extends `src/lib/shared/net-worth.ts` (new kind/class) and
  `src/lib/shared/wallets.ts`/`src/lib/server/wallets/validation.ts` (new optional fields' parsing, same
  discipline as the existing `last_four` field).
- **Touched:** `src/routes/(app)/kekayaan/+page.server.ts` (load gains trend + credit-card data, actions gain
  the wallet-date update reusing FN-04's existing wallet-update action rather than inventing a new one — confirm
  with `src/routes/(app)/dompet/+page.server.ts`'s existing `updateWallet` action and extend its parsed fields);
  `src/lib/ui/net-worth/NetWorthSection.svelte` (re-grouping, suggestion slot, `shown()` wiring);
  `src/lib/server/db/schema.ts` (both rebuilt tables); `src/lib/shared/i18n.ts` + `i18n-en.ts`;
  `docs/design/tokens.css` (class-colour tokens) + `test/contrast.test.ts`.
- **Reused, unchanged:** `net_worth_snapshots` writer (`workers/jobs/src/net-worth.ts`, FN-25's cron tick — no
  schedule or cadence change), `requireSpaceAccess`/`pageScope`, `summarizeNetWorth`'s exact-BigInt convention,
  `walletBalanceMinor` (FN-04), `amounts`/`shown()` (kit), the `/dompet?ubah=<id>` wallet-edit convention, the
  Laporan desktop two-column breakpoint.
- **No new Worker, no new cron, no AI.** Everything in scope runs in the app Worker's existing request path on
  data already in D1; the deferred screenshot-import item (if ever built) would be the one part needing the jobs
  Worker/AI Gateway path FN-25 already fenced off.

## Prerequisites

- **No new credential.** Every data source here is D1 already in the schema, or (for the trend chart) a table
  the existing hourly cron already fills with FN-25's existing keyless price sources. No `.dev.vars.example`
  entry changes.
- If the deferred screenshot-import item is ever picked up, it would need the same on-hold Anthropic key /
  AI Gateway ids FN-15/16/17/19/20/22/23 already wait on (`docs/TASKS.md`), plus redacted sample screenshots —
  neither is a prerequisite for this pass.

## Owner decisions

1. **Debts never appear as a bar segment or percentage; shown as a separate negative line under the bar.**
   Proposed default. Trade-off: a debt-heavy space's bar looks "fuller" than its true net position would suggest
   unless the user reads the line beneath it; the alternative (a bar that can go negative / show a red
   deficit segment) is visually busier and has no precedent elsewhere in the design system. Default: **as
   described above**.
2. **"Piutang" becomes a new tracked asset kind (`receivable`), not a "not counted yet" suggestion.** Proposed
   default, matching the reference showing it as a counted class. Trade-off: one more table-rebuild migration and
   one more kind to maintain forever; the cheaper alternative is folding "money owed to you" into the existing
   `other_asset` kind with no dedicated class/colour (saves the migration, loses the honest separate line the
   reference shows). Default: **add the kind** (as scoped).
3. **Pension (BPJS JHT/DPLK) stays a plain `other_asset` manual item, suggested by a client-side name-keyword
   heuristic only — no new `pension` kind.** Proposed default to avoid a second kind/migration for a feature that
   is, functionally, identical to any other manual asset. Trade-off: it will not get its own allocation-bar
   colour or class subtotal, only a suggestion card. Default: **as described**.
4. **Credit-card statement/due dates are a bare day-of-month (1–31) pair on the wallet row, no reminder, no
   projected next date.** Proposed default, matching Langganan's existing billing-day convention. Trade-off: the
   user sees "tanggal 12" but not "next due 12 Nov" — computing that would require assuming a timezone-correct
   month-rollover rule this PRD has not scoped testing for. Default: **bare day-of-month only**.
5. **Portfolio screenshot import ("Impor tangkapan layar") is deferred, not built this pass.** Proposed default —
   it is a new AI/OCR parser family with no fixtures yet, already deferred once in FN-25's own PRD. Trade-off:
   the header action from the reference is incomplete without it; the "Tambah" action ships alone this pass.
   Default: **defer to a future FN-25c (or later) PRD**.
6. **Eye toggle stays device-local (`localStorage`), not an account setting.** Unchanged from FN-25's existing
   `HeroAmount` behaviour — no new decision needed, flagged here only because the owner's request named it
   explicitly. Default: **keep as built**.
7. **New allocation-bar class colours are a small fixed palette added to `tokens.css`, not reused
   category/brand colours.** Proposed default to keep CLAUDE.md's "no copying the reference product's... colour
   scheme" boundary unambiguous — the palette must read as Montra's own, not a close match to the reference's
   blue/purple/orange bar. Default: **new tokens, AA-checked, visually distinct from the reference's hues**.

## Suggested split into passes

If the full scope above does not fit one `/build-feature` risk-tier-Large cycle:

- **Pass 1 (FN-25b):** trend chart (item 1), allocation bar + legend without the receivable kind (item 2 using
  only existing classes), eye-toggle extension (item 7), Tambah header action (item 8's in-scope half), desktop
  two-column layout, i18n/theme work. No migration.
- **Pass 2 (FN-25c):** receivable kind + migration (item 3), credit-card dates + migration + credit-card section
  (item 5), Belum dihitung suggestions (item 4), Dompet/Investasi/Kripto grouped sections (item 6, depends on
  pass 1's layout). Two migrations.
- **Deferred (future PRD):** portfolio screenshot import.

## Tracker impact

- `docs/TASKS.md` gains a Phase 4 line under the existing FN-25 entries: "FN-25b Wealth page parity: trend chart
  (reuses FN-25's snapshots, no migration), allocation bar, receivable kind + credit-card dates (migration
  0039+, renumber at merge), Belum dihitung suggestions, Dompet/Investasi/Kripto grouping, eye-toggle extension.
  Screenshot import proposed deferred (owner decision needed if the owner wants it picked up)."
- `docs/ACCEPTANCE.md` gains a "Money and dates" row once built: "Net-worth trend chart plots only stored daily
  snapshots, no interpolation; allocation bar/legend percentages sum exactly from assets only, debts excluded" —
  and a "Required journey" row is not needed (FN-25's existing row already covers the money accuracy baseline this
  pass extends, not replaces).
- Closes the reopened half of FN-25's own "Out of scope" line on screenshot import only if the owner later
  approves Pass 2.5/FN-25c picking it up — otherwise it stays explicitly deferred here, not silently dropped.

## Owner decisions — answered 2026-10-11

Debts appear as a separate minus line under the bar, never a bar segment (1); "Piutang" is its own asset kind (2,
migration in pass 2); portfolio screenshot import is deferred (5); two passes — pass 1 without migration (chart,
allocation bar and chips, Belum dihitung suggestions, grouped sections, credit-card 30-day spend cards without dates,
eye toggle, desktop layout), pass 2 (FN-25c) with the Piutang kind and credit-card statement/due days. Decisions 3, 4,
6 and 7 take the proposed defaults.
