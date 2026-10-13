# FN-18 CSV import and export — QA report

**Verdict: PASS**

Reviewed at commit `043eaa3` (detached, on top of `main` `9c77de9`), engineer report cycle 1. Controller brief
deviations (possible-duplicate heuristic vs PRD decision F; all-or-nothing write vs criterion 13's wording) are
implemented exactly as described in the engineer report and are judged as controller-approved, not FAILs.

## Commands run

- `npm ci` — installed 245 packages, exit 0, local npm registry (no provider).
- `npx svelte-kit sync` — exit 0, no output, local.
- `npm run db:reset:local` — removed local D1 state, ran migrations incl. `0010_csv_import.sql`, seeded; 8 commands
  executed successfully, exit 0, local D1 (wrangler persist), no remote/provider.
- `npm run check` — `COMPLETED 1192 FILES 0 ERRORS 0 WARNINGS`, exit 0, local tsc/svelte-check.
- `npm run lint` — "All matched files use Prettier code style!" + eslint clean, exit 0, local.
- `npx vitest run --maxWorkers=4` — `Test Files 91 passed (91)`, `Tests 1302 passed (1302)`, exit 0, local D1 fixtures
  (no AI, no remote provider).
- `npm run build` — client + service-worker + Cloudflare adapter build, `✓ built` ×2, exit 0, local.
- `npm run gates` (full, single invocation) — check 0 errors/0 warnings, lint clean, `Tests 1302 passed (1302)`,
  build `✓ built`, exit 0, local.
- `E2E_PORT=8849 LD_LIBRARY_PATH=<scratchpad> npx playwright test --workers=2`
  — `192 passed, 15 skipped`, exit 0, local `wrangler dev` (real Worker runtime, local D1, no real external
  provider); includes all 3 `e2e/impor.spec.ts` specs on desktop, all passing; no re-run needed (zero failures).
  Server stopped automatically when Playwright exited (`reuseExistingServer` tied to the run); confirmed no
  stray `wrangler dev` process remained afterward on this port.

No ad-hoc `wrangler dev` was started by QA (the engineer's own pre-handoff probes on :8824 are reported in
`ENGINEER_REPORT.md`, not re-run here since the integration and e2e suites already exercise the same server-side
paths against a real local D1).

## Checked criteria

**Parsing (`src/lib/shared/csv.ts`)**

1. PASS — `csv.test.ts` "reads comma and semicolon files…" (delimiter from header, no manual selection).
2. PASS — `csv.test.ts` "keeps a quoted delimiter, an escaped quote and an embedded line break inside one field".
3. PASS — `csv.test.ts` "recognises the template (full or minimum set, any case) and Money Manager" / "answers
   null for neither".
4. PASS — `csv.test.ts` "skips transfers and unknown types" (`mapTemplateRow`).
5. PASS — `csv.test.ts` "falls back from an empty wallet_source to payment_method".
6. PASS — `csv.test.ts` "never guesses a missing or unreadable date or amount" (both mappers).
7. PASS — `csv.test.ts` "maps Note to the title, the part before / to the category, Income/Expense to the type".
8. PASS — `csv.test.ts` "reads ISO and day-first dates, ignoring a time after them" / "refuses anything else and
   impossible dates".
9. PASS — `csv.test.ts` "reads every FEATURES.md amount vector through the shared money parser"; `csv.ts` imports
   `parseMoneyAmount` once, one call site per mapper (`readAmount`).
10. PASS — e2e `impor.spec.ts` "an unknown header asks for the format…" shows "Format tidak terdeteksi, pilih
    manual" + the `Segmented` override; `i18n-en.ts` has the English entry (i18n coverage test, see 32).

**Import, idempotency and missing-row handling**

11. PASS — `impor.test.ts` "creates missing categories and wallets, writes source csv with the batch id and
    extras"; find-or-create helpers in `wallets/repo.ts`/`categories/repo.ts`.
12. PASS — `impor.test.ts` "re-importing the same file creates nothing and reports every row as already
    imported"; also proven end-to-end in e2e ("Siap diimpor 0 · … Sudah pernah diimpor 2").
13. PASS (as a controller-approved deviation) — `impor.test.ts` "saves every valid row and counts the bad ones,
    never guessing an amount or date"; the write itself is all-or-nothing per row set (`db.batch` + `batchAssert`),
    matching the engineer's recorded decision #2, approved by the controller brief.
14. PASS — `impor.test.ts` "skips non-IDR rows apart from the other skips; IDR rows still import".
15. PASS — route action tests assert the exact `trf(...)` result line computed from server counts; e2e confirms
    the same line rendered in the UI.
16. PASS — `impor.test.ts` "creates missing categories and wallets, writes source csv with the batch id and
    extras" asserts `source = 'csv'` and `import_batch_id` set.
17. PASS — `impor.test.ts` "processes at most CSV_MAX_ROWS rows and reports the rest; totals equal the file
    exactly" — 5,003-row file, exactly 5,000 imported, 3 `notProcessed`, `periodTotals` sum matches the expected
    `BigInt` total exactly (integer, no mixed currency).
18. PASS — `impor.test.ts` "cross-space: another space's wallet id and batch id get the uniform not-found
    answers" (404 "Dompet tidak ditemukan." for a cross-space `defaultWalletId`).
19. PASS — `csv-import.ts` `prepare()`/`importCsv` always re-runs `readCsv` on `input.fileText`, never accepts a
    client-computed row array; route action re-uploads the raw file (`e2e/impor.spec.ts` uses `setInputFiles`,
    confirming the raw bytes travel to the server).

**Undo**

20. PASS — `impor.test.ts` "tombstones every row of the batch content-free and sets undone_at; a second undo is
    a no-op"; e2e confirms rows leave Riwayat and the Export CSV after undo.
21. PASS — same test, second half (double-click/replay → `already`, no second tombstone, no error).

**Export**

22. PASS — `csv-export.ts`/`impor.test.ts` "neutralises formula cells, leaves out transfers and demo rows, and
    round-trips…" confirms template column order and transfer exclusion.
23. PASS — same test exercises all six formula-start vectors (`=`, `+`, `-`, `@`, tab, CR) across title/tag/
    notes/reference, all guarded with a leading `'`; `csv.test.ts` "neutralises every formula start… with a
    leading '".
24. PASS — `impor.test.ts` "export: CSV attachment for a valid range; a missing range or a range over a year
    goes back with a message" — missing/reversed range redirects to `?ekspor=salah`, >1 year is truncated with
    `?ekspor=dipotong`.
25. PASS — same round-trip test: export into a CSV, re-import into an empty space, compare
    `[type, amount_minor, occurred_on, title, note, tag, reference]` sorted — identical.
26. PASS — `/impor/ekspor` is a plain GET `+server.ts` (Owner decision E); e2e "without JavaScript: import and
    export work as plain form posts" downloads via a plain `<a>`/form GET with JS disabled.

**Cross-cutting**

27. PASS — every load/action in `+page.server.ts` calls `currentSpaceScope(locals)`/`currentSpaceScope(event.locals)`,
    never a client-supplied `spaceId`; `csv-export.ts`'s `+server.ts` does the same.
28. PASS — `impor.test.ts` "cross-space…" and "a removed member's import writes nothing (the membership is
    re-checked inside the batch)" — both answer uniform not-found/empty, never 200 with another space's data.
