# FN-34 Daily streak and "Tutup hari" — PRD

Catalog entry: `docs/FEATURES.md` › FN-34 (Phase 1b, owner request 2026-10-08, `docs/design/APP_PARITY.md` § 1
"Mobile" and § 4). Tracker: `docs/TASKS.md` › App layout parity › "New features seen in the reference app (PRDs
first): FN-34 streak / close the day, FN-35 money-flow chart, recurring transactions, balance adjustment type."
This PRD closes the FN-34 slice of that line. Risk tier: **Small** (one new table, no change to any existing
money total, additive UI on two screens).

Owner decisions already fixed (do not re-litigate): server-first in D1, signed-in only
(`CLAUDE.md` › Locked architecture). This PRD fixes its own open decisions under **Owner decisions** below with
a proposed default; the owner auto-accepts defaults unless told otherwise.

## Goal

The main journey ends at Beranda, and Beranda should reward the habit of checking in, not just the habit of
spending. A "close the day" action turns "did I log everything today?" into one explicit, dated action — even a
day with nothing to log still counts, so a quiet day never breaks the streak the way a forgotten receipt would.
A visible streak on the mobile top bar gives the same daily pull as the reference app, without copying its coin
mechanic: ours is a plain count, nothing that could be read as money, a loyalty currency or a reward the user
could mistake for value.

## Scope

- **Migration (next unused number; `migrations/0019_privacy.sql` is the last applied — assign **`0020`**, renumber
  at merge if another feature's migration lands first, per `CLAUDE.md` › Data access › "Migrations"):
  `day_closures` table: `id`, `user_id` (FK `users`, cascade delete — a closure is a personal record, not
  space data, see Owner decision A), `closed_on` (WIB date string), `created_at`, `updated_at`. Unique index on
  `(user_id, closed_on)` so a second close of the same day is a no-op, not a duplicate row. No `deleted_at`/`seq`:
  closures are never edited or deleted, and they carry no money, so they are not sync-scoped per `CLAUDE.md`'s
  "every user-data table has `space_id`, `updated_at`, `deleted_at` and a sync sequence" (that rule is for
  financial rows scoped to a space; a closure is account-scoped and has no `space_id` — see Owner decision A).
- **`src/lib/server/streak/`** (new): `repo.ts` — `closeDay(db, userId, closedOn, now)` (guarded insert,
  `INSERT … SELECT … WHERE NOT EXISTS`, idempotent and safe under a concurrent double-tap);
  `streakSummary(db, userId, today)` → `{ current: number, closedToday: boolean }`, reading at most
  `STREAK_LOOKBACK_DAYS` (bounded, e.g. 400) of the user's most recent `closed_on` rows ordered descending and
  walking back from `today` or `yesterday` while each date is exactly one WIB day before the last, per
  `CLAUDE.md`'s "Bounded work: every scan has a row cap and a period."
- **`src/lib/server/budgets/summary.ts`** (`berandaSummary`, `src/lib/server/budgets/summary.ts:37-59` today)
  extended to also return `streak: { current, closedToday }` so the Beranda load stays the one call Beranda needs.
- **Beranda (`src/routes/(app)/+page.svelte`, "Hari ini" card at line 297 today)**: while `!closedToday`, the
  card's existing full-width button becomes "Tutup hari ini" (closes with zero or more of today's entries already
  shown above it); a new form action `close-day` on `src/routes/(app)/+page.server.ts` calls `closeDay` and
  re-renders the card as closed ("Hari ini ditutup · {n} hari berturut-turut"), loading/saving/success states per
  `CLAUDE.md`. No "re-open" action this pass (Out of scope).
