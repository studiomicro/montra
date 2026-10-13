# Security review: fn-17-spreadsheet (cycle 1)

**Verdict: PASS after cycle 2 re-check** (cycle 1: FAIL on M1, medium; M1 fixed at ed847fd, no medium or high remain; see "Re-check (cycle 2, ed847fd)" at the end)

Reviewed `git diff 6093a3f..463f7f1` (QA cycle 1 PASS), against `docs/ENGINEERING_CHECKLIST.md` and the PRD.

## Findings

### M1 (medium): crafted .xlsx pins the Worker CPU; the XML tag budget does not bound it

- `src/lib/server/spreadsheet/xml.ts:64-72` (`parseAttrs`): `/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g` runs over each open tag's
  attribute area. When a long run has no `=` (`<x aaaa…/>`), every start position scans to the end and then backtracks. The cost is
  super-quadratic in the tag length. The whole tag costs **one** unit of `XML_TAG_BUDGET`.
- `src/lib/server/spreadsheet/xlsx-read.ts:207-220` (`isDateFormat` / `isForeignFormat`): `\[[^\]]*\]` and
  `\[\$([^\]-]*)…\]` are quadratic on an unclosed `[[[[…` / `[$[$…` format code. Also, `readStyles` (`:238-243`) runs both
  regexes again for **every** `<xf>`. No cache and no length cap on `formatCode` (Excel caps it at 255 characters), so
  N `<xf>` × a long format code is amplified even with linear regexes.
- Nothing caps a tag's length. Parts under `RATIO_FLOOR` (1 MB) have no ratio check, so a tiny compressed file can carry these
  runs.

Measured locally (Node 26, same V8 regex engine as workerd), calling `readXlsx` on files built with `test/helpers/xlsx.ts`:

| Payload | File size | `readXlsx` time | Result |
| --- | --- | --- | --- |
| sheet `before`: `<x ` + 80 000 × `a` + `/>` | 2 115 B | 4 701 ms | ok |
| same, 10 such tags in one sheet | 2 883 B | **73 064 ms** | ok |
| styles `formatCode` = 40 000 × `[` | 1 907 B | 11 296 ms | ok |
| styles `formatCode` 20 KB × 300 000 `<xf>` (+ 90 KB random comment to stay under the 100× ratio) | 109 465 B | 15 914 ms | ok |

Exploit: a signed-in user posts the 2.9 KB file to `?/previewSheet` (or `suggestMapping` / `importSheet`). The reader is
synchronous, so the request runs until the Worker's CPU limit kills it. No `cpu_ms` is set in wrangler, so the default applies.
Other requests on that isolate, including the other two spreadsheet-lane slots, fail with it. The `spreadsheet-upload` limit allows 30 tries per window per account, and accounts are cheap. This contradicts the reader's own
contract ("XML_TAG_BUDGET tags in all parts (the CPU bound)", `xlsx-read.ts:28`) and PRD AC 9 ("reader CPU/time is bounded …
abort after a work budget"). The current tests cover tag counts only.

Fix: make the work budget count characters, not just tags. Options:
- refuse an open tag longer than a small cap (e.g. 64 KB) as `too_complex`;
- replace `parseAttrs` with a linear hand scan, or anchor it (`y` flag with a leading `\s*`) so a failed match ends the loop;
- cap `formatCode` (e.g. 255 characters, else treat it as "not a date / not foreign" or refuse);
- compute `isDateFormat` / `isForeignFormat` once per `numFmtId`, not per `<xf>`.

Add a regression test with the 10 × 80 000 `a` payload asserting `too_complex` (or completion) under a wall-clock bound.

### L1 (low): peak memory per read is a large share of the 128 MB isolate limit

`xlsx-read.ts:146-192`, `:462`. For one 16 MB part, the inflated chunks, the joined copy and the decoded string are all live at
once. The shared-strings array (≤ 16 MB of text) stays live through every sheet read. A 2.6 MB file with a 16.7 MB
`sharedStrings.xml` (2-byte UTF-8) and a 16.7 MB sheet peaked at about 78–88 MB (heap + ArrayBuffers, Node). `readXlsx`
is synchronous, so two reads never peak together. But `SHEET_READ_LANE_MAX = 3` lets two more requests hold their bytes, form
copies and parsed grids at the same moment. The 50 MB `XLSX_MAX_TOTAL_INFLATED` leaves little headroom. Suggest:
- inflate straight into a preallocated `Uint8Array(entry.size)` (sizes are already checked), not chunks plus a copy;
- lower `XLSX_MAX_ENTRY_INFLATED` / `XLSX_MAX_TOTAL_INFLATED`, or keep a lane of 1–2.

### L2 (low): dedupe-key collision across tabs for row numbers above 2^20

`src/lib/shared/spreadsheet/rows.ts:173` keys a row `tab * TAB_KEY_STRIDE + row.r`. `xlsx-read.ts:375-376` accepts any increasing
`<row r>`, including above 1 048 576, so a crafted file can map tab 0 row 1 048 577 onto tab 1 row 1. The colliding row is skipped
as already imported, and `preview` reports a wrong tab or row. Only the uploader's own import is affected (integrity, not
access). Refuse or ignore `r > 1 048 576` in the reader.

