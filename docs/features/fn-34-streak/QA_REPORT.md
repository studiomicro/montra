# FN-34 Daily streak and "Tutup hari" — QA report (cycle 1)

Branch `fn-34-streak` (worktree `.claude/worktrees/fn-34-streak`), head `051d8fe`, based on main `253a939`.

## Verdict: FAIL

One finding (visual defect, Finding 1) blocks a clean PASS; everything else checked out, including the one item
the engineer explicitly left untested (closing with JavaScript disabled, now verified).

## Commands run

- `flock ... npm run check` → `1463 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0, real toolchain (svelte-check/tsc).
- `flock ... npm run lint` → Prettier clean, ESLint clean, exit 0, real toolchain.
- `flock ... npx vitest run --maxWorkers=2` → `Test Files 157 passed (157)`, `Tests 2259 passed (2259)`, exit 0, local D1 (`openLocalD1`), mocked AI/providers per project convention, no real provider.
- `flock ... npm run build` → `✔ done`, exit 0, real Vite/Wrangler build.
- `FIN_PERSIST_TO=<scratchpad> flock ... npm run db:migrate:local` → fresh persist dir, `0000_init.sql` … `0019_privacy.sql`, `0021_streak.sql` all ✅, exit 0, real local D1 (wrangler --local).
- `LD_LIBRARY_PATH=... E2E_PORT=8845 CI=1 flock ... npx playwright test e2e/beranda.spec.ts --workers=1` → `16 passed, 1 skipped`, exit 0, real local dev server (3-Worker `wrangler dev`), not mocked.
- `LD_LIBRARY_PATH=... E2E_PORT=8846 CI=1 flock ... npx playwright test e2e/tmp-fn34-qa.spec.ts --workers=1` (QA-written, no-JS close + 4 screenshots) → `5 passed`, exit 0, real local dev server.
- `LD_LIBRARY_PATH=... E2E_PORT=8847 CI=1 flock ... npx playwright test e2e/tmp-fn34-qa.spec.ts --workers=1` (QA-written, chip close-up screenshot) → `3 passed`, exit 0, real local dev server.
- `LD_LIBRARY_PATH=... E2E_PORT=8848 CI=1 flock ... npx playwright test e2e/tmp-fn34-qa.spec.ts --workers=1` (QA-written, chip `scrollHeight`/`clientHeight` overflow probe) → `3 passed` (test itself passes; the measured metrics are Finding 1's evidence), exit 0, real local dev server.
- `npm run gates` and `npm test` were never run (RAM rule); each gate step above was run separately under the heavy lock instead.
- Temporary QA spec `e2e/tmp-fn34-qa.spec.ts` was deleted after use; not committed, not part of the permanent suite.

## Checked criteria

1. Open day shows today's card + full-width "Tutup hari ini" — PASS. `e2e/beranda.spec.ts` FN-34 test; code review of `+page.svelte:437-446`.
2. Submit writes one row, re-renders in place, button gone — PASS. `test/integration/streak.test.ts` "criteria 1–3"; e2e click + assertion; `role="status"` text matches.
3. Idempotent across reload/second device/new tab — PASS. Integration test (two `streakOf` reads after close) + e2e `page.reload()`; cross-device proven by `closeDay` called twice with different `now` in `repo.ts` tests.
4. Unbroken consecutive days: `current` grows by exactly 1 — PASS. `count.test.ts` unit vectors + integration "grows by exactly one per unbroken WIB day closed".
5. Gap resets to 0, gap day never back-filled — PASS. `count.test.ts` + integration "a gap resets the streak to 0".
6. WIB boundary, 23:30/00:30 around a month end — PASS. Integration test uses `Date.UTC(2026,9,31,16,30)`/`(...,17,30)` (same UTC date, different WIB date) → `2026-10-31`/`2026-11-01`, streak 2. `count.test.ts` also covers a leap-year month boundary (2028-02-29→03-01) and a year boundary.
7. Double submit → exactly one row, no 500 — PASS. 20 concurrent actions + 20 concurrent repo calls in integration test; guarded `INSERT…SELECT…WHERE NOT EXISTS…ON CONFLICT DO NOTHING` in `repo.ts:33-50`.
8. One account-wide streak across spaces — PASS. Integration "closing from the shared space's Beranda shows on the personal one, and not for the other member"; `closeDay`/`streakSummary` take `userId` only, never `spaceId` (`repo.ts`).
9. Scoped to `locals.user.id`, no id/date from the request — PASS. Integration "no id or date in the form can reach another account"; signed-out → 303 `/masuk`; removed member resolved to personal space by `currentSpaceScope`; `+page.server.ts:83-89` reads `scope.userId` and `wibDateString(Date.now())` only, ignores form fields.
10. Beranda load failure shows existing error state, rest still renders — PASS. Integration test renames `day_closures`, confirms `streak: null`, `summary` and `lists` still populate, `loadError: null`; template shows "Tutup hari belum bisa dimuat." (`+page.svelte:447-455`). The whole-page `ErrorState` still covers a `summary` failure as before (unchanged code path), verified by reading `+page.svelte:265-267`.
11. English entries for every new phrase — PASS. All 7 new/changed i18n keys have English entries in `i18n-en.ts` (diff reviewed); full vitest run includes `test/i18n-coverage.test.ts`, which passed.
12. 360 px: button ≥44 px tall, full width, chip doesn't cause horizontal scroll — PASS on the literal wording (e2e asserts height ≥44, width within card padding, `expectNoHorizontalScroll` before/after close), but see **Finding 1**: the zero-streak chip text visually overflows its pill at 360 px.
13. Zero closures → `{current: 0, closedToday: false}` — PASS. `count.test.ts` "is 0 with no closures at all"; integration "a user who never closed a day has a streak of 0".
14. (QA-added) Closing with JavaScript disabled — PASS. New Playwright test: signed-up user, new browser context with `javaScriptEnabled: false`, clicks the plain `<form action="?/closeDay">` submit button, full-page round trip renders the closed card and chip from fresh SSR data; reload confirms persistence. This was the one item the engineer flagged as "NOT RUN."
15. Migration 0021 applies on a fresh local DB — PASS. `npm run db:migrate:local` against an empty persist dir applied `0000`–`0019` and `0021_streak.sql` cleanly (0020 does not exist on this branch yet, as the engineer's report notes — it belongs to a parallel wave and will be renumbered at merge).
16. `day_closures` covered by account export and deletion — PASS. `src/lib/server/export/tables.ts` adds `dayClosures` to `ACCOUNT_TABLES`/`ACCOUNT_TABLE_DECISIONS` (json); `delete-account.ts` deletes it explicitly (plus FK cascade as a backstop); integration test "closures go with the account" confirms 0 rows after `deleteAccount`. Covered by the full vitest run (`src/lib/server/export/tables.test.ts`).
17. No reward currency or reference product names — PASS. Grepped the diff and the new strings: no coin/flame/badge wording tied to the streak, no other-product brand terms. Plain count only, per Owner decision D.
18. Success shown only after the server confirms — PASS. `use:enhance` default behaviour (no optimistic UI override in the diff); closed-state text only renders from `data.streak`/the action's return after the server round trip; e2e test observes the button disappear and the status text appear only after `closeButton.click()` resolves.

## Findings

**Finding 1 (visual bug, blocks PASS).** The zero-streak chip text overflows its 24 px pill at 360 px width — the
default state shown to every account that has never closed a day (i.e. every brand-new sign-up) on the primary
target viewport named by `CLAUDE.md` ("Phone first (360 px up)") and by AC12.

- Scenario: sign up a new user (streak `current: 0`), open Beranda at 360×780.
- Expected: the chip ("Belum ada hari berturut-turut") renders as a single-line pill like the rest of the chip
  states ("1 hari berturut-turut", "{n} hari berturut-turut"), matching the design system's pill pattern and the
  previous "Hari ke-N" chip it replaced.
- Actual: the 30-character string wraps to two lines inside `.day-chip`, which is fixed at `height: 24px` with no
  `white-space: nowrap`/`overflow` handling (`src/routes/(app)/+page.svelte:554-564`). Measured in-browser:
  `scrollHeight: 30` vs. `clientHeight: 24` (container `clientWidth` 164–172 px at 360 px viewport), while the
  post-close chip ("1 hari berturut-turut") measures `scrollHeight === clientHeight === 24` — it fits on one line.
  The second line spills outside the pill's rounded background, so the chip looks visually broken (text without
  its background) rather than scrolling horizontally — AC12's literal "no horizontal scroll" wording is technically
  met, but the chip itself is broken for the one state every new account sees first.
- Screenshots: `docs/features/fn-34-streak/shots/phone-light.png` and `phone-dark.png` show the wrapped chip at the
  top of Beranda; `chip-closeup.png` is a cropped close-up of just the header row showing the second line without
  pill styling behind it. `desktop-light.png`/`desktop-dark.png` show the same chip rendering correctly at 1280 px
  (more horizontal room), confirming the defect is 360 px-specific.
- Suggested fix (not applied — QA does not edit source): either shorten the zero-state copy to fit one line
  (e.g. drop to something closer in length to the counted states), let `.day-chip` grow in height when wrapped
  (remove the fixed `height: 24px`, use `min-height` + vertical padding instead), or keep it to one line with
  `white-space: nowrap` plus a smaller font/`text-overflow: ellipsis` as a last resort. Any of these needs a
  360 px screenshot re-check, not just the existing `expectNoHorizontalScroll` assertion (which does not catch
  vertical wrap/overflow).

No other findings. The gates, the migration, the account-isolation tests, the WIB boundary tests, the concurrency
tests, the i18n coverage and the export/deletion coverage are all clean. `docs/ENGINEERING_CHECKLIST.md` items
relevant to this feature (concurrent writes, bounded work, migrations, one access rule, i18n, currency display N/A
here, touch targets, truthful state) are all satisfied except the one 360 px chip-rendering issue above.

## Files touched by QA

- `docs/features/fn-34-streak/shots/desktop-light.png`, `desktop-dark.png`, `phone-light.png`, `phone-dark.png`,
  `chip-closeup.png` — new, for this report.
- No source, migration or test file under `src/`, `workers/` or `migrations/` was modified. A temporary Playwright
  spec (`e2e/tmp-fn34-qa.spec.ts`) was written, run and deleted; it is not part of the diff.