- **Mobile top bar streak chip**: the shell's top bar (`docs/design/APP_PARITY.md` § 1 "Mobile", not yet built as
  of this PRD — tracked separately as parity wave A) shows a small grey chip under the date line. This feature
  supplies the chip's content once the streak exists: `"{n} hari berturut-turut"` singular-safe at `n = 0`
  ("Belum ada hari berturut-turut" or similar, through `tr()`/`trf()`). **Dependency:** if parity wave A ships
  first with the placeholder "Hari ke-N" chip, this feature's implementer edits that same shell component to
  switch it to the streak chip; if this feature ships first, it adds the chip itself. Either way only one chip
  shows at a time — never both.
- **i18n:** every new Indonesian phrase ("Tutup hari ini", "Hari ini ditutup", the streak chip template, the
  zero-streak phrasing) gets an English entry in `src/lib/shared/i18n-en.ts`.

## Out of scope

- Any coin, point, badge image or monetary-looking reward — explicitly forbidden by the owner's brief.
- Re-opening or un-closing a day once closed.
- Streak freezes, streak insurance, or any paid mechanic tied to the streak (no plan gating this pass).
- A streak leaderboard or comparison across space members — a closure is personal to the account, not shared.
- Backdating a close for a day that already ended (no "close yesterday" catch-up action).
- A Fitur toggle entry for streak (Owner decision C: default is always-on, not hideable).
- Push notifications or reminders nudging the user to close the day (that is FN-24's territory, not built here).

## Acceptance criteria

1. Given a signed-in user on Beranda on a WIB date they have not yet closed, when the page loads, then the
   "Hari ini" card shows today's entries (or the existing empty prompt) and a full-width button reading
   "Tutup hari ini".
2. Given that same state, when the user submits the close action, then a `day_closures` row is written for
   `(userId, today's WIB date)`, the card re-renders without a page reload showing "Hari ini ditutup" and the
   current streak count, and the button is gone (no further close is offered for that day).
3. Given a WIB date already closed by this user, when the Beranda load runs again (reload, second device, new
   tab), then the card still shows the closed state and the same streak count — closing is idempotent and
   persists across reload.
4. Given a user closed yesterday and today, when `streakSummary` runs, then `current` is at least 2 and increases
   by exactly 1 for each additional unbroken consecutive WIB day closed.
5. Given a user closed three days ago but not yesterday or today, when `streakSummary` runs, then `current` is 0
   (a gap resets the count; the gap day itself is never retroactively closed).
6. Given the WIB boundary around midnight, when a close is submitted at 23:58 WIB and another at 00:05 WIB the
   next calendar day, then they are recorded as two different `closed_on` dates (the WIB date, never the UTC
   date) — tested at 23:30 WIB on the last day of a month and 00:30 WIB on the first, per
   `docs/ENGINEERING_CHECKLIST.md` › "WIB dates."
7. Given a double submit of the close action (two tabs, a slow network retry), when both requests reach the
   server, then exactly one `day_closures` row exists for that `(userId, date)` — concurrency-safe, no duplicate
   or 500 (`docs/ENGINEERING_CHECKLIST.md` › "Concurrent writes").
8. Given a user who is a member of a shared space and of their own personal space, when they close the day from
   either space's Beranda, then exactly one account-wide streak is affected (Owner decision A) — closing from one
   space's Beranda also shows the correct chip on the other space's Beranda the same WIB day.
9. Given any request to `close-day` or to read the streak summary, when the request is handled, then it is scoped
   to `event.locals.user.id` only — there is no id in the form or URL a caller could substitute for another
   account's streak (no existence oracle; `docs/ENGINEERING_CHECKLIST.md` › "One access rule").
10. Given the Beranda load fails (D1 error), when the page renders, then the "Hari ini" card shows its existing
    error state (not a crash) and the rest of Beranda still renders with whatever did load.
11. Given the UI language is English, when the streak chip, the close button or the closed-state text render,
    then every phrase has an English string (`docs/ENGINEERING_CHECKLIST.md` › "i18n").
12. Given 360 px width, when the "Tutup hari ini" button and the mobile top bar chip render, then the button is a
    full-width tap target ≥ 44 px tall and the chip's text does not cause horizontal scroll.
13. Given a user with zero closures ever, when `streakSummary` runs, then it returns `current: 0` without error
    (first-ever load, no row to find).

## Architecture notes

- Touches: `migrations/0020_streak.sql` (new, number confirmed at merge); `src/lib/server/db/schema.ts` (add
  `dayClosures` table); `src/lib/server/streak/repo.ts` (new); `src/lib/server/budgets/summary.ts`
  (`berandaSummary` — extend the return shape only, do not change its existing fields or call signature);
  `src/routes/(app)/+page.server.ts` and `+page.svelte` (the "Hari ini" card, line 297 today, and a new
  `close-day` action); the mobile shell top bar component from parity wave A (name not yet fixed; coordinate with
  whichever PRD/implementation lands it); `src/lib/shared/i18n.ts` + `i18n-en.ts`.
- Reuses: `wibTodayString()`/WIB date helpers in `src/lib/shared/dates.ts` (used throughout FN-05/08); the
  `currentSpaceScope`/session pattern only for the Beranda load's existing space check — the streak itself reads
  `locals.user.id` directly, not a space id (Owner decision A), so it needs no `requireSpaceAccess` call of its
  own, but the Beranda route it renders inside still goes through the existing space gate.
- No change to `transactions`, `wallets`, or any FN-05 aggregate: this feature adds a new, independent table and
  never touches a money total.

## Prerequisites

None. No new secret, provider or credential. Uses the existing D1 binding only.

## Owner decisions

- **A — Scope of a closure: per account or per space?** Default: **per account** (one streak across every space
  the user belongs to; `day_closures.user_id`, no `space_id`). Trade-off: a user who manages two unrelated spaces
  (e.g. personal + a shared household space) gets one shared streak, not two independent ones; closing from
  either Beranda extends the same count. Alternative (per space) would mean a user with several spaces juggles
  several streak numbers, which reads as more confusing than rewarding.
- **B — What "closing the day" actually requires.** Default: **nothing** — the button is always available once
  the WIB date has started, whether today has zero or many transactions (mirrors the brief: "closing the day with
  zero or more entries extends the streak"). Trade-off: this makes the streak a pure engagement nudge, not a
  data-completeness signal (a user could close every day without ever logging anything and still keep a streak).
  Alternative (require at least a glance at today's list, enforced by requiring the card to have been opened) adds
  friction without adding any verifiable guarantee, since the system cannot prove the user actually read the list.
- **C — A Fitur toggle for streak?** Default: **no toggle this pass** — always on for every account, like the
  existing Beranda chart picker. Trade-off: a user who dislikes the chip cannot hide it yet. Alternative (add
  `streak` to `src/lib/shared/feature-flags.ts` `MODULES` and the `feature_flags.module` CHECK constraint,
  `migrations/0007_feature_flags.sql:9`) is a small follow-up if requested, not built here to keep this PRD's risk
  tier Small.
- **D — Reward wording.** Default: a plain count with no icon implying currency ("12 hari berturut-turut"), no
  flame/fire emoji by default (common in streak UIs but close to gamified-currency framing); the exact icon is a
  design-system call, not fixed here. Trade-off: a plainer chip is less visually exciting than a flame icon, which
  is deliberate — the brief asks for "non-monetary and ours," and a flame is at least visually associated with
  "streaks-as-currency" patterns elsewhere.

## Tracker impact

Closes the FN-34 slice of `docs/TASKS.md` › App layout parity › "New features seen in the reference app (PRDs
first): FN-34 streak / close the day, FN-35 money-flow chart, recurring transactions, balance adjustment type."
No existing `docs/ACCEPTANCE.md` row names this feature; on completion add a new "Money and dates" row
("Streak closures bucket by the WIB date (23:30/00:30 WIB test)") and the existing "Space isolation on every
load, action and sync push/pull" row's check list gains this feature's routes once red-teamed (Owner decision A
means the correct claim for FN-34 is "account isolation," which the red team should treat as the same class of
check).