29. PASS — `impor.test.ts` "20 concurrent imports of the same file create each row exactly once, never an error"
    — 30 rows from 20 concurrent calls, exactly one wallet/category created, no error, no double insert.
30. PASS — `impor.test.ts` "refuses a missing, empty, non-UTF-8, malformed or unknown-format file… never a 500"
    and "refuses an oversized body with 400 and a non-form body with 415".
31. PASS — `+page.svelte`: batch list keyed `(batch.id)`, wallet picker `(wallet.id)`, duplicates list
    `(dup.line)` — no filename/title keys.
32. PASS — `npx vitest run src/lib/shared/i18n.test.ts` passes (12/12, part of the full suite); `i18n-en.ts` has
    51 new entries per the engineer report.
33. PASS — `csv-export.ts`/`csv.ts` use `formatCsvAmount` (exact string arithmetic, never a float) for export
    cells; `+page.svelte` dates go through `formatDayLabel`/WIB helpers; money display elsewhere in the route
    uses the shared formatter.
34. PASS — grep of the diff shows raw file text only reaches `readCsv`/`sha256Hex` in `csv-import.ts`/
    `validation.ts` during the request; no R2, D1 or log write of file bytes found; `import_batches` only stores
    counts/filename, never row content.
35. PASS — reviewed `messages.ts` and the route's error mapping: every user-facing string is a fixed phrase
    (e.g. "Dompet tidak ditemukan.", "Impor tidak ditemukan.") with no path, stack, row id or internal
    identifier interpolated.
36. PASS — `npm run gates` clean (see Commands run); fail-before proof recorded in the engineer report (formula
    guard removed → 2 failed; dedupe pre-check removed → 3 failed; row cap removed → 1 failed; cross-space wallet
    check removed → 2 failed) — not independently re-run by QA (would require editing source, which QA may not
    do), accepted on the engineer's own record together with the now-passing suite.

## Findings

None. No acceptance criterion failed; `npm run gates` and the full Playwright suite (`192 passed, 15 skipped, 0
failed`) are both clean. `npm run db:migrate:local` on a fresh DB (via `db:reset:local`) applied `0010_csv_import`
without error.

## Engineering checklist spot-check

- D1 100-param: `json_each` binds used for bulk find-or-create and possible-duplicate matching — no growing
  `inArray`.
- Bounded work: 5 MB / 5,000 rows / 50 columns caps enforced in `csv.ts`/`validation.ts`; export capped to 1 year,
  paginated 1,000 rows/page in `csv-export.ts`.
- One access rule: every write path threads through `isLiveMember`/`currentSpaceScope`; no second ad hoc check.
- No upload persistence: confirmed by code review (see criterion 34).
- CSV export guard: confirmed by code and the dedicated regression test covering all 6 vectors.
- i18n: confirmed by the passing coverage test.

No ENGINEERING_CHECKLIST violations found in this diff.
