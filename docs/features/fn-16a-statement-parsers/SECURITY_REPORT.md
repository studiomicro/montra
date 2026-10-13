# FN-16a statement parsers: security report (red team, cycle 1)

Reviewed: `git diff main...fn-16a-statement-parsers` (HEAD 995874a) in a detached worktree. No source edits.
Probes were written as a temporary Vitest file of fictional, code-generated PDFs, run with
`npx vitest run --maxWorkers=2` under the heavy lock, then deleted.

## Verdict: FAIL

The upload path's decompression cap (PRD criterion 13, owner decision B) can be bypassed in at least five ways.
A file of about 300 KB makes PDF.js inflate 300 MB in memory, which is over the Worker's 128 MB limit. Any
signed-in user can do this. The PDF read runs on every statement upload, even though `STATEMENT_PARSERS` is
still empty.

## Findings

### H1 (high): the Flate budget scanner disagrees with PDF.js, so a zip bomb is "measured ok"

`src/lib/server/statements/pdf-streams.ts:94` (`filtersOf`), `:114` (`marker`), `:26` (`DICT_WINDOW`).
The scanner reads the PDF with regexes. PDF.js reads it with a real lexer. Each shape below returned
`{status:'ok', unmeasured:false}`, then `extractPdfText` returned `ok` with the page text. PDF.js had inflated
the whole stream. The test used an 80 MB to 300 MB stream of spaces behind one line of text. With a 300 MB
stream, the file was 306 KB and the probe measured a peak of about 651 MB (heap + ArrayBuffers).

1. **Hex-escaped filter name**: `/Filter /Flate#44ecode`. The regex `\/[A-Za-z0-9]+` stops at `#` and yields
   `Flate`, which the scanner skips as "not Flate". PDF.js decodes `#44` to `D`, so it sees `FlateDecode`.
   The same trick works for `/LZW#44ecode` and `/RunLength#44ecode`, which the scanner is meant to refuse.
2. **Comment between `>>` and `stream`**: `>>\n%c\nstream`. The marker regex `>>\s*stream` misses the
   stream, but PDF.js skips the comment and reads it.
3. **Nested dictionary first**: `/DecodeParms << /Filter /None >> /Filter /FlateDecode`. The first regex
   match is the nested `/None`.
4. **`/Filter` more than 4 KiB before `stream`**: `/Filter /FlateDecode /Pad (xxxx…5000…)`. The filter falls
   outside `DICT_WINDOW`.
5. See H2.

Repro: put any of the dictionaries above around `deflateSync(Buffer.alloc(300<<20, 0x20))` as page content.
Upload it to `/impor?/previewStatement` and the Worker exceeds its memory limit. When an isolate runs out of
memory, Cloudflare drops every in-flight request in that isolate, including other users' requests. There is no
rate limit on the statement actions, so the attack can be repeated freely.

Fix direction: do not try to reproduce PDF syntax with regexes. Enforce the budget where the bytes are inflated.
One way is to wrap or patch PDF.js's `FlateStream`, `LZWStream`, `RunLengthStream` and `PredictorStream`
`ensureBuffer`/`readBlock` with a shared byte counter that throws past the cap. That is "enforced during
extraction" as the PRD asks. It would also cover encrypted files, object streams, inline images and filter
chains. A cheaper fallback would mean normalising `#xx` names, skipping comments, matching dictionary depth and
dropping the window. It would still be fragile.

### H2 (high): an encrypted PDF skips the budget entirely, and the attacker chooses the password

`src/lib/server/statements/pdf-streams.ts:132` and `src/lib/server/statements/pdf-text.ts:133-134`.
In an encrypted file, Flate streams that fail to inflate are marked `unmeasured`. The file is then accepted
when PDF.js reports `EncryptFilterName`. An attacker can encrypt the file with RC4 and an empty user password.
PDF.js opens it without asking for a password, and the file is genuinely encrypted, so the check passes.

Repro: `buildPdf([{content: 300 MB of spaces, flate: true}], {password: ''})` from `test/helpers/pdf.ts` gave
`{"status":"ok","unmeasured":true}`, then `ok` with the page text. The file was 307 KB and peak memory was
about 680 MB.

