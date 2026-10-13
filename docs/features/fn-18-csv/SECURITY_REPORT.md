# FN-18 CSV import/export: security report

- Reviewed: `git diff 9c77de9..043eaa3` (cycle 1), commit 043eaa3, in an isolated worktree.
- Reviewer: red-team-pentester. Date: 2026-10-08.

## Verdict: PASS

No critical, high or medium findings. Six low findings are listed below so they are tracked.

## What was checked and held

- **No upload persistence.** File bytes and text exist only in request memory: `readFormBody`, then `readUploadedCsv`,
  then `prepare`. The diff has no R2 `put`, KV or queue write of file content and no `console.*` call in
  `src/lib/server/imports/`. D1 receives only normalised, validated transaction rows. `import_batches` stores
  counts, the format and the cleaned file name. The preview action writes nothing.
- **Server re-parse, no trust in the client.** The import and preview actions accept only the raw file plus
  `format`, `defaultWalletId` and `skipPossibleDuplicates`. They ignore any client row list, so a forged preview
  payload has nothing to attach to. Every row goes through FN-05's `capturedTransactionInput`, which checks the
  amount (1 … MAX, safe integer), the wallet currency, the category kind and that ids belong to the space.
  `source` is `csv`, `is_demo` is 0 and `dedupe_key` is computed on the server. None of these can be injected.
  Transfers and non-IDR rows are skipped.
- **Cross-space access.** `defaultWalletId` resolves through `getWallet(spaceId)`. Wallets and categories are
  found or created inside the caller's space and gated on `isLiveMember`. Undo is scoped by `space_id`, live
  membership and `updated_at`, and another space's batch id returns 404 `missing`. Export joins categories and
  wallets on `space_id = t.space_id` and filters `is_demo = 0` and non-transfer rows. Live probe: user B's
  export of the same range returned only the header row.
- **Dedupe keys.** The key is `csv:<128-bit SHA-256 of the exact text>:<record index>`. The unique index is
  `(space_id, source, dedupe_key)`, so one space's keys can never collide with or suppress another space's rows.
  Forging a collision within the space would need a SHA-256 prefix collision.
- **Concurrency and races.** Live probe: 20 concurrent imports of different files all returned 200. The
  integration test with 20 concurrent imports of the same file passes: each row is written exactly once, and a
  unique violation leads to a re-count with at most 3 attempts. Undo and import cannot interleave. Each is one
  `db.batch`, and the transaction tombstoning is gated on the batch `seq` that the same batch just set.
- **Caps (server-side, before the full parse).** `readFormBody` enforces a 5 MB + 64 KiB cap. It checks
  `content-length` first and also counts streamed bytes. File size is capped at 5 MB, the CSV at 50 columns
  (checked at every delimiter) and 5,000 rows (kept rows; the rest are only counted). Strict UTF-8 decode
  returns 400 on invalid bytes. Wallets are capped at 50 and categories at 100 per space, all-or-nothing in one
  guarded statement. Transactions are capped at 100k per space. Live probe: a 7.2 MB chunked body got 400
  `Invalid form`; `text/plain` got 415.
- **Parser robustness** (Vitest probe, about 5 MB inputs, local timings):
  - 5.2M blank lines: 85 ms.
  - 228k tiny rows: 70 ms.
  - One 5 MB quoted field: 233 ms.
  - 5 MB unquoted amount: 182 ms, refused by the money parser's truncation cap.
  - 5 MB unterminated quote: 194 ms, refused as `unterminated_quote`.
  - 2.6M escaped `""` pairs: 108 ms.
  - 5 MB of commas: 36 ms, refused as `too_many_columns`.
  - BOM, CR-only line breaks, NUL in a field and a header that mixes `;` and `,` were all handled without a
    throw.
  - The parser is a linear state machine. Every regex is anchored or input-bounded (date input sliced to 32
    characters), so ReDoS was not possible. NUL and other control characters are removed by `cleanText` before
    storage.
- **D1 parameter sizes.** The worst case for the duplicate-check JSON is 5,000 rows × 80 astral code points =
  1.94 MB, under D1's 2 MB value limit. The worst case for a 250-row insert chunk is 1.10 MB.
- **CSRF and origin.** Live probe: cross-origin multipart POST got 403, and a POST with no Origin got 403
  (SvelteKit `checkOrigin`). Export is a GET that downloads only. SameSite cookies keep it from being read
  cross-site.
- **Formula injection.** `csvCell` guards `= + - @ \t \r` before RFC 4180 quoting. Quotes, newlines, `,` and `;`
  are quoted. Live probe: a title `=HYPERLINK("http://x")` was exported as `"'=HYPERLINK(""http://x"")"`. Every
  stored text value goes through `cleanText`, which trims, collapses whitespace and strips Cc/Cf/Zl/Zp. So a
  leading space, NBSP, U+3000, LF, tab or zero-width character cannot reach the exporter from any current write
  path. There is no sync push yet.
- **Export bounds.** The range is limited to one year. The response streams 1,000-row keyset pages, at most 100
  pages for a full space. The headers are `private, no-store` and `nosniff`. The filename is built only from
  validated dates.
- **Rendering.** `+page.svelte` has no `{@html}`. File names and titles are rendered as escaped text.
- **Account deletion.** `import_batches` is in `SPACE_SCOPED_TABLES` after `transactions`, which respects the
  foreign key order. `created_by_user_id` is set to null on user delete.

