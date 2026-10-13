# FN-16c BCA CSV mutasi parser — summary

Status: **complete** (2026-10-09). No migration.

- `src/lib/shared/statements/bca-csv.ts`: KlikBCA/myBCA CSV exports detected by layout (the
  `Tanggal,Keterangan,Cabang,Jumlah,,Saldo` column row plus the `No. Rekening` and `Mata Uang` labels) and read under
  the same `bca` institution id as the PDF parser. Each row is read from its right end (amount, DB/CR, running
  balance), so commas in a remark only widen the description; one leading `'` is stripped per cell; real DD/MM/YYYY
  dates and strict two-decimal amounts through the existing money parser.
- Refused whole before any write unless the running balance chains from `Saldo Awal` to `Saldo Akhir` and the
  `Kredit`/`Debet` totals match; also refused for a missing, repeated or unknown footer line, rows after the footer, a
  `PEND` date and a missing currency line; a non-IDR file imports nothing.
- The account number and name are never read into rows; card numbers are masked; formula-looking descriptions stay text
  and the CSV export prefixes them.
- Tests: `bca-csv.test.ts` on synthetic fixtures, `impor-statements` integration cases, an e2e BCA CSV case. Owner's
  real export (git-ignored): 8 rows, 0 rejected, Rp0 gap.
- QA PASS, red team PASS. Open lows: odd third-party remark text (an unclosed quote, many commas) can make a month's
  CSV unimportable; a raw line break plus quote in a remark could let a sender change the date/description of their
  own row; the same month imported twice (or as PDF and CSV) is flagged "Mungkin duplikat", not blocked.