The engineer report lists this as a residual risk "bounded by the deadline and the 128 MB limit". That is not a
bound. The deadline is wall-clock time and can only fire between awaits, and running out of memory is the
failure itself. The H1 fix (counting inside PDF.js after decryption) closes this as well.

### M1 (medium): text amplification through a reused Form XObject uses a lot of CPU before any cap fires

`src/lib/server/statements/pdf-text.ts:143-150`. `maxTextChars` is checked only after `getTextContent()`
finishes a whole page. In the probe, a 3.2 KB file had a Form XObject with about 2 KB of text, drawn 60,000
times by `/X1 Do` in a 2 KB compressed content stream. It took 13.8 s of CPU before returning `too_complex`.
With 20,000 draws it took 4.5 s. Time grows linearly with the number of draws, so a few hundred thousand draws
(still a tiny file) passes the Worker CPU limit. The text items held for that one page also grow without a
bound. No 40 MiB cap applies, because nothing large is decompressed.

Fix direction: stream the text with `streamTextContent()` or the reader of `getTextContent`, count characters
and items while they arrive, and cancel past the cap. Add a per-user rate limit on the statement actions too.

### L1 (low): a timeout during loading leaves the PDF.js loading task alive

`src/lib/server/statements/pdf-text.ts:127-128`. When the deadline beats `getDocumentProxy`, `doc` stays null,
so `finally` never calls `loadingTask.destroy()`. Parsing continues in the same isolate after the 400 response.
Calling `getDocument` directly (from `getResolvedPDFJS()`) keeps the task, so it can be destroyed on timeout.

### L2 (low): a 15 MB upload is copied several times (memory headroom)

`readCapped` body, then the `FormData` File, then `arrayBuffer()` in `validation.ts`, then `bytes.slice()` for
PDF.js, plus a windows-1252 string of the whole file in `measureFlateStreams` (about 30 MB of UTF-16). A
legitimate 15 MB PDF uses about 90 MB before PDF.js allocates anything, close to the 128 MB limit, and two
concurrent uploads in one isolate would exceed it. Consider dropping references early, or lowering the cap to
what bank statements actually need.

## Checked, no finding

- **PDF.js version / font code execution**: unpdf 1.8.1 bundles PDF.js **6.1.200** (`apiVersion` in
  `node_modules/unpdf/dist/pdfjs.mjs`). CVE-2024-4367 was fixed in 4.2.67. The bundle has no `new Function` or
  `eval`, because glyphs are compiled to command arrays and `isEvalSupported` no longer exists in 5.x/6.x.
  `disableFontFace: true`, `useSystemFonts: false` and `verbosity: 0` are set. Runtime WebAssembly compilation
  (the PostScript functions) is refused by workerd and falls back to the interpreter. No
  `cMapUrl`/`standardFontDataUrl`/`wasmUrl` is set, so there is no fetch and no SSRF.
- **Authorization**: both statement actions take the space from `currentSpaceScope(locals)` and never from the
  form. `fallbackWalletOf` checks the wallet in that space before the file is read, and another space's id gets
  the same answer as a missing one. The batch insert is gated by `isLiveMember`. The `institution` field is
  allow-listed against `STATEMENT_PARSERS`.
- **Dedupe key**: `statement:<128-bit SHA-256 of the bytes>:<row index>`, computed on the server. The unique
  index is `(space_id, source, dedupe_key)`, so a forged key cannot reach another space. Tombstones count, so a
  deleted row is never recreated.
- **Password**: zod-capped at 128 characters, passed only to PDF.js, and never logged, stored or returned.
  `statementFailure` does not echo it. The field is `type=password autocomplete=off`. PDF.js's
  `PasswordException` carries no secret.
- **Error messages**: refusals are fixed i18n strings. `hints` hold only format, page count, column count and
  whether the file is a Montra CSV, with no content. D1 errors are logged with `errorLabel` only. No new
  `console.*` calls in the server code.
