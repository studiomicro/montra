# Changelog

## v0.17.0 — 2026-10-15 03:20 UTC (staging, d47800c)

- Transfers between your own accounts now pair up by themselves after a statement import when the match is clear;
  each one is marked "Otomatis" and can be undone. Unclear pairs still wait for you.
- A cleaner look across the app: fields and buttons without frames, one link style, tidier rows and headers, clearer
  charts in dark mode, and Struk as the main button on Beranda.
- The net worth report no longer shows empty months before your first record and names a start value by its date.
- Behind the scenes: database update 0048 (transfer match source and a lookup index).

## v0.16.1 — 2026-10-14 17:10 UTC (staging, 02bc2b6)

- OCBC Rekening Koran statements import again when the summary lists a currency with no transactions that month.
- Behind the scenes: no database update.

## v0.16.0 — 2026-10-13 17:51 UTC (staging, 2a8b6a7)

- The drawings on empty pages and the city on Beranda look like blueprints: fine outlines on a light grid, with
  dashed guide lines and small corner markers, in light and dark mode.
- Behind the scenes: no database update.

## v0.15.0 — 2026-10-13 16:00 UTC (staging, 6bfb84e)

- The tab bar, sheets and other floating parts look like clear glass, with a soft light along the top edge; reduced
  transparency keeps them solid.
- BNI statements with English month names in their dates import again.
- OCBC Rekening Koran statements with the summary on the last transaction page import again.
- Behind the scenes: no database update.

## v0.14.0 — 2026-10-13 12:50 UTC (staging, e516794)

- Masuk and Daftar open with a slow-moving field of tiny letters on a blue card (black in dark mode); it rests after a
  minute and stays still when reduced motion is on.
- Behind the scenes: no database update.

## v0.13.0 — 2026-10-13 08:44 UTC (staging, 1006e48)

- Alur uang by month, quarter or year, with the previous-period comparison and an average per month; a new net worth
  report with opening, closing and change per asset group.
- A greeting on Beranda by time of day, a calendar of daily spending, closed days and bills from the date at the top,
  feature icons, and an optional daily greeting from your own figures.
- Credit cards as their own wallet: limit, statement and due days, the bill left to pay and bill payments as transfers.
- Behind the scenes: database updates 0046–0047 (net worth by asset group, credit card details and statements).

## v0.12.0 — 2026-10-13 05:20 UTC (staging, 47d9811)

- Transfers between your own wallets no longer count twice: "Cocokkan transfer" on Impor matches them, you confirm
  each pair, and every match can be undone.
- Sign in with a passkey (fingerprint, face or device PIN); add or remove passkeys in Pengaturan › Akun.
- Smoother motion: page changes, charts that draw in, and pull to refresh in the installed app.
- Hidden amounts also hide charts and percentages; a shop name the AI recognises is now a "Pakai nama" suggestion.
- Sturdier statement imports, better account-number masking, and no voucher card on Pro accounts. Montra is now open
  source under AGPL-3.0.
- Behind the scenes: database updates 0043–0045 (transfer matches, passkeys, Gmail reading limits and agent report
  deletion).

## v0.11.0 — 2026-10-11 17:46 UTC (staging, a988a31)

- Imported into the wrong wallet? "Pindahkan ke dompet lain" on Impor › Riwayat impor moves a whole import to another
  wallet with the same currency; the month-by-month balance check follows it.
- Behind the scenes: database update 0042 (activity log allows the new move action).

## v0.10.1 — 2026-10-11 15:01 UTC (staging, 2104ae6)

- BCA PDF statements whose transfer details run over a line starting with a date now import instead of being
  refused. Import a refused BCA month again.
- Behind the scenes: no database update.

## v0.10.0 — 2026-10-11 12:29 UTC (staging, 2f0f8d3)

- Imported bank rows get real categories from the bank's codes; "Rapikan kategori" tidies older rows with review and
  undo.