## Findings

### L1 (low): full account or card numbers stored and exported unmasked

- **Where:** `src/lib/server/imports/csv-import.ts:322-325` (`reference`, and `paymentMethod`, `tag`,
  `recurrence`), the wallet names created at `:269`, and `src/lib/server/imports/validation.ts:81` (`filename`).
- **Scenario:** A user imports a bank-derived sheet whose `reference` column, Money Manager `Accounts` column or
  file name holds `1234567890123456`. That value is stored in D1 and returned in every export. Confirmed live:
  the export contained `...,Tunai,1234567890123456`.
- **Checklist:** This deviates from the Masking rule ("reduced to the last 4 digits before storage"). The text
  is the user's own, as with manual notes, which is why this is rated low.
- **Fix:** Before storage, reduce digit runs of 10 or more (spaces and dashes allowed) in `reference`, wallet
  names created by import, and `filename` to `••••1234`. Otherwise, record an owner decision that user-authored
  CSV fields are exempt.

### L2 (low): a D1 failure logs up to 5,000 parsed rows with bound parameters

- **Where:** `src/lib/server/imports/csv-import.ts:144` (`db.all` with the JSON of all rows) and `:364`
  (`throw e`). There is no `handleError` in `src/hooks.server.ts`.
- **Scenario:** Drizzle wraps a failed `db.all` in `DrizzleQueryError`, whose message is
  `Failed query: … params: <json>`. A transient D1 error (overload, reset or timeout) during preview or import
  is not caught. SvelteKit's default handler then `console.error`s it, and `observability` is enabled in
  `wrangler.jsonc`. As a result, dates, amounts and titles of every row land in Workers Logs. This contradicts
  PRD item 34 ("never written to ... a log").
- **Note:** The same pattern exists app-wide. This feature makes it worse because one query binds the whole
  file.
- **Fix:** Add a `handleError` that logs only `error.name`, the route id and the D1 `cause` message, never
  `params`. Alternatively, catch inside the import and preview actions and rethrow a content-free error.

### L3 (low): wallets and categories are created before rows are validated, and stay when nothing is written

- **Where:** `src/lib/server/imports/csv-import.ts:269-279`, which runs before `capturedTransactionInput` at
  `:291`.
- **Scenario:** In a file whose rows name an existing USD wallet, the validator refuses every row
  (CURRENCY_MISMATCH), but each row's new category has already been created. The same happens when the final
  batch ends as `limit` or `gone`. A member can therefore add up to the 50-wallet and 100-category caps to a
  shared space without writing a single transaction.
- **Impact:** Members may create these objects anyway, so this is clutter, not an authorisation bypass.
- **Fix:** Run the pure validator checks before find-or-create, and only find or create names used by rows that
  will be written. Or create them in the same `db.batch` as the rows.

### L4 (low): formula guard skips fullwidth lead characters and LF

- **Where:** `src/lib/shared/csv.ts:405`.
- **Scenario:** `＝`, `＋`, `－` and `＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20) and a leading `\n` are not prefixed. In
  the probe, `csvCell('＝1+1')` returned `＝1+1` unchanged. Some CJK-locale spreadsheet setups convert
  fullwidth signs on entry. Current write paths strip LF.
- **Checklist:** The checklist list (`= + - @` tab CR) is met.
- **Fix:** Extend the class to `[=+\-@\t\r\n＝＋－＠]` and match it after `^\s*`, so the guard
  holds even if a future write path (FN-12 sync push) skips `cleanText`.

### L5 (low): an export stream keeps running after the member is removed

- **Where:** `src/routes/(app)/impor/ekspor/+server.ts:13` checks membership once.
  `src/lib/server/imports/csv-export.ts:52` keeps reading pages with only `spaceId`.
- **Scenario:** A member is removed while a large export is streaming. They still receive the rest of the year
  (up to 100 pages) after removal. "A removed member loses access at once" holds only at request granularity.
- **Fix:** Re-check `isLiveMember` in each page query (add it to the `WHERE`), or end the stream when it fails.

### L6 (low, accuracy): blank lines count toward the 5,000-row cap and the "not processed" count

- **Where:** `src/lib/shared/csv.ts:100`.
- **Scenario:** A file of 5,000 blank lines and then real rows imports nothing. It reports millions of rows
  "not processed" (the probe counted 5,237,680). No security impact, but the counts are misleading.
- **Fix:** Skip blank records before counting them against `maxRows`.

## Commands run

- `npx svelte-kit sync`: passed.
- `npm run db:reset:local`: passed.
- `npm run build`: passed.
- `npx vitest run test/integration/impor.test.ts src/lib/shared/csv.test.ts --maxWorkers=2`:
  - First run, while wrangler dev was up: 46 passed, 1 failed, likely a load flake. The failure did not
    reproduce, and its name was not captured.
  - Rerun: 47/47 passed, 2 files.
- Ad-hoc Vitest parser probe: run, then deleted. Results are in "Parser robustness" above.
- `npx wrangler dev --port 8829` (local only) with a Node probe script:
  - CSRF: cross-origin → 403, no Origin → 403.
  - 7.2 MB body → 400.
  - `text/plain` → 415.
  - Formula-guarded export confirmed.
  - Cross-space export returned the header only.
  - 20 concurrent imports → 20 × 200.
  - The server was stopped after the probes.
- The Playwright suite was not run, as instructed.
