**Verdict: PASS** (cycle 2: no medium or high findings; 3 low findings remain open and are tracked)

# FN-19 forwarding: red-team security report

Cycle 2 re-check of `git diff f3ca908..fe81e8b` (commit fe81e8b) against the cycle 1 report. Each fix was
attacked through the real `handleEmail` path against local D1 (workerd), using throwaway vitest files built on
the `workers/inbound/src/process.test.ts` harness. The files were deleted afterwards.

## Re-check of cycle 1 findings

| Id | Cycle 1 | Status in cycle 2 | Evidence |
| -- | ------- | ----------------- | -------- |
| M1 | Medium | **Fixed** | Details below |
| L1 | Low | **Fixed** (relies on L2) | Details below |
| L2 | Low | **Fixed in the procedure**; stays low until the owner runs it | Details below |
| L3 | Low | **Partly fixed**; still open as low | Details below |
| L4 | Low | **Deferred**; low is acceptable | Details below |
| L5 | Low | **Fixed** | Details below |
| L6 | Low | **Fixed** | Details below |

### M1 (fixed)

- **Change:** `parsers.ts` now returns `referenceKey`, the full reference cleaned, with spaces removed and
  upper-cased. `draft.ts` `mailDedupeKey` hashes `JSON.stringify([parser, referenceKey, amountMinor])`.
  `process.ts` removes `referenceKey` from the capture before anything is written.
- **Attack:** the cycle 1 repro used ref `99999999999999993456` against `20261008143205123456`, with the same
  amount and the same last 4 digits. It now gives 2 drafts.
- **Spacing variant:** the same reference written as `2026 1008 1432 0512 3456` merges into the existing draft.
  It is the same payment, so the ledger's `draft_created` is truthful.
- **No leak of the full reference:** it is not stored anywhere. A search of every draft and ledger column
  gives `refKeyStored=false`. Notes still show only `Ref ••••3456`.

### L1 (fixed, but relies on L2)

- **Change:** `process.ts` keeps a confirmation code only when `authenticatedFrom(auth, from)` holds. That
  means DMARC pass, DKIM aligned with the From domain, and a matching `header.from`, all from the trusted top
  header. Any other mail that looks like a confirmation is stored as `not_payment` (id and date only).
- **Rejected attempts:** each gave `not_payment` with no code and no subject:
  - a plain spoofed From;
  - a forged header placed below a failing top header;
  - DKIM `d=attacker.example`;
  - `header.from` that does not match;
  - the look-alike domain `google.com.attacker.example`;
  - a display name made to look like the Google sender;
  - `INBOUND_AUTHSERV_ID` unset with a forged header.
- **Still accepted:** a forged **topmost** header carrying the configured authserv-id. That is exactly the L2
  premise, so this fix holds only once L2's procedure has been carried out.
- **Side effect (not a security issue):** while `INBOUND_AUTHSERV_ID` is unset, real Gmail confirmation codes
  are never shown either.

### L2 (procedure fixed)

- **Change:** RUNBOOK step 5 now finds the authserv-id on the "Send to a Worker" route, with a debug Worker
  that logs only authserv-ids. It also requires a forged-header mail to show Cloudflare's own header **first**
  before `INBOUND_AUTHSERV_ID` is set. Until then the variable stays unset, so the code fails closed. Step 6
  adds a real spoofed-mail check.
- **Why it stays low:** this is correct, but it is still an owner item that has not been verified against a
  real mail.

### L3 (partly fixed, still open as low)

- **Change:** `text.ts` `DIGIT_RUN` now also joins digit groups separated by `*`, by a spaced `-` or `–`, and
  by `/` between groups of 3 or more digits. `DATE_SHAPE` accepts `/`. The regex is linear: 100–120k-character
  hostile inputs took 2–39 ms.
- **Now masked:** `4111*1111*1111*1111`, `4111/1111/1111/1111`, `4111 – 1111 – …`, `1234 - 5678 - 9012`,
  `0812/3456/7890`, and non-breaking-space groups.
- **Dates and amounts kept as printed:** `08/10/2026 18:05`, `2026/10/08 14:32`, `01/10/2026 – 31/10/2026`,
  `Rp 1.250.000 - Rp 500.000`, `IDR 250,000.00`.
- **Still open (low):** these 16-digit forms stay unmasked and would reach `pending_text` and the AI for up to
  24 h:
  - an unspaced en dash, em dash, U+2212 minus or U+2010 hyphen (`4111–1111–1111–1111`);
  - `_`, `,` or `•` between groups;
  - a slash with spaces around it (`4111 / 1111 / …`).

  Banks rarely print cards this way, and most print them already masked.
- **Fix suggestion:** treat any single non-alphanumeric, non-newline character between digit groups of 3 or
  more digits as a joiner. Alternatively, mask any line whose digit groups add up to 12–19 digits.
