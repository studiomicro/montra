# FN-10 Savings goals (Tabungan) — engineer report (cycle 1)

Branch `fn-10-goals` from `main` at `98df284` (FN-00, FN-01, FN-03, FN-04). Not pushed.

## What works

- `/kekayaan` has a second stacked section, "Tabungan", below "Dompet" (Owner decisions A, D). It lists up to 50
  live goals, oldest first. Each row links to `/kekayaan/tabungan/[id]` and shows the name, `{floor %}%`, a
  `ProgressBar`, and `formatMoneyCompact(saved) / formatMoneyCompact(target)` (e.g. `Rp0 / Rp1,25 jt`). A
  "Tercapai" badge shows at ≥ 100 %. Empty state: "Belum ada target tabungan." with "Tambah target". The add
  form (name and `AmountInput` target) opens in a `Sheet`. Without JS it opens inline through
  `?target=baru`, and a refused submission shows its errors inline. `?arsip=1`, the existing "Lihat yang
  diarsipkan" toggle, also lists archived goals under "Target diarsipkan". The goal section loads and fails
  separately from the wallet section (separate `ErrorState`), so a broken goal list never hides the wallets.
- `/kekayaan/tabungan/[id]` shows the big saved figure (`formatMoney`), the compact `saved / target` line,
  the percent (not capped, e.g. 115 %), the `ProgressBar` (fill capped at 100 %) and the "Tercapai" badge. A
  line says the goal is a record only and moves no money. The page has these actions:
  - "Tambah tabungan" (amount and optional note).
  - "Ubah target" (name and target, guarded on `updated_at`). Its sheet also holds "Arsipkan target".
  - "Riwayat tabungan": newest first, 50 per page through `?sebelum=<created_at>_<id>`. Each entry shows the
    amount, the note, the author (or "Akun yang sudah dihapus") and a WIB timestamp from `formatDateTimeWib`.
    "Hapus" is behind a `<details>` confirm.
  - An archived goal's page is read-only and shows "Pulihkan". Every action works with and without JS
    (`?tambah=1` and `?ubah=1` open the inline forms).
- The UI shows success only after the server confirms the write (no optimistic figures). Each Sheet's title
  id comes from `$props.id()`, and focus goes back to the opener when a Sheet closes.

## Files

- Migration `migrations/0006_goals.sql`, plus `meta/0006_snapshot.json` and a journal entry with tag
  `0006_goals` and idx 6. drizzle-kit generated it as `0004_goals` on this base. I renamed the SQL file, the
  snapshot and the journal tag/idx to 0006 together, because transactions (0004) and budgets (0005) are
  being built in parallel. **The controller renumbers at merge if needed.** The snapshot's `prevId` points
  at 0003's snapshot, so it needs re-chaining after 0004/0005 land.
  - `goals`: CHECK `target_amount_minor > 0`, index `(space_id, deleted_at)`, FK to spaces with ON DELETE
    CASCADE.
  - `goal_contributions`: CHECK `amount_minor > 0`, index `(space_id, goal_id, deleted_at, created_at)`, FK to
    goals with CASCADE, FK to spaces with CASCADE, and `created_by_user_id` nullable with FK to users ON
    DELETE SET NULL.
- New:
  - `src/lib/server/goals/{repo,contributions,progress,validation,messages}.ts`
  - `src/lib/shared/goals.ts`
  - `src/lib/ui/kit/ProgressBar.svelte` (SVG `<rect width>`, class fill `var(--ink)` on `var(--chart-track)`,
    `role="progressbar"`, `aria-valuenow`/`aria-valuetext`, no inline style)
  - `src/lib/ui/goals/{GoalForm,GoalsSection}.svelte`
  - `src/routes/(app)/kekayaan/tabungan/[id]/+page.server.ts` and `+page.svelte`
