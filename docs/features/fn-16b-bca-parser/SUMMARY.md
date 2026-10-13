# FN-16b BCA e-statement parser — summary

Status: **complete** (2026-10-09). No migration.

- `src/lib/shared/statements/bca.ts`, registered in `parsers.ts`: BCA text-PDF e-statements detected by layout markers
  (the `TANGGAL KETERANGAN CBG MUTASI SALDO` header and the `PERIODE :` line) and read into rows through the existing
  FN-18 money parser, dedupe key and validator. DB = expense, otherwise credit; wrapped descriptions joined; headers,
  footers, opening/closing and totals blocks excluded; year from PERIODE; out-of-month days rejected; any non-IDR
  `MATA UANG` line refuses the file.
- Self-checks (red team M1): a statement imports only when every printed running balance, the opening and closing
  balances, the MUTASI CR/DB totals and counts and the period all match exactly; otherwise it is refused whole
  ("Isi mutasi ini tidak cocok dengan saldo yang tercetak…") before any write.
- Shared fixes: `MAX_AMOUNT_MINOR` in `src/lib/shared/money-parse.ts` enforced in `statementRow`; titles masked before
  truncation; the balance check counts only imported rows.
- Tests: `bca.test.ts` on synthetic three-page fixtures (`test/fixtures/statements/bca.ts`), red-team repro cases,
  detection tests, `impor-statements` integration cases, an e2e BCA journey. Owner's real September 2026 statement
  (git-ignored): 9 rows, 0 rejected, balance gap Rp0, all self-checks pass.
- QA PASS (both cycles). Red team FAIL (M1 forged rows) → cycle 2 → PASS. Open lows: a remark equal to the table header
  can redistribute amounts between one sender's adjacent rows (sum unchanged); third-party text like `MATA UANG USD`
  refuses a whole statement.
- Not verified: continuation pages of a multi-page BCA statement (the sample has one page).