- **Header/MIME spoofing**: the file kind comes from magic bytes only. The browser MIME type and the file
  extension are ignored. A `%PDF-` inside a CSV header is sent to the PDF path and refused as corrupt.
- **Body limits**: `readFormBody` streams with a cap (15 MB + 64 KiB), an overall timeout and an idle timeout
  before multipart parsing. `file.size` is checked again afterwards. The statement CSV path is still bounded by
  `CSV_MAX_ROWS` and `CSV_MAX_COLUMNS`.
- **Upload persistence**: no R2, D1 or log writes of bytes or text. The filename is cleaned and masked. Row
  title, notes and wallet name go through `cleanText` and `maskAccountNumbers`. No `{@html}` in
  `+page.svelte`.
- **CSV injection on later export**: statement rows are exported through the existing shared formula guard
  (`src/lib/shared/csv.ts:408-430`, covering `=`, `+`, `-`, `@`, tab and CR), which is unchanged.
- **FN-18 refactor**: `importCsv` still checks the wallet before parsing, and still re-parses the uploaded text
  on the server (it never trusts rows sent by the client). Same validator, same `db.batch`, same
  `isLiveMember`. `alreadyImported` is now scoped by `source` as well as by space and key prefix, and the range
  bounds are unchanged. No weakening found.
- **Compat harness** (`scripts/compat-statements.ts`): Node-only and outside `src/`, so the app cannot import or
  call it. It runs `assertLocalOnly`. The password comes from the environment, not argv. It prints counts, typed
  reasons and a masked 24-character folder name, never file names or row text. `readdirSync` with
  `isFile()` does not follow symlinks. `.superpowers/` is git-ignored.

## Engineering checklist

- Untrusted text: met (cleaned and capped).
- No upload persistence: met.
- Bounded work per request: **not met** (H1, H2, M1).

## Re-check (cycle 2): head 976e7f9

Read: `git diff 995874a..976e7f9`, ENGINEER_REPORT "Cycle 2". Probes used fictional, code-generated PDFs and were deleted.
Node probes ran with `npx vitest run --maxWorkers=1` under the heavy lock: 17/17 passed (these are measurement probes,
not assertions). A workerd run used the repo's `workerd` binary with a probe Worker bundled through `patchPdfjs`,
measuring process VmHWM (peak RSS). One fresh process was used per file and every process was killed afterwards.
`vite build` exited 0. The patched chunk `.svelte-kit/output/server/chunks/pdfjs.js` contains `__finCharge` at
`ensureBuffer` and the native loop, 4× `__finNoImage`, and `financerDecodeBudget`. `/impor` imports that chunk.

### Verdict (cycle 2): FAIL

| Cycle 1 item | Status |
| - | - |
| H1 regex pre-scan bypasses | Fixed in Node: all four shapes give `too_complex` in about 0.1 s. In workerd they are refused too, but see N1 |
| H2 empty-password RC4 | Fixed in Node (`too_complex`, 99 ms) |
| M1 XObject amplification | Improved: 300,000 draws gives `too_complex` in 3.0 s (Node) or 3.9 s (workerd). The per-chunk caps work |
| L1 loading task left alive | Fixed: `task.destroy()` runs in `finally` |
| L2 copies | Improved: zero-copy hand-off, and the hash is computed before the read. Nothing reads `bytes` after the PDF read (checked `read.ts`, `statement-import.ts`, the route and the harness) |

### New findings

**N1 (high): in workerd the budget does not bound memory, and one Brotli case is not refused at all.**
Peak RSS of the workerd process. The baseline is about 85 MB, and an honest text PDF stays at 86 MB.

| File (fictional) | Size | Result | Peak RSS |
| - | - | - | - |
| Flate stream of about 30 MB (under the cap) | 31 KB | too_complex | 149 MB |
| `/Flate#44ecode`, 300 MB | 306 KB | too_complex | **434 MB** |
| comment gap, 300 MB | 306 KB | too_complex | **435 MB** |
| `/BrotliDecode`, 300 MB | 1.1 KB | **ok (read)** | **687 MB** |
| `/Contents` array, 50 references to a 30 MB stream | 31 KB | too_complex | **1,645 MB** |
| Form XObject, 300,000 draws | 5 KB | too_complex | 204 MB |

