# Security re-check: fix-lows-imports

Reviewed: `git diff 5a486bc..13cb08f` (8 commits, branch `fix/lows-imports`), worktree `montra-worktrees/lows-imports-rt`,
plus each "Resolution (2026-10-13)" note. Reviewer: red team, 2026-10-13. No source changed; PoCs deleted.

## Verdict: PASS

No medium or high findings. Three new low findings (L1-L3) and one documentation note (N1) are recorded below so they are tracked.

## Re-break attempts on each FIX

| Fix | Attack tried | Result |
| --- | --- | --- |
| FN-16a L5 `overUserSlidingLimit` (`auth/throttle.ts:252`) | Burst at a minute or window edge; 40 concurrent requests; per-user key against other users; clock skew; row growth | Holds. The window sums 10 earlier one-minute buckets plus the current one (11 minutes, so slightly stricter). The current minute is counted by the guarded increment, which is exact under concurrency. The only race: a request at a minute edge may miss an increment still in flight for the previous minute (at most the in-flight count, negligible). The key is per user and the hash includes the bucket, so there are no collisions. One bound JSON parameter, inside D1's 100-parameter cap. At most about 60 rows per user per scope; `countAttempt` sweeps rows older than 1 h. See L1 for the lockout side effect. |
| FN-16a L4 lane byte accounting (`statements/pdf-text.ts:181`, `forms.ts:42-66`, `impor/+page.server.ts:310`) | Leaks after 400/408/abort/BodyTooLarge; double release; charging after release; starving other users; a lying `content-length` | Holds. `release()` runs in `finally` on every exit, is idempotent and returns `held`. `charge` refuses after release. The first charge is `min(declared, 64 KB)`. Each growth charges only the delta, and doubling bounds the charge at about 2x the bytes actually sent. A declared length larger than the cap is refused before any charge. To fill the 45 MB budget you must really send about 45 MB from several accounts (one place per user), each behind the sliding upload limit. Nothing leaks because the JS isolate runs on one thread. Removing the slot cap means many small waiting uploads, but the PDF read itself is still one at a time per isolate. |
| FN-16f/16h L1 positioned row starts (`ocbc-text.ts:84`, `pdf-text.ts:147`, `ocr/lines.ts:147`) | A remark-forged `DD-Mon-YYYY DD-Mon-YYYY` or `DD/MM/YYYY DD/MM/YYYY` line; whitespace items in the date column; an embedded `\n` inside a remark item; mismatched layout to force the text-only fallback; pulling `leftmost` | Holds against third-party text. Remark text can never be placed left of the date column. `leftmost` can only move left, which fails closed. `LineStarts` ignores whitespace-only items, and every split part of a multi-line item gets the remark's own x. `lineX.length === split('\n').length` holds by construction for PDF, so a third party cannot force the fallback. On the OCR path, words come from the user's own device, so a forged `\n` in a word only affects the user's own data. See L3 for OCR pages of mixed scale. |
| FN-16b C2-L1 forged BCA table header (`bca.ts:163`) | Header plus a forged `DD/MM` start, so that the real amount line lands in a forged row | Refused. Any forged row adds one row, so the printed `MUTASI CR` count no longer matches. A header with no forged start leaves an amount line outside any row (`broken`). No count-preserving variant was found. |
| FN-16c L1 lone quote / commas / `=` (`read.ts:145`, `csv.ts`, `bca-csv.ts:108`) | The literal-quote retry used to shift columns | Holds. The retry runs only on `unterminated_quote`. Records are at most 200 columns wide, and the bank parser's balance checks still decide. A theoretical case remains: a multi-line remark, read with literal quotes, could start a forged date row. It would still have to pass the running-balance checks, the same limit as before, so it is not a finding. |
| FN-48A L1 narrative tile (`bank-narratives.ts:114`) | Income narratives without a transfer word; purchase prefixes other than `KARTU DEBIT` / `QRIS` | **Partly bypassable: L2.** |
| FN-48C L3 (`transfers/match.ts:509`) | Restoring the credit after the merged debit was deleted | Holds: the restore requires a live debit in the same space. |
| FN-48C `?sebelum` paging (`cocokkan-transfer/+page.server.ts:28`, `match.ts:590`) | Cross-space cursor, injection, unbounded reads | Holds. The cursor is bound as parameters, the query is scoped by `l.space_id`, `limit 51`, a malformed value reads as page 1, and the `href` is server-generated and URI-encoded. A cursor from another space only filters this space's own links by time. |
| FN-48 QA straddle (`wallet-sum.ts:85`) | Cross-space link or credit rows | Holds: both `l.space_id` and `c.space_id` are pinned. `in (NULL, NULL)` excludes nothing. |
| FN-16j L1/L2 (`imports/repo.ts:332,374,434`) | Archived source wallet; source archived mid-move; member removed mid-move | Holds. `source_archived` is answered only after the membership-gated batch read. The guard subquery requires `f.deleted_at is null`. The re-read is `isLiveMember`-gated, so a removed member gets 404. |
| FN-16g L5 HEIC meta walk (`ocr/image-kind.ts:129`) | A zero-size box, sizes below the header length, 64-bit sizes past the file, a meta box over 512 KB, a decoy `ispe` in `mdat`/`free`, a decoy inside `meta` | Holds. Each step advances at least 8 bytes, with at most 64 boxes. Every size is checked against `fileBytes`, and the meta box is capped at 512 KB. A decoy `ispe` inside `meta` can only raise the declared size (the largest wins), so it fails closed. All of this runs client-side only. |
| FN-16g L4 OCR asset extra files (`scripts/ocr-assets.ts:156`) | A planted file, a symlink, edited notices | Holds. A symlink is listed as a non-directory, so the folder counts as not current and is rebuilt. |

