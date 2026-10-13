# FN-10 Savings goals (Tabungan) — QA report (cycle 1)

## Verdict: PASS

Commit under test: `b661f7f` (detached, on top of `main` `98df284`). Diff `98df284..b661f7f`, 29 files,
+4829/-23.

## Commands run

- `npm ci` — installed 245 packages, exit 0 (local npm registry).
- `npx svelte-kit sync` — regenerated `.svelte-kit` types, exit 0.
- `npm run db:reset:local` — migrations 0000/0001/0002/0003/0006 applied to a fresh local D1, exit 0 (local wrangler/D1, no remote).
- `npm run gates` — check: svelte-check 1029 files/0 errors/0 warnings + workers tsc clean; lint: Prettier + eslint clean; test: Vitest 48 files/478 tests passed; build: adapter-cloudflare "✔ done" — exit 0 (local, no real provider).
- `LD_LIBRARY_PATH=<scratchpad> npm run test:e2e` — full Playwright suite, 107 passed, 14 skipped (phone/desktop-only splits), 0 failed — exit 0 (local wrangler dev on 8787, no real provider).
- `npx vitest run src/lib/server/wallets` — 13 passed, 0 failed (confirms `wholeAmountMinor` extraction left wallet behaviour unchanged) — exit 0 (local).
- Ad-hoc `wrangler dev --port 8806 --persist-to .wrangler/state` + two Playwright scripts (`check360.mjs`, `check360b.mjs`, written to a scratch dir and deleted after use) to visually confirm the engineer's "floating tab bar may cover a bottom button" concern at 360×780 — local only, server stopped after use, port freed (verified via `ss -ltn`).

## Checked criteria (PRD `docs/features/fn-10-goals/PRD.md`)

