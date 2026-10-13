# QA Report — fix-xlsx-memory-sqref

**Verdict: PASS**

Worktree: `<repo>-worktrees/fix-xlsx-qa`, commit `811eada` (`wip(fix-xlsx-memory-sqref):
cycle 1`), base `main` `4da075f`. Diff touches only `src/lib/server/spreadsheet/xml.ts`, `xlsx-read.ts`, their tests
and `test/helpers/xlsx.ts`, matching the PRD's fix scope. No migration, no `tests/e2e` changes — ran no e2e (no UI
change, confirmed by `git diff 4da075f..811eada --stat -- migrations/ tests/e2e` → empty both).

## Commands run

- `npm ci --no-audit --no-fund` → installed, exit 0 (local, no provider).
- `npx vitest run src/lib/server/spreadsheet src/lib/shared/spreadsheet test/integration/impor-spreadsheet.test.ts test/integration/impor-spreadsheet-qa.test.ts` → 11 files / 161 tests passed, exit 0 (fixtures, in-memory).
- Fail-before L5: reverted `xml.ts`+`xlsx-read.ts` to `4da075f`, ran `xlsx-cpu.test.ts -t "a dataValidation over 40 KB after"` → 1 failed (`{ok:false,error:'too_complex'}` vs expected `ok:true`), exit non-zero (fixtures).
- Fail-before L1: same revert, ran `xlsx-read.test.ts -t "allocates exactly one buffer"` → 1 failed (`TypeError: centralDirectory is not a function`), exit non-zero (fixtures).
- Restored fix (`cp` back from backup, `git status --short` clean vs 811eada) → `xlsx-cpu.test.ts` + `xlsx-read.test.ts` → 47 passed, exit 0.
- QA-written `src/lib/server/spreadsheet/qa-ac-extra.test.ts` (ac-a, ac-b probes below) → 4 passed, exit 0 (in-memory fixtures, not committed).
- `npm run gates` (check, lint, test, build) → svelte-check 2160 files/0 errors, prettier+eslint clean, **315 test files / 4574 tests passed**, Cloudflare adapter build `✔ done`, exit 0.

## Checked criteria (PRD acceptance criteria 1–7)

1. **PASS** — `dataValidation`/`conditionalFormatting`/self-closing `ignoredError` with >40 KB `sqref` after
   `<sheetData>` → `readXlsx` returns `ok:true` with correct rows. `xlsx-cpu.test.ts` "L5: a very long sqref"
   (`it.each` ×3) + `selection` in `sheetViews`, all passing in the full run.
2. **PASS** — an over-cap tag the reader uses (`<c>` huge attr, `<row>` huge attr, `<sheet>` name, long tag outside
   a worksheet part) still refuses `too_complex`. Same describe block, "an open tag past the cap on a tag the
   reader uses still refuses" + "outside a worksheet (styles.xml)" — passing.
3. **PASS** — 16 MB worksheet as one tolerated tag reads within the CPU bound. "a 16 MB worksheet that is one long
   `<dataValidation>` reads in linear time" — passing, and `xml.test.ts`'s "one 16 MB named tag scans in linear
   time" (<1000 ms) — passing.
4. **PASS** — `inflateEntry` allocates exactly one `entry.size` buffer, no chunk list, verified via `Uint8Array`
   constructor spy + `Inflate.prototype.push` spy: `made.length === 1`, `out.buffer.byteLength === entry.size`,
   round-trips the real bytes. Confirmed failing before the fix (`centralDirectory`/`inflateEntry` not exported)
   and passing after.
5. **PASS** — real size ≠ declared → `corrupt`, with every `Uint8Array.prototype.set` call proven to stay inside
   the declared size (no OOB write); per-entry/total/ratio caps still `too_large`, including when the header lies.
   `xlsx-read.test.ts` "inflateEntry: one preallocated buffer" suite — passing.
6. **PASS** — fail-before/pass-after shown above for both one AC1 (L5) and one AC4 (L1) test.
7. **PASS** — targeted vitest paths and `npm run gates` both clean (see Commands run).

## Task-specific checks

**(a) Early ratio pre-check cannot refuse a legitimate small-but-highly-compressible part below `RATIO_FLOOR`.**
`RATIO_FLOOR = 1 MiB`. The pre-check (`entry.size > RATIO_FLOOR && entry.size > entry.compressed * XLSX_MAX_RATIO`)
and the streaming check use the same gate, so any part whose *declared* size is ≤ `RATIO_FLOOR` skips the ratio
test entirely regardless of its real ratio — same as the pre-fix streaming-only behaviour. Verified directly:
900 KB of one repeated byte (ratio ≈ 500:1, well under the 1 MiB floor) inflates successfully via `inflateEntry`,
and a real `readXlsx` workbook whose worksheet part is padded with a 700 KB highly-compressible comment (still
under the floor once inflated) reads `ok:true`. Both in `qa-ac-extra.test.ts`, "QA ac(a)" — 2/2 passing.

**(b) A tolerated long tag nested inside `sheetData`, or carrying nested value-bearing children, cannot hide or
corrupt cell data.** `scanXml`'s `longTags` bypass only suppresses attribute parsing on the four named tags
(`dataValidation`, `conditionalFormatting`, `ignoredError`, `selection`); `readSheet`'s handler matches tags purely
by name with no real tree/stack, so opening/closing one of these four is a no-op for the cell state machine
(`row`, `col`, `cellType`, `capture`, `inline`) — it never resets or hijacks them. Verified by deliberately
misordering a worksheet: (1) a >32 KB `<dataValidation>` wraps a real `<row>` *inside* `<sheetData>` (adversarial,
not the documented real-Excel order) — the wrapped row's cell value (28000) is still read correctly, row count
unaffected; (2) a tolerated `<selection>` with a decoy nested `<v>999999</v>` sits between two real `<c><v>` cells
in `sheetViews` — both real cell values (111, 222) come back unchanged, the decoy value never leaks into either
cell. Both in `qa-ac-extra.test.ts`, "QA ac(b)" — 2/2 passing.

**(c) Fail-before re-run (one L5, one L1).** Done myself independently of the engineer's claim, by reverting
`xml.ts` and `xlsx-read.ts` to `4da075f` and re-running the two named tests — both failed as expected (see Commands
run), then restored and re-confirmed passing.

## Engineering checklist

Diff is parser-only (untrusted-input XML/zip reader): no D1, auth, access, sync, money-display, UI or i18n surface
touched. Checked the applicable items: "Bounded work" (scan stays linear, proven for 16 MB — item 3 above),
"Fail-before proof" (satisfied, item (c) above), "No real providers in tests" (all fixtures, no network/AI calls).
No violations found.

## Findings

None. No fabricated figures, no silent data loss, no OOB writes, caps still enforced, nesting stays balanced for
both self-closing and paired tolerated tags.
