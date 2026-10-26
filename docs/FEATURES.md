# MONTRA — Feature catalog

Stable IDs. Use them in PRD titles, slugs (`fn-07-budgets`) and tracker lines. Status lives in `docs/TASKS.md`,
phases in `docs/PRD.md` § 5.

**Source.** Every feature below is Montra's own catalogue. **Mirror** = behaviour that follows common practice in
comparable money apps, which we match. **Ours** = a deliberate difference. Match behaviour, never brand: no copying of
another product's name, mascot, logo, illustrations or product names. A public URL is not source code; never
reconstruct another app from its bundles.

---

## Phase 0 — Foundation

### FN-00 Foundation

SvelteKit on Workers, D1 + Drizzle, R2, Queues, Workflows, KV, Analytics Engine bindings; `workers/jobs` and
`workers/inbound` skeletons; i18n (`tr()` + English test); app shell with the 5-tab bottom bar (Beranda, Riwayat,
Laporan, Kekayaan, Tambah) and a desktop sidebar; `npm run gates`; seed and reset scripts; Vitest; Playwright on
`wrangler dev`; `.dev.vars.example`; CSP and security headers; staging environment.

### FN-01 Account and sign-in

- **Mirror:** e-mail + password account (name, e-mail, password hash); sessions stored as hashes; sign out removes
  the local account key; delete account in Settings › Akun **and** from a browser page without the app; deletion
  removes account, all server records, connected apps and their e-mail data, assistant chats and memory, agent
  reports, photos, imports, reminders, notifications and every session; records in shared spaces stay for the other
  members; used voucher codes stay marked used without the account; for people 18+ (younger with guardian
  permission); UI in Bahasa Indonesia and English.
- **Ours:** optional Google sign-in next to the password (owner decision); PBKDF2 parameters and lockout rules
  reused from the earlier project.

### FN-02 Guest mode, local-first storage and sync

- **Mirror:** the app works without an account; records live on the device; signing in uploads them and syncs
  them to every device and to shared-space members; a deleted record leaves a content-free tombstone so other
  devices delete it too; CSV import and the voice parser work without an account; on iPhone the installed app keeps
  its own storage, separate from Safari.
- **Ours:** IndexedDB on the client, D1 as the server copy, a per-space change log with a cursor; conflict rule and
  scope are owner decisions (see `docs/ARCHITECTURE.md`).

### FN-03 Spaces and sharing (Ruang)

- **Mirror:** a personal space for everyone; shared spaces with up to 5 people; roles Pemilik (owner) and Anggota
  (member); invite by link (valid 7 days) or by code; wallets, transactions, budgets and goals are shared with all
  members; a member who leaves or deletes the account leaves the records with the others; several spaces and shared
  spaces are a Pro feature; space avatar at the top right of Beranda opens Settings.

---

## Phase 1 — Core ledger

### FN-04 Wallets (Dompet)

- **Mirror:** wallet types Tunai, Bank, E-wallet, Kartu kredit (plus Investasi as a category group); a **favourite
  wallet** used whenever a capture names none; wallet matching by name, then by type (GoPay → e-wallet, credit card
  → card wallet, debit → bank account); transfers between own wallets are not income or expense.
- **Ours:** institution list with logos (BCA, Mandiri, BRI, BNI, Bank Jago, BSI, CIMB Niaga, Permata, Jenius,
  SeaBank, GoPay, OVO, DANA, ShopeePay, LinkAja, …); account numbers masked to the last 4 digits.

### FN-05 Transactions and history (Riwayat)

- **Mirror:** fields date, type (expense, income, transfer), title/merchant, amount, currency, original amount for
  foreign currency, category, wallet, payment method, recurrence, tag, notes, reference number, attached photo,
  source (manual, Gmail, voice, receipt, import); history grouped per day with that day's money in and out; search,
  period ("Periode ini") and filter; header "N transaksi · keluar Rp X"; badge "Tercatat" on auto-captured rows;
  edit and delete anywhere; a deleted auto-captured transaction never comes back from the same source; foreign
  currency converted at the day's rate with the original kept, or held for review when no rate exists.

### FN-06 Categories

- **Mirror:** 15 preset categories, renameable, icon changeable, user-added. Seen presets: Kopi, Makan & Minum,
  Belanja Harian, Belanja, Transportasi, Tagihan, Kesehatan, Hiburan, Pendidikan, Tempat Tinggal (expense); Gaji,
  Bonus, Freelance, Hadiah, Pemasukan Lain (income); plus "Tanpa kategori". Category is guessed from words (kopi,
  makan, parkir, bensin) and merchants, and changed with one tap.

### FN-07 Budgets and safe-to-spend

- **Mirror:** set a budget once; the remainder is split over the remaining days of the month ("Sisa Rp5,24 jt ·
  Rp187 rb/hari untuk 28 hari").

### FN-08 Home (Beranda)

- **Mirror:** "Pengeluaran <bulan>" total; comparison with last month in rupiah, not percent ("lebih banyak",
  "lebih hemat", "hampir sama"); average per day; "Hari ke-N" of the month; today's spending and list; chart picker:
  daily bars (last 14 days, swipe to see each day), calendar, per category, versus last month; tap a day to see its
  figure; quick capture buttons Suara (voice, grey) and Struk (receipt, black).

### FN-09 Reports (Laporan)

- **Mirror:** free reports tab: month and period summaries, per-category and per-merchant breakdowns, in versus
  out. (Detailed layout not public; design our own.)

### FN-10 Savings goals (Target / Tabungan)

- **Mirror:** goals with a target amount and progress (e.g. "Tabungan 100 % · Rp 1.250.000 / Rp 1.250.000");
  shared with the space.

### FN-11 Drafts inbox and review (Kotak masuk)

- **Mirror:** one place where drafts wait: Gmail payments held as possible duplicates, Slack drafts, AI captures
  needing review; "Periksa draf" screen; bulk "Atur kategori" and "Atur dompet"; save several drafts at once
  ("Simpan 2 transaksi").

### FN-12 Feature toggles

- **Mirror:** Profil › Fitur turns modules on or off (Kekayaan, Langganan, Barang, Koleksi, Ruang bersama, …); all
  modules feed the same numbers.

### FN-13 Install and notifications (PWA)

- **Mirror:** install from the browser (iPhone Safari: Bagikan › Tambah ke Layar Utama, "Buka sebagai App Web";
  Android Chrome: ⋮ › Instal aplikasi); install guide page with a QR code for desktop visitors; in-app browser
  detection (Instagram, TikTok, WhatsApp) with "open in Safari/browser" advice; full screen without address bar;
  updates arrive without a download; "Beri tahu di perangkat ini" push toggle per device; iPhone push needs iOS 16.4+
  and the home-screen icon.
- **Ours:** Android share target (screenshot or receipt → FN-15).

---

## Phase 1b — Reference app layout parity additions (owner request 2026-10-08)

Seen in the reference app's screenshots (`docs/design/APP_PARITY.md` § 4) but not covered by FN-00 – FN-13. Core
ledger additions: they touch wallets, transactions and Beranda, so they are numbered and scoped here rather than at
the end of the catalog.

### FN-34 Daily streak and "Tutup hari"

- **Mirror:** closing the day — reviewing today's entries, or confirming there are none — extends a running streak
  of consecutive WIB days; a small streak-day chip sits in the mobile top bar; Beranda's "Hari ini" card gains a
  close action while the day is still open.
- **Ours:** no coins, points or in-app currency of any kind; a plain non-monetary streak count, our own wording and
  icon (never a reward-coin or any coin visual).

- **FN-34b streak extensions** (owner request 2026-10-11, all four options picked): a `/beruntun` page (current +
  longest streak, a calendar of closed days, 7/30/100-day milestones), reached from the top-bar chip; an evening
  Web Push reminder (reuses FN-24) when today is not yet closed, default 20:00 WIB, per-user hour, off switch;
  a computed (no new table) streak freeze earned every 7 closed days, banked up to 2, bridging one missed day
  without writing a backdated closure; and a second, space-scoped budget streak — consecutive WIB days spent
  within FN-07's safe-to-spend — snapshotted the morning after each day (FN-07's budget carries no amount
  history, so a later change never rewrites a past day's verdict). Still no coins, points or currency-like
  reward. PRD: `docs/features/fn-34b-streak-plus/PRD.md`.

### FN-35 Money-flow chart ("Alur uang")

- **Mirror:** a three-column flow diagram for one month — income sources → wallets → spending categories — with
  link width by amount; reached from the Fitur section, the way Kekayaan and Langganan are.
- **Ours:** a small SVG drawn by hand (no chart library), built only from the same FN-05 aggregates Beranda and
  Laporan already use; nothing summed or interpolated beyond what is stored.

### FN-36 Recurring transactions

- **Mirror:** a transaction can be set to repeat on a schedule (e.g. "tiap tanggal 12", weekly); due instances are
  created automatically; Transaksi gains an "aktif berulang" filter; a series can be paused, stopped, and edited
  either for one instance or for the series going forward.
- **Ours:** instances are created by `workers/jobs`' existing hourly Cron Trigger and Queues pipeline (the FN-24
  pattern), idempotent per series and WIB date — a redelivered or repeated tick never creates a duplicate.