**Resolution (2026-10-13): already fixed in cycle 2 (see the re-check table).** `readSheet` refuses `<row r>` above 1,048,576 as `corrupt` and `TAB_KEY_STRIDE = SHEET_MAX_ROW + 1`. Test: `xlsx-cpu.test.ts` "a `<row r>` above 1,048,576 is refused; the last Excel row is read". No further change.

### L3 (low): AI sample cells are not masked for account or card numbers

`src/lib/shared/spreadsheet/layout.ts:338-354` (`sampleRows`, `headerTexts`) uses `cleanText` only. `ai-mapping.ts:100-103` sends
these cells to Anthropic. A sample with a full account or card number leaves the server unmasked. The call uses the user's own key,
gateway logging is off (`cf-aig-collect-log: false`) and the PRD says "numbers shown as-is", so this is low. Still, apply
`maskAccountNumbers` to text cells in `mappingPrompt`: it does not change column-role detection. This matches the checklist
"Masking" rule.

### L4 (low): lane slots can be held by slow uploads

`spreadsheet.server.ts:87-99` reserves the per-isolate lane (3 slots) before `readFormBody` (60 s total, 15 s idle) and holds it
through the AI call (30 s). Three accounts trickling bytes can make the isolate's reader answer 503 for others. Same design as the
statement lane, so only tracked here.

### Informational (no action needed)

- Macro refusal is name-based (`vbaProject.bin`, `macroEnabled` content type). A renamed macro part would not be refused, but
  the server never reads or executes it and the file is never stored. Harmless.

## Checked and holding

- **Zip bomb:**
  - Declared sizes are checked first, then the real output is counted while streaming (`Inflate`, 4 KB input steps).
  - Per-entry cap is 16 MB, total cap is 50 MB, ratio cap is 100× past 1 MB, and a lying size is refused.
  - At most 1 000 entries; ZIP64 is refused (`0xffff` / `0xffffffff`); the encrypted-entry flag is refused.
  - Only fixed part names are inflated. Duplicate names: the last entry wins, but every inflation still counts against the
    total. Several sheets pointing at one part are still bounded by the total. Path traversal does not apply: nothing is
    written, and `worksheetPart` allows only `xl/worksheets/<name>.xml`.
- **XML:**
  - DOCTYPE, ENTITY, ELEMENT, ATTLIST and NOTATION are refused anywhere, case-insensitive. Any other `<!` is refused.
  - Only the 5 predefined entities and numeric references are decoded, and an unknown entity is kept literal. No billion
    laughs, no XXE, nothing fetched.
  - `decodeXmlText`, `columnOf`, `unescapeOoxml` and `hasDeclaration` are linear.
- **Grid:**
  - Cells are stored only as they occur. `XFD1048576`, or any column ≥ 50 with a value, is refused `too_many_columns`.
  - A huge `<dimension>` or row number allocates nothing.
  - A huge shared-string index resolves to an empty cell. 200 000 shared strings max; 256 characters per cell.
- **Formulas:** `<f>` is ignored, and only the cached `<v>` is used. External links, drawings and macros are never inflated, and
  relationships with `TargetMode="External"` are dropped.
- **Refusals:** `.xls` (OLE magic) gives legacy; OLE with `EncryptedPackage` gives encrypted; `.xlsm`, `vbaProject.bin` or the
  `macroEnabled` content type gives macro. Extension pre-checks happen before any read.
- **AI mapping:**
  - The call goes out only when the user presses the button and the tab is in `unmapped`.
  - The model gets the tab name, the header and at most 5 samples. Every cell goes through `cleanText`, capped at 60
    characters, and the prompt holds at most 50 columns.
  - The key is resolved server-side and goes only into the `x-api-key` header. Page data gets booleans only.
  - The output is checked with a strict zod schema plus grid checks (index range, single roles, `columnsIssue`), and
    `headerRow` is looked up through server-held `rowNumbers`.
  - Injected cell text can at most pre-fill a wrong mapping, which the user then reviews. Import recomputes from the
    bytes and the zod-validated mapping (`fitMapping`).
  - Other settings: `redirect: 'manual'`, gateway URL from env, 30 s timeout, capped body reads, gateway cache and logs off.
    The `spreadsheet-ai` limit is 10 per window.
