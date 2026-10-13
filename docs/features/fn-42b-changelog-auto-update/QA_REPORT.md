# QA report — FN-42b changelog and automatic update checks (cycle 1)

**Verdict: PASS**

Diff reviewed: `git diff 38c5f82..4485fb3` (27 files). No `src/`, `workers/` or `migrations/` file edited by QA. One test file added: `e2e/catatan-rilis-qa.spec.ts` (AC6/AC23 DOM checks).

## Commands run
- `npm run gates` (flock stub on PATH, local only, no provider): exit 0; svelte-check 1864 files 0 errors 0 warnings; prettier + eslint clean; vitest `Test Files 241 passed (241)`, `Tests 3638 passed (3638)`; vite build done.
- `E2E_PORT=5742 npx playwright test e2e/catatan-rilis.spec.ts e2e/pwa.spec.ts` (local wrangler dev, mock payments, no real provider): exit 1, `42 passed, 3 failed` under parallel load (pwa.spec.ts:338 phone+desktop and :603 phone, banner not visible within 5 s).
- `E2E_PORT=5742 npx playwright test e2e/pwa.spec.ts -g "updates \(FN-42|automatic update checks" --workers=1`: exit 0, `11 passed (1.1m)` (the 3 failures are a load flake; they pass alone, including the untouched FN-42 test at :338).
- `E2E_PORT=5742 npx playwright test e2e/catatan-rilis-qa.spec.ts --project=phone --workers=1`: exit 0, `6 passed (16.2s)`.
- Fail-before for AC20: CHANGELOG.md newest heading temporarily set to `## v9.9.9`; `npx vitest run src/lib/server/content/release-notes.test.ts` gave `1 failed | 12 passed` ("v9.9.9 has no 9.9.9.id.md release note"); file restored with `git checkout CHANGELOG.md`; rerun `13 passed`.
- No migration added, so `db:migrate:local` not run. Full e2e suite not run (by instruction).

## Criteria
1 PASS integration `pengaturan-pemakaian.test.ts` (all notes newest first, en text, signed out 303 /masuk).
2 PASS e2e catatan-rilis no-JS 360 px (H1, H2 per pair, dates, no scroll, no CSP, 44 px back link).
3 PASS existing release-notes tests over all files (gates).
4 PASS pwa.spec no-JS test and Tentang "Lihat semua" (44 px, QA spec); 3 H3 cards (release-pages.test).
5 PASS `test/release-pages.test.ts` (both pages use ReleaseNote, one "Versi kamu").
6 PASS (DOM + 2 screenshots at 360 px): light, dark, mono/light, mono/dark all >= 4.5:1 for card heading, date, list text, back link, badge, notice title/list/link; no horizontal scroll; panel card, no new colour seen.
7, 8 PASS sw-update.test.ts. 9 PASS auto-check.test.ts (fake timers, cleanup).
10 PASS pwa.spec automatic checks (one update per gap, hidden none, no reload). 11 PASS (banner without tap, item survives, one reload). 12 PASS. 14 PASS.
13 PASS unit (enabled=false creates nothing).
15 PASS whats-new.test.ts. 16 PASS integration (note, null signed out, null for 9.9.9, 4 KB cap).
17, 18, 19 PASS e2e/catatan-rilis.spec.ts (5 tests, phone + desktop).
20 PASS with fail-before above. 21 PASS RUNBOOK "Release notes" present; no change under `.claude/`.
22 PASS i18n-en entries for all 5 new phrases (`Lihat semua`, `Tutup` already existed); missing-English test passes.
23 PASS (DOM): H1 then H2 per release; Tentang H2/H3 no skip; notice `role=status` labelled, region focusable, link and "Tutup" >= 44 px with touch; keyboard Enter on "Tutup" returns focus to MAIN.
24 PASS no D1/migration; payload keys only `notes`, `version`.
25 PASS gates clean; only the two named specs plus the QA spec run; `nav.ts`, `shell.spec.ts` untouched.

## Findings
- None blocking. Note: 3 pwa.spec update-flow tests timed out at 5 s under parallel load with other pipelines running; all pass with one worker. Possible flake risk for the 5 s banner expectation under load.
- Observation (not a defect): the closed offline-queue sheet puts a hidden H2 in `<main>`; QA spec filters hidden headings.
- Checklist: no violated item found (WIB, money, access N/A; i18n, a11y, bounded work ok).
- Screenshots: 2 viewed (changelog light, notice dark), well under the 5 limit.