The verdict on each file is right except Brotli, but memory is not bounded before allocation. Two causes are
likely. First, workerd's native `DecompressionStream` produces output eagerly: the charge in the `for await` loop
runs only after chunks already exist, so the stream inflates past the cap before the throw. Second, the Brotli
path appears to finish in workerd without hitting either charge point. In Node the same Brotli file was
`too_complex`. So the Node regression tests, and the engineer's workerd timing table, do not show the
production memory behaviour. Miniflare and workerd locally enforce no 128 MB isolate limit, so "the isolate
survived" is not evidence.

Fix direction: do not use the native path while a budget is set. Make
`asyncGetBytesFromDecompressionStream` return `{decompressed: null}` at once, so PDF.js uses its JS decoders,
which grow only through the charged `ensureBuffer`. Also bound the JS Brotli ring buffer. Then add a workerd
regression that asserts peak RSS, not only the verdict.

**N2 (medium): one PDF read per isolate, with an unbounded queue taken after the body is read, lets one tenant
stall others.** In `pdf-text.ts`, `exclusive()` has no depth limit and no wait timeout. A request reads its
whole body (up to 15 MB) before it joins the queue. Each queued read can take up to the 15 s deadline. The
per-user throttle (30 per 10 minutes, fixed window, so a burst of up to 60 across a window boundary) still lets
one account hold the lane for minutes. Other users' uploads in that isolate wait behind it while their bodies
stay in memory. `await task.destroy()` has no timeout, so a destroy that never settles would block the lane for
the isolate's lifetime. Fix: cap the queue depth and per-user in-flight reads, check them before reading the
body (answer 503 with Retry-After), and put a timeout on `destroy()`.

**N3 (low): the patch's fail-closed behaviour depends on the module path.** If unpdf moves `dist/pdfjs.mjs`,
the plugin silently skips the transform. The runtime check then refuses every PDF, so it fails closed, which
is acceptable. Tests would catch it.

### Checked, no new finding
- Throttle: counted per user before the body is read. D1 errors fail closed (`failClosed` covers
  `statement-upload`). 429 is answered with a fixed message.
- Build vs dev vs test: the plugin is applied in vite (`ssr.noExternal`), in vitest (`deps.inline`) and in the
  harness (`registerHooks`), and every anchor must match exactly once.
- Detached buffer: no later read was found.

## Re-check (cycle 3): head 69a5a30

Read: `git diff 976e7f9..69a5a30` and the ENGINEER_REPORT "Cycle 3" section. Runs, each under the heavy lock:
- `npm run test:pdf-workerd`: `pdf-bound-workerd: all passed`, with 16 files, each in a fresh workerd process.
- `npx vitest run --maxWorkers=2` on `pdf-text.test.ts`, `pdfjs-bounded.test.ts` and
  `impor-statements.test.ts`: 3 files, 52 tests, all passed.

No workerd processes were left running.

### Verdict (cycle 3): PASS (low findings only)

**N1 (workerd memory): fixed.** All three cycle-2 shapes are now `too_complex` in workerd, with peak RSS growth
well under 128 MB:

| Shape | Peak growth | Cycle 2 peak RSS |
| - | - | - |
| `#44` 300 MB | 10.4 MiB | 434 MB |
| Brotli | 0.2 MiB | 687 MB (was read OK) |
| 50-reference contents array | 11.2 MiB | 1,645 MB |

The other bombs in the harness also stay at or below 13 MiB, and Form XObject × 300,000 at 23 MiB. The
honest cases still read: a plain 3-page statement, a password-protected file, and a file with a declared
60000×60000 JPEG logo.

What the patch does, and why the other shapes the coordinator listed are covered (from reading
`scripts/pdfjs-bounded.ts` against PDF.js 6.1.200):
- **Allowlist hook.** The allowlist runs in `Parser.makeFilter`. PDF.js calls this once per filter, after the
  lexer has decoded `#xx` name escapes and after indirect objects are resolved. So a filter array that mixes
  allowed and disallowed filters, an indirect `/Filter`, and an escaped name are all judged on the real filter
  name. Any filter outside the allowlist poisons the budget.