- **Authorization:**
  - Every action uses `currentSpaceScope` (session space; the space id is never taken from the client).
  - The wallet comes from `getWallet(spaceId, id)` and is re-checked in SQL by `refsHold`, which also checks space,
    currency and that the wallet is not deleted.
  - Categories come only from the space's visible list. Batches and dedupe keys are per space.
  - Both roles (owner and member) may import, as with CSV. No new IDOR surface.
- **`createMissing:false` / `allowNoCategory`:**
  - `createMissing` defaults to `true`, so the CSV and statement paths are unchanged.
  - `allowNoCategory` is set only in the spreadsheet branch (`csv-import.ts:462,478`). No other `insertTransactions` caller
    sets it, and it is never built from client input.
  - The SQL bypass needs both `noCategory = 1` and `categoryId is null`. A named category is still checked for space, kind,
    hidden and deleted.
  - Manual entry calls `capturedTransactionInput` without options, so a category is still required.
- **No storage or logging:**
  - The bytes stay in memory. The D1 batch row keeps only the filename after `cleanText` + `maskAccountNumbers`.
  - Dedupe keys hold a 128-bit file hash prefix, the same pattern as CSV.
  - The only log is a fixed line plus `errorLabel` (error names only). The diff writes nothing to R2 or KV.
  - Titles and categories pass through `maskAccountNumbers` (`rows.ts:94`). The UI has no `{@html}`.
- **Re-export:** the diff adds none. Imported titles flow into the existing `csv-export.ts`, which guards formula prefixes.
- **Throttles:**
  - `spreadsheet-upload` is counted before the body is read (30 per window, fail-closed).
  - `readFormBody` caps the body at 5 MB + 128 KB, with a 60 s total and 15 s idle timeout.
  - `overTransactionCreateLimit` is checked before import. The lane allows 1 read per user and 3 per isolate.

## Commands run

- `git diff --stat 6093a3f..463f7f1` and file reads of the changed server, shared and UI files.
- `node re.mjs` (scratchpad) gave the regex timings, for example `attrs a* 40000 7783 ms`, `isDate [* 40000 3443 ms` and
  `isForeign [$* 40000 3316 ms`.
- `node_modules/.bin/tsx <scratchpad>/cpu.ts`, `cpu2.ts`, `styles.ts`, `styles2.ts` gave the M1 table above.
- `node --expose-gc node_modules/.bin/tsx <scratchpad>/read.mts` (2.6 MB, 33 MB inflated) gave
  `ok peak heap+ab MB 78`. Under `--max-old-space-size=64` it gave `ok … 88`.
- Probe scripts were deleted afterwards. No source changed and no process is left running.

## Re-check (cycle 2, ed847fd)

**Verdict: PASS** (no medium or high finding remains; one new low note, L5)

Reviewed `git diff a56c53e..ed847fd` only (7 files). Gates were accepted from the engineer and not rerun.

| Finding | Status | Evidence |
| --- | --- | --- |
| M1 (medium) | **Fixed** | See below. |
| L2 (low) | **Fixed** | `readSheet` refuses `rowNumber > SHEET_MAX_ROW` (1 048 576) as `corrupt`, for both an explicit `r` and an implied next row. `TAB_KEY_STRIDE = SHEET_MAX_ROW + 1`, so `tab * stride + row` cannot name another tab's row. Excel's last row is still read. Stride is only used in `rows.ts`; keys of unreleased CSV/statement paths are unaffected. |
| L3 (low) | **Fixed** | `ai-mapping.ts` `cell()` = `cleanText(maskAccountNumbers(text), 60)`. Masking runs before truncation, so a long number cannot be cut into an unmasked piece. Applies to the tab name, header and sample cells (all go through `cell`). Dates and dot-grouped amounts stay readable (test `mappingPrompt masks account and card numbers`). |
| L1 (low) | Open, unchanged | Not in this fix cycle. Peak memory about 78-88 MB per read. |
| L4 (low) | Open, unchanged | Same design as the statement lane. |
| L5 (low, new) | Open, optional | See below. |

### M1 detail

- `parseAttrs` is now a hand scan. Every loop pass advances `at` (a stray `=`, a name with no `=`, or a non-quote value all move forward), and each `indexOf` for a closing quote is followed by a jump past it, or by `return` when none exists. Linear in the tag length.
- `scanXml` refuses an open tag over `XML_TAG_MAX_LENGTH` (32 KB) as `XmlBudgetError`, mapped to `too_complex`. The `>`-finding loop is one forward pass, and the next search starts at the tag end, so total scan stays linear in the part size (bounded by the 16 MB / 50 MB inflate caps).
- `isDateFormat` / `isForeignFormat` now use `splitFormat`: one pass; an unclosed `[` or `"` sets a flag so it is searched for once, and a closed one jumps past its close. No regex is left on the format code except fixed-prefix tests over the short remainder. Classification is unchanged for normal codes (same results on the existing and new test cases).
- `readStyles` classifies each `numFmt` once when declared (`formats: Map<id, {date, foreign}>`) and an `<xf>` only looks it up. `formatCode` over 512 characters or more than 2000 formats refuse the file as `too_complex`.
- Regex audit of `src/lib/server/spreadsheet/*.ts` (non-test). All are linear or run on bounded input:

