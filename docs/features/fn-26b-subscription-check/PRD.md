# FN-26b Subscription check

Slug: `fn-26b-subscription-check`. Phase 4 (Wealth), extends FN-26. Risk tier: **Medium** (one small new table,
a bounded read-only detection query over existing data, new UI states on an existing route; no AI, no Queues,
no new Worker, no money invented — every figure a candidate shows is copied from a stored transaction row).

## Goal

A subscription list the user has to type every entry into by hand is only as complete as their memory; the
easiest way to miss a recurring bill is to never think to add it. FN-26b closes that gap the way the user's own
history already can: it looks at the expenses already captured (manual, Gmail, receipt, statement — any
source) for merchants or amounts that repeat like a bill, and offers to add them, with the same Rp/date/cadence
shown nowhere else inventing a number. It turns Langganan from "a list you remember to keep" into "a list that
checks itself against what you already recorded," without ever auto-adding anything or reading a bank PIN,
password or new data source.

## Scope

- **Owner request source:** 2026-10-11, "add subs tracker", with a screenshot of the reference app's
  Subscriptions page. Mirror the *behaviour* only (CLAUDE.md, `docs/FEATURES.md` header): an empty state, a
  "run a check" card that counts likely subscriptions not yet in the list with brand badges, and an
  "Add subscription" header action plus a full-width button — never the reference's name, mascot, copy or
  product names.