- Changed:
  - `src/lib/server/db/schema.ts`
  - `src/lib/server/spaces/spaces.ts`: `goalContributions` and `goals` are first in `SPACE_SCOPED_TABLES`.
  - `src/lib/server/forms.ts`: new `wholeAmountMinor`, FN-04's strict whole-unit amount parser moved out of
    `wallets/validation.ts` so goals reuse it instead of copying it.
  - `src/lib/server/wallets/validation.ts`: now calls `wholeAmountMinor`; behaviour unchanged, and all wallet
    tests still pass.
  - `src/routes/(app)/kekayaan/+page.server.ts`: load adds `goals`, `goalsError` and `openGoal`; new
    `createGoal` action. No wallet prop or action changed.
  - `src/routes/(app)/kekayaan/+page.svelte`: renders `<GoalsSection>`.
  - `src/lib/shared/i18n-en.ts`: 41 entries.
  - `test/contrast.test.ts`: non-text 3:1 pairs.
- Tests:
  - `test/integration/goals.test.ts` (21)
  - `test/integration/tabungan-routes.test.ts` (19)
  - `src/lib/server/goals/validation.test.ts` (27 with `it.each`)
  - `src/lib/ui/kit/ProgressBar.test.ts` (4)
  - `src/lib/server/forms.test.ts` (+12)
  - `test/contrast.test.ts` (+4)
  - `e2e/tabungan.spec.ts` (8 journeys × 2 projects)

## Design notes and recorded defaults (auto-accepted per standing instruction)

1. **Saved amount**: computed only by SQL `SUM()` in `goals/progress.ts`, through `goalSavedMinor`,
   `goalsSavedSums` (one grouped query) and `savedSumSql` (the insert guard). No stored "saved" column.
   `goalProgressPercent` uses BigInt floor division, so it stays exact past 2^53, is never capped at 100 and
   refuses a target ≤ 0.
2. **Overflow guard**: an insert that would take a goal's saved total past `Number.MAX_SAFE_INTEGER` is refused
   in the same guarded statement (409 "Jumlah tabungan target ini sudah terlalu besar."). Without it, a few
   13-digit contributions would make `formatMoney` throw (a 500).
3. **`created_by_user_id` is nullable with ON DELETE SET NULL.** The PRD said NOT NULL. Deleting a member's
   account must not fail on the FK or delete a shared space's history, which matches the `audit_events`
   precedent. The UI shows "Akun yang sudah dihapus".
4. **Deleting a contribution clears its note** along with setting `deleted_at`, so the tombstone has no
   free-text content. The amount stays because of the NOT NULL CHECK. No contribution-restore UI exists.
5. **Name and note cleaning**: control and zero-width characters are stripped, as in FN-04's `cleanText`
   precedent, and a name that is empty after stripping is refused. An over-long name or note is **refused,
   never truncated**: lengths are counted in code points, so 60 emoji are accepted and 61 characters are
   refused. PRD criterion 3 reads as "refuse names with control characters", but Scope says
   "control/zero-width stripped", and the codebase rule is strip. I took strip.
6. **50-goal cap**: counts archived goals too (the FN-04 wallets precedent), so the list query stays bounded
   at 50 including archived ones. A space with 50 archived goals cannot add more; that is the same trade-off
   FN-04 made.
7. **Archived goals are read-only.** Adding a contribution answers 409 "Berubah sejak terakhir dimuat…", and
   deleting one answers 404. Archive and restore leave the contribution rows untouched.
8. **Archive stays on the goal's page**, which now shows the archived state with "Pulihkan" (one-click undo),
   instead of redirecting to `/kekayaan`.
9. **Adding a contribution does not touch the goal row's `updated_at`**, so an open edit form is not made stale
   by someone else's contribution.
10. **Out of scope / not built**: per-goal currency (always IDR), links to wallets or transactions, negative
    contributions, reordering, notifications, `/kekayaan` sub-navigation.

## Gates

`npm run gates` exits 0:
- svelte-check: 1029 files, 0 errors, 0 warnings; workers `tsc` clean.
- "All matched files use Prettier code style!"; eslint clean.
- Vitest: 48 files, 478 tests passed.
- Build: "✔ done".

