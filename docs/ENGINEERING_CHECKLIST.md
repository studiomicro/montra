# MONTRA engineering checklist

Recurring defect classes. The D1, web and test items are carried over from earlier pipelines, where each
one cost a fix cycle; the money, capture and AI items are specific to MONTRA. Engineers check every change against
this list before handing it to QA; QA and the red team check the diff against it. Add an item whenever a finding
repeats, and name the helper to reuse.

## Data access (D1)

- **100 bound parameters per statement.** Never `inArray(col, list)` with a list that can grow. Bind the list once
  as JSON: `col IN (SELECT value FROM json_each(?))`. Test with 101+ ids.
- **LIKE and GLOB patterns.** D1 rejects a pattern longer than 50 bytes. Use `instr(lower(col), ?) > 0` for
  substring search. Test with a 60-character term.
- **Concurrent writes.** A read-then-write that depends on state is one guarded statement (`UPDATE … WHERE …
  RETURNING`, `INSERT … SELECT … WHERE NOT EXISTS`) inside one `db.batch`. Prove it with a concurrent test.
- **Bounded work.** Every scan has a row cap and a period; aggregates are computed in SQL, not by loading all rows.
- **Migrations.** Never edit an applied one; re-runnable; RUNBOOK notes the D1 Time Travel bookmark before a
  remote apply.

## Money and dates

- **Integers only.** `amount_minor` is an integer; parsing "Rp 1.250.000,00", "1,250,000" and "25 ribu" / "1,5 jt"
  goes through the one shared parser. Never `parseFloat` on money.
- **One currency per sum.** Aggregates group by currency or convert explicitly with a stored rate and date.
- **Sign convention.** Expense negative or positive is decided once in the schema docs; transfers between own
  accounts never count as income or expense.
- **WIB dates.** Buckets use `occurred_on` (WIB). Test 23:30 WIB on the last day of a month and 00:30 WIB on the
  first.
- **Totals reconcile.** A dashboard figure equals the sum of the list it links to, with the same filters.

## Access and privacy

- **One access rule.** Every query on space data goes through the shared space-access helper. Hidden and missing ids
  get the same answer (status, body, timing): no existence oracle.
- **Masking.** Account and card numbers are reduced to the last 4 digits before storage and logs.
- **Untrusted text.** E-mail bodies, OCR text, statement rows, voice transcripts and assistant questions are
  untrusted: strip control and zero-width characters, cap length before `normalize()`, never render as HTML.

## Capture and AI

- **Idempotent capture.** Dedupe key per source (Message-ID, file hash + row index, receipt image hash). A replayed
  queue message or a resent e-mail never creates a second row.
- **Schema-validated output.** Every model response is parsed with zod; invalid output becomes a reviewable draft
  with the error, never a crash and never a confirmed row.
- **Confidence and review.** Below the threshold, or sender authentication failed: state `Perlu ditinjau`.
- **No tool can write.** Assistant tools are read-only and receive the space id from the session, never from the
  model.
- **Cost.** Every AI call goes through AI Gateway, is metered against the user's credits, and has a timeout.
- **No real providers in tests.** `npm test` binds AI to a stub; tests pass their own mock responses.

## Sync and account key

- **One validator.** A synced record passes the same schema, money and space checks as the form action that edits
  it. Never trust `space_id`, `updated_by` or `seq` from the client.
- **Tombstones.** Deletes are `deleted_at` rows without content; pull returns them; a tombstone beats an older edit.
- **Shared code.** Money, date, CSV and voice parsers live in `src/lib/shared` and run unchanged on device and Worker.
- **Sealed results.** Only WebCrypto/vetted primitives (X25519, HKDF-SHA256, AES-256-GCM, scrypt); never invent a
  scheme; fresh nonce per seal; round-trip test plus a wrong-password test.
- **No upload persistence.** Statements, screenshots and receipts stay in memory; grep the diff for R2/D1/log writes
  of file bytes or extracted text outside the sealed path.

## Web and output

- **Redirects.** Use the shared safe-return helper, never a `startsWith('/')` check.
- **Form bodies.** Use the shared guard: cap the size, answer 400 or 415, never 500; prototype-safe parsing.
- **Svelte keyed lists.** Key `{#each}` by a database id or index, never by merchant text or user input.
- **CSV export.** Prefix cells starting with `=`, `+`, `-`, `@`, tab or CR with `'`.
- **CSP.** Per-route additions only, never `'unsafe-inline'`.

## UI quality

- **i18n.** Every new Indonesian phrase gets an English entry, including `trf()` templates and server messages.
- **Currency display.** Use the shared formatter (`Rp 1.250.000`); never format by hand.
- **Truthful state.** Only a confirmed server write is shown as saved.
- **Accessibility.** Focus returns to the opener; headings never skip; touch targets ≥ 44 px on coarse pointers;
  AA contrast in both themes.

## Tests

- **Gates.** `npm run gates` (check, lint, test, build) is clean.
- **Fail-before proof.** Every regression test fails on the unfixed code; show that run.
- **Fixtures.** Bank e-mail fixtures are fictional (invented names, `*.example` domains and numbers), one folder per institution; fixture names never
  match real account numbers.

## Pre-handoff probes

Run the ones that apply and list their result lines.

- **Concurrency:** 20 concurrent requests at any counter, cap, credit balance or invite; the limit holds exactly.
- **Two tabs / stale forms:** state-changing forms compare `updated_at` and answer "changed meanwhile".
- **Cross-space:** every new route and payload crawled as a non-member and as a removed member; sync pull returns nothing from other spaces.
- **Money vectors:** `Rp 1.250.000`, `1.250.000,50`, `Rp 28.000,00`, `IDR 1,250,000.00`, `25rb`, `25k`, `1,5 jt`,
  `2 ceban`, `goceng`, `gopek`, `cepek`, `goban`, negative refunds, DB/CR suffixes.
- **Two devices:** edit on one, delete on the other, sync both; the result follows the conflict rule.
- **Month boundaries:** WIB vectors above.
- **360 px:** layout, touch targets, no horizontal scroll.
- **No-JS forms:** a form action's refusal or success shows without JavaScript.
- **User copy:** never contains a file path or internal identifier.
