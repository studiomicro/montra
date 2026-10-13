# Security report: fix-xlsx-memory-sqref (FN-17 L1, L5)

Scope: `git diff 4da075f..811eada`. Untrusted `.xlsx` parsing only: `src/lib/server/spreadsheet/xml.ts`
(`scanXml` `longTags`, `nameAt`) and `src/lib/server/spreadsheet/xlsx-read.ts` (`inflateEntry` preallocation,
`SHEET_LONG_TAGS`). Medium-tier narrow review, 2026-10-11.

## Verdict: PASS

No medium or high finding. No regression to the existing caps. One low finding is tracked below.

## What was attacked

### inflateEntry preallocation (xlsx-read.ts:168-216)

- **A lying declared size.** The pre-check (xlsx-read.ts:169-174) applies the per-entry cap (16 MB), the running
  total cap (50 MB) and now also the ratio cap to the *declared* size before `new Uint8Array(entry.size)`. To get a
  16 MB buffer, the central directory must claim at least about 168 KB of compressed bytes (ratio 100), and those
  bytes must exist inside the 5 MB file (`end > bytes.length` refuses). PoC: a 250 KB random part with declared
  size 16 MB allocates the buffer and is then refused `corrupt` (produced < declared).
- **Many entries each declaring 16 MB.** Any `Refused` from `part()` aborts the whole read (xlsx-read.ts:532-540,
  `readXlsx` catches once). So at most one lying buffer is allocated per read. Honest parts add to `state.total`
  only after success, and the pre-check uses `state.total + entry.size`. Overlapping central entries that point
  at one real compressed blob still stop at the 50 MB total, as before.
- **Write past the buffer.** The callback checks `next > entry.size` before `out.set` (xlsx-read.ts:200-202). The
  thrown `Refused('corrupt')` passes through fflate's `push` and is mapped to `corrupt` (xlsx-read.ts:208-211).
  `LimitHit` is checked first, so real output past a cap still answers `too_large`. No out-of-bounds write is
  possible: a typed-array `set` past the end would throw `RangeError`, which is also mapped to `corrupt`.
- **Central directory vs local header.** Only central sizes are used; the local header's size fields are ignored.
  PoC: a local header that lies (uncompressed size 5) still inflates to the exact central size. The method 0
  (stored) path is unchanged. It needs `compressed === size` and returns a subarray with no allocation.
- **Refusal codes.** Declared too big gives `too_large`. Real output that differs from the declared size gives
  `corrupt`. Real output past a cap gives `too_large`. These match the PRD.

### scanXml longTags (xml.ts:104-195)

- **Name tricks.** `x:dataValidation` is accepted, because `localName` strips one prefix. The reader never uses
  this tag's attributes, so this is harmless. Case variants (`DataValidation`), a double prefix
  (`a:b:dataValidation` gives `b:dataValidation`), a longer name (`dataValidationX`) and a name with no blank
  before a 16 MB attribute run are all refused `too_complex`. A tab after the name ends it correctly. A `/`
  directly after the name gives `dataValidation`, which opens with no attributes and is harmless.
- **The reader's own tags.** `row`, `c`, `v`, `is`, `t` and `rPh` are not in `SHEET_LONG_TAGS`. A long one still
  refuses. `longTags` is passed only to `readSheet`, never to workbook, rels, styles, sharedStrings or
  `[Content_Types]` (xlsx-read.ts:493).
- **Smuggling or mis-attribution.** A long tolerated tag emits only `open(name, {})` (plus `close` when
  self-closing). Any `<c ...>` text inside its quoted attributes is never emitted. A non-self-closing long
  `<selection>` around `<v>` inside a `<c>` behaves like a short unknown tag (PoC: cells `['5','7']` stay in
  place). An unclosed long `<selection>` before rows still reads. The scanner keeps no nesting stack and the
  reader keys only on its own tag names. Unbalanced unknown tags therefore had the same effect before the change.
- **Time.** Each tag is scanned once by the `end` loop, and `nameAt` stops at the name. A 16 MB part made of
  about 450 long `dataValidation` tags scanned in 66 ms. A 16 MB tag with no blank (refused) took 275 ms.
  Both are linear.
- **Budget.** `--budget.tags` runs before the long-tag branch (xml.ts:137). PoC: three long tags with budget 3
  throw `XmlBudgetError`.
- **Declaration check.** `hasDeclaration` still runs first on the whole part (unchanged).

## Findings

### L1 (low): a lying header can make one read allocate a zero-filled 16 MB buffer before refusing

xlsx-read.ts:189. Before the change, a header that declared 16 MB over small real output allocated only the small
real output. Now the reader allocates `entry.size` up front. To reproduce: build a zip with about 170 KB of
incompressible deflate data and set the central directory's uncompressed size to 16,777,216. `readXlsx` allocates
16 MB and then returns `corrupt`.

The cost is bounded: one buffer per read (the first refusal aborts the read), it needs at least 168 KB of real
compressed bytes, and it is no more than the peak an honest 16 MB part uses (now 1x instead of the old 2x). It
can only be exploited together with the request-level upload rate limits. No action is required. Optionally,
grow the buffer lazily or cap the preallocation for parts that are not yet proven.

**Resolution (2026-10-13): ACCEPTED.** The report says no action is required: one buffer per read, at least 168 KB of real compressed bytes, no more than an honest 16 MB part uses, and behind the per-user upload limits. Growing the buffer lazily would bring back the doubling copies whose peak this fix removed for every honest part.

**Follow-up "the returned grid keeps the `sharedStrings.xml` text alive (~9 MB)" (HISTORY): not reproduced, no change.** A probe in a fresh Node process with a real `gc()` (`node --expose-gc --import tsx`, scratchpad) read a workbook whose one 19-character cell came from an 8 MiB `sharedStrings.xml`: the returned workbook kept 29.7 KB alive (heap + external + ArrayBuffers), the same in three runs. A copy of each cell text made no difference, so it was not kept.

### Informational (pre-existing, unchanged)

- Close tags have no length cap (xml.ts:160-165). The cost is linear and bounded by the 16 MB part and the tag
  budget. This is not a regression.

## Engineering checklist

The diff adds no R2, D1, Queue or log writes for upload content ("No upload persistence" holds) and no
`console.*`. The work stays bounded ("Bounded work"). The exports `centralDirectory`, `inflateEntry` and the
`Entry`/`Inflation` types are for tests only and are server-side (`src/lib/server`), so no client bundle
exposure.

## Commands

- `npm ci --no-audit --no-fund`: exit 0
- Temporary PoC `src/lib/server/spreadsheet/zz-poc.test.ts` (7 tests): 7 passed, then the file was deleted
- `npx vitest run src/lib/server/spreadsheet`: Test Files 6 passed (6), Tests 85 passed (85)