- Month-to-month balance check on Impor, with a visible adjustment for any gap after you confirm.
- Patungan: split a bill by name, link it to your payment, and only your share counts; mark each person paid.
- Kekayaan chart, allocation bar, "not counted yet" suggestions, grouped sections and credit-card spend.
- Subscription check on Langganan, a streak page with freezes and an evening reminder, a budget streak, and a
  cleaner Impor page.
- Behind the scenes: database updates 0037–0041 (category presets and sources, streak and notification settings,
  subscription dismissals, statement balances, patungan).

## v0.9.0 — 2026-10-11 09:28 UTC (staging, f305aa4)

- Pro look for Pro and Agen: Emas and Hijau tua themes, a Pro badge, a crowned Koko, a framed Beranda number and a
  Pro home-screen icon after reinstall.
- New currencies TWD, HKD and CNY (RMB); cents in amount fields for currencies that have them. Rupiah and yen stay
  whole numbers.
- OCBC Rekening Koran statements import (the rupiah part); the PDF password field explains OCBC's date-of-birth
  password.
- Clearer amount messages, and a refused amount stays as typed.
- Behind the scenes: no database update.

## v0.8.0 — 2026-10-11 05:05 UTC (staging, 240c497)

- A fresh look: the Geist typeface, a slimmer phone tab bar with a round Tambah button, and a cuter Koko.
- Agent (beta) for the Agent plan: reports on your own records as a download, kept for 30 days. It needs your own
  Anthropic key and is not working on staging yet.
- Tidier screens: a back link on every inner page, the settings gear on the phone top bar, Impor in one card, clearer
  input fields and a better fit on small iPhones.
- Excel files from heavily edited workbooks now import instead of being refused.
- Fixed: cancelling a scan on Impor stops it straight away; disconnecting Gmail removes everything it read.
- Behind the scenes: database updates 0035–0036 (Gmail clean-up, agent runs), already applied on staging on 2026-10-10.

## v0.7.0 — 2026-10-10 09:04 UTC (staging, 5dd17e5)

- More ways to import on Impor: Excel and Google Sheets files (.xlsx), plus scanned statements, mobile-banking and
  e-wallet screenshots and camera photos of paper statements. Photos and scans are read on your phone and never leave
  it, and no key is needed. Rows with doubtful digits wait for your check, and Tambah › Mutasi now opens Impor.
- Kamera and Galeri for every photo upload (receipts, items, collectibles), with big photos shrunk and turned upright
  on your phone and a clear how-to-fix message for HEIC photos.
- Cleaner shop names and a category with a visible reason on every capture, changeable in one tap and remembered per
  space (Pengaturan › Pedagang). The extra AI step needs your own Anthropic key and is not switched on yet.
- Tanya, the assistant that answers from your own records, replaces the "Segera hadir" page. It is available once the
  AI settings and your own key are in place; it is not working on staging yet.
- Otomatis from your mailbox: a private forwarding address for bank mails and a read-only Gmail connection through
  Montra's own Google app (testing mode first). Both are available once configured; neither is working on staging yet.
- Easier install on iPhone and Android, a full release list in Pengaturan › Tentang, automatic update checks, and two
  fixes: the saved notice on Riwayat waits for the confirmed write, and brand badges skip words like "ke GoPay".
- Behind the scenes: database updates 0030–0034 (e-mail forwarding, billing hardening, Tanya messages, Gmail
  connection, merchant rules). Not yet set on staging: the AI Gateway and Anthropic key (Tanya, AI steps), Google
  OAuth and the connected-apps key (Gmail), the forwarding domain, the re-claim hash key and the admin account ids.
  The running Workers still report 0.6.0; the 0.7.0 version bump takes effect at the next deploy.

## v0.6.0 — 2026-10-09 16:49 UTC (staging, 7286bf1)

- More banks on Impor: BNI, Mandiri (statements with several accounts let you pick one) and OCBC e-statements
  now import, each row checked against the printed balance; a file that looks tampered with is refused whole.
- Meet Koko, Montra's little coin: on sign-in, empty pages and errors, and it cheers when a save, a closed day or
  a budget with money left is confirmed. It sits still when your phone asks for reduced motion.