1. Create a goal → 0 % / Rp 0 / target, no reload — PASS (e2e `tabungan.spec.ts:77` "first goal: empty state → add in the sheet → 0 % … kept on reload"; integration `tabungan-routes.test.ts` "createGoal saves; the reload shows Rp 0 of the target at 0 %").
2. Persists across full reload — PASS (same e2e test reloads and re-asserts).
3. Invalid name/target refused, no row written — PASS (`goals/validation.test.ts` 27 cases incl. control/zero-width/over-length/zero/negative/non-numeric; e2e no-JS refusal path).
4. No-JS create works as a plain POST — PASS (e2e "without JavaScript: refused and valid goal, a contribution and a stale-free delete"; `?target=baru` inline form).
5. Progress = `formatMoneyCompact(S)/formatMoneyCompact(T)` + `floor(S*100/T)%`, via `goalSavedMinor`/`goalProgressPercent` only, never a client resum — PASS. `progress.ts` computes saved only by SQL `SUM()` (`savedSumSql`); no other module sums `goal_contributions` (grep confirms `repo.ts`/`contributions.ts` both import from `progress.ts`). `goals.test.ts` "totals reconcile: the shown percent equals the manual sum of the seeded contributions" passes. `goalProgressPercent` uses BigInt floor division — exact past 2^53, never rounds up.
6. ≥100% shows "Tercapai" badge, percent uncapped, bar fill capped at 100% — PASS (`progress.ts` never caps the percent; `ProgressBar.svelte` clamps `fill = Math.min(100, …)`; `goals.test.ts` "over-saving reads above 100 % and the goal is met"; `ProgressBar.test.ts` 4 tests).
7. Zero contributions shows an honest `Rp 0 / target` and `0%` — PASS (same createGoal e2e test; `goalProgressPercent` returns 0 for `savedMinor <= 0`).
8. Add contribution: amount>0 CHECK+zod, `created_by_user_id`, write confirmed before UI updates — PASS (`contributions.ts` guarded INSERT…SELECT…WHERE with `isLiveMember`; e2e "contributions raise the progress after the server confirms").
9. Zero/blank/negative/non-numeric amount refused — PASS (`validation.test.ts`, SQL CHECK test "the SQL CHECK refuses a zero or negative contribution").
10. Reload preserves contribution and progress — PASS (e2e reload assertion in the same journey).
11. Delete tombstones, history row disappears, saved amount drops after server confirm — PASS (e2e "archive hides the goal... "/contribution delete flow; `deleteContribution` tombstones + clears note; `goals.test.ts` "tombstones the row, clears its note and lowers the saved amount").
12. Delete scoped by both `space_id` and `goal_id`, cross-goal/cross-space id refused uniformly — PASS (`goals.test.ts` "refuses a contribution of another goal or another space (scoped by space AND goal)"; `deleteContribution`'s `WHERE` includes `goalId`, `spaceId`, and an `exists` check the goal itself is live in that space).
13. Edit updates row, `updated_at` advances, new values only after server confirms — PASS (`updateGoal`'s guarded `UPDATE…WHERE updated_at = expected`; e2e "edit the target; a second tab's stale save is refused").
14. Stale `updated_at` on second submit refused with FN-04's exact phrase — PASS. `messages.ts`: `GOAL_CHANGED = msg('Berubah sejak terakhir dimuat. Muat ulang lalu coba lagi.')` — same i18n key as FN-04, not re-keyed; verified by reading the shared `tr()`/`i18n-en.ts` entry and by `tabungan-routes.test.ts` "a second tab's stale edit gets 'changed meanwhile'".
15. Archive tombstones the goal, leaves contributions untouched — PASS (`archiveGoal` only sets `goals.deleted_at`; `goals.test.ts` "archive keeps the contribution log; restore brings back the same progress").
16. Restore clears `deleted_at`, progress intact — PASS (same test, plus e2e "archive hides the goal and keeps its history; restore brings back the same progress").
17. Every load/action resolves via `locals.space.id`; `[id]` routes scope by `WHERE space_id = ? AND id = ?` — PASS (read `repo.ts`/`contributions.ts`: every query/guarded-write includes `eq(goals.spaceId, spaceId)`/`eq(goalContributions.spaceId, spaceId)` in the same statement; `+page.server.ts` files call `requireSpaceAccess` and pass `locals.space.id`, never a client-supplied id — confirmed by reading both route files).
18. Cross-space probe (non-member, removed member) returns nothing, never 200 — PASS. Engineer's pre-handoff probe (ENGINEER_REPORT.md) plus `goals.test.ts`/`tabungan-routes.test.ts` "one access rule" suite: "a non-member and a removed member get the unknown-id answer on the page and every action", "a contribution id of another goal in the same space is refused like an unknown one", "a stale current space … gets the helper's 404", "user-facing answers never carry an id" — all pass under `npm run test`.
19. 20-concurrent-`addContribution` probe: no lost write, no 500 — PASS. `goals.test.ts` "20 concurrent contributions: none lost, the sum is exact" and `tabungan-routes.test.ts` "20 concurrent contributions through the action: all 200, sum exact" both pass; mechanism is a guarded `INSERT…SELECT…WHERE` with an inline overflow guard, no mutable counter.
20. Form bodies capped, 400/415, never 500 — PASS (`forms.ts` `readFormBody` reused unchanged; `tabungan-routes.test.ts` "answers 400 to a 20 KB body and 415 to a non-form body, never 500").
21. `{#each}` keyed by id — PASS (grep: `GoalsSection.svelte:188,206` key by `goal.id`; `tabungan/[id]/+page.svelte:295` keys by `c.id`).
22. English i18n entries for every new phrase, coverage test fails if missing — PASS (part of the 478 Vitest tests that passed; `i18n-en.ts` diff adds 49 lines).
23. Currency via shared formatters, timestamps via shared WIB date module — PASS (grep confirms `formatMoney`/`formatMoneyCompact`/`formatDateTimeWib` imports in the detail page and `GoalsSection.svelte`; no hand-built `Rp` string found).
24. Focus returns to opener on Sheet close; 44px targets; AA contrast — PASS (e2e "goals fit 360 px … with 44 px targets" for light and dark; `test/contrast.test.ts` +4 non-text 3:1 pairs; Sheet focus-return is the same shared `Sheet.svelte` component FN-04 already uses).
25. Error text never leaks a path/id/stack — PASS (`messages.ts` reviewed: all fixed phrases, no interpolation of ids; `goals.test.ts` "user-facing answers never carry an id").
26. `npm run gates` clean; fail-before proof shown — PASS (gates run above; ENGINEER_REPORT.md's 15-mutation fail-before table, each with a tests-failed count, is consistent with the passing suite now).

## 360 px floating tab-bar concern (engineer's note)

Verified independently with an ad-hoc `wrangler dev` on port 8806 and a throwaway Playwright script (360×780
viewport, light scheme): created a goal, added 10 contributions to push the history list to realistic length,
scrolled the document fully to `document.body.scrollHeight`. Result: `window.scrollY` reached the document's max
(919 of 1699px total), the last contribution's "Hapus" control bounding box ended at y=627, the fixed `nav.tabbar`
starts at y=698 — a 71px gap remains, so the primary action (and every other bottom control) stays reachable and
unobscured after a full scroll. Screenshot taken and discarded per the 5-screenshot budget (not retained, matches
`.content`'s `padding-bottom: calc(var(--tabbar-h) + 40px + env(safe-area-inset-bottom))` in `(app)/+layout.svelte`,
the same shared layout every other tab already relies on). **PASS** — no primary action is unreachable.

## Cross-cutting/deviation review

- **`created_by_user_id` nulled on account deletion (NOT NULL in PRD, nullable + ON DELETE SET NULL as shipped):**
  judged acceptable. The PRD's own "Out of scope" section never addresses what happens to a shared goal's history
  when a contributing member later deletes their account, and `CLAUDE.md` requires shared-space data to survive a
  member's departure (mirrors the `audit_events` precedent already in this codebase, and FN-01's account-deletion
  design for shared-space history). A NOT-NULL FK would instead force a hard failure or a cascade-delete of another
  member's logged contribution on an unrelated action (account deletion), which would silently destroy a shared
  space's progress figure — worse than the deviation. Tested directly: `goals.test.ts`
  "deleting a member's account keeps their contribution in the shared space, without their name" confirms the
  amount and `goalSavedMinor` survive with `author: null`, shown in the UI as "Akun yang sudah dihapus". Accepted.
- **Migration renumbered `0004_goals` → `0006_goals.sql` by hand** (parallel FN-05/FN-07 work assumed 0004/0005):
  disclosed by the engineer, `db:reset:local` applies 0000→0006 cleanly with no gap errors in this worktree's
  isolated state (0004/0005 do not exist here), consistent with the PRD's own "renumber at merge if needed"
  caveat. Not a QA blocker; flagged for the controller at merge.
- No other `docs/ENGINEERING_CHECKLIST.md` item is violated: D1 writes use guarded `INSERT…SELECT…WHERE`/
  `UPDATE…WHERE…RETURNING` inside `db.batch` (no interactive transactions, no read-then-write race); money is
  integer-only via `wholeAmountMinor`/`digitsToMinor` (no `parseFloat`); `goals`/`goal_contributions` both lead
  `SPACE_SCOPED_TABLES` (children before `wallets`/`spaces`) so `purgeSpaces` deletes them first; `ProgressBar.svelte`
  has no inline `style` attribute (width is an SVG `rect` attribute, CSP-safe); ids never leak in user copy.
- Money vectors / WIB month-boundary vectors / two-device sync were judged not applicable by the engineer because
  goals use the whole-unit `AmountInput` contract only (not the slang/locale money parser) and carry no
  `occurred_on` bucketing or sync layer yet — confirmed correct by reading `validation.ts` (no date bucketing
  exists in this feature) and the PRD's own Scope/Out-of-scope sections, which do not ask for either.

## Findings

None. No acceptance criterion failed; no checklist violation found; `npm run gates` and the full e2e suite are
both clean.