### FN-37 Balance adjustment ("Penyesuaian saldo")

- **Mirror:** a wallet can be set to a stated balance; the app records the difference as one transaction instead of
  asking the user to compute and type it.
- **Ours:** a distinct transaction type, excluded from every spending/income total, budget and report FN-05's
  aggregates produce — it changes a wallet's balance and nothing else.

---

## Phase 2 — Capture

### FN-14 Voice and quick text entry (Suara)

- **Mirror:** tap Suara and recording starts at once; the browser's own speech recogniser turns speech into text
  (the server never receives audio); words appear live with amounts highlighted; ID/EN language toggle; typing the
  same sentence gives the same result.
- **Mirror (parser):** amounts `25rb`, `25 ribu`, `25k`, `25.000`, `1,5 jt`, `1,5 juta`; slang cepek 100, gopek
  500, seceng 1.000, noceng 2.000, goceng 5.000, ceban 10.000, goban 50.000, with multipliers ("2 ceban" = 20.000);
  separators "dan", "terus", "lalu", "plus", comma, or two amounts with no separator; quantities ("beli 2 kopi 50rb"
  = one draft); wallet words ("pakai gopay", "tunai", "kartu kredit", own wallet names) apply to items that name no
  wallet, else the favourite wallet; income words (gaji, bonus, THR, refund, cashback, jual) make income drafts.
- **Mirror (AI check):** signed-in users get an AI re-read with their wallet names as hints: same result shows "AI
  setuju dengan draf ini"; a different result replaces the draft, or is offered as "Pakai versi AI" when the user
  already edited it.
- **Mirror:** "Catat lagi" — frequent expenses appear as one-tap buttons under the voice field, with undo; works
  without an account (local parser only).
- **Ours:** Workers AI Whisper fallback for browsers without speech recognition.

### FN-15 Receipt scan (Struk)

- **Mirror:** Struk button on Beranda or + › Struk; camera or gallery; "Baca struk"; AI reads shop, date, total,
  items, tax (PB1), service and discount in seconds with visible progress (upload → reading → ready); flags "Periksa
  totalnya" / "Periksa tanggalnya"; every field editable; save as **one transaction** (items kept in the notes) or
  **split per item** (each ticked item its own expense with a guessed category, tax + service + discount as one
  "Pajak & servis" transaction so the total still matches); wallet from the printed payment method, else favourite;
  photo stays attached as proof; "Baca lagi"; "Lampirkan fotonya saja"; one photo per receipt; no PDF here; needs an
  account (guests can attach a photo to a typed transaction).

### FN-16 Statement import (Impor mutasi bank/e-wallet)

- **Mirror:** Settings › Impor mutasi; choose the wallet; bank template "Deteksi otomatis"; inputs PDF
  e-statement, XLS/XLSX, CSV, screenshots (JPG, PNG, HEIC); max 20 MB, one file per import; password-protected PDFs
  ask for the password, used once and never stored; AI reads pages in 10–60 s while the app stays usable; CSV parsed
  on the device.
- **Mirror (review "Tinjau impor"):** summary (period, rows, total in and out); balance check (opening + rows =
  closing, else warn that rows may be missing); a "Sudah ada" already-imported flag and "Mungkin
  duplikat" (same amount, at most one day apart, in the same wallet or from Gmail in any wallet), both excluded but
  tappable to include; categories guessed from the description, bulk "Atur kategori"; original text per row;
  bank abbreviations cleaned ("TARIKAN ATM" → Tarik tunai); in/out from DB/CR, debit/credit columns or balance
  change; missing year taken from the statement period; institution label detected from content; tabs Semua /
  Keluar / Masuk; "Masukkan N transaksi".
- **Mirror (after):** "Lihat di Riwayat"; import history on the same screen; undo removes every transaction of
  that import; guidance to skip own-wallet transfers and log them as transfers.
- **Ours — FN-16a, the deterministic subset** (`docs/features/fn-16a-statement-parsers/PRD.md`, owner request
  2026-10-08): text-based PDF, CSV and XLS(X) e-statements are read by a per-institution parser, never a model —
  no AI Gateway key needed. Scanned/image PDFs and receipt photos still need this feature's AI half (above), which
  stays blocked on the on-hold Anthropic key (`docs/TASKS.md`).
- **Ours — FN-16g, on-device OCR** (`docs/features/fn-16g-ocr/PRD.md`, owner decision 2026-10-10): scanned or
  image-only statement PDFs, phone-camera photos of paper statements and e-wallet / mobile-banking history
  screenshots are read **on the user's device** by Tesseract (WebAssembly in a Web Worker, `ind` + `eng`
  tessdata_fast), never by AI and never on the server. The engine (about 9 MB decoded, about 4 MB on the wire) is
  served from the app's own origin and downloaded only when someone picks an image; camera action next to the
  gallery/file pick; EXIF orientation, downscale to 6 MP, deskew, "Foto kurang jelas" on a weak page. Only the
  recognised words (no image, no file name) go to the server, which rebuilds the rows itself with the FN-16a bank
  parsers or the screenshot list reader, refuses a statement that does not add up, keeps unsure figures out
  (poisoned, never repaired) and puts unsure rows in "Perlu ditinjau" (excluded unless ticked in). Limits: 5
  images or 12 PDF pages per run, 15 MB per file, 64 MP declared. Rows import with source `statement` through the
  same preview, dedupe, import history and undo. Screenshot layouts are written from fictional fixtures and are
  unverified until the owner's redacted samples are run through `npm run compat:ocr`.
- **Ours — FN-16h, a second OCBC layout** (`docs/features/fn-16h-ocbc-rekening-koran/PRD.md`): OCBC NISP's
  single-account "REKENING KORAN" e-statement (e.g. a Tanda360Plus Digital account), read by the same
  user-facing "OCBC" parser that already reads OCBC's multi-account Laporan Konsolidasi layout (FN-16f).