**E2E**: the full Playwright suite (`LD_LIBRARY_PATH=…/syslibs`, port 8787 was free) had 107 passed, 14
skipped (phone-only or desktop-only skips), 0 failed. That includes the unchanged `e2e/kekayaan.spec.ts`.

## Fail-before proof

Each mutation was applied to a copy, the goal tests were run, and the file was restored. Script:
`scratchpad/mutate.mjs`.

| # | Mutation | Tests failed |
|---|---|---|
| M1 | delete not scoped by `goal_id` | 2 |
| M2 | no `updated_at` guard | 2 |
| M3 | no overflow guard | 1 |
| M4 | grouped sums count deleted rows | 1 (after adding the list-after-delete assertion; it survived the first run) |
| M4b | single sum counts deleted rows | 2 |
| M5 | percent `Math.round` on floats | 3 |
| M6 | percent capped at 100 | 2 |
| M7 | no 50 cap | 2 |
| M8 | goal tables missing from `SPACE_SCOPED_TABLES` | 1 (schema coverage) |
| M9 | `getGoal` not scoped by space | 1 |
| M10 | add not scoped by space | 2 |
| M11 | name truncated instead of refused | 3 |
| M12 | zero allowed | 19 |
| M13 | archive tombstones contributions | 6 |
| M14 | ProgressBar fill uncapped | 1 |
| M15 | loose amount regex | 10 |

## Pre-handoff probes

Run against a scratch `wrangler dev` on 127.0.0.1:8802 with `--persist-to .wrangler/probe-fn10`, migrated
locally and deleted afterwards. Requests were plain `fetch`, as both no-JS (`accept: text/html`) and
enhanced (`x-sveltekit-action`).

- **Concurrency**: 20 concurrent `addContribution` → `{"200":20}`, all success. Saved shown is Rp 211.000,
  expected Rp 211.000. History has 21 rows, expected 21.
- **Cap**: 10 concurrent `createGoal` at 47 goals → 3 created, 7 refused with the cap message; 50 listed. The
  51st no-JS create → 409, message shown.
- **Reversal**: delete contribution → 200 "Catatan tabungan dihapus.", saved Rp 210.000 (expected Rp 210.000).
  Deleting again → 404 "Catatan tabungan tidak ditemukan.".
- **Two tabs / stale forms**: same `updatedAt` twice → 200 "Perubahan disimpan.", then 409 "Berubah sejak
  terakhir dimuat. Muat ulang lalu coba lagi."; the first edit stays.
- **Cross-space**, as a non-member and as a removed member, with the `space` cookie still naming the shared
  space:
  - GET goal 404 and GET unknown id 404, with identical bodies after nonce normalisation.
  - `/kekayaan?arsip=1` does not list the goal.
  - All 5 actions: enhanced 404/404 with identical `data`. SvelteKit's response also echoes the requester's
    own URL in `location`; the bodies are identical once that echo is normalised. No-JS also gets 404.
  - The goal and its history were unchanged after both crawls.
  - Timing medians: 38.2 vs 38.5 ms (non-member), 38.2 vs 38.8 ms (removed member), 30 requests each.
- **Body guard**: 20 KB → 400; JSON → 415.
- **No-JS forms**:
  - Refused create → 400 with the error and the typed name echoed.
  - Create → 200 "Target ditambahkan.", row reads `Rp0 / Rp50 jt`.
  - Contribution → 200 "Tabungan dicatat.".
  - Negative amount → 400 with the error.
  - Also covered in Playwright on phone and desktop.
- **User copy**: refusal messages carry fixed phrases only; no goal or contribution id appears in the
  message data (Vitest also asserts this).
- **360 px**: Playwright light and dark, no horizontal scroll, 44 px targets (row link, "Tambah target",
  "Tambah tabungan", "Ubah target", "Hapus", back link).
- **Money vectors / month boundaries / two devices**: not applicable. Goals accept only the whole-unit
  AmountInput contract, not the slang parser (FN-14a); they have no `occurred_on` bucketing and there is no
  sync layer yet.

## Checklist items applied

