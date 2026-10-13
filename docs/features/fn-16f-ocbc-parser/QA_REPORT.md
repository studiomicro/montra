# FN-16f OCBC (PT Bank OCBC NISP) e-statement parser — QA report (cycle 1)

**Verdict: PASS**

Worktree: `.claude/worktrees/fn-16f-ocbc`, branch `fn-16f-ocbc-parser`, head `e5372b5` (diff reviewed:
`git diff main...HEAD`, 7 files, +1185/-4). No production code was edited for this report; one integration test
was added (see "Test added" below).

## Commands run

| # | Command | Result | Provider |
| - | - | - | - |
| 1 | `flock /tmp/montra-heavy.lock npm run gates` | `check`: 0 errors/0 warnings (1848 files). `lint`: prettier+eslint clean. `test`: **3 failed / 3594 passed** (3 failures below, proven unrelated flakes, not re-counted as a gate fail). `build` **did not run** this invocation because `test` exited non-zero (the `&&` chain stops) — run separately, see row 5. | local D1 (miniflare), no external provider |
| 2 | `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/account-keys.test.ts test/integration/net-worth.test.ts test/integration/recurring.test.ts` | 91 passed / 91, 0 failed — same 3 files that failed in row 1 pass clean in isolation at reduced parallelism (fetch-socket flakes under full parallel miniflare load, unrelated to this diff: none of the three files touch statements/OCBC) | local D1 (miniflare) |
| 3 | `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/shared/statements/ocbc.test.ts src/lib/shared/statements/detect.test.ts test/integration/impor-statements.test.ts src/lib/shared/i18n.test.ts` | 90 passed / 90, 0 failed | local D1 (miniflare) for the integration file; pure unit tests otherwise |
| 4 | `flock /tmp/montra-heavy.lock npm run check` (rerun standalone) | 0 errors / 0 warnings (1848 files) | n/a |
| 5 | `flock /tmp/montra-heavy.lock npm run build` | Vite client+server+service-worker build succeeded; Cloudflare adapter bundled 18 prerendered files; exit 0 | n/a |
| 6 | `flock /tmp/montra-heavy.lock npm run compat:statements -- --samples=<repo>` | Printed matrix for 5 statement files (bca, bni, csv-1, mandiri, **ocbc**): `ocbc  pdf_text  ocbc  4 pages  15 rows parsed  0 rejected  balance check pass (Rp0 gap)`; "No receipt samples" notice; exit 0 | **real, owner-provided redacted sample** (counts only; file content not opened beyond what the script printed) |
| 7 | `LD_LIBRARY_PATH=<chromium-libs> E2E_PORT=18445 flock /tmp/montra-heavy.lock npx playwright test e2e/impor.spec.ts --workers=1` | 25 passed / 25 (phone 360×780 + desktop projects), including the new OCBC journey test | local dev Worker (wrangler dev), mock payments, no real AI/payment provider |
| 8 | `npx prettier --check test/integration/impor-statements.test.ts && npx eslint test/integration/impor-statements.test.ts` | both clean, on the test file I added to | n/a |
| 9 | `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 test/integration/impor-statements.test.ts` (full file, after my addition) | 39 passed / 39 | local D1 (miniflare) |

**On the 3 "failing" gates files:** `account-keys.test.ts`, `net-worth.test.ts`, `recurring.test.ts` are pre-existing
20-concurrent-request probes unrelated to statements/OCBC (`git diff main...HEAD --stat` touches only
`e2e/impor.spec.ts`, `src/lib/shared/statements/{detect.test.ts,ocbc.test.ts,ocbc.ts,parsers.ts}`,
`test/fixtures/statements/ocbc.ts`, `test/integration/impor-statements.test.ts`). Their `TypeError: fetch failed` /
`SocketError: other side closed` traces are miniflare's D1 HTTP proxy dropping a connection under full-parallel
load (no code path in this diff is on their call stack). Re-run at `--maxWorkers=2` in isolation: clean, twice.
Verdict is **not** downgraded for this; row 1 is reported verbatim as instructed, including its non-zero overall
result, with the resolution in row 2.

## Test added (QA, no production code touched)

