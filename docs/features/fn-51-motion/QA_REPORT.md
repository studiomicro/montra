# QA report — FN-51 more motion (cycle 1, HEAD 80e0fce, main a45585f)

**Verdict: PASS** (with AC 6 manual check not verified and one stale-doc finding; no AC fails).

Host load stayed 32–94 throughout (other projects share the machine). `npm run gates` was NOT run as one command; its steps were run separately (below). The full `npm run test` had load-induced failures only in files the branch does not touch (see Commands).

## Commands run

- `npm run check` — svelte-check 2256 files, 0 errors, 0 warnings, tsc service-worker/jobs/inbound clean; real tools, no provider.
- `npm run lint` — "All matched files use Prettier code style!", eslint clean; real tools.
- `npx vitest run test/motion-css.test.ts test/integration/imports-move.test.ts src/lib/ui test/i18n-coverage.test.ts` — first pass 45 files passed, 1 failed (`src/lib/ui/offline-queue/sync.test.ts`, 20 ms timer race, 567 tests passed); local D1/Miniflare, fixtures.
- `npx vitest run src/lib/ui/offline-queue/sync.test.ts` — 16 passed alone (branch only adds CSS to `OfflineQueueStatus.svelte`, not sync code).
- `npx vitest run test/integration/imports-move.test.ts` (alone, touched file) — 16 passed; it also passed (with all `src/lib/ui`, `motion-css`, i18n) in the first batch.
- `npm run test` (full, load 74) — 43 files failed, 302 passed (345); 37 tests failed, 4889 passed, 719 skipped. Failures were `ECONNRESET`/`fetch failed` Miniflare errors and timeouts across untouched integration files. Mixed-in: `imports-move.test.ts` (touched) failed there but passes alone and in batch.
- Rerun of those 43 files (`--maxWorkers=3`) — 28 passed, 15 failed (load, 1711 s). Rerun of the 14 untouched failures one at a time (`--maxWorkers=1`) — 9 files passed; 5 failed (barang, net-worth-scale, net-worth, recurring, spaces).
- Same 5 files on `main` a45585f (`--maxWorkers=1`) — net-worth-scale, net-worth and recurring fail there too (5 tests): pre-existing under load, not the branch. barang + spaces on the branch alone: 55 passed (2 files). Result: every full-run failure either passes alone or fails identically on main; none counts against the branch.
- `E2E_PORT=5393 npx playwright test e2e/motion.spec.ts --workers=1` (shim PATH) — 15 passed, 14 skipped (desktop project skipped by design), exit 0; local worker, real Chromium, no provider.
- `E2E_PORT=5393 npx playwright test e2e/shell.spec.ts e2e/ios-responsive.spec.ts --workers=1` — 45 passed, 2 skipped, exit 0.
- `git checkout -- docs/features` — restored `fn-40-visual-refresh/shots/p23-beranda-first-wallet-360.png` rewritten by e2e. `SECURITY_REPORT.md` (red team, untracked) left alone.

## Checked criteria

Evidence: Vitest `test/motion-css.test.ts` (gating, keyframe properties, duration tokens, LOADING_ONLY, Skeleton call sites, hover media queries, keys), `src/lib/ui/motion.test.ts`, `src/lib/ui/shell/pull-to-refresh.test.ts`, `e2e/motion.spec.ts` — all green above.

