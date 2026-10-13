# FN-15 Receipt scan (Struk) — summary

Status: **complete** (2026-10-09). Migration `0029_receipt_photos.sql`.

- `riwayat/struk`: camera or gallery, the photo re-encoded in the browser (EXIF stripped, ≤ 2576 px), checked again on
  the server (≤ 5 MB, ≤ 8000 px, image sanitiser) and read by Claude (`claude-sonnet-5-5`, one constant) through the
  app's AI Gateway with the user's own key (FN-41). Strict JSON schema re-checked with zod; the model's text is
  untrusted and never chooses ids. 10 reads per 10 minutes per user, counted before the call; per-isolate slot cap.
- Review: shop, date (WIB, two-digit years), total, items, PB1, service, discount; "Periksa totalnya" /
  "Periksa tanggalnya" flags; save as one transaction or split per item (tax + service − discount as one "Pajak &
  servis" row, totals always match); a mismatched total saves only after "Simpan walau totalnya berbeda". Wallet guessed
  from the payment line. "Baca lagi"; "Lampirkan fotonya saja" on manual entry.
- Photos: stored in R2 only when the user keeps them (`transactions.photo_key`), served by `riwayat/[id]/foto` to space
  members only with `nosniff`/CSP, released on delete, space purge and account deletion, included in the export,
  counted in Pemakaian. Dedupe key `receipt:<sha256>:<index>`; a deleted capture is never recreated.
- Without a key the Struk entry points explain how to add one in Pengaturan › Integrasi.
- Tests: receipts unit tests, `test/integration/struk.test.ts`, `migration-0029.test.ts`, `compat-receipts.test.ts`,
  `e2e/struk.spec.ts` (the read step is mocked in the browser; the save hits the real server and D1).
  `npm run compat:receipts` is the owner-run golden set with a real key.
- QA PASS. Red team PASS; cycle 2 fixed L1 (a photo could attach to another member's existing row). Open lows: L2
  partial remote apply of 0029 (take the Time Travel bookmark and row counts), L3 `receipt` label without a read.
- Not verified: a real Anthropic read; no receipt samples yet.