- **Ours — FN-16i, import layout adjustment** (`docs/features/fn-16i-impor-layout/PRD.md`, owner request
  2026-10-11, with a screenshot of the reference app's Imports page): reorders `/impor`'s cards to the reference's
  wallet-then-file, statement-card-then-history left column and other-ways-then-reading-jobs right column; lifts
  the wallet picker above the format segments and gives it FN-43 brand badges; expands the bank-statement
  institution picker to name every FN-04-listed institution honestly — a real parser is selectable, everything
  else is a disabled row naming its working alternative (CSV/Spreadsheet, the on-device OCR screenshot path, or
  "not yet"); and fixes the stale "Pindai struk — Segera hadir" row to link to the now-shipped FN-15. Layout and
  copy only — no new parser, no migration.
- **Ours — FN-16j, move an import batch to another wallet** (`docs/features/fn-16j-move-import/PRD.md`, owner
  request 2026-10-11, prompted by two real BCA statement batches imported into the wrong wallet): "Pindahkan ke
  dompet lain" next to Riwayat impor's existing "Urungkan" moves every live transaction of a batch — and a
  statement batch's FN-48B continuity wallet — to another live, same-currency wallet of the space in one write,
  refusing a currency mismatch, a stale page, a non-member or a batch whose rows no longer share one wallet. No
  migration beyond widening the audit-log action enum.

### FN-17 Spreadsheet import (Excel / Google Sheets)

- **Mirror:** `.xlsx` through the same import screen; AI only maps the layout (date, description, category, amount
  columns); numbers are copied by code, never rewritten by the model (3,000-row test gives identical totals); reads
  one long table or one tab per month (month and year from the title, day-only date column), separate in/out
  columns or amount + type, an income tab next to an expense tab, titles above the table, repeated headers, Excel
  date serials; skips total, subtotal and balance rows and rows without a date; matches sheet categories to
  existing ones by name or keyword ("Makan" → Makan & Minum, "Ngopi" → Kopi), else guesses, else "Tanpa kategori";
  never creates categories; one wallet per import; rejects budget-only or asset-only sheets with a clear message;
  amounts must be numbers (no "25rb").

### FN-18 CSV import and export

- **Mirror:** Settings › Impor/ekspor CSV; two formats: our template and Money Manager export; parsed on the
  device, works without an account and offline; comma or semicolon separators; dates `2026-10-01` or `01/10/2026`;
  amounts `28000`, `28.000`, `Rp 28.000,00`; missing categories, wallets and tags are created; saved directly (no
  review) but listed in import history with undo.
- **Mirror (template columns):** `date, type, merchant, amount, currency, category, payment_method, recurrence,
  tag, notes, wallet_source, reference`; minimum `date, type, merchant, amount`; `type` expense / income
  (pemasukan); transfer rows skipped; empty `wallet_source` falls back to `payment_method`.
- **Mirror (Money Manager):** Period, Accounts → wallet, Category (part before "/") → category, Note → title,
  Income/Expense, Amount, Currency.
- **Mirror (export):** pick a date range, "Ekspor CSV" in the same template; transfers excluded; formula-injection
  safe (ours).

### FN-19 Gmail auto-capture

- **Mirror (connect):** Settings › Aplikasi terhubung › Gmail › Hubungkan; explanation screen of what is read and
  where text goes; Google consent; access through a SOC 2 Type II / ISO 27001 connection partner, read-only use;
  "Periksa otomatis" toggle (hourly, 06.00–23.00 WIB; night mail handled at 06.00); "Dicatat ke" target space when
  the user has several; "Beri tahu di perangkat ini" push per captured payment.
- **Mirror (what is read):** senders — banks BCA, Mandiri, BRI, BNI, Bank Jago, BSI, CIMB Niaga, Permata, Jenius,
  SeaBank; e-wallets GoPay/Gojek, Grab, OVO, DANA; shops and travel Shopee, Tokopedia, Blibli, Lazada, Bukalapak,
  Traveloka, tiket.com, Blue Bird, KAI; subscriptions Apple, Google Play, Netflix, Spotify; any sender whose subject
  has "QRIS", "struk", "invoice", "tagihan", "bukti pembayaran", "transaksi berhasil". Promotions and Social tabs
  skipped, attachments never opened, mails without a money amount never read.
- **Mirror (processing):** AI decides payment vs promo, unpaid bill, shipping notice or OTP; extracts amount,
  merchant, date, reference, direction and category; one purchase = one record (same reference + amount ignored);
  held for review when the user logged the same amount within 12 hours; wallet matching as FN-04; foreign currency
  as FN-05; e-mail text deleted after reading; only transaction + sender + subject kept; non-payment mails leave
  only id and date.
- **Mirror (look-back):** "Lihat ke belakang" 7 days, 1, 3, 6 or 12 months; "Pindai sekarang" runs in the
  background; "Transaksi dari Gmail" review grouped per day with in/out, duplicates excluded but tappable, bulk set
  category and wallet, edit title/amount/date, open the mail in Gmail, "Impor", undo the whole import; free = 7 days,
  longer look-back paid with credits (FN-30).
- **Mirror (disconnect):** revokes at Google and at the partner, deletes every e-mail record (including pending
  drafts and mail text in assistant chats); transactions stay.
- **Ours:** e-mail forwarding address (`workers/inbound`) as a fallback and for non-Gmail users; partner vs own
  CASA-assessed OAuth app is an owner decision.

### FN-20 Merchant recognition and auto-categorisation

- **Mirror:** merchant names recognised and cleaned; categories assigned (coffee → Kopi, ojek → Transportasi,
  salary → Gaji); one tap to change.
- **Ours:** order user rule → space history → cache → AI; learns from corrections per space.
- **Built (2026-10-10, `feat/fn-20-merchants`):** a curated generic dictionary sits between cache and AI; reason
  chips on drafts and manual entry; `/pengaturan/pedagang` lists and deletes learned rules; AI is BYOK and optional.

### FN-21 Encrypted upload results (account key)

- **Mirror:** uploaded statements, screenshots and receipt photos are processed in memory only and never stored;
  the AI partner reads them under a random name with caching off, then the job and file are deleted there, the
  deletion is verified and leftovers are swept hourly; the review screen shows "file deleted" once confirmed.
- **Mirror (crypto):** each account has a key pair made on the device at sign-in (X25519); results are sealed to
  the public key (HKDF-SHA256, AES-256-GCM); the private key is wrapped with a key derived from the password (scrypt,
  OWASP settings) and only the wrapped key is on the server; every signed-in device can open results; sign-out drops
  the key from the device; a one-time "Kunci dengan akunku" step for older accounts; if the key is not active yet,
  results are not stored at all.
- **Mirror (still visible):** only when, size, type and success of an upload. Portfolio screenshots (FN-25) are
  read while waiting and never stored.

---

## Phase 3 — Intelligence

### FN-22 Assistant ("Tanya")

- **Mirror:** free and unlimited for every plan; answers from the user's own records with figures, comparison and
  small charts (e.g. 3-month bars, top merchant); suggested questions ("Bulan lalu habis berapa buat kopi?",
  "Langganan apa yang paling mahal?", "Pengeluaran makan naik atau turun?"); on the Agent plan it can search and read
  other mail in Gmail when asked, and that mail text is removed from the chat after answering; chats kept 30 days,
  deletable in Settings › Ingatan asisten.
- **Ours:** Claude through AI Gateway (other apps use other models); read-only tools scoped to the space.

### FN-23 Agent (beta)

- **Mirror:** "Tinggal tanya, Agen yang kerjakan": annual recap, monthly report, asset list for SPT; visible steps
  (reading N transactions → grouping by category → monthly summary → ready to download); report files deleted
  after 30 days; Agent plan only.

### FN-24 Notifications and reminders

- **Mirror:** push for each payment captured from Gmail (merchant, amount, category; shows on the lock screen);
  reminders (subscriptions, bills) also sendable to Google Calendar (FN-29).
- **Ours:** budget 80 % / 100 % alerts and a weekly summary, per-type settings.

---

## Phase 4 — Wealth

### FN-25 Net worth (Kekayaan)

- **Mirror:** savings, stocks, crypto, gold, debt and property/assets in one chart with current prices; net worth
  total; change over 30 days ("Naik Rp 42 jt dalam 30 hari"); allocation by class (Kas, Investasi, Kripto, Emas,
  Properti & aset); portfolio screenshot import (read, never stored).

**FN-25b Wealth page parity** (owner request 2026-10-11): trend chart from FN-25's existing daily snapshots (1M/
3M/1Y/All, no new table), a stacked allocation bar + legend chips with debts shown as an honest separate line
(never a bar segment), a new `receivable` ("Piutang") asset kind, "Belum dihitung" suggestion cards (Emas, Dana
pensiun), one card per `kartu_kredit` wallet with its 30-day spend and statement/due day-of-month fields, grouped
Dompet/Investasi/Kripto sections, and an eye-toggle extension to every new figure; portfolio screenshot import
proposed deferred. PRD: `docs/features/fn-25b-wealth-page/PRD.md`.