## New findings

### L1 (low): refused statement uploads keep extending the sliding lockout
`src/lib/server/auth/throttle.ts:277`. `countAttempt` also increments when the attempt is refused, so every refused request adds to the current bucket. A client (or an auto-retrying tab) that keeps sending more than about 3 uploads a minute after hitting 30 stays locked until it has been quiet for about 11 minutes. Under the fixed window, the lock ended at the window edge. The effect falls only on the user themselves; no other user is affected. Reproduction: 30 uploads, then 5 per minute for 20 minutes; every one is refused with 429. Suggested fix (optional): count only allowed attempts, or cap a bucket at `max + 1`.

**Resolution (cycle 2): FIX.** `fix(import): cycle 2 lows: allowed-only sliding count, narrative allowlist, per-width row starts, CI OCR cache`. `overUserSlidingLimit` counts only allowed attempts: one guarded upsert adds 1 to the current minute only while it is below the room the earlier ten minutes leave, so a refused retry writes nothing and the budget returns as soon as the allowed uploads age out. The allowed count in any 10-minute span is still at most 30 (the L5 edge stays closed). Test: `sign-in.test.ts` "cycle 2 L1: refused retries are not counted; the budget returns once the allowed ones age out" (fails on the cycle-1 code).

### L2 (low): FN-48A L1 still bypassable through other bank prefixes
`src/lib/shared/merchants/bank-narratives.ts:107-114`. `isPurchase` and the income transfer-word cut are a denylist. The PoC (vitest, deleted) returned:
- `KR OTOMATIS LLG-BANK MANDIRI ANDI BUNGA DEPOSITO` (income, SKN/LLG credit with the sender's note) gives `bunga`.
- `SETORAN TUNAI BUNGA` (income) gives `bunga`.
- `TRANSAKSI DEBIT TGL: 0105 QR 014 TOKO PAJAK` (expense) gives `pajak`.
- `TRANSAKSI DEBIT ... TOKO BIAYA ADM` gives `biaya-bank`.
- `DB DEBIT DOMESTIK TOKO PAJAK` and `PEMBAYARAN QRIS TOKO PAJAK` give `pajak`.

The impact is the same as the original L1: the category only, shown for review, undoable, and a space rule still wins. Suggested fix: an allowlist, where fee, tax and interest tiles fire only when the narrative starts with the bank's own prefix (as already done for `BUNGA` and `PAJAK BUNGA`). Alternatively, add `kr otomatis`, `llg`, `transaksi debit`, `qr`, `db debit` and `pembayaran qris` to the purchase/transfer cut.

**Resolution (cycle 2): FIX.** `fix(import): cycle 2 lows: allowed-only sliding count, narrative allowlist, per-width row starts, CI OCR cache`. `narrativeTile` is now an allowlist: fee, tax, interest, cash and card-bill words count only as the narrative's first word, or for a fee (`BIAYA …`) right after a debit transfer's channel prefix (`… DB BIAYA`); a transfer only from the leading channel prefix (`TRSF`, `BI-FAST`, `SWITCHING`, …). Every PoC above now gives no tile. Test: `bank-narratives.test.ts` "cycle 2 L2: only the bank’s own leading words pick a tile, whatever prefix the rest follows". Comparison of the cycle-1 and cycle-2 `narrativeTile` over every string literal in `test/fixtures/statements/*` and the narrative tests, both kinds (587 strings, 1174 pairs); every changed output:

- income `Biaya transfer BI Fast`: transfer → none (a fee line, never income);
- income `Tunggakan Bunga /` and `Overdue Interest`: bunga → none (overdue loan interest labels, not interest earned);
- income `SWITCHING DB BIAYA TXN KE 009 BANK`, `TRSF E-BANKING DB BIAYA TRANSFER`, `BI-FAST DB BIAYA`: transfer → none (debit fee lines read as income);
- expense `TRSF E-BANKING CR 1407/FTSCY BUNGA DEPOSITO ANDI` and `SWITCHING CR TRF JASA GIRO`: none → transfer; expense `BI-FAST CR BIF TRANSFER DR 009 PAJAK`: pajak → transfer;
- four test-title strings (not narratives).

No honest row of its own kind changed: `BIAYA ADM`, `BUNGA`, `PAJAK BUNGA`, `TARIKAN ATM …`, `KARTU KREDIT/PL …` and every transfer fixture keep their tiles.

### L3 (low): OCR pages of different scale weaken the OCBC row-start gate
`src/lib/shared/statements/ocbc-text.ts:105-118`. `leftmost` is one pixel x across all pages, but the tolerance uses each page's own `widthPx`. If OCR images of one OCBC statement have different resolutions or crops, real rows can be refused (this fails closed). In an unusual mix, a description column could also fall inside the tolerance and fall back to the old text-only behaviour. Only the user's own image choice causes this; a third party cannot. Suggested fix: compute `leftmost` per page, or as a share of each page's width.

**Resolution (cycle 2): FIX.** `fix(import): cycle 2 lows: allowed-only sliding count, narrative allowlist, per-width row starts, CI OCR cache`. Each page's line starts are taken as a share of that page's own width before the leftmost row start is found and compared, so pages read at different scales neither refuse real rows nor loosen the gate. Test: `ocbc-rekening-koran.test.ts` "cycle 2 L3: pages read at different scales (OCR) still find the date column on every page" (two pages, 1240 and 2480 px).

### N1 (note): FN-16g L2 resolution text is stale
`docs/features/fn-16g-ocr/SECURITY_REPORT.md:65` says the CI workflow lives on `chore/ci-cd`. It is on main now (`5a486bc`). `ci.yml` and `deploy-staging.yml` use `npm ci --ignore-scripts` (mitigated), but `.ocr-cache/` is not cached between runs, so a build depends on GitHub being reachable (availability only).

**Resolution (cycle 2): FIX.** `fix(import): cycle 2 lows: allowed-only sliding count, narrative allowlist, per-width row starts, CI OCR cache`. The cache is needed for availability: the `build` and `e2e` jobs run `ocr:assets`, which downloads tessdata from raw.githubusercontent.com when `.ocr-cache/` is empty. `ci.yml` now restores `.ocr-cache` in both jobs with the key `ocr-<hash of src/lib/shared/ocr/assets.ts>` (the pinned commit and asset version live there) and saves it only on a push to main after a miss, so pull requests, a fork's included, only read it. The FN-16g L2 resolution note is corrected.

## ACCEPTED items: judgement for a public repo
- **FN-16f L2 (partly) and FN-16h L2: third-party structure lines refuse the file.** Reasonable. The behaviour is fail-closed: nothing is written and the refusal is visible. Gating by position without a real sample risks refusing genuine statements.
- **FN-16c L2: duplicates shown as "Mungkin duplikat".** Reasonable. Identical same-day payments cannot be told apart.
- **FN-16d BNI fail-closed refusal.** Reasonable.
- **fix-xlsx-memory-sqref: one eager buffer.** Reasonable. It is bounded by the part size and the per-user limits.
- **FN-16g QA: second-import duplicate.** Reasonable. It is flagged and needs a deliberate action.
- **FN-17 row-number guard: already fixed.** Verified by its test name.
- **FN-48A L2: runbook-only recovery for 0037.** Reasonable. The steps are correct, require the Time Travel bookmark first, and are remote and owner-run only.

## Checklist (docs/ENGINEERING_CHECKLIST.md)
- Bound parameters: the sliding limit binds one JSON list; the paging query uses 3 params plus a limit.
- Bounded work: links are paged at 51; the HEIC walk is limited to 64 boxes and 512 KB; statement CSV is limited to 200 columns.
- One access rule: move and paging are scoped by space and membership.
- Form bodies: `BodyBudgetExceeded` becomes 503, never 500.
- i18n: the new strings have English entries.
- Concurrency: the 40-concurrent probe is in `sign-in.test.ts`.
- Not run here: `npm run gates`. Only the targeted files below were run.

## Commands run (one file at a time, all passed)
- `npx vitest run src/lib/shared/statements/ocbc.test.ts`: 28 passed
- `npx vitest run src/lib/shared/statements/ocbc-rekening-koran.test.ts`: 37 passed
- `npx vitest run src/lib/shared/statements/bca.test.ts`: 28 passed
- `npx vitest run src/lib/shared/statements/bca-csv.test.ts`: 18 passed
- `npx vitest run src/lib/shared/csv.test.ts`: 32 passed
- `npx vitest run src/lib/shared/merchants/bank-narratives.test.ts`: 20 passed
- `npx vitest run src/lib/shared/ocr/image-kind.test.ts`: 9 passed
- `npx vitest run src/lib/shared/ocr/lines.test.ts`: 5 passed
- `npx vitest run src/lib/server/forms.test.ts`: 54 passed
- `npx vitest run src/lib/server/statements/pdf-text.test.ts`: 35 passed
- `npx vitest run src/lib/server/statements/read.test.ts`: 17 passed
- `npx vitest run scripts/ocr-assets.test.ts`: 9 passed
- `npx vitest run test/integration/sign-in.test.ts`: 12 passed
- `npx vitest run test/integration/impor-statements.test.ts`: 43 passed
- `npx vitest run test/integration/imports-move.test.ts`: 18 passed
- `npx vitest run test/integration/cocokkan-transfer.test.ts`: 27 passed
- PoC `src/lib/shared/merchants/poc-rt.test.ts` (L2 bypass vectors): confirmed, then deleted.

## Cycle 2 (2026-10-13): re-check of `git diff 13cb08f..15accec`

**Verdict: PASS.** L1, L2, L3 and N1 are fixed. No new medium or high findings. Two informational notes follow (I1, I2); they are not tracked as findings.

| Item | Re-break attempt | Result |
| --- | --- | --- |
| L1 allowed-only sliding count (`auth/throttle.ts:278-293`) | PoC (deleted): 8 concurrent attempts every 15 s for 25 minutes, then the busiest 10-minute span of allowed attempts. Separately: 30 allowed, then 100 refused at +5 min, then a probe at +11 min. | **Fixed.** The busiest span held exactly 30 allowed attempts, with 90 allowed over 25 minutes. Refused attempts are not written, and the user is free again at +11 min. A `room <= 0` check comes before any write. The guarded upsert `where count < room` applies the cap atomically in one statement, so a burst at an edge cannot exceed `max`. The minute-edge race with an increment still in flight remains, bounded by the in-flight count (negligible). Old rows are swept on the first attempt of each minute (older than 1 h). |
| L2 narrative allowlist (`merchants/bank-narratives.ts:139-161`) | PoC (deleted): merchant text `KARTU DEBIT BIAYA ADM TOKO` and `QRIS BIAYA ADMIN`; sender notes `TRSF E-BANKING CR …/FTSCY BUNGA` and `…/12345 BUNGA DEPOSITO`; `TRANSFER BUNGA`; channel stuffing `DB CR TRSF BIAYA ADM`; `TOKO TRSF` | **Fixed** for third-party text after a bank prefix. Results: `undefined`, `undefined`, `transfer`, `transfer`, `transfer`, `transfer`, `undefined`. Fee, tax and interest tiles now fire only on the first word, or on a fee right after a `… DB` channel prefix. |
| L3 per-width row starts (`statements/ocbc-text.ts:105-125`) | Pages at different scales; width 0 or missing | **Fixed.** Positions are now shares of each page's own width, so `leftmost` and the 2% tolerance use the same unit on every page. A missing or zero width falls back to text only (a reader artefact; a third party cannot cause it). The new test `ocbc-rekening-koran.test.ts` "cycle 2 L3" covers 1240 px and 2480 px pages. |
| N1 CI `.ocr-cache` (`.github/workflows/ci.yml:78-94,114-119`) | Fork PR poisoning; action pin | **Fixed.** The save step runs only when `github.event_name == 'push'`, and the workflow runs on push only for `main`. Pull requests, forks included, only restore. Whatever is restored is checked against the pinned SHA-256 per file before use (`scripts/ocr-assets.ts:50,75-81`), so a poisoned entry would be discarded anyway. Pin checked with `gh api repos/actions/cache/git/ref/tags/v6.1.0`: the result was `55cc8345863c7cc4c66a329aec7e433d2d1c52a9`, the commit the workflow pins. `permissions: contents: read`. The `fn-16g-ocr` resolution text is updated. |

Informational (not findings; category only, reviewable and undoable):
- **I1.** Digits are dropped from the narrative, so for a debit transfer with a digits-only reference, the first word after it is read as if it followed the channel prefix. PoC: `TRSF E-BANKING DB 0105/12345 BIAYA KURSUS` gives `biaya-bank`. On an outgoing transfer that text is normally the user's own note.
- **I2.** A bank that prints a merchant's name as the first word of a narrative would let that merchant steer the category (`PAJAK TOKO` gives `pajak`). No supported bank format was found that does this.

Commands run (one file at a time, all passed):
- `npx vitest run src/lib/shared/merchants/bank-narratives.test.ts`: 21 passed
- `npx vitest run src/lib/shared/statements/ocbc-rekening-koran.test.ts`: 38 passed
- `npx vitest run src/lib/shared/statements/ocbc.test.ts`: 28 passed
- `npx vitest run test/integration/sign-in.test.ts`: 13 passed
- `npx vitest run test/integration/fix-lows-imports.qa.test.ts`: 3 passed
- `npx vitest run test/integration/impor-statements.test.ts`: 43 passed

Two PoCs (`test/integration/poc-rt-sliding.test.ts` and `src/lib/shared/merchants/poc-rt.test.ts`) were run and deleted. `npm run gates` was not run. Nothing was committed.