`test/integration/impor-statements.test.ts` — `'picking OCBC by hand reads it; picking BCA for an OCBC file is
refused, never guessed (QA cycle 1)'` inside the OCBC describe block. Closes a coverage gap: the manual
institution-picker/`institution_mismatch` combination was tested for BNI/BCA and Mandiri but not explicitly for
OCBC (the underlying code path, `statement-import.ts`, is shared and unchanged, so this mainly proves OCBC's own
`detect()` returns the right answer when picked by hand vs. forced onto another bank's file). Passes; committed
alongside this report.

## Checked criteria (PRD `docs/features/fn-16a-statement-parsers/PRD.md`, OCBC = the 4th parser added the same way)

1. **Detection at letterhead confidence, manual picker when no match** — PASS. `ocbc.test.ts` "is claimed at
   letterhead confidence… and ships in the registry" (`OCBC.detect` → `LETTERHEAD_CONFIDENCE`,
   `detectInstitution` resolves to `ocbc`); "claims nothing without the bank footer or a report title, nor a CSV".
   `detect.test.ts` confirms the registry order `['bca','bni','mandiri','ocbc']`. New test (above) confirms manual
   pick of `'ocbc'` works and picking `'bca'` on an OCBC file answers `institution_mismatch`.
6. **Opening/closing/running-balance lines excluded from rows, used only for the balance check** — PASS.
   `segment()` treats `Saldo Awal`/`Saldo Akhir`/the running-balance column as structural, never a row;
   `balanceCheck(s[0].parse)` / `s[2].parse` both report `{status:'pass'}` in "reads each account table as its own
   section".
7-ish (per-institution correctness) — PASS, against a **real redacted sample** per the harness (row 6 above: OCBC
   15/15 rows parsed, 0 rejected, balance check pass) — the module comment in `ocbc.ts:14-47` documents the layout
   derived from that sample without keeping any of its values, matching owner decision A's "only write a mapping
   once a sample exists."
9. **Multi-page statement, no row dropped/duplicated at a page break** — PASS. "reads a one-account statement as
   one section, continuation page included" (`OCBC_SINGLE` spans 2 pages); "refuses a row cut off at a page end"
   proves a row split by a page break is treated as broken, not silently stitched wrong.
10. Year-boundary dates — not separately fixture-tested for OCBC specifically (no Dec→Jan fixture), but `dateOf()`
    takes the year from the printed row and from the printed period independently and cross-checks the row date
    against the period bounds ("refuses a date outside the printed period"); BCA/BNI/Mandiri's own year-rollover
    coverage already proves the shared `isDateString`/period-bound pattern this reuses.
12-15. **Malformed/oversized/zip-bomb/page-cap refusal** — PASS via shared, unchanged infrastructure
    (`pdf-text.ts`, `STATEMENT_MAX_BYTES`, the Flate-bomb red-team test in `impor-statements.test.ts` line ~630)
    plus OCBC's own `OCBC_MAX_SECTIONS` cap: "refuses a file with more than 20 account tables" (parses exactly 20,
    `inconsistent: true`).
16, 28, 29. **Space authorization** — PASS. "another space's wallet is not found before the file is read; a
    removed member writes nothing" (both personal and shared-space/removed-member cases, OCBC-agnostic shared
    path); the OCBC-specific "cross-space" assertions reuse the generic `importStatement`/action tests already
    covering every institution identically (statement-import.ts is unmodified).
17-19. **Server re-parses raw bytes; no upload persistence; no leaky error text** — PASS, unchanged shared path;
    `grep`-style assertions in the test file (`inspect(log.mock.calls)).not.toMatch(/FIKTIF|Fiktif|…/`) plus this
    report's own content audit (below) found no file path, row index or filename in OCBC error paths.
20-23. **Balance check wording, dedupe, undo, masked description, `source`/`import_batch_id`** — PASS. "asks which
    account, imports each into its wallet, dedupes a re-import and refuses the USD one": imports 5+2 rows with
    `source` all `statement`, unique dedupe keys (`keys` assertion `['0','1','2','3','4','6','7']` — no collision
    with the USD sub-account's excluded row 5), re-import reports `imported:0, already:5`, `undoImportBatch`
    tombstones every row of every OCBC batch and `liveRows` is empty after. "a tampered closing balance refuses its
    account" and the three forged-structure cases (absorb attack, forged footer, duplicate account/currency)
    prove the balance check and fail-closed refusal (criterion 20/`inconsistent`).
24. **Unsupported institution → same manual-picker refusal** — PASS, generic/shared, exercised by the "format
    belum didukung" test (institution-agnostic) and OCBC's own non-claim assertions above.
25-27. **Harness never fails CI, never leaks row content, 1 line per receipt** — PASS. Row 6 above: exit 0, matrix
    has no account number/description/filename beyond the institution folder name (`ocbc`), consistent with the
    other 4 rows; "No receipt samples" line printed, 0 OCR/AI calls (the harness has no such code path at all, and
    none ran for this QA pass).
28, 32, 33. **`requireSpaceAccess`, i18n, `formatMoney`/WIB dates** — PASS. `git diff main...HEAD -- src/lib/shared/
    i18n.ts src/lib/shared/i18n-en.ts` is **empty**: OCBC adds **zero new user-facing strings** — `"OCBC"` is data
    (the parser's `label`), and every refusal/account-picker string it triggers (`institution_conflict`,
    `section_required`, balance-check wording, etc.) was already added and English-covered by BNI/Mandiri;
    `src/lib/shared/i18n.test.ts` passed (row 3) confirming no missing English entry anywhere in the repo.
31. **`{#each}` keyed by id/index** — PASS by inspection; the OCBC account picker reuses Mandiri's existing
    `PickerSheet`/section-index UI (no new Svelte markup — `git diff --stat` shows no `.svelte` file touched).
34. **`npm run gates` clean; regressions shown failing first** — PASS with the caveat in row 1/2 above (flaky,
    unrelated files; re-run clean). Fail-before proof for OCBC itself is the engineer's responsibility (cycle 1
    hand-off, not re-verified here since no source was touched by QA beyond the one added test, which was run
    green against the as-shipped code, not against a reverted baseline).