### FN-26 Subscriptions (Langganan)

- **Mirror:** pick from 200+ ready services; billing day ("Tiap tanggal 12"); next bills list; calendar of all
  billing dates; monthly total.

### FN-26b Subscription check

- **Ours** (owner request 2026-10-11, "add subs tracker", with a screenshot of the reference app's Subscriptions
  page — mirror its behaviour only, never its name, mascot, copy or product names): a "Pemeriksaan langganan" card
  on `/langganan` that deterministically finds likely subscriptions already sitting in the user's own transactions
  — a known catalogue/brand service name, or an unrecognised merchant charged the same amount on a monthly/weekly/
  yearly cadence — and offers to add each one (pre-filled into the existing add form, never auto-added) or dismiss
  it ("Bukan langganan", remembered so it never reappears). No AI, no new capture source; reads only transactions
  already stored. PRD: `docs/features/fn-26b-subscription-check/PRD.md`.

### FN-27 Belongings (Barang)

- **Mirror:** photograph an item and AI recognises it; product-name search for the price (some apps query Google,
  Amazon and Bing from their server without the user's identity); purchase price and current value per item; total
  current value.

### FN-28 Collectibles (Koleksi)

- **Mirror:** trading cards and certain game items follow market prices; other items use a value the user sets;
  gain versus purchase price ("Naik 18 % dari harga beli"); item photos.

---

## Phase 5 — Connected apps, plans, trust

### FN-29 Connected apps

- **Mirror:** Settings › Aplikasi terhubung: Gmail (FN-19); Google Sheets (export a space's transactions);
  Google Calendar (reminders); Notion (monthly reports); Slack (messages in a chosen channel become drafts in the
  inbox, including other members' messages); each receives only what the user sends; disconnect any time.

### FN-30 Plans, credits, vouchers and billing

- **Mirror:** Free — manual, voice, receipt and statement capture; budgets and reports; Gmail 7-day look-back then
  hourly checks; 300 starter credits; unlimited assistant; 10 document uploads per month. Pro — 1,000 credits each
  month, Gmail look-back up to 12 months, hourly checks always on, unlimited uploads, more spaces incl. shared. Agent
  — Pro plus Agent (beta). Weekly or monthly billing; when a plan ends its features stop and data stays. Credit
  prices for Gmail look-back: 1 month 80, 3 months 250, 6 months 550, 12 months 1,000 (one-time). Voucher codes.
- **Ours:** our own prices and credit name (owner decision); Xendit or Midtrans.

### FN-31 Privacy, usage statistics and data rights

- **Mirror:** no ads, no third-party trackers, no data sale; Gmail data never used for ads, credit scoring or
  lending; self-hosted usage statistics (screens opened, button names, device type, language, country; no account
  id, e-mail, amounts, typed text or IP) with an opt-out in Settings › Statistik pemakaian; server logs without IP;
  data-copy, correction and objection requests by e-mail answered within 3×24 h; breach notice within 3×24 h;
  30-day notice before any shutdown.
- **Ours:** Analytics Engine for statistics; retention limits for import results and logs.

### FN-32 Public site, blog and legal pages

- **Mirror:** landing page (how it works, features, security, pricing, FAQ, ID/EN switch); blog with how-to
  articles per capture path, install guide and upload security; privacy policy; terms of use; a public
  delete-account page usable without the app.

---

## Later

### FN-33 Native apps

- **Mirror:** comparable apps also ship iPhone and Android apps (Expo push), with App Store billing rules in their terms.
- **Ours:** Play Store TWA first, then iOS Capacitor with native push, share extension and Face ID lock.

### FN-38 Public API

- **Ours:** no common-practice precedent; a versioned, Bearer-authenticated REST API
  under `/api/v1` for the owner's own scripts and the future native app (FN-33). Personal access tokens are
  created and revoked in Settings, shown once, stored hashed like sessions, each scoped read or read-write and
  optionally restricted to one space, with an expiry and a last-used time. Read endpoints cover spaces, wallets,
  categories, transactions (filtered, cursor-paginated) and budgets, plus the Laporan month summary; write
  endpoints create, edit and delete transactions, reusing FN-05's validation and FN-02's idempotent client ids.
  Rate-limited through the existing throttle; every call re-checked through the shared space-access helper; an
  OpenAPI 3.1 document at `/api/v1/openapi.json` plus a docs page. Never billing, auth, invites, account
  deletion, exports or AI through this surface.

### FN-39 Ride-hailing and food delivery options

- **Mirror:** FN-06's existing "category guessed from words, merchants" and FN-20's "ojek → Transportasi" already
  describe folding ride-hailing and food delivery into the generic Transportasi and Makan & Minum presets;
  FN-19's e-wallet sender list already names GoPay/Gojek and Grab.
- **Ours** (owner request 2026-10-08): two of their own preset expense categories, **Ojek Online** and **Pesan
  Antar Makanan**, instead of folding into Transportasi/Makan & Minum. One shared keyword table recognises
  gojek/goride/gocar/grab/grabbike/grabcar/maxim/ojol → Ojek Online and gofood/grabfood/shopeefood → Pesan Antar
  Makanan in voice, Slack drafts, CSV import and statement import (FN-16a) alike. Dompet's add-wallet form gets
  GoPay/OVO/ShopeePay/DANA quick-pick chips (GrabPay is OVO in Indonesia, no separate chip); Langganan's catalogue
  gains GoPay Plus, GoFood Plus and GrabUnlimited entries, prices left for the user to type as with every other
  catalogue entry. No brand marks, logos or mascots — service names as plain text only. PRD:
  `docs/features/fn-39-ride-hailing/PRD.md`.

### FN-40 Black-and-white theme, motion and isometric illustrations

- **Ours:** no common-practice precedent named for this one (the visual system is in
  `docs/design/DESIGN_SYSTEM.md`); owner request 2026-10-08. A 4th "Hitam-putih" (monochrome) theme next to
  Terang/Gelap/Sistem, following the system light/dark scheme while desaturating every token except
  `--money-in`/`--money-up`; short functional motion (page transitions, sheet slide, a counting Beranda number,
  charts growing in, staggered list rows, press feedback), Svelte-native only, fully removed under
  `prefers-reduced-motion`; original hand-drawn isometric SVG illustrations for empty states, sign-up/sign-in,
  Beranda's zero-wallet state and error pages, recolouring per theme via `currentColor`, behind an `<Illustration>`
  slot a Rive runtime can later replace (no `.riv` file or Rive dependency in this pass — the owner cannot author
  one here); and a glass ("Liquid Glass"–style) material on floating chrome (tab bar, sidebar, sheets, toasts,
  segmented controls/chips) with a documented ≤ 3-blurred-layer budget, a solid fallback under
  `prefers-reduced-transparency` or missing `backdrop-filter` support, and AA contrast against that fallback in
  every theme including mono. PRD: `docs/features/fn-40-visual-refresh/PRD.md`.

### FN-41 Integrations: per-user AI keys (BYOK) and an admin status view

- **Ours:** no common-practice precedent (comparable apps do not expose a settings page for bringing your own AI key); owner request
  2026-10-09 ("please add settings to add integrations"), with two owner answers: **per-user BYOK** — each user
  adds their own Anthropic API key in `/pengaturan/integrasi` and pays their own AI cost, sealed at rest with a
  dedicated server-held key (`AI_KEYS_ENCRYPTION_KEY`, the FN-29 `CONNECTED_APPS_ENCRYPTION_KEY` pattern, a
  separate secret), masked after saving, replaceable, removable, rate-limited "Tes koneksi" against the real
  Anthropic API through the app's AI Gateway route; and **admin = e-mails listed in the Worker secret
  `ADMIN_EMAILS`**, who get a read-only `/pengaturan/integrasi/admin` page naming which app-wide secrets (Web Push,
  connected-apps key, this feature's own key, support e-mail, AI Gateway id, billing mock) are configured —
  never a value. No AI feature calls Claude in this pass; it only provides the key other FN-15/16/17/19/20/22/23
  PRDs will read through `resolveAnthropicKey()`, and remains independent of the owner's own on-hold Anthropic-key
  decision (`docs/TASKS.md`). PRD: `docs/features/fn-41-integrations-byok/PRD.md`.

### FN-42 Version, updates and usage in Pengaturan

- **Ours:** no common-practice precedent named; owner request 2026-10-09 ("add version
  update and usage on settings"). Two read-only pages: `/pengaturan/tentang` shows the running `APP_VERSION` (the
  same value `/api/v1/health` reports), its release date and a bilingual "Apa yang baru" list bundled at build
  time from a new `src/lib/content/release-notes/` pair of files per release (kept separate from the engineering
  `CHANGELOG.md`), plus a PWA update control: an already-open tab shows "Versi baru tersedia — Muat ulang" only
  once a new service-worker build has finished installing (a first-ever install still activates silently as
  today), and a manual "Periksa pembaruan" button; reloading never drops an unsent FN-02 offline-queue item.
  `/pengaturan/pemakaian` shows the signed-in account's plan and credit balance/ledger (FN-30) and real usage
  against real limits for the current space — spaces, categories, API tokens, shared-space members, stored
  belongings/collectibles photos in R2 — never a fabricated "of N" where no ceiling or usage figure exists yet
  (connected apps, Gmail look-back), plus a static "Belum ada pemakaian AI" placeholder FN-41's BYOK keys will
  later fill in. No migration — every figure reads an existing table. PRD:
  `docs/features/fn-42-version-usage/PRD.md`.

### FN-43 Brand badges for wallets, imports and subscriptions

- **Ours:** no common-practice precedent named for this one; owner request 2026-10-09 ("add bank, ewallet, ride
  logo on the wallet and etc"). Orchestrator decision (legal, 2026-10-09): MONTRA does not copy or download any
  bank, e-wallet or ride-hailing company's logo artwork (trademarks, no brand-guideline permission yet,
  `CLAUDE.md`'s no-brand-copying rule); instead a shared brand registry (`src/lib/shared/brands.ts`) gives 15
  Indonesian banks, 7 e-wallets and 5 ride-hailing/food-delivery services their own rounded monogram badge (e.g.
  "BCA", "GoPay"), coloured close to — never a copy of — the real brand hue, built the same way FN-26's
  `InitialsTile` already draws every subscription tile (16 % tint, AA text in light/dark/mono), with a documented
  extension point for official logo SVGs if the owner later obtains brand-guideline permission (a **You**/legal
  item, not built this pass). Shows on Dompet's wallet rows, Langganan's catalogue picker and due-bills list, and
  Impor's statement-institution picker (matched by the existing `StatementParser.id`, e.g. `bca`); Alur uang's
  wallet bars take the matched brand's colour instead of the flat accent. A wallet or subscription gets its badge
  from its existing `name` text alone, matched live every render — no new column, no migration. Category tiles
  stay exactly as they are; native `<select>` wallet pickers, Riwayat/Beranda's day-grouped transaction rows and
  net-worth accounts are unchanged this pass (see the PRD's Out of scope). PRD:
  `docs/features/fn-43-brand-badges/PRD.md`.

### FN-44 Mascot ("Koin hidup")

- **Ours:** an original character by design (`docs/design/DESIGN_SYSTEM.md` forbids copying any
  other product's mascot), not a mirror. Owner request 2026-10-09 ("add
  mascot more montra like clawd"), answered the same day with the concept **"Koin hidup"**: a small pixel-art
  living coin with eyes and feet, drawn in Montra's accent colour on a 24×24 pixel grid, proposed name **"Koko"**.
  "Like Clawd" names the small-pixel-mascot *style* only (as Anthropic's Claude Code has one) — Koko's shape,
  palette and poses are original, never Clawd's or any other brand's character. A new
  `<Mascot pose>` component (`src/lib/ui/kit/Mascot.svelte`) with finite, `steps()`-animated poses — idle (with a
  bounded blink), wave, hop, celebrate, sad, sleep, and a loading cycle (the one pose allowed to loop, and only
  while work is outstanding) — takes over exactly the placements the owner named: the sign-up/sign-in hero and
  Beranda's zero-wallet moment (replacing FN-40's `welcome`/`wallet` illustrations there only), error pages
  (replacing `broken`), `EmptyState`'s previously text-only default (now `sleep` instead of nothing), three
  already-server-confirmed success moments (a transaction saved, a day closed, a budget's safe-to-spend turning
  positive), a new global navigation loading indicator, and the app icon/favicon — all generated deterministically
  by a checked-in script reusing the existing Playwright dev dependency, no new package. FN-40's nine other
  domain-specific isometric scenes (wallet-in-forms, budget, calendar, parcels, growth, goal, people, history,
  inbox) are unchanged, to avoid "double art." No migration, no space-scoped query change. PRD:
  `docs/features/fn-44-mascot/PRD.md`.

### FN-45 Camera and gallery photo picker

- **Ours:** no common-practice precedent named; owner request 2026-10-10 ("add camera and import gallery compatibility"). One
  shared `PhotoPicker` (`src/lib/ui/photos/PhotoPicker.svelte`) replaces the bare photo `<input type="file">` on
  Struk (FN-15, incl. the no-JS review form) and the Barang/Koleksi item photo field (FN-27/FN-28). On touch devices
  it shows "Kamera" (`capture="environment"`) and "Galeri"; on fine-pointer-only desktops "Pilih foto" plus a drop
  zone; both when unsure — feature detection via `matchMedia`, never the user agent. Without JavaScript it is the
  same single named input that posts as today; field names, form actions, server sniffing (`image.ts`) and limits
  are unchanged. Gallery compatibility: HEIC/HEIF is detected from the bytes and converted by the browser's own
  decoder where it has one (Safari), otherwise refused before upload with an Indonesian how-to-fix message (no
  decoder library; the server's HEIC refusal gets the same message); item photos over 8 MB or 2560 px are
  re-encoded on the device with EXIF orientation baked in (Struk keeps its 2576 px re-encode); several files →
  the first is used and the user is told. Impor's statement/screenshot OCR upload (`feat/fn-16g-ocr`) adopts the
  component after merge. No migration. PRD: `docs/features/fn-45-camera-gallery/PRD.md`.

### FN-46 Pro look

- **Mirror:** none (visual plan differentiation is a generic SaaS pattern).
- **Ours:** owner request 2026-10-11 ("Montra Pro unique design"), four parts the owner picked the same day: a Pro
  badge next to the account's name/avatar (sidebar, Pengaturan, `/pengaturan/akun`) plus a distinct Pro card with
  plan and WIB end date on `/pengaturan/paket`; two gated colour themes ("Gold", "Deep green") beside Terang/Gelap/
  Hitam-putih (FN-40), each following the system light/dark scheme, enforced server-side in `hooks.server.ts` from
  `user_plan_state` (FN-30) so a lapsed plan or a hand-edited cookie reverts to `system`, never trusted from the
  client; a Pro home-screen icon and a crowned Koko (FN-44) variant, honestly scoped to install/reinstall time (a
  PWA manifest and `apple-touch-icon` are read once, at install, by design — not live-updatable); and a premium
  background treatment behind Beranda's one big number, for Pro and Agen alike, never changing the figure, its
  size, or "one big number first". No migration — every check reads the existing `user_plan_state` table through
  `planOf`/`planStateOf` (FN-30). PRD: `docs/features/fn-46-pro-look/PRD.md`.

### FN-47 More currencies and decimal amounts

- **Ours:** no common-practice precedent named; owner request 2026-10-11. (FN-46 is a parallel "Pro look" visual pass on its
  own branch, not a currency feature.) Two parts. **More currencies:** `WALLET_CURRENCIES` gains `TWD`, `HKD` and
  `CNY` — picked up automatically by every wallet, budget, subscription and net-worth currency allow-list and by
  the Frankfurter-backed FX fetch (FN-25) with no migration (no DB `CHECK` on the currency column); the picker
  shows `CNY` as "CNY (RMB)" (owner decision), the other two as bare codes like every currency already live.
  **Decimal amounts:** every 2-decimal currency (USD, SGD, MYR, EUR, AUD, GBP, TWD, HKD, CNY) can be typed and
  edited to the cent — "," is the decimal mark in the Indonesian UI, "." in English (the other character groups
  thousands), capped at 2 fraction digits (refused past that, never rounded) — fixing a standing bug where an
  edited foreign-currency amount silently lost its cents. IDR and JPY keep today's whole-unit-only entry
  unchanged. PRD: `docs/features/fn-47-currencies-decimals/PRD.md`.

### FN-48 Categories for imported rows

- **Mirror:** none named for this one; owner request 2026-10-11, evidence from a real staging BCA wallet (33
  statement rows, 21 "Lainnya", 11 "Pemasukan Lain", 1 "Tagihan" — Indonesian bank mutation jargon like "BIAYA
  ADM", "TARIKAN ATM", "KARTU KREDIT/PL …", "TRSF E-BANKING DB/CR", "BI-FAST CR", "SWITCHING …" never matches
  FN-20's merchant-oriented dictionary).
- **Ours:** six new preset tiles (Biaya Bank, Pajak, Tarik Tunai, Kartu Kredit, Transfer keluar/masuk, Bunga, migration);
  a deterministic bank-narrative recognition layer added to FN-20's resolver, reading a row's raw words before
  the existing prefix-stripping removes the very words ("trsf", "tarikan", "bi fast", "db", "cr") this layer
  needs, wired into every FN-16/16g/17/18 import path that assigns a category today; FN-20's reason chip reused
  for the new layer; and a new "Rapikan kategori" review action that re-categorises existing rows still stuck in
  a fallback category — preview, confirm, one-step undo, never touching a category the user set by hand. No AI.
  PRD: `docs/features/fn-48-statement-categories/PRD.md`.
- **Part C — own-transfer matching** (`docs/features/fn-48c-transfer-matching/PRD.md`, owner request 2026-10-11):
  "Cocokkan transfer" on Impor pairs a Transfer-keluar debit in one wallet with a same-amount Transfer-masuk credit in
  another within ±1 day, confirmed per pair, merged into one FN-05 transfer with one-step undo (migration 0043).


### FN-49 Patungan (split bill)

- **Mirror:** LINE and GoPay's bill-splitting flow named only as a behaviour reference by the owner (request
  2026-10-11, "add feature to patungan per user like LINE and GoPay") — never their name, mascot, logo or copy;
  this is scoped against that behaviour description, not any screenshot of either app.
- **Ours:** a payer records a bill once and splits it among space members and/or named guests (no account
  needed) in four modes — equal (remainder to the payer), exact amounts (must sum to the total), per receipt item
  (reusing FN-15's already-parsed item lines, tax/service shared proportionally by a deterministic
  largest-remainder rounding), and percentage (basis-point precision, same rounding method) — three new tables
  (`patungan_splits`, `patungan_participants`, `patungan_share_links`) plus a `patungan` entry in FN-12's
  `feature_flags.module`. **Amended 2026-10-11:** a split can be **linked to the transaction that paid the whole
  bill** (e.g. an imported bank row); the transaction's stored `amount_minor` never changes, but two new nullable
  `transactions` columns (`patungan_split_id`, `patungan_effective_amount_minor`) make every aggregate — Riwayat,
  Beranda, Laporan (month/category/merchant/monthly), budgets/safe-to-spend, Alur uang, Tanya/Agent, and the
  public API's `/api/v1/laporan/ringkasan`/`/api/v1/transactions` summaries — count only the payer's own share for
  that row, through one shared SQL substitution in `src/lib/server/transactions/aggregate.ts` (the project's
  single existing "only functions that sum `transactions`" module, so every downstream caller inherits the fix
  without its own change). A standalone split (no transaction picked) now always creates the payer's own-share
  expense (no longer an opt-in checkbox). The payer's own expense counts only their own share, never the full
  bill — the others' shares are money the payer is owed, settled by a payer-only "Tandai lunas"/"Catat sebagian"
  action that never creates or alters a transaction (Montra never moves or invents money; auto-settling from an
  imported repayment is explicitly deferred). One read-only, unguessable, hashed, rate-limited, revocable, 30-day
  share link (`/patungan/bagikan/[token]`, works signed out, modelled on FN-03's invite-token pattern) shows every
  participant's name and amount plus the payer's typed payment details to anyone who opens it, never any other
  space data; WhatsApp-ready text alongside it. Counting unsettled shares on the Kekayaan ("Piutang") page is a
  deferred follow-up: it depends on FN-25c's `receivable` net-worth kind, which has not merged yet
  (`docs/features/fn-25b-wealth-page/PRD.md` pass 2); until then `/patungan` carries its own "Belum dilunasi"
  total. PRD: `docs/features/fn-49-patungan/PRD.md`.

### FN-50 Passkeys and bot check on sign-in

- **Mirror:** none (a bot check and passkeys are generic sign-in
  hardening). Owner request 2026-10-12 ("add passkey and cloudflare bot
  checker sign in on login").
- **Ours:** two parts. **Bot check:** Cloudflare Turnstile on `/masuk` and `/daftar`, verified server-side through
  siteverify (token single-use, `action` and `hostname` checked, 5 s timeout, fail closed) after the existing
  per-client throttle and before any password derivation; on only when both `TURNSTILE_SITE_KEY` (var) and
  `TURNSTILE_SECRET_KEY` (secret) are set — otherwise no widget, no check, and the admin status page says "Belum
  dikonfigurasi" (never a silent fail-open that looks configured). Turnstile is Cloudflare infrastructure already
  serving every request, not a third-party tracker; its script is allowed in the CSP of the two auth routes only.
  **Passkeys:** WebAuthn as a second way to sign in beside e-mail + password (every account keeps a password; no
  passkey-only accounts, no Google sign-in): register from `/pengaturan/akun/passkey` after re-proving the
  password, list and remove (up to 10), sign in from `/masuk` through conditional-UI autofill or a button;
  attestation `none`, ES256/RS256, challenges stored with a 5-minute expiry and single use, origin and rpId bound
  to the app host, counter rollback refused and recorded. Two new tables plus a content-free `auth_events` table
  (migration 0044; 0043 is FN-48c's). A passkey sign-in holds no account key (FN-21): a feature that needs it asks
  for the password once per page session through the existing key-material action (owner decision, option 1).
  Password change, API tokens, key material and account deletion keep demanding the password. PRD:
  `docs/features/fn-50-passkey-turnstile/PRD.md`.

### FN-51 More motion on phone PWA and desktop

- **Mirror:** none named (motion is generic UI craft); `docs/design/DESIGN_SYSTEM.md`
  § Motion stays the rulebook (quiet, ≤ 300 ms, `--ease`/`--duration-*` tokens, nothing under reduced motion).
- **Ours:** owner request 2026-10-12 ("add more animation on the PWA and Desktop side"), building on FN-40 Part 2
  and FN-44. A bounded set of purposeful animations for the phone PWA and the ≥ 1024 px desktop layout: the route
  transition gains an 8 px slide beside its fade (Web Animations on `<main>`, never the View Transitions API,
  taps never lost); Riwayat's appended day groups, the Impor batch an action just touched and Kotak masuk's
  discarded draft enter/leave with the existing row motion; Laporan's Donut, CumulativeChart and StackedBars,
  Kekayaan's TrendChart and AllocationBar and the Beranda/Anggaran progress bar draw in on mount (SVG draw, scale
  and opacity only); the loading Skeleton shimmers (the one new loop, confined to loading like MascotLoading);
  desktop-only hover/focus lift on tappable cards and a scale-in dialog; phone-only Tambah button rotation while
  the sheet is open; a one-time streak-chip hop when the count grows; client-only banners (install hint, what's
  new, update, offline queue) fade in instead of popping. Hard limits kept and tested: no animation library,
  transform/opacity/`stroke-dashoffset` only inside keyframes (a Vitest rule), nothing on first paint, every
  addition inside `prefers-reduced-motion: no-preference`, JS-driven motion skipped while `document.hidden`. No
  migration, no server query change, no new copy. Owner decisions (2026-10-12): subtle intensity; Koko waves
  "welcome back" once per WIB day in the installed app; pull-to-refresh in the installed app on Beranda and
  Riwayat. PRD: `docs/features/fn-51-motion/PRD.md`.

### FN-53 Quarterly and yearly money flow, and a net-worth report

- **Mirror:** none named (generic period reporting, not something read from the reference app); owner request 2026-10-13
  ("add quarterly and yearly moneyflow, net worth report"). Extends FN-35 and FN-25/FN-25b.
- **Ours:** Alur uang (`/alur-uang`) gains a **Bulan | Kuartal | Tahun** switcher (calendar quarters and years by
  the WIB `occurred_on` date; shareable `?p=`, `?k=2026-Q3`, `?y=` URLs, plain-link stepper, works without
  JavaScript): the same flow chart and breakdown aggregated over the period (7 categories per side and 6 wallets
  before "Lainnya" for a quarter or year), a rupiah comparison with the previous period (never percent), the average
  per month, and a per-month list that adds up to the total; one currency drawn, transfers, adjustments, deleted and
  `Data demo` rows left out, the current quarter or year running "so far" to today. A new **Laporan kekayaan** page
  (`/kekayaan/laporan`, Bulan | Kuartal | Tahun) reports the net-worth change from the stored daily snapshots only:
  opening and closing value, the change in rupiah, one point per month with gaps shown (never bridged), and the
  change by asset group (Dompet, Kas, Investasi, Kripto, Emas, Properti & aset, Utang) with the largest movers
  first. A missing snapshot is never invented: the opening value may be carried back at most 7 days with its date
  printed, otherwise the change is measured "sejak" the first record or shown as unavailable. The group split needs
  one additive column on the daily snapshot (`classes`, migration 0046) written by the jobs Worker from the
  deploy on, so older periods show the total change only. Amounts honour the eye toggle; free for every plan; no
  AI, no cache, no export. PRD: `docs/features/fn-53-period-reports/PRD.md`.

### FN-54 Greeting hero, calendar page, daily greeting and feature icons

- **Mirror:** owner request 2026-10-13 ("add greetings page and calendar update the app icon and placement"), with
  three screenshots of the reference app (local only): a time-of-day greeting hero on its home screen with the
  date, a one-line state, the month's spending, an ask-the-assistant field and two comparison chips; a small
  calendar date badge in the header beside the receipt and voice buttons; a once-a-day "on this day" story
  sheet; and a sidebar and feature grid where every item has its own icon on a coloured chip. Behaviour and
  layout structure only — never the reference app's name, mascot, illustrations, copy, brand colours or product
  names (`CLAUDE.md` no-brand-copying rule).
- **Ours:** four parts, built in order. **A:** one feature registry in `nav.ts` gives every sidebar and feature
  item a distinct glyph (Impor, Kekayaan bersih and Koleksi change; `sparkle` stays the AI mark) on a tinted chip
  using existing category hues (grey in mono), shown in the sidebar, the Fitur sheet and a new "Fitur" tile grid
  on Beranda that follows FN-12's flags; the home-screen app icon is **not** redrawn — it waits for the owner's
  logo file (`docs/TASKS.md`), only the swap path is prepared and documented. **B:** a greeting hero on Beranda
  (Selamat pagi/siang/sore/malam by the WIB hour, the date, "Belum ada catatan hari ini" or the day's count, the
  unchanged one big month figure, an ask field that prefills Tanya and sends nothing, a last-month comparison chip
  and a budget-left chip computed from stored rows, amounts masked by the eye toggle, and an original isometric
  skyline strip with a sun or moon that follows the time of day and a still Koko), a calendar badge showing the
  server's WIB date, and on desktop Struk and Suara moved into the header beside it. **C:** a `/kalender` page — a
  month grid of daily spending with closed days and the bills and recurring items still to come, a day detail that
  reconciles with Riwayat. **D:** an optional once-a-day greeting sheet built from the user's own figures, with a
  device cookie for "seen today" and a switch-off in Pengaturan › Tampilan, plus "on this day" cards only from a
  curated, owner-reviewed, cited file (no scraping, no model-written facts; the build ships with the entries the
  owner approves, possibly none). No migration by default; no AI call, plan gate or credit cost. PRD:
  `docs/features/fn-54-greeting-calendar/PRD.md`.

### FN-55 Credit cards and credit card e-statement import

- **Mirror:** FN-04 already names the wallet type "Kartu kredit" and wallet matching "credit card → card wallet"; the
  reference app's card handling beyond that is not read, so none is copied. Owner request 2026-10-13 ("add Credit card
  also, and add creditcard e-statement import parser").
- **Ours:** two parts, delivered in bounded passes (`docs/features/fn-55-credit-cards/PRD.md`). **Card wallet
  (FN-55a):** a `kartu_kredit` wallet gains an optional credit limit, statement day and due day (the FN-25c
  credit-card fields, same column names, migration 0047 planned; 0046 is FN-53's); a computed card page shows debt now,
  available credit in rupiah (never a percent), the last statement's printed balance, due date and printed minimum
  payment (shown as printed, never computed), what has been paid since that statement and what is still unbilled, and
  a "Jatuh tempo" chip; card spending counts on the purchase date as it does today, paying the bill is a transfer from
  a bank wallet (never an expense), and FN-48 Part C's "Cocokkan transfer" learns to pair an imported bank debit
  "KARTU KREDIT/PL …" with the card's payment line (credit dated 1 day before to 3 days after, confirmed per pair);
  fees, interest and the annual fee are expenses, a refund is income, a cicilan line is that month's expense with its
  marker kept in the note, a foreign purchase keeps the IDR amount billed with the original in the note; a card's
  negative balance counts as a liability in net worth with the total unchanged. **Card e-statement import (FN-55b and
  per-issuer FN-55c):** card statements are a new parser kind read through the FN-16 pipeline (text-layer PDF only,
  password used once and never stored, card number reduced to the last 4): the statement is imported only when
  previous balance − payments − credits + purchases + fees = new balance, every printed total equals its rows and
  every row is readable, else the whole file is refused and nothing is written (stricter than bank statements);
  a stored `card_statements` record per statement, statement-level dedupe, a card-specific duplicate rule, and
  statement-to-statement continuity. No issuer parser is written from guesswork: BCA, Mandiri, BNI, CIMB Niaga and
  OCBC are each "waiting for sample" until the owner supplies a real redacted e-statement; the infrastructure is
  proven with a test-only fictional issuer. No AI, no credits, no bank login, no advice. PRD:
  `docs/features/fn-55-credit-cards/PRD.md`.

### FN-56 ASCII field animation on sign-in and sign-up

- **Mirror:** none for the content (the reference app's auth pages are not read). Owner request 2026-10-13 ("Add ascii
  animation on login and register"), then a video of a third-party product page as a **style reference only**: a rounded
  panel of tiny monospaced letters shown only inside slowly morphing noise blobs, denser and brighter in the core. We copy
  none of its text, logo, brand or colour and use no code from it (`CLAUDE.md` no-brand-copying rule).
- **Ours:** one shared, decorative ASCII field on `/masuk` and `/daftar` (rendered once by the `(auth)` layout): the rows
  repeat Montra's own letters ("MONTRA", the digits 0-9 as a fixed ramp, "Rp") and appear only where a seeded value-noise
  field (pure function in `src/lib/shared`, `(t, cols, rows)` in, string rows out, deterministic and Vitest-checked) is above
  a threshold, so soft blobs drift, merge and split over about 10 s, with sparser, fainter glyphs at the edge and denser ones in
  the core. White glyphs in three opacity tiers on an electric-blue card in light (`--brand-surface`, owner decision 8;
  black in dark, near-black in mono; the app-wide blue accent is a separate feature, FN-57), Geist Mono with system monospace as fallback, text in `<pre>`s (no canvas, no library, no image, no network request) in a
  CSS-fixed box so nothing shifts: a 140 px band above the form on phone and tablet, a tall 360 x 560 px card beside the form
  from 1024 px. Drawn with `requestAnimationFrame` throttled to about 15 fps; the server renders one still frame (no JavaScript
  and `prefers-reduced-motion` show it); paused in a hidden tab and when off-screen; frozen after 60 s of played time.
  `aria-hidden`, no focus stop, no pointer events, never reacts to the form; the passkey button, the Turnstile widget and every
  form state are untouched. Koko's wide-screen hero stays beside it (owner decision 3, 2026-10-13).
  UI only: no migration, no server change, no new dependency, no new copy. PRD: `docs/features/fn-56-auth-ascii/PRD.md`.

---

## Second reference — CekSaldo (e-money card reader)

**Source.** ceksaldo.hamanto.com (home page, privacy policy) and its App Store listing (v1.0.14), read on
2026-10-26 (owner request: "Add feature from Ceksaldo.hamanto.com to montra research"). CekSaldo is a native iPhone and
Android utility that reads the balance and on-card history of Indonesian e-money cards by NFC tap, with no account.
**Mirror** = what CekSaldo does; **Ours** = what Montra would do and how it differs. The same rule applies as for
any reference: match behaviour, never brand — no copying of its name, icon, screenshots, copy or plan names ("Premium+",
"Community"), and no reconstruction of its app from bundles or network traffic.

**Already in Montra (no new FN):** a daily streak (FN-34), hidden amounts on Beranda and lists, CSV export (FN-18), a
weekly plan period (FN-30, `BILLING_PERIODS`), Indonesian and English UI.

**Platform limit (applies to FN-58 and FN-62).** Montra is a PWA. Web NFC only reads and writes NDEF tags, only in
Chrome on Android, and is absent from Safari on iPhone. Indonesian e-money cards (Flazz, e-Money, Brizzi, TapCash and the
others) answer ISO 7816 / FeliCa commands that a browser cannot send. Reading a card therefore needs the native apps of
FN-33 (Core NFC on iPhone, `IsoDep`/`NfcF` on Android), not the PWA.

### FN-58 E-money card balance and history (NFC tap)

- **Mirror:** tap a contactless e-money card on the back of the phone to read its balance and the history stored on the
  card; seven issuers (Mandiri e-Money, BCA Flazz, BRI Brizzi, BNI TapCash, KMT Commuter Line, JakCard/JakLingko, Bank
  Mega MegaCash); read-only (never tops up or changes a card); saved cards with a name, swiped between on Home; balance
  can be hidden; card details page; every read happens on the device and no account is needed; the card number is kept as
  read; a failed scan can be reported by the user, with raw NFC responses, through Telegram or WhatsApp.
- **Ours:** a new wallet type, *Kartu e-money* (`e_money`, migration), so a card's balance counts in net worth like any
  wallet. In the PWA (pass 1, no NFC): add the card by hand, record top-ups as a transfer from a bank or e-wallet, and fix
  the balance with a balance adjustment (FN-37). In the native apps (pass 2, after FN-33): "Tap kartu" reads the
  balance and the on-card rows on the device; rows become drafts with source `nfc` and a dedupe key built from the card,
  terminal and the card's own sequence number, so a second tap never doubles a row; a balance that differs from Montra's
  offers a balance adjustment instead of changing history; the card number is masked to the last 4 digits before it
  leaves the device (`CLAUDE.md` data rule), and raw NFC responses are never stored or sent. Issuers in the order owner
  samples arrive, one reader per issuer, each tested on a real card. Owner decisions: whether to build it, and when the
  native apps come.
- **Pass 1 built (2026-10-26):** owner chose the seven issuers above; the lead kept the card as `type = 'e_wallet'`
  with a nullable `wallets.emoney_issuer` (migration 0049, `ALTER TABLE … ADD`) instead of a new `e_money` type, so
  `wallets` is not rebuilt. The wallet form's "Kartu e-money" choice saves that pair; see HISTORY.

### FN-59 Toll and trip receipts

- **Mirror:** look up the online receipts of eight toll operators for a card over the last 7, 14 or 30 days (on request,
  the app sends the card number and date range straight to each operator's receipt site); trip records that join card
  rows with operator receipts; original receipts saved to Photos; a signed verification QR per toll or parking row, made
  by a cloud function and checked on a public verify page.
- **Ours:** not planned for now. It sends full card numbers to third-party sites that publish no API, and a fetch from
  our Worker would route those numbers through Montra's servers; the operators' terms are unknown. If the owner wants
  it later: toll rows from an e-money card (FN-58) get a *Tol* category suggestion, and receipts are only ever fetched
  on the device, per explicit request, never stored on our side. The verification QR is not mirrored: it puts the full
  card number in an image and needs a signing service for no use Montra has. Owner decision (and a legal read of the
  operators' terms) before any work.

### FN-60 Print and PDF export with receipts

- **Mirror:** export a card's history as PDF or CSV, or print it, with the original receipts attached; a combined export
  view; locations edited by the user appear in the export. Paid only.
- **Ours:** next to the FN-18 CSV export, a printable period report (Riwayat filter or a month) as HTML with a print
  stylesheet, so "Simpan sebagai PDF" in the browser makes the PDF with no PDF library; each row with an FN-15 receipt
  photo can include it on its own page. Generated on demand, never stored. Whether it is Pro only is an owner decision
  (FN-30).

### FN-61 Share a status image without the amount

- **Mirror:** share an image of the card's status that does not show the exact balance.
- **Ours:** "Bagikan" on the streak (FN-34) and the month summary: an image drawn on the device (canvas, no upload)
  with the streak, the month and words like "di bawah anggaran", never a rupiah amount; shared through the Web Share API
  where available, otherwise downloaded.

### FN-62 Voice assistant shortcuts and NFC automation

- **Mirror:** Siri and Shortcuts actions, an iOS NFC personal automation, and a ready-made Shortcuts template in
  Settings; optional spoken balances.
- **Ours:** in the PWA, manifest `shortcuts` (none today) for "Tambah transaksi", "Catat suara" and "Riwayat", which also
  give a Shortcuts "Open URL" target on iPhone; a "Bacakan" button on Beranda that reads the month's number aloud with
  the browser's speech synthesis (`id-ID`), off by default and never while amounts are hidden. Siri intents and NFC
  automation wait for the native apps (FN-33).

### Not mirrored

- **Community:** an opt-in public feed with profiles, a paid badge and shared location names. No social feed in
  Montra (`CLAUDE.md` product boundaries: no data sale, no ads; records belong to spaces).
- **Lifetime plan:** a one-time purchase next to weekly, monthly and yearly. Recorded as input for FN-30 pricing, an
  owner decision; no work.
- **Third-party analytics and crash SDKs:** CekSaldo uses Firebase Analytics, Crashlytics and RevenueCat. Montra keeps
  its own Analytics Engine statistics (FN-31) and no third-party trackers.