- Badges for banks, e-wallets and ride or food apps on Dompet, Langganan, Beranda, Impor and Alur uang.
- Receipt saves now need a real read of that photo first, and an offline delete sent twice no longer says
  "Transaksi tidak ditemukan".
- Page titles no longer flicker when you scroll just a little.
- Behind the scenes: no database update.

## v0.5.0 — 2026-10-09 05:57 UTC (staging, d1bf90a)

- The app is now called Montra, with a new staging address.
- Receipt reading: photograph a receipt and Montra reads the shop, date, total, items, tax and service for you to
  check, then saves it as one transaction or per item. It uses your own Anthropic key.
- Pengaturan › Integrasi stores your own Anthropic key safely and tests the connection.
- BCA PDF e-statements import on Impor, each row checked against the printed balance.
- Pengaturan › Tentang shows the version and what's new and tells you when an update is ready; Pengaturan ›
  Pemakaian shows your plan, credits and limits.
- Behind the scenes: a fresh staging database with updates 0000–0029, including 0028 (AI keys) and 0029 (receipt
  photos on transactions).

## v0.4.0 — 2026-10-09 00:54 UTC (staging, 9a2af2a)

- Gojek, Grab and food delivery: new Ojek Online and Pesan Antar Makanan categories, and words like "gojek",
  "grabfood" or "gofood" pick the right one when you speak, import a CSV or statement, or send from Slack.
- One-tap GoPay, OVO, ShopeePay and DANA when adding a wallet, and GoPay Plus, GoFood Plus and GrabUnlimited in
  Langganan.
- A new Hitam-putih (black and white) theme in Pengaturan › Tampilan, and a frosted-glass look for the menu bar,
  sheets and titles.
- Gentle motion across the app (sheets, charts, lists, the monthly total), switched off when your phone asks for
  reduced motion.
- New illustrations on empty pages, error pages and sign-in, plus a "first wallet" card on Beranda.
- Behind the scenes: database update 0027 (two new categories for every space).

## v0.3.0 — 2026-10-08 15:50 UTC (staging, 4b0724d)

- Upload a bank statement (PDF or CSV) on Impor: see the rows first, skip ones you already have, and undo the import
  if needed. The file is read once and never stored. Bank-specific reading for BCA and BRI comes next.
- Personal access tokens and a REST API: connect your own scripts and tools to your records, with tokens you can
  name, limit and revoke in Pengaturan.
- Items and net-worth entries in demo data are now kept out of your real totals.
- Behind the scenes: database updates 0025 (demo flag on items and net worth) and 0026 (access tokens).

## v0.2.0 — 2026-10-08 11:11 UTC (staging, aad8a15)

- Record transactions, edits, deletions and voice entries while offline; they save once you are back online, and the
  app shows what is still waiting.
- Clearer limits: long subscription names wrap, small buttons are easier to tap on phones, and unknown currencies are
  refused instead of shown wrongly.
- Your data download now includes every transaction type, and leaves demo data out.
- Safer sign-in and account handling, and fair-use limits on how fast new transactions can be added.
- Behind the scenes: database update 0024 (a stricter check on closed days).

## v0.1.0 — 2026-10-08 08:27 UTC (staging, 199ba58)

- A new look across the whole app: clearer pages, a sectioned menu on desktop and a Dompet tab on phones.
- Laporan now shows a daily calendar, a spending trend against last month, where the money went, top places and the
  biggest expenses, plus a yearly view. A new Alur uang page shows money flowing from income to wallets to spending.
- Anggaran has its own page with budgets per category and a marker for how far into the month you are.
- Close the day from Beranda to keep a streak; set up recurring transactions that appear on their own; correct a
  wallet to its real balance with Penyesuaian saldo.
- Privacy settings: switch usage statistics off, see what you agreed to, and download all your data in one file.
- Plans and credits (test mode only) and a public site with an install guide.
- Behind the scenes: database updates 0018–0023 (billing, privacy, category budgets, streaks, balance adjustments,
  recurring transactions).
