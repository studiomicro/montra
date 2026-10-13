# FN-26 Subscriptions (Langganan)

Slug: `fn-26-subscriptions`. Phase 4 (Wealth). Risk tier: **Medium** (new table + static catalogue data file,
depends on FN-24's notification plumbing landing first or alongside).

## Goal

Recurring bills are the easiest money leak to miss: a Netflix or data-plan charge that nobody looks at twice a
month. FN-26 gives the user one list of what they pay for, when it next charges (in WIB), a monthly total, and
a reminder before it happens — closing the loop a large service catalogue opens, without us ever
pretending to detect the charge automatically (that is Gmail capture's job, FN-19, separately gated).

## Scope

- **`src/lib/shared/subscriptions-catalogue.ts`**: our own static data file of common Indonesian-market
  services — streaming (own names only, e.g. "Netflix", "Spotify", "Disney+ Hotstar", "YouTube Premium"),
  telco/data plans, cloud storage, software — as plain `{ id, name, category }` entries. **Names only, no
  logos, no brand marks**: every catalogue tile is rendered as a generated two-letter initials tile (a new
  `InitialsTile.svelte` component, deterministic colour from the name's hash, same 44 px-safe sizing as the
  category tiles) — matching CLAUDE.md "no copying of the reference product's brand or copy" and the explicit
  instruction to avoid third-party logos without a licence. Start with a modest curated list (tens, not 200 —
  see Owner decisions); "Lainnya" / custom name is always available, so the catalogue is a convenience, never a
  limit.
- **Migration `0013_subscriptions.sql`** (renumber at merge): `subscriptions` table, space-scoped: `id`,
  `space_id`, `catalogue_id` (nullable — null for a custom name), `name` (the shown name; copied from the
  catalogue at creation or typed), `amount_minor`, `currency`, `billing_cycle` (enum `monthly`, `yearly`,
  `weekly`), `billing_day` (1–31 for monthly, 1–366 ordinal-in-year for yearly, 1–7 for weekly — validated per
  cycle), `wallet_id` (nullable, FN-04 wallet it is paid from, informational), `linked_transaction_id`
  (nullable FK to `transactions`, set when the user marks a charge paid and either picks an existing
  transaction or the action creates one — see below), `next_charge_on` (WIB date, maintained server-side, not
  client-trusted — recomputed on every read/write from `billing_cycle`/`billing_day` and "today"), `reminder_days_before`
  (0–14, default 2 — when FN-24 fires a bill reminder), `created_at`, `updated_at`, `deleted_at`, `seq`.
  Content-free tombstone CHECK matching the project convention. Added to `SPACE_SCOPED_TABLES`.
  - **Why `transactions.recurrence` is not used:** FN-05 shipped without a `recurrence` column (deferred at
    build time, confirmed in `docs/features/fn-05-transactions/SUMMARY.md`). FN-26 does not reopen that
    migration; the "optional link to recurring transactions" from the feature request is implemented as the
    nullable `linked_transaction_id` pointer instead — a subscription optionally points at the transaction row
    that recorded its most recent payment, set by the user's own "Tandai sudah dibayar" action, never inferred.
- **`src/lib/server/subscriptions/{validation,repo}.ts`**: modelled on `goals/repo.ts`'s guarded-insert /
  `writable` / `whyNot` pattern; `MAX_SUBSCRIPTIONS_PER_SPACE` (propose 100); `nextChargeOn(cycle, day, today)`
  pure function in `src/lib/shared/subscriptions.ts` (testable WIB-date arithmetic, reusing
  `addDays`/`monthRange`/`isDateString` from `src/lib/shared/dates.ts`, never a hand-rolled date calc) —
  handles the month-length edge case (billing day 31 in a 30-day month lands on the last day of that month,
  same rule a bank would apply, documented in the function's comment).
- **`markPaid` action**: sets `linked_transaction_id`, advances `next_charge_on` to the following cycle, and
  — if the user chose "catat transaksi baru" rather than linking an existing one — creates a `transactions`
  row through the existing `src/lib/server/transactions/repo.ts` create path (source `manual`, category
  guessed from the catalogue entry's category where one exists, else "Tanpa kategori"), so the subscription
  never writes a transaction row through a side door that skips FN-05's own validation.
- **`/langganan` route** (new top-level route, matching the nav naming of `/kekayaan`, `/kotak-masuk`, etc.):
  list of active subscriptions sorted by `next_charge_on`, a monthly-total header (bills normalised to a
  monthly figure: yearly ÷ 12 floor, weekly × ~4.345 floor — labelled "≈" since it is an estimate, never
  presented as exact), a simple calendar-free "upcoming" list (FEATURES.md's "calendar of all billing dates"
  is satisfied by this chronological list in v1 — see Owner decisions on the calendar widget), add/edit/
  archive sheet reusing the add-from-catalogue vs custom-name choice, and the `markPaid` action per row.
  Loading/empty/error/saving/success states match the existing `/kekayaan` wallet-section pattern exactly
  (`Skeleton`, `ErrorState`, `EmptyState`, `track()` submit function, `invalidateAll` on 404/409).
- **FN-24 integration:** on the subscription create/update/markPaid paths, and on the existing jobs-Worker
  cron tick, enqueue (or directly create via `createIfAbsent`) a `bill_reminder` notification kind
  (`src/lib/shared/notifications.ts`'s `NotificationKind` gains this member) `reminder_days_before` days
  before `next_charge_on`, deduplicated per `(subscription_id, next_charge_on)` so it never re-fires for the
  same cycle. This is additive to FN-24's PRD (which must land first or in the same merge) — FN-26 does not
  duplicate FN-24's push/notification plumbing, it calls it.
- **Nav:** `/langganan` is one of FN-12's existing toggleable modules (`langganan` is already in `MODULES`,
  `src/lib/shared/feature-flags.ts:8`) — the route must honour `data.hiddenModules.includes('langganan')` with
  the same "Tampilkan lagi di menu" notice already built for Kekayaan, and the tab bar/sidebar filtering
  (FN-12, `TabBar`/`Sidebar`) needs the real route wired in (today `langganan` is a flag with no route behind
  it).
- **i18n**: catalogue names are proper nouns (not translated) but every other string (cycle labels, reminder
  copy, empty/error states) goes through `tr()`/`trf()` with an English entry.

## Out of scope

- Any automatic detection of a subscription from Gmail or a transaction pattern — this pass is entirely
  user-entered; FN-19/FN-20 (both on hold) may later suggest one, as a separate PRD.
- A visual month calendar grid of billing dates — v1 ships the chronological upcoming list; a calendar view is
  a presentational enhancement, not a data requirement, and can be added later without a schema change.
- Google Calendar export of billing dates (FN-29, Phase 5).
- Price history or "this subscription got more expensive" tracking — `amount_minor` is the current price only.
- Shared-space-specific subscription ownership/assignment (who in the household pays) — a shared space simply
  sees the same list every member sees, like wallets and goals today.

## Acceptance criteria

1. Given a user adds a subscription from the catalogue, then its name and category are copied from the
   catalogue entry at creation time (editable afterward) and its tile renders as generated initials, never a
   fetched or bundled third-party logo.
2. Given a user types a custom name instead, then `catalogue_id` is null and the tile still renders from
   initials of the typed name.
3. Given a monthly subscription with `billing_day = 31` and the next occurrence falls in a 30-day (or 28/29-day
   February) month, then `next_charge_on` lands on that month's last real day, never on an invalid date like
   `2026-11-31` — proven by a vectors test across every month length and both WIB leap and non-leap Februaries.
4. Given a subscription's `next_charge_on` is today or in the past (the cron has not yet advanced it, or the
   user never marked it paid), when the page loads, then `next_charge_on` is recomputed from scratch from
   `billing_cycle`/`billing_day` and the current WIB date rather than trusted as stored — it is always the
   *next* occurrence, never stale.
5. Given a user marks a subscription paid and chooses "catat transaksi baru", then exactly one new
   `transactions` row is created through FN-05's own create path (same validation, same space scope, same
   `source = 'manual'`), `linked_transaction_id` is set to it, and `next_charge_on` advances to the following
   cycle; given the user instead picks an existing transaction, then no new transaction is created and the
   link is set to the chosen one, which must belong to the same space (cross-space ids are refused with the
   standard 404, no existence oracle).
6. Given `reminder_days_before` days remain before `next_charge_on`, when the jobs-Worker cron tick runs, then
   exactly one `bill_reminder` notification is created for that subscription's cycle, never duplicated by a
   repeated cron tick or a retried queue message, and it is created again for the *following* cycle only after
   `next_charge_on` has advanced.
7. Given the monthly total header, then it equals the sum of every active subscription's `amount_minor`
   normalised to a monthly figure (yearly ÷ 12, weekly × 52 ÷ 12, both floored and grouped per currency like
   Beranda's `otherCurrencies`), shown with an "≈" marker, and is never silently added across different
   currencies.
8. Given the `langganan` module is hidden via FN-12, then `/langganan` still loads and its total still counts
   toward any cross-feature figure that includes it (none in this pass, but the convention is enforced for
   future Beranda/Laporan integration), with the same hidden-module notice pattern as `/kekayaan`.
9. Given a space the user is not a live member of, every subscriptions route and action answers exactly as
   `requireSpaceAccess` does elsewhere (404 for unknown/foreign ids, no existence oracle, timing-identical).
10. Given a create/update/archive action, then it follows the guarded `writable`/stale-vs-missing pattern
    (comparing `updated_at`), survives a reload, and shows saving → success only once the server confirms.
11. Given the account-deletion path runs, every subscription of a space the user was the last live member of
    is purged via `SPACE_SCOPED_TABLES`; a shared space's subscriptions survive for the other members, and a
    subscription's `linked_transaction_id` pointing at a since-deleted (tombstoned) transaction degrades to
    "no linked transaction" display, never a broken reference error.
12. Every new Indonesian string has an English entry; every money figure uses `formatMoney`/
    `formatMoneyCompact`; every date shown is the WIB calendar date; no catalogue entry bundles or links to a
    third-party logo image.

## Architecture notes

- **New migration** `migrations/0013_subscriptions.sql` (renumber at merge — coordinate with FN-24/FN-25/FN-27/
  FN-28, which land in the same window). New Drizzle table `subscriptions` in `src/lib/server/db/schema.ts`,
  added to `SPACE_SCOPED_TABLES` ahead of `transactions`/`wallets` (it references both, so it is a child of
  both in deletion order — list it alongside `drafts` near the top per the existing ordering comment).
- **New static data:** `src/lib/shared/subscriptions-catalogue.ts` — a plain exported array, no build step, no
  external fetch; reviewed for brand-safety at build time (names only, no mascots/logos/copy).
- **New component:** `src/lib/ui/kit/InitialsTile.svelte` (or `src/lib/ui/subscriptions/InitialsTile.svelte`
  if scoped to this feature), deterministic hash → one of the design system's existing token colours, never an
  arbitrary unbounded palette (AA-contrast both themes, per the design system's own rule).
- **Reused:** `requireSpaceAccess`/`isLiveMember`; the goals repo's CRUD pattern as template; `addDays`/
  `monthRange`/`wibTodayString` (`src/lib/shared/dates.ts`) for `nextChargeOn`; FN-05's transaction create path
  (`src/lib/server/transactions/repo.ts`) for the "catat transaksi baru" branch of `markPaid`; FN-24's
  `createIfAbsent`/notification kind plumbing (`src/lib/server/notifications/repo.ts`, once FN-24 lands) for
  bill reminders; FN-12's `MODULES`/`hiddenModules` (`src/lib/shared/feature-flags.ts`) — `langganan` already
  exists as a flag, this PRD is what gives it a real route.
- **Nav wiring:** `TabBar`/`Sidebar` (wherever FN-12 filters modules — grep `hiddenModules` usage) needs
  `/langganan` added as the real destination for the existing `langganan` flag.
- **No AI, no R2** in this feature — purely typed data and one date-math helper.

## Prerequisites

- **FN-24 must land first or in the same change** for the reminder plumbing (`createIfAbsent`, the jobs-Worker
  cron tick, `notification_prefs`). If shipped before FN-24, `markPaid`/create/update still work and the
  monthly total/list still render; only the reminder-creation call is stubbed out (a `// TODO FN-24` with no
  user-visible gap, since no notification kind exists yet to fail loudly about).
- No new credential or provider account.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Catalogue size: a curated few dozen common Indonesian-market services, not a 200+ catalogue** — auto-accepted;
   the catalogue is our own data file maintained by hand (no scraping, no licensing a third-party database),
   and "Lainnya" with a typed name covers every gap from day one. Growing the list later is a content change,
   not a schema change.
2. **No logos, initials tiles only** — auto-accepted per the explicit instruction and CLAUDE.md's brand rule;
   trade-off is a less visually rich list, offset by zero licensing risk.
3. **Link to recurring transactions via a nullable pointer set on "mark paid", not a `transactions.recurrence`
   column** — auto-accepted; avoids reopening FN-05's already-shipped, already-tested schema, and keeps
   subscriptions' own cadence (cycle + day) as the one source of truth for "when does this charge."
4. **No calendar grid widget in v1**, chronological list only — auto-accepted as the data-complete, lower-risk
   choice; FEATURES.md's "calendar of all billing dates" is a presentation detail layered on the same data
   later without a schema change.
5. **Subscription cap: 100 per space** — auto-accepted, generous for a personal/household bill list.
6. **Monthly-total normalisation shown with "≈"** — auto-accepted as the honest way to show one figure across
   mixed billing cycles without claiming false precision.

## Tracker impact

- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-26 Subscriptions: catalogue (names/initials only),
  billing cycle + next charge date (WIB), optional transaction link, FN-24 bill reminders. Depends on FN-24."
- `docs/ACCEPTANCE.md` gains a new row once checked, likely under "Money and dates": "Subscription next-charge
  date is always the next real WIB calendar occurrence (month-length and leap-year vectors)."