- **Over-masking (low, data loss):** `Rp150.000*12` (an instalment) becomes `Rp••••0012`, so the AI loses that
  figure. It cannot create a wrong amount, because the AI's amount is checked against the same masked text.

- **Resolution (2026-10-13):** FIXED in `fix(mask): mask card groups joined by other dashes, _, comma, bullet or a spaced
  slash` (9456de8). `DIGIT_RUN` now also joins digit groups by an unspaced en/em dash, U+2212, U+2010, `_`, `,`
  or `•`, and by a spaced ` / `; amounts grouped with commas (`1,250,000.00`) or with a 2-digit comma decimal stay
  as printed, and `*`, `_`, `•` and the dashes split a run like a space does, so `Rp150.000*12` is no longer
  over-masked. Test: `src/lib/shared/text.test.ts` › "FN-19 forwarding red team L3 (2026-10-13): other single
  joiners and a spaced slash; instalments stay" (failed before: `Kartu 4111–1111–1111–4321` unmasked).

### L4 (deferred, low is acceptable)

- **Remaining risk:** someone holding a leaked address can cause 60 AI reads an hour on the user's own key,
  and can fill a shared space's 1,000-draft cap.
- **Why it can stay deferred as low:**
  - it needs the 128-bit bearer secret;
  - the owner can rotate or turn off the address at once on the settings page;
  - every capture is a draft, never a transaction;
  - BYOK Haiku reads of at most 6,000 characters cost little.
- **Follow-up:** track it in docs/TASKS.md: a daily AI-read cap per address, and a smaller cap on
  `unverified` drafts.

- **Resolution (2026-10-13):** ACCEPTED, as this report rates it. Abuse needs the address's 128-bit bearer secret, which the
  owner can rotate or turn off at once; each mail is held to the address's 60-an-hour cap, every capture is a
  draft, and the reads run on the user's own key at Haiku prices for at most 6,000 characters. A separate daily cap
  would need a CHECK change on `inbound_mail` (a table rebuild) for a path the user controls by choosing what to
  forward. Gmail, where any outside sender can trigger a read, got its daily cap (FN-19 Gmail L6).

### L5 (fixed)

- **Change:** `inbound_addresses` and `inbound_mail` are now account tables, exported by `user_id`.
  `tables.ts` `scopeWhere` and `countRows` both use `user_id = <user>` for the account scope. `local_part`,
  `window_*`, `pending_text`, `confirmation_code`, `message_key` and `address_id` are still left out.
- **No leak of other users' rows:** the account scope never selects by space, so another member's rows in a
  shared space cannot come in.
- **Space export:** it marks both tables `none` and explains why. `notIncluded` does not list them.
- **Tests:** the new integration test (export after leaving a space) and `test/integration/privacy.test.ts`
  pass.

### L6 (fixed)

- **Change:** `messageKeyOf` without a Message-ID now hashes date, From, subject and the cleaned text.
- **Attack:** an exact replay of a mail without a Message-ID dedupes (ledger 1 row, 1 draft). The same From
  and subject with a different body gives a new row and draft (2 drafts, 2 ledger rows in total).

## New issues from the cycle 2 diff

None of medium or high severity.

- **Trivial:** for an exact replay on the deterministic path, `processInboundMail` still returns the outcome
  `draft` (`process.ts:122`). This affects only the log's outcome code; there is no data effect.

## Commands

- `npx vitest run test/integration/forwarding.test.ts workers/inbound/src workers/jobs/src src/lib/shared/inbound src/lib/shared/text.test.ts`
  (with the temporary red-team file): `Test Files 10 passed (10)`, `Tests 112 passed (112)`.
- `npx vitest run test/integration/privacy.test.ts src/lib/server/export`: `Test Files 2 passed (2)`,
  `Tests 34 passed (34)`.
- The temporary files `workers/inbound/src/zz-redteam.test.ts` and `src/lib/shared/zz-redteam-mask.test.ts` were
  deleted.

## History

- **Cycle 1 (f2a3726): FAIL.**
  - M1: dedupe was keyed on the masked reference, so a distinct payment was silently dropped and the ledger
    still said `draft_created`.
  - L1: a spoofed Gmail confirmation code was shown.
  - L2: the authserv-id procedure was not done on the Worker route.
  - L3: `*`-separated and spaced-dash-separated card and account numbers were not masked.
  - L4: a leaked address could drive AI cost and fill the draft cap.
  - L5: the export missed rows of spaces the user had left.
  - L6: mail without a Message-ID deduped on date, From and subject only.
  - Everything else held: spoofing, replay, recipient oracle, limits, MIME robustness, AI validation, IDOR,
    retention, logs, deletion.
- **Cycle 2 (fe81e8b): PASS.** M1, L1, L5 and L6 are fixed. L2 is fixed in the procedure (owner run pending).
  L3 is partly fixed (residual bypasses stay low). L4 is deferred as low.