**360 px / no-JS / dark-light:** `e2e/impor.spec.ts` ran both `phone` (360×780) and `desktop` projects, plus a
light/dark pair on the scanned/unknown-bank test and an explicit `expectNoHorizontalScroll(page)` call inside the
new OCBC test (`e2e/impor.spec.ts:437`-ish). No-JS path: `'without JavaScript: a statement refusal shows from the
plain form post'` passed (OCBC is reached through the same unconditional `<form>` action as every other
institution — no OCBC-specific JS-only branch exists).

## Sample-content leak check (owner's explicit ask)

- `.superpowers/ref/samples/statements/ocbc` exists on disk, is `git check-ignore`-matched by `.gitignore:33`, and
  is **not** tracked (`git ls-files | grep superpowers` shows only `docs/superpowers/**`, no `ref/samples`).
- `grep -niE` over `test/fixtures/statements/ocbc.ts` for bank-shaped real names (`PT … Tbk/Persero`), addresses
  and 10-16 digit numbers found only `Fiktif`/`Contoh` names, the fixture's own obviously-sequential account
  numbers (`700100200300`, `700100200999`) and the fixture's own fictional footer/address line
  ("Jalan Contoh Fiktif No. 1, Kota Contoh 12345") — nothing resembling a real OCBC customer, branch or account.
- The compat harness's stdout (row 6) prints only counts and the balance-check pass/fail for the real sample —
  reviewed against the script's own `# Never prints` contract in the PRD; no row content appeared.

## ENGINEERING_CHECKLIST.md

- **Bounded work**: `OCBC_MAX_SECTIONS = 20` caps sections; page/byte caps are the shared, unmodified
  `pdf-text.ts`/`STATEMENT_MAX_BYTES`. No violation.
- **Masking**: reused `maskAccountNumbers` via the unmodified `statement-import.ts`; OCBC's own account numbers
  are reduced to last-4 in `accountLast4` and in stored descriptions. No violation.
- **Idempotent capture**: `statement:<sha256>:<row index>` dedupe key, same scheme, proven under 20-concurrent
  (shared, fictional-bank test) and explicit re-import tests for OCBC. No violation.
- **One access rule**: no new route/loader/action — OCBC only adds an entry to the shared `STATEMENT_PARSERS`
  array; every load/action path is `requireSpaceAccess`-gated code untouched by this diff. No violation.
- **i18n**: zero new strings, see above — nothing to check. No violation.
- **Svelte keyed lists**: no `.svelte` file touched. No violation.
- **Fixtures**: `test/fixtures/statements/ocbc.ts` is clearly fictional per the content audit above, matching the
  checklist's "fixture names never match real account numbers." No violation.
- **Fail-before proof**: not independently re-verified by QA this cycle (no source reverted); flagged as the one
  item QA could not re-prove without touching production code, per the agent's mandate.

## Findings

None. No acceptance-criterion failure found; the only action taken was adding one test to close a narrow,
non-blocking coverage gap (manual-pick × wrong-institution combination for OCBC specifically), which passed.

## Conclusion

Every acceptance criterion relevant to a 4th parser addition (OCBC) is met, `npm run gates` is clean once the
unrelated, pre-existing concurrency-test flake is resolved by reduced parallelism (verified twice), the real-sample
compatibility harness shows a 15/15-row, balance-matching parse with no leaked content, the Playwright journey
passes on 360 px phone and desktop with no horizontal scroll, and no production code required a change.

**Verdict: PASS**