1. Reduced motion end state: PASS (motion-css gating over every MOTION_FILES entry; e2e `motion.spec.ts:66` reduced-motion render).
2. Durations <= 300 ms or loop: PASS (`FN51_FILES` duration-token test).
3. Keyframes transform/opacity/stroke-dashoffset only, fail-before proof: PASS (per-file test; `motion-css.test.ts:153` plants a `width` keyframe and shows the rule rejects it).
4. `infinite` only in LOADING_ONLY, every `<Skeleton` in a loading branch: PASS (`motion-css.test.ts:93,105`).
5. First paint, no waiting for script: PASS (`pageFadeAllowed` with `from: undefined` false; hero/bar values final; no-JS row tap e2e `motion.spec.ts:176` passes).
6. CLS and 60 fps on Android: NOT VERIFIED (manual; no device here). Not a failure.
7. Hidden tab: PASS (`motion.test.ts` — `pageFadeAllowed`, `countUpDuration`, `streakHop`, `welcomeWaveDue` with `hidden: true`).
8. Route transition: PASS (e2e `motion.spec.ts:202`: transform+opacity keyframes, tap lands, transform `none` after; none under reduce).
9. Same-path no transition: PASS (existing helper test).
10. Riwayat "Muat lebih banyak": PASS (e2e `motion.spec.ts:473`).
11. Impor batch row highlight: PASS (`highlightedBatchId` tests; `GroupRow highlight`). Browser optional, not run.
12. Kotak masuk exit: PASS (`rowOut` test duration 0 under reduce; e2e `motion.spec.ts:524` zero CSP violations).
13. Charts draw-in, same final geometry: PASS (e2e `motion.spec.ts:268`).
14. Budget bar `aria-valuenow` final from first frame: PASS (motion-css ProgressBar render test; fill scales).
15. No replay on re-render: PASS (`{#each}` key test).
16. Skeleton shimmer, rows <= 8: PASS (component test + `skeletonRows`).
17. Desktop hover/focus lift media-query context: PASS (motion-css hover tests; background outside, translate inside no-preference).
18. Desktop dialog scale-in and pointer-events: PASS (e2e `motion.spec.ts:323`).
19. FAB `aria-expanded` and 45 degree turn: PASS (e2e `motion.spec.ts:359`, CSS gating test).
20. Streak hop: PASS (`streakHop` table test; CSS gated).
21. Banners: PASS (gating of the four files).
22. Gates: PARTIAL as stated — check clean, lint clean, build not re-run by QA (engineer reported clean), test: touched/behaviour files all green; untouched failures are load-only (baseline on main identical).
23. No space-scoped query change: PASS (diff outside `src/lib/ui` and docs touches only `src/routes/(app)/impor/+page.server.ts` + `test/integration/imports-move.test.ts`, see below).
24. States unchanged: PASS (existing route/component tests green).
25. i18n: PASS (`test/i18n-coverage.test.ts` green; no new phrase; `Memuat…` reused).
26. CSP: PASS (no inline `style=`/`.style`/`setProperty` added by the diff; motion spec CSP watch green).
27. 360 px / 44 px: PASS (shell + ios-responsive 45 passed).
28. Focus return: PASS (existing e2e assertion in motion spec).
29. Persisted state: PASS (`welcomeWaveDue` WIB vectors 23:30 / 00:30 in `motion.test.ts`; key `montra-welcome-wib-date`).
30. e2e economy: PASS (new cases only in `motion.spec.ts`; default reduce kept).

Owner decisions: 1 subtle (8 px, `--ease`, no hover shadow) PASS; 2 desktop/phone split PASS; 3 Koko welcome (standalone, once per WIB day, no copy) PASS — implemented in `src/routes/(app)/+page.svelte`, unit-tested only (no e2e); 4 shimmer PASS; 5 no shadow PASS; 6 pull-to-refresh PASS (`PullToRefresh.svelte`, e2e `motion.spec.ts:408`: installed only, pull reloads, scroll-up does nothing); 7 Kotak masuk exit PASS.

## Scope check: partial-cycle changes

`src/routes/(app)/impor/+page.server.ts` adds `batchId` to three action results (`import`: `result.batchId`, already returned by the existing import path at line 514; `undo`/`move`: the posted `id` the action already validated and used for its own 404). No new query, no change to the space-access call, authorization or error paths. This is exactly PRD B2 / AC 23. `test/integration/imports-move.test.ts` adds one expected key (`batchId`) to the existing `toEqual` for the move result; 16 tests pass. Within scope.

## Findings

1. Low (doc only): `docs/FEATURES.md:638-639` still says Koko welcome and pull-to-refresh are "owner decisions (defaults: no / deferred)". Owner answered yes to both on 2026-10-12 and both are built. Update when trackers are written; not blocking.
2. Info: Koko welcome wave and streak chip hop have unit/CSS tests but no browser test (PRD asks for Vitest only for both). Not a failure.
3. Info: `DURATION_TOKEN` in `motion-css.test.ts` accepts any animation shorthand starting with a Koko pose name; loose but intended for Mascot.
4. Checklist: no `docs/ENGINEERING_CHECKLIST.md` item violated that I could identify from the diff (no server query, no money, no secret serialisation; stable keys on charts).