- **Detection is deterministic only, from stored transactions, in this pass** — no Gmail re-read, no new
  capture source, no AI call. Two ways a transaction group becomes a candidate (the user's own words: "known
  service names" and "recurring amount+merchant patterns"):
  1. **Known-name match:** the group's cleaned merchant key matches an FN-26 catalogue entry
     (`src/lib/shared/subscriptions-catalogue.ts:38`, `catalogueEntry`/id lookup) whose category is one of the
     subscription-shaped ones (`streaming`, `musik`, `game`, `telko`, `cloud`, `software`, `belajar` — not
     `lainnya`), or an FN-43 brand (`src/lib/shared/brands.ts:28`, `matchBrand`) in the same shape, inside the
     window — **one occurrence is enough** (a single Netflix charge is still obviously a subscription).
  2. **Recurring pattern match:** the group's cleaned merchant key (same key FN-20 already groups by,
     `cleanDescriptor` from `src/lib/shared/merchants/clean.ts`, used in
     `src/lib/server/merchants/resolve.ts:1,99-104`) has **at least two** expense rows in the window with the
     *same* `amount_minor` + `currency` and gaps between consecutive dates that fit one cadence within
     tolerance: weekly (6–8 days), monthly (27–32 days, so a 28/29/30/31-day month still matches), or yearly
     (358–372 days). The closest-fitting cadence of the group's gaps is the guess; a group whose gaps fit none
     of them is not a candidate.
  - **AI is explicitly out for this pass** (owner decision 1 below): FN-41's per-user BYOK key could later help
    label an ambiguous group, but nothing here calls Claude, matching the "off by default" instruction by not
    building the path at all yet rather than shipping a default-off toggle nobody can turn on usefully without
    a follow-up PRD scoping what the model is asked and what it may change (never a merchant or amount it
    invents).
  - **Window: 90 days**, not the reference's 30 — 30 days cannot contain two occurrences of a monthly cadence,
    so a 30-day window would only ever find known-name matches and never prove a pattern; 90 days holds three
    monthly cycles. The card's copy therefore never claims a day count ("dari riwayat transaksi", not "30
    hari terakhir") so it stays true if the window changes later. See Owner decisions #2.
  - Excludes `is_demo` transactions, `transfer`-type rows, and any row whose merchant key matches (a) a live
    subscription already in this space (by its own name's cleaned key, or by a shared `catalogueId`/brand id)
    or (b) a dismissed match key (below) — a dismissed or already-added service never reappears.
  - **Bounded:** reads at most the space's 300 most recent live expense rows with `occurred_on` in the window
    (`order by occurred_on desc limit 300`, same shape as `listPayableExpenses`,
    `src/lib/server/subscriptions/repo.ts:510-535`); groups and the cadence check run in memory on that bounded
    set; returns at most 20 candidates, each carrying at most 6 of its most recent source rows.
- **New shared pure module** `src/lib/shared/subscriptions-detect.ts`: `type ExpenseRow = { id, title,
  amountMinor, currency, occurredOn }`; `groupByMerchantKey`, `guessCadence(datesSorted): BillingCycle | null`
  (the tolerance windows above), `buildCandidates(rows, { catalogueMatch, brandMatch, excludeKeys })` — fully
  unit-testable without D1, reused by the server repo so the cadence math has one implementation.
- **New server module** `src/lib/server/subscriptions/detect.ts`: `findCandidates(db, spaceId, today)` — the
  bounded query plus the exclusion set (live subscriptions' keys, dismissed keys), returning:
  ```
  interface SubscriptionCandidate {
    matchKey: string;           // stable id for add/dismiss
    name: string;                // best display name: the catalogue/brand name, else the cleanest source title
    catalogueId: string | null;
    category: SubscriptionCategory | null; // from the catalogue/brand match; null for a pattern-only match
    amountMinor: number; currency: string; // the most recent matching row's own amount — never averaged or invented
    cadence: BillingCycle | null;          // null only cannot happen for a kept candidate (both paths set one;
                                            // a known-name single-occurrence match defaults the display cadence
                                            // to 'monthly' as a guess, clearly editable in the add form)
    lastOccurredOn: string;                // WIB date
    sourceRows: { id: string; occurredOn: string; amountMinor: number; title: string | null }[]; // ≤ 6, newest first
  }
  ```
- **Migration — new table `subscription_dismissals`** (number below): `id`, `space_id`, `match_key` (the same
  key the candidate carries — kept on the tombstone too, like `merchant_rules.match_key`
  (`src/lib/server/db/schema.ts:2145-2176`), since it is an index key, not personal content), `created_by`
  (nullable `users.id`, `on delete set null`), `created_at`, `updated_at`, `deleted_at`, `seq`. Unique index on
  `(space_id, match_key)` where `deleted_at is null` (one live dismissal per key, concurrency-safe
  insert-if-absent, per the engineering checklist's "Concurrent writes" item). Added to `SPACE_SCOPED_TABLES`
  (purged with the space and with the account, same as `merchant_rules`).
- **`/langganan` route changes** (`src/routes/(app)/langganan/+page.server.ts`,
  `src/routes/(app)/langganan/+page.svelte`):
  - `load` additionally calls `findCandidates` (bounded, same `Promise.all` the other reads already use,
    `+page.server.ts:67-72`) and returns `candidates: SubscriptionCandidate[]`.
  - **Subscription check card**, shown above the list in both the empty and non-empty states: an icon, a label
    ("Pemeriksaan langganan"), and either "Belum ditemukan langganan baru" (no candidates) or
    `trf('Ditemukan {n} kemungkinan langganan yang belum ada di daftar', { n })` with up to 4 of the
    candidates' `BrandBadge`/`InitialsTile` icons (reusing the existing component,
    `src/lib/ui/kit/BrandBadge.svelte` as already used at `+page.svelte:375`) plus a "+N" overflow chip, and a
    primary button "Jalankan pemeriksaan" that opens a new sheet state listing the candidates (data already
    loaded — see Architecture notes on why this needs no extra round trip) with an "Tambah" and a "Bukan
    langganan" action per row, each showing name, amount, cadence guess, last date, and an expandable "N
    transaksi terkait" revealing the (≤ 6) source rows read-only.
  - **"Tambah" on a candidate** opens the existing add sheet (`SheetState.add`) pre-filled via a new
    `fromCandidate(candidate)` values-builder beside the existing `blank()`/`valuesOf()`
    (`+page.svelte:42-67`): `name`, `category` (candidate's category or `'lainnya'`), `amount` (from
    `amountMinor`/`currency`), `cycle` (`cadence`), `day`/`weekday`/`month` derived from `lastOccurredOn` the
    same way `blank()` derives them from `data.today`, `catalogueId` when matched. The form posts through the
    **existing, unchanged** `createSubscription` action — no new write path, no auto-save; the user sees and
    can edit every field before saving, same as adding from the catalogue.
  - **New action `dismissCandidate`**: form field `matchKey` (capped like every other id field,
    `idField`/`ID_MAX_LENGTH` pattern, `src/lib/server/subscriptions/validation.ts:184-188`), scoped through
    the same `scopeOf`/`requireSpaceAccess` every other action here uses
    (`+page.server.ts:43-49,109-113`); inserts the dismissal (insert-if-absent, idempotent — dismissing twice
    is not an error); the candidate is removed from the sheet's list client-side on success and never
    reappears on reload or a later check (matched by `matchKey` in the exclusion set).
  - **Empty state copy change** (currently "Belum ada langganan. Catat tagihan rutin supaya tidak kelewatan.",
    `+page.svelte:342`): add a line naming examples the way the reference does, in our own words — streaming,
    musik, paket data, internet, and listrik — e.g. "Streaming, musik, paket data, internet, listrik — catat
    berapa yang keluar tiap bulan." Icon and title stay (`illustration="calendar"`); the check card renders
    below the empty-state block in this state too, so a user with zero subscriptions but matching history
    still sees it.
  - **Full-width "Tambah langganan" button directly under the check card**, in addition to the existing header
    `PageAction` (`+page.svelte:248-254`) and the existing bottom `PageAction` below the list
    (`+page.svelte:412-417`) — the reference shows both a header action and a full-width button; the existing
    bottom button already covers the non-empty-list case, so this adds the one placement that was missing
    (right under the card, visible even before any subscription exists).
- **Small, honest catalogue/category addition** so the empty-state suggestion naming "listrik" has something
  real behind it beyond "Lainnya" (which already covers it today, but a named entry matches intent): a new
  `utilitas` subscription category (`label: 'Utilitas'`, `tileKey: 'tagihan'`) in
  `src/lib/shared/subscriptions.ts`'s category map, and two catalogue entries (`pln`, `pdam`) in
  `subscriptions-catalogue.ts`, names only, no logos — same convention as every other entry.
- **Real gaps found comparing today's `/langganan` against the reference** (everything else the reference
  shows — monthly total, a chronological upcoming-bills list, add/edit/mark-paid — FN-26 already built; see
  `docs/features/fn-26-subscriptions/PRD.md` and the hero/list markup at `+page.svelte:348-411`):
  1. This feature itself — the check card and detection (the only functional gap).
  2. The empty-state suggestion line (cosmetic, included above).
  3. A visual "calendar of all billing dates" — FN-26 deliberately deferred this (its own Owner decision 4);
     **not reopened here**, stays out of scope.
- **i18n**: every new string (card label/counts, button labels, candidate row fields, dismiss confirmation,
  new catalogue category label) through `tr()`/`trf()` with an English entry in `i18n-en.ts`; catalogue/brand
  proper nouns stay untranslated as today.

## Out of scope

- Any AI-assisted detection or cadence labelling (owner decision 1) — purely deterministic this pass.
- Reading Gmail, receipts or any new capture source for this feature — detection reads only transactions
  already in the space (any source), never reaches outside it.
- Auto-adding a subscription without the user confirming the add form — never built, never will be by this
  PRD's own rule (CLAUDE.md: money/figures only from stored rows, user checks before saving).
- Un-dismissing a candidate from a settings page (a `/pengaturan/langganan-diabaikan` list) — the table is
  built so this is a later, additive PRD; v1 has no UI to see or undo a dismissal once made.
- A visual calendar grid of billing dates (FN-26's own deferred item, not reopened).
- Changing `MAX_SUBSCRIPTIONS_PER_SPACE`, the mark-paid flow, or any FN-24 reminder behaviour — untouched.
- Detecting subscriptions from income rows, transfers, or archived/demo transactions.
- Any change to FN-20 merchant resolution, FN-39 categories, or FN-43 brand matching logic itself (used
  read-only, as-is).

## Acceptance criteria

1. Given a space with zero subscriptions and zero matching transactions, when `/langganan` loads, then the
   empty state shows an icon, a title, and a suggestion line naming streaming, music, a data/phone plan,
   internet and electricity as examples of what to track — in Indonesian with an English entry — and the check
   card shows "Belum ditemukan langganan baru" with no badges.
2. Given a space with an expense transaction titled a known catalogue/brand subscription name (e.g. "Netflix")
   dated within the last 90 WIB days, and no live subscription or dismissal matching it, when `/langganan`
   loads, then the check card's count includes it and shows its brand/initials badge, even though it occurred
   only once.
3. Given a space with two or more expense transactions of the identical `amount_minor` and `currency` at an
   unrecognised merchant, dated 27–32 days apart inside the 90-day window, then that merchant becomes a
   candidate with cadence "monthly"; given the same setup but the gaps are, say, 10 and 40 days apart (fitting
   no cadence tolerance), then it does not become a candidate.
4. Given a candidate, when its "N transaksi terkait" is expanded, then every row shown is one of its own real
   source transactions (id, WIB date, exact stored amount) — never an average, a rounded figure or an invented
   row — capped at 6, newest first.
5. Given the primary "Jalankan pemeriksaan" button is pressed, then the full candidate list (name, amount,
   cadence guess, last date) opens without a fresh server round trip failing silently — if the load itself
   failed, the existing `ErrorState`/retry path is shown instead and the card is not rendered as if candidates
   were checked.
6. Given a user taps "Tambah" on a candidate, then the add sheet opens pre-filled with that candidate's name,
   guessed category, amount, currency and cadence (day/weekday/month derived from its last occurrence), all
   editable, and saving goes through the existing `createSubscription` action with its existing validation,
   limit and wallet checks — no new transaction, no new write path, and the subscription is not created until
   the user submits.
7. Given a user taps "Bukan langganan" on a candidate, then a dismissal row is created for that match key; on
   the next load (and after any later check), that candidate never reappears for this space, even though its
   source transactions are unchanged; dismissing the same key twice (e.g. a retried request) never errors or
   creates a second live row.
8. Given a subscription is later added (via the catalogue, a custom name, or a candidate) whose cleaned name
   matches a candidate's match key, then that candidate stops appearing on the next load — a service already
   in the list is never also offered as "not yet in the list."
9. Given a space the user is not a live member of, every route and the new `dismissCandidate` action answer
   exactly as `requireSpaceAccess` does elsewhere (404 for unknown/foreign ids, no existence oracle,
   timing-identical) — same guard as every existing `/langganan` action.
10. Given `Data demo` transactions exist in a space, then they are never read into detection and never produce
    a candidate; given a transaction is a `transfer`, it is excluded the same way.
11. Given the detection query runs, then it reads at most 300 of the space's most recent live expense rows
    within the 90-day window (one bounded, indexed query — no unbounded scan), returns at most 20 candidates,
    and the whole load still answers inside the page's normal loading budget (no spinner specific to the
    check beyond the page's existing `Skeleton`/loading state).
12. Given the account-deletion path runs, every `subscription_dismissals` row of a space the user was the last
    live member of is purged via `SPACE_SCOPED_TABLES`; a shared space's dismissals survive for the other
    members, consistent with every other FN-26 table.
13. Given the `dismissCandidate` action is called concurrently twice for the same match key (two tabs, a
    retried submit), then exactly one live dismissal row exists afterward (insert-if-absent, not a race).
14. Every new Indonesian string has an English entry; every money figure uses `formatMoney`/
    `formatMoneyCompact`; every date shown or used in cadence math is the WIB calendar date (`occurred_on`),
    never a UTC date; no candidate, badge or catalogue entry bundles or links a third-party logo image.
15. Given the `langganan` module is hidden via FN-12, then the check card and candidates still compute and
    render under the same hidden-module notice `/langganan` already shows (`+page.svelte:258-263`) — unchanged
    convention, not reopened.
16. Loading, empty (no candidates vs. no subscriptions), error (load failure reuses the existing
    `ErrorState`/retry), saving (add/dismiss buttons disable and show progress using the existing `busy`/
    `track()` pattern, `+page.svelte:83-154`) and success states (dismiss and add both show only after the
    server confirms) are all present for the new UI exactly as the rest of `/langganan` already does.

## Architecture notes

- **New migration** — this worktree's `migrations/` currently ends at `0036_agent_runs.sql`. Per the owner's
  numbering note: `0037` is reserved for FN-48 (in progress, `docs/TASKS.md` "FN-48 categories for imported
  rows"), and `0038`/`0039` may be taken by FN-34b/FN-25b if either lands first. **This PRD proposes
  `migrations/0040_subscription_dismissals.sql`**, to be renumbered at merge like every other concurrent
  migration in this window (the same "renumber at merge" note FN-26's own PRD carries,
  `docs/features/fn-26-subscriptions/PRD.md:128`) — coordinate the actual number with whichever of FN-48/
  FN-34b/FN-25b has merged by the time this lands.
- **New Drizzle table** `subscriptionDismissals` in `src/lib/server/db/schema.ts`, modelled directly on
  `merchantRules` (`schema.ts:2145-2176`): same `space_id` FK, same `(space_id, match_key)` partial unique
  index, same "key survives the tombstone" convention. Added to `SPACE_SCOPED_TABLES`.
- **New shared module** `src/lib/shared/subscriptions-detect.ts` (pure, unit-tested): grouping and cadence
  math only — no DB, no fetch — imported by both the server repo and its own Vitest file.
- **New server module** `src/lib/server/subscriptions/detect.ts`: the bounded query (reusing the `Db` type and
  the same space-scoped `select`-style pattern as `src/lib/server/subscriptions/repo.ts:120-135`), the
  exclusion-set lookups (live subscriptions' names + `subscription_dismissals`), and the catalogue/brand match
  calls (`catalogueEntry`/`matchBrand`, both already pure functions, no new dependency).
- **Reused as-is, read-only:** `cleanDescriptor` (`src/lib/shared/merchants/clean.ts`) for the merchant key —
  the exact function FN-20 already groups transaction descriptors by, so a candidate's key is the same key a
  merchant rule or history entry would use, keeping "already in the list" matching consistent; `matchBrand`
  (`src/lib/shared/brands.ts:171`) and `catalogueEntry` (`subscriptions-catalogue.ts:85`); `BrandBadge`
  (`src/lib/ui/kit/BrandBadge.svelte`, already imported at `+page.svelte:25`); `wibDateParts`/`daysBetween`
  (`src/lib/shared/dates.ts`) for the cadence tolerance windows; `requireSpaceAccess`/`isLiveMember`
  (`src/lib/server/spaces/access.ts`); the existing `createSubscription` action and `SubscriptionForm.svelte`
  for the add flow (zero changes to either); the existing `track()`/`busy`/`Skeleton`/`ErrorState`/`EmptyState`
  UI-state plumbing in `+page.svelte`.
- **Why the "run the check" button needs no new server round trip:** detection is cheap and bounded (one
  indexed query over ≤ 300 rows), so it runs inside the page's normal `load` every time, like the monthly
  total already does (`monthlyTotals`, `+page.server.ts:77-85`). The button only reveals, client-side, the
  candidates already on `data.candidates` in a new sheet state — consistent with how the existing "Pilih
  layanan" catalogue sheet already opens from already-loaded data (`+page.svelte:266-269`). If a fresher
  check is wanted after adding a transaction elsewhere, the existing pull-to-refresh `retry()`/`invalidateAll`
  path (`+page.svelte:156-163`) re-runs it, same as every other figure on this page.
- **No AI, no R2, no Queues, no new Worker** in this feature — one bounded D1 query, pure date/string math, and
  the existing form actions.

## Prerequisites

- No new credential or provider account.
- Depends on FN-26 (merged/landed), FN-20 (`cleanDescriptor`), and FN-43 (`matchBrand`) already being in the
  codebase as read — all three are already present on `main` at the commit this worktree branched from
  (`81d7d5a`), so no sequencing blocker.
- Migration number depends on which of FN-48/FN-34b/FN-25b have merged first (see Architecture notes) — flag
  at `/ship` time, not a build blocker.

## Owner decisions

1. **AI-assisted detection: not built this pass, default off/deferred.** The request says "AI optional only
   with the user's own key, off by default" — rather than ship a toggle that calls nothing useful, this PRD
   builds the deterministic path only and defers an AI-assisted follow-up (e.g. labelling an ambiguous
   group's cadence, or suggesting a cleaner name) to its own later PRD once there is a concrete AI task to
   scope and gate behind FN-41's BYOK key. Trade-off: fewer candidates found than an AI-reading approach would
   surface (e.g. a one-off oddly-worded merchant with a real recurring pattern AI might name better), offset
   by zero AI cost, zero new privacy surface, and nothing invented.
2. **Detection window: 90 days, not the reference's 30.** Needed so a monthly cadence (two charges ~30 days
   apart) can ever be proven; 30 days structurally cannot contain two monthly occurrences. Trade-off: a
   service the user started paying 31–90 days ago and has only paid once shows only if it is a known
   catalogue/brand name (path 1); an unknown-merchant pattern genuinely needs the second occurrence regardless
   of window size. Default: 90 days, revisit only if real usage shows it is too slow to surface known names
   (it already is not, since known names need just one occurrence).
3. **Cadence tolerance: 6–8 days (weekly), 27–32 days (monthly), 358–372 days (yearly).** Wide enough to
   survive weekend/holiday payment-date drift without matching unrelated purchases. Default as stated; no
   configuration surface.
4. **No un-dismiss UI in v1.** A wrong "Bukan langganan" tap is permanent until a later settings page is
   built (table is ready for it). Trade-off: a rare mis-tap requires re-adding the subscription manually from
   the catalogue/custom-name path, which still works today; offset by keeping this PRD's scope to detection +
   dismiss, not a second settings page.
5. **New `utilitas` category + 2 catalogue entries (PLN, PDAM), names only.** Cheap, consistent with every
   existing catalogue entry's no-logo rule, and makes the empty-state's "listrik" example honest without
   relying solely on "Lainnya". Default: include; if the owner would rather keep the catalogue exactly as FN-26
   left it, this is the one line item to cut (everything else in this PRD works unchanged without it, since
   "Lainnya" with a typed name already covers electricity and water today).
6. **Candidate and source-row caps: 20 candidates, 6 source rows each, 300 scanned transactions.** Generous
   for a personal/household bill list (matches FN-26's own 100-subscription cap reasoning) while keeping the
   query bounded per the engineering checklist. Default as stated.

## Tracker impact

- Adds to `docs/TASKS.md` under "Phases 3 – 5 and later", alongside the existing FN-26 line: "FN-26b
  Subscription check: deterministic detection from stored transactions (known-name + recurring-pattern
  matches), dismiss list, add-flow prefill into the existing form. Depends on FN-26/FN-20/FN-43 (all landed).
  Migration proposed as 0040 (coordinate with FN-48/FN-34b/FN-25b at merge)."
- `docs/ACCEPTANCE.md` gains a new row once checked, under the same area FN-26's row lives in: "Subscription
  check finds known-service and recurring-amount candidates from stored transactions only, never invents a
  figure, and a dismissed or already-added service never reappears."

## Owner decisions — 2026-10-11

Proposed defaults taken by the orchestrator (no owner-visible trade-off beyond the PRD's own wording): deterministic
detection only, AI deferred; 90-day window; cadence tolerances as proposed; no un-dismiss UI in v1; `utilitas`
category with PLN/PDAM entries; caps 20/6/300. Migration number assigned at merge (next free after 0037).