- **Decoding stays in charged code.** While a read runs, PDF.js's native decompression is switched off. Flate,
  ASCII85/Hex, RunLength, Predictor (DecodeParms), decryption and content-array concatenation all grow memory
  only through `ensureBuffer`, which is charged before it allocates. That covers object streams, Type3 CharProcs,
  nested forms and Flate-compressed embedded fonts.
- **Image filters never decode.** Image-only filters are allowed only on image dictionaries (including inline
  `BI…ID…EI` images, which have `W`), and their decoders refuse to run.
- **Annotations** are not read by text extraction.
- **Page caps.** The 200-page × 8 MiB per-page cap cannot pass the 40 MiB document cap, because the document
  total is charged cumulatively. Pages may use embedded Flate fonts and logos, and these stay allowed.

I did not build new adversarial files for the shapes in the list above. They were checked by reading the
patched code paths, and the harness covers the measured shapes.

**N2 (cross-tenant queue): fixed, with a residual L4.** A lane slot is reserved before the body is read: at
most 3 uploads per isolate and 1 per user. Without a slot, the answer is 503 with `Retry-After: 30` and the body
is never read. A read waits at most 10 s for its turn and then gets `reader_busy` (503). `destroy()` is now
bounded at 2 s. An honest user therefore waits at most about 10 s plus their own read, never behind an
unbounded queue.

**N3 (moved module path): fixed.** The plugin's `buildStart` fails the build when `unpdf/pdfjs` stops
resolving to `dist/pdfjs.mjs`. This is tested. Every anchor is still count-checked, and the runtime check still
fails closed.

### Low findings (tracked, not blocking)
- **L4 (low): the lane slot is held during the body upload, so a few accounts can make other users in one
  isolate get 503.** The slot is held for the whole body read (up to 60 s total, 15 s idle). An account that
  uploads slowly holds one slot almost continuously within its 30 per 10 min throttle. Three such accounts
  landing on the same isolate make every other user's upload there get an immediate 503. They are not stalled,
  and no memory is at risk. Suggested fix: shorten the statement body timeouts, or count body-reading slots
  separately from parsing slots.
  - **Resolution (2026-10-13): FIX.** `fix(import): statement uploads charge body bytes, not slots, and throttle on a sliding window (FN-16a L4, L5)`. The lane no longer counts slots: `reservePdfRead` keeps one upload per user, and the body's buffer is charged as it grows against `PDF_READ_BUFFER_BYTES` (what three full uploads held before), so a slow uploader holds only the bytes it has sent; past the budget the read stops with 503 + Retry-After. Tests: `impor-statements.test.ts` "red team L4: slow uploads of other users never block an upload; a full byte budget answers 503", `pdf-text.test.ts` "the statement lane holds one upload per user; bytes, not slots, bound the isolate (N2, L4)", `forms.test.ts` "charges each buffer growth to `charge`; a refusal throws BodyBudgetExceeded (FN-16a red team L4)".
- **L5 (low): the throttle window is fixed,** so up to 60 uploads can pass around a window boundary.
  - **Resolution (2026-10-13): FIX.** `fix(import): statement uploads charge body bytes, not slots, and throttle on a sliding window (FN-16a L4, L5)`. Statement and OCR uploads count through `overUserSlidingLimit` (`auth/throttle.ts`): one-minute buckets, the last ten plus the current one summed, the current minute's count taken from the guarded increment, so no 10-minute span holds more than 30 allowed uploads and concurrent attempts count exactly. Other scopes keep `countAttempt`. Tests: `impor-statements.test.ts` "red team L5: 30 uploads just before a window edge leave none just after it", `sign-in.test.ts` "overUserSlidingLimit (FN-16a red team L5)" (edge, recovery, 40 concurrent).
- **Residual (accepted):** allocations that are not decode output (the object graph, font parsing, text items)
  stay uncounted. They are bounded by the 15 MB input, the item and character caps, and the 15 s deadline. The
  harness showed at most 23 MiB of growth.