- **One access rule**: `requireSpaceAccess(locals.user, locals.space)` on every load and action. Every write
  repeats `isLiveMember` in its own statement. Goal and contribution lookups carry `space_id` (and `goal_id`)
  in the same query, so hidden and missing ids get the same answer.
- **Concurrent writes**: guarded `INSERT … SELECT … WHERE` and `UPDATE … WHERE … RETURNING` in `db.batch`
  with `bumpSpaceSeq`.
- **Bounded work**: 50-goal list, 50-row history page, SQL aggregates.
- **Migrations**: new file only.
- **Integers only**: `wholeAmountMinor` goes through `digitsToMinor`; there is no `parseFloat`.
- **One currency per sum**: IDR only.
- **Totals reconcile**: the list row, the detail header and the history list are tested to agree.
- **Untrusted text**: `cleanText`, with the length capped before normalising.
- **Form bodies**: `readFormBody`.
- **Keyed lists**: by id.
- **CSP**: no inline style.
- **i18n**: English entries for every new phrase, and the coverage test passes.
- **Currency display**: shared formatters only.
- **Truthful state**: success is shown only after the server confirms.
- **Accessibility**: focus return, heading order h1 → h2 → h3, 44 px targets, 3:1 graphics contrast test.
- **Gates**: clean. **Fail-before**: the mutation table above.

## Concerns / for QA

- At merge, migration numbering and the snapshot chain must be re-done alongside 0004/0005.
- The detail page's skeleton shows only on retry (SSR delivers data up front), the same as FN-04.
- E2E no-JS submits on the phone use Enter, not a click. The floating tab bar can cover a button that
  Playwright scrolls only to the viewport edge; the layout has bottom padding, so a person can scroll it
  clear.

## Cycle 2 (red team L1, L3) and rebase on main

- **L1, content-free tombstones.** In `goal_contributions`, `amount_minor` and `created_at` are now
  nullable, guarded by the CHECK `goal_contributions_content_check`:
  - a live row has `amount_minor > 0` and `created_at`;
  - a deleted row has no amount, note, author or time.

  `deleteContribution` nulls all four in the same guarded statement, and the sums still read live rows only.
  Default 4 above is superseded: a deleted row now keeps only its ids, `deleted_at`, `updated_at` and `seq`.
- **L3, per-goal cap.** `MAX_CONTRIBUTIONS_PER_GOAL = 10.000` live rows, enforced in the guarded insert. A
  refused add answers 409 "Target ini sudah punya 10.000 catatan tabungan, batas terbanyak.". Deleted rows
  free a place.
- **Tests, failing before the fix** (3 failed, then pass):
  - D1-direct CHECK test (live and tombstone shapes);
  - row content after delete;
  - 10 concurrent adds at cap−5 → exactly 5 succeed and 5 get `limit`;
  - route answer at the cap.
- **L2** is accepted per the controller.
- **Rebase.** `git rebase main` conflicted in every schema, journal and i18n region. I reset the branch to
  `main` (01cc53d), carried the QA and security report commits over, and reapplied the final tree as one
  commit. The pre-rebase history is kept on the local branch `fn-10-goals-pre-rebase`.
  - The migration is now `0005_goals`, generated by drizzle-kit on top of 0004. The snapshot `prevId` is
    chained to 0004's id; the journal has idx 5 and tag `0005_goals`.
  - In `SPACE_SCOPED_TABLES`, `goalContributions` and `goals` come before `transactions`, `categories` and
    `wallets`.
  - The duplicate i18n keys "Catatan (opsional)" and "Ya, hapus", which FN-05 also added, are kept once.
  - The e2e spec uses `APP_ORIGIN`.
- **Checks after the rebase:**
  - `npm run db:reset:local` applies 0000–0005.
  - `npm run gates` exits 0: svelte-check 1068 files, 0 errors, 0 warnings; Prettier clean; Vitest 56 files,
    576 tests passed; build done.
  - Full Playwright run with `E2E_PORT=8822`: 121 passed, 14 skipped, 0 failed.