| File:line | Regex | On | Verdict |
| --- | --- | --- | --- |
| `xml.ts:51` | `&(#x[0-9a-fA-F]{1,6}\|#\d{1,7}\|[a-zA-Z]{2,4});` | attribute and text values | bounded quantifiers, at most about 9 characters per `&`: linear |
| `xml.ts:98` | `<!(?:DOCTYPE\|ENTITY\|...)` /i | whole part | literal prefix: linear |
| `xml.ts:132` | `/&/g` | CDATA | linear |
| `xml.ts:159` | `/\s/` (search) | one tag, at most 32 KB | linear |
| `xlsx-read.ts:209` | `_x([0-9A-Fa-f]{4})_` | cell text (kept to 8 x 256 chars) | fixed width: linear |
| `xlsx-read.ts:256,266,268` | `[dy]`, `^(?:rp\|idr)`, `[$€£¥]\|"(?:usd\|...)` | `splitFormat` output, code at most 512 | no nesting: linear |
| `xlsx-read.ts:345` | `^([A-Z]{1,3})\d*$` | a cell `r` attribute | anchored, `{1,3}`: linear |
| `xlsx-read.ts:487` | `^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$` | part name (zip name, at most 64 KB) | anchored, one start: linear |
| `xlsx-read.ts:530` | `macroEnabled` /i | content-types part | literal: linear |
| `validation.ts:51-53,62-64` | `\.(?:xls\|...)$` | file name | literal alternation: linear |
| `validation.ts:93,94,104,123,161` | `^tab\.(\d{1,3})...$`, `^\d{1,7}$`, `^\d{1,3}$` | form field names and values | anchored, bounded: linear |

  `ai-mapping.ts`, `import.ts` and `messages.ts` have none. The new `maskAccountNumbers` call (shared `text.ts`) now runs on cells of at most 256 characters, so even a non-linear mask regex could not be amplified.

- Timing (Node 26, `readXlsx`, scratchpad probe `tsx`, wall clock). The cycle 1 repros now end at once:

| Payload | Cycle 1 | Now |
| --- | --- | --- |
| 10 x (`<x ` + 80 000 `a` + `/>`) | 73 064 ms | 13-45 ms, `too_complex` |
| 1 such tag | 4 701 ms | 3-7 ms, `too_complex` |
| `formatCode` = 40 000 x `[` | 11 296 ms | 1-4 ms, `too_complex` |
| 300 000 `<xf>` + 20 KB format code | 15 916 ms | 27-85 ms (refused by size/ratio before it matters; the cap would refuse it too) |
| 140 random tags of 32 KB (no `=`; `x=` soup; 2 000 valid attributes each) | n/a | 150-470 ms including building the zip, `ok` |
| 2 000 formats x 512 chars + 60 000 `<xf>` | n/a | 93 ms, `ok` |

  Highly repetitive payloads over 1 MB are stopped earlier by the 100x ratio cap (`too_large`), so the probes above use random text to get past it.

- Legitimate files: 512 characters is twice Excel's own 255 format-code limit; 2 000 is far above Excel's 250 or so custom formats; 32 KB is far above any attribute set Excel or Google Sheets writes for `c`, `row`, `xf`, `numFmt`, `sheet`, `col`. Existing and QA fixtures (including the generated 3 000-row file and the custom-date / foreign styles) pass.

### L5 (low, new, optional): a very long `sqref` can refuse a real file

`xml.ts` `XML_TAG_MAX_LENGTH` applies to every open tag in a sheet, including `conditionalFormatting`, `dataValidation` and `ignoredError`, whose `sqref` Excel can write as thousands of cell ranges in heavily edited workbooks. Over 32 KB (roughly 3 000+ ranges) the whole file is refused as `too_complex`, with a message the user can act on (re-save a trimmed copy). It is a fail-closed usability edge, not a security issue. If real files hit it, raise the cap for `sqref`-carrying tags or skip such tags instead of refusing.

### Commands run (cycle 2)

- `git diff a56c53e..ed847fd` (7 files) and file reads of `xml.ts`, `xlsx-read.ts`, `ai-mapping.ts`, `text.ts`.
- `npx vitest run src/lib/server/spreadsheet src/lib/shared/spreadsheet test/integration/impor-spreadsheet.test.ts test/integration/impor-spreadsheet-qa.test.ts`: 10 files, 141 tests, all pass.
- `npx tsx <scratchpad>/probe.mts`, `probe2.mts` (timings above). Scripts stay in the scratchpad, outside the repo. No source changed.
