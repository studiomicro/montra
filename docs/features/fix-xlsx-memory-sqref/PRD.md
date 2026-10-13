# fix-xlsx-memory-sqref — FN-17 spreadsheet import lows L1 and L5

Source: `docs/features/fn-17-spreadsheet/SECURITY_REPORT.md` (L1 cycle 1, L5 cycle 2). Risk tier: Medium (existing
parser of untrusted input; no migration, auth, access or money logic).

## Symptom

- **L1 (memory):** reading one .xlsx peaks at about 78–88 MB (heap + ArrayBuffers, Node) for a 2.6 MB file with a
  16.7 MB `sharedStrings.xml` and a 16.7 MB sheet. The Workers isolate limit is 128 MB, and `SHEET_READ_LANE_MAX = 3`
  lets other requests hold their bytes at the same time.
- **L5 (refusal):** a real workbook whose `<dataValidation>`, `<conditionalFormatting>` or `<ignoredError>` open tag
  carries a `sqref` longer than 32 KB (heavily edited sheets) is refused as a whole with `too_complex`.
  Reproduced 2026-10-11 on `main` 4da075f: a sheet with a 48 595-character `sqref` on `<dataValidation>` →
  `readXlsx` returned `{"ok":false,"error":"too_complex"}`.

## Root cause

- L1: `src/lib/server/spreadsheet/xlsx-read.ts:172-191` (`inflateEntry`) collects fflate's output in `chunks[]`, then
  allocates `out = new Uint8Array(produced)` and copies every chunk. At the end both the chunks and the joined copy are
  live, so each inflated part is held twice. The UTF-8 decode that follows adds a third copy (the string).
- L5: `src/lib/server/spreadsheet/xml.ts:151` (`scanXml`) throws `XmlBudgetError` for any open tag longer than
  `XML_TAG_MAX_LENGTH` (32 KB), whatever its name. `xlsx-read.ts:500` maps that error to `too_complex`. The reader
  never uses the attributes of these tags.

## Fix scope

Touch only `src/lib/server/spreadsheet/` (`xml.ts`, `xlsx-read.ts`), their tests and `test/helpers/xlsx.ts`.

1. **L1:** in `inflateEntry`, inflate into one preallocated `Uint8Array(entry.size)`. `entry.size` is already checked
   against `XLSX_MAX_ENTRY_INFLATED` and the total. Each chunk is written into it at its offset, so no chunk list is
   kept. Keep every existing cap: per entry, total, ratio, `produced !== entry.size` → `corrupt`. A chunk that would
   go past `entry.size` is caught before the write: it gives `corrupt` (a lying header), or `too_large` if a cap is
   also hit. Keep the order of the cap checks so the existing boundary tests still hold. Also check whether the
   shared-strings array or the inflated part bytes can be released earlier, for example by dropping the reference to
   the part bytes once they are decoded. Do this only if it is simple and keeps behaviour. Do not change
   `SHEET_READ_LANE_MAX` or the inflate caps unless a measurement shows the peak is still above ~60 MB after the
   change. If you do change them, say so in the handoff as an owner-visible trade-off.
2. **L5:** let the caller of `scanXml` name tags whose oversized open tag is tolerated, for example an optional
   `longTags: ReadonlySet<string>` parameter or handler field. For such a tag past `XML_TAG_MAX_LENGTH`, do not parse
   its attributes, and call `open(name, {}, selfClosing)` (plus `close` if self-closing) so nesting stays balanced.
   Every other tag keeps the cap and still refuses. The worksheet scan passes `dataValidation`,
   `conditionalFormatting`, `ignoredError` and `selection` (`sqref` in `<selection>` too); no other part does.
   The tag budget, the declaration check and the quote-aware end scan stay as they are. Scan time stays linear in the
   input length, so a 16 MB part made of one huge tolerated tag must not be quadratic.

## Acceptance criteria

1. Given a worksheet with a `<dataValidation sqref="…">` open tag over 40 KB (ranges like `A1:B2 A4:B5 …`) after
   `<sheetData>` (real Excel order), when `readXlsx` runs, then it returns `ok: true` with the sheet's rows.
   Same for `<conditionalFormatting sqref="…">` and a self-closing `<ignoredError sqref="…"/>`.
2. Given an open tag over 32 KB on a tag the reader uses (e.g. `<c>` with a huge attribute, or `<sheet>` in
   `workbook.xml`), when `readXlsx` runs, then it is still refused `too_complex`.
3. Given a 16 MB worksheet that is one tolerated tag with a giant `sqref`, the read finishes within the existing CPU
   test bound (see `xlsx-cpu.test.ts`) and does not refuse for any reason except the existing caps.
4. Given a deflated entry, when it is inflated, then exactly one output buffer of `entry.size` bytes is allocated per
   entry and no chunk list is kept. Prove it with a unit test at the `inflateEntry` layer: export it for tests, or
   test it through an injectable/spy-able path. The test must fail on the current chunk-and-join code, for example by
   asserting the returned buffer's `byteLength === entry.size` *and* that its `buffer.byteLength === entry.size`
   (no oversized backing store), plus a counter or spy showing no second full-size allocation. Also record a
   before/after peak measurement for the report's 2.6 MB / 16.7 MB + 16.7 MB file (Node,
   `process.memoryUsage().heapUsed + arrayBuffers`) in the handoff.
5. Given an entry whose real inflated size is larger or smaller than its declared size, then the result is still
   `corrupt`. Given one past the per-entry, total or ratio cap, then it is still `too_large`, with no write past the
   preallocated buffer.
6. Regression tests for AC 1 and AC 4 fail with the fix reverted and pass with it (record both runs).
7. Existing tests still pass: `npx vitest run src/lib/server/spreadsheet src/lib/shared/spreadsheet
   test/integration/impor-spreadsheet.test.ts test/integration/impor-spreadsheet-qa.test.ts`, then `npm run gates`.

## Out of scope

L2 (dedupe-key collision above 2^20 rows) and any other FN-17 finding; UI, copy, i18n; the AI mapping step.

## Owner decisions

None expected. A change to `SHEET_READ_LANE_MAX` or the inflate caps would be one (see Fix scope 1).
