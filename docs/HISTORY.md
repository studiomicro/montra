# MONTRA — History

Completed work and the test evidence log, kept as written at the time; entries describe the state on their date.
Entries before 2026-10-09 were written under an earlier working title.
Open work: `docs/TASKS.md`. What is verified and how: `docs/ACCEPTANCE.md`.

## Completed work

- **FN-58 pass 2 groundwork: Android app, read-only NFC bridge, KMT reader (2026-10-26)** — owner decisions 2026-10-26:
  Android first, command formats from public sources checked against the owner's real-card logs. `native/android-app`:
  Capacitor 8.5.3 shell (app id `id.montra.app`) loading the web app from `MONTRA_APP_URL`, and `MontraNfcPlugin.java`,
  which connects to a tapped card (ISO-DEP or FeliCa) and passes only read commands (ISO 7816-4 SELECT, READ BINARY,
  READ RECORD, GET DATA, GET RESPONSE; FeliCa Polling, Request Service, Request Response, Read Without Encryption,
  Request System Code); the UID never reaches the page. `src/lib/shared/emoney`: the same lists (a test compares them
  with the Java file), standard probes, and a KMT balance reader (system 90B7, service 0x1017) written from Metrodroid's
  GPL-3.0 decoder and Sony's FeliCa manual as references. `/dompet/diagnosa-kartu` reads a card, shows a KMT balance
  and copies a log with the IDm and long digit runs masked; Dompet links to it only inside the app. Research and
  source register: `docs/features/fn-58-emoney/RESEARCH.md` (Mandiri medium confidence but its earliest licensed
  source is decompiled; Flazz tainted; Brizzi and Flazz Gen 1 need keys; MegaCash has nothing public). Checks: debug APK
  builds (JDK 21, Gradle 8.14.3); Vitest for the guard and KMT frames (fictional frames); `e2e/diagnosa-kartu.spec.ts`
  with a fake bridge. Not verified: any real card or phone.
- **FN-58 pass 1 "Kartu e-money" wallet (2026-10-26)** — owner decisions 2026-10-26 (seven issuers), design by the
  lead. The wallet form's type picker gains "Kartu e-money": it saves `type = 'e_wallet'` with the chosen issuer
  (Mandiri e-Money, BCA Flazz, BRI Brizzi, BNI TapCash, KMT (KAI Commuter), JakCard / JakLingko, MegaCash; a picker
  that is required for this choice and refused with any other type or an unknown key) and the optional last 4 digits
  (never a full number). Seven quick picks (`?tambah=1&kartu=<issuer>`, no JavaScript needed) fill the name, the
  choice and the issuer; no brand badge (none exists for these cards). Dompet rows, archived rows and Kekayaan's
  wallet list show "Kartu e-money · BCA Flazz". Balance, top-ups (transfers), the FN-37 adjustment and net worth work
  as for any e-wallet. Migration 0049 adds the nullable `wallets.emoney_issuer` with `ALTER TABLE … ADD` and a column
  CHECK (null unless `e_wallet`, else one of the seven keys); no rebuild, no backfill. Archiving a wallet keeps the
  issuer, like `last_four` and the 0047 card columns (an archived wallet is restorable; wallets do not clear content
  on archive). The data export carries the new column. NFC reading (pass 2) waits for the FN-33 native apps. Checks:
  `npm run check`, `npm run lint`, `npm run build`; `npm test` 6624 passed and 1 failed (the export row test, fixed),
  then a second full run 6620 passed and 5 timed out under a machine load average near 30 (`koleksi`, `net-worth`,
  `recurring`), each file passing when re-run alone; new tests: `migration-0049.test.ts` (3), validation (5),
  WalletForm (4), wallets repo (3), dompet routes (2), net worth (1). e2e phone + desktop: `kekayaan.spec.ts` (with the
  new e-money journey) and `kartu-kredit.spec.ts` 26 passed, 3 skipped; `kekayaan-halaman`, `kekayaan-bersih`,
  `qa-fn43-brand-badges`, `alur-uang` 20 passed, 3 skipped. NOT verified: staging (0049 not applied remotely).
- **Galaxy Z Fold layout coverage (2026-10-26)** — owner request. `e2e/ios-responsive.spec.ts` also runs on Chromium
  (Android Chrome's engine) with Playwright's presets: `android-fold7-cover` (360 × 764, phone layout),
  `android-fold7-open` (984 × 1016) and `android-fold6-open` (928 × 1004), both on the 860 px tablet tier with two
  columns. Unfolded and turned (1040 / 1028 px) is the desktop layout, covered by the `desktop` project. No app change
  was needed. Checks: the 3 new projects plus `ios-17` and `ios-duo-open-landscape` (5 passed), `npm run check`,
  `npm run lint`.
- **FN-57 app-wide electric-blue accent (2026-10-26)** — owner request 2026-10-13, decisions 2026-10-26: hue
  `#0B3DF5` (the FN-56 auth card), light theme only (dark keeps the ink fill), Hitam-putih, Emas and Hijau tua
  unchanged; scope primary buttons, Tambah, the current tab and sidebar item, switched-on toggles, selected chips,
  pills, tiles, radios and checkboxes, the calendar badge, and links and the focus ring. New tokens `--action` /
  `--on-action` in `docs/design/tokens.css` (blue/white in light, `--ink`/`--bg` elsewhere); `--brand` moves to the
  same blue for links and focus. Status marks (badges, streak days, the unread dot, test-mode notes, chat bubbles)
  stay ink; the public site is untouched. DESIGN_SYSTEM principle 6 rewritten. `test/contrast.test.ts` checks
  `--on-action` on `--action` ≥ 4.5 and `--action` on `--bg`/`--panel` ≥ 3 in all nine theme layers, and that blue
  is the light theme only. Also: `scripts/e2e-build.sh` falls back to a mkdir lock where `flock` is missing (macOS),
  and `e2e/kekayaan-halaman.spec.ts` checks one column at 840 px (the 860 px tablet tier keeps two). Checks:
  `npm run check`, `npm run lint`, `npm test` (6607 passed), `npm run build`, full phone + desktop e2e (693 passed,
  95 skipped, 11 failed; after the test fix, the 6 still failing (`period-reports` ×3 and `period-reports-qa`, `motion` reduced
  motion) fail the same on main 3867a6f, and the rest were D1 CLI and timing failures under load that pass alone).
- **Foldable and new-iPhone auto layout (2026-10-26)** — owner request. New tablet tier from 860 to 1023 px (no
  sidebar, tab bar stays): Beranda, Dompet, Anggaran, Laporan, Impor and Kekayaan show both columns, and the shell
  widens a two-column page to the full width. This covers iPhone Duo unfolded and turned (890 px) and iPhone 17 /
  17 Pro / 18 Pro turned (874 px). Folded Duo (466 px), unfolded upright (626 px) and upright iPhones (402 px) keep
  the phone layout. New WebKit projects `ios-17`, `ios-17-landscape`, `ios-duo-folded`, `ios-duo-open` and
  `ios-duo-open-landscape` run `e2e/ios-responsive.spec.ts`, which now also asserts the column count. Checks:
  `npm run check`, `npm run lint`, `npm test` (6589 passed), `npm run build`, and the 7 iOS projects (7 passed).
  Duo safe-area insets are emulated, not measured; only a real device can confirm them.
- **Whole-app design polish (2026-10-15)** — owner request. 51 screens and 2 sheets audited at 360 and 1280 px,
  light and dark, on a local build with fictional non-demo data (`docs/design/POLISH_AUDIT.md`, § Status per
  finding). Fixed 20 of 24 fully, 3 partly: page header actions, record-row meta wrapping, one link style, Dompet
  wallet line spacing, category names in Laporan, daily bar scaling and dark bar contrast, dark heat steps, Alur uang
  big number and flow labels, yearly average label, empty-account layout. Owner decisions: no 1 px frame on fields
  and secondary buttons (design system; 2 px focus ring kept), Struk primary over Suara on Beranda. New unit tests
  (`screen-title.test.ts` and cases in chart-scale, BarChart, flow geometry, formatDayHeader, row-text, wealth-ui;
  15 fail on the unfixed code); e2e beranda, beruntun and kalender updated. NOT verified: real devices, mono and Pro
  themes, 601–1023 px, Langganan, Barang, Koleksi, Patungan, Agen and the public site.
- **FN-48d transfer auto-match (2026-10-15)** — owner decision 2026-10-15 (all six PRD defaults accepted): right
  after a statement import commits, its unambiguous own-transfer pairs (both rows in the transfer tile, exact amount
  and currency, two wallets, WIB dates within ±1 day, no other candidate sharing either row) merge by themselves
  through FN-48c's merge, link and undo, at most 20 per import; card payments stay manual; an undone auto-merge is
  never applied again (`transfer_links.source`); the merge re-checks ambiguity, card pair and undo memory at write
  time. `/impor` says how many were matched; Cocokkan transfer badges them "Otomatis". Migration 0048 (`source`
  column + partial index `transactions_space_amount_idx`). Tests: `transfer-auto-match.test.ts` (17),
  `migration-0048.test.ts` (4), 6 `chooseAutoMatches` unit tests. Red team L1 (count under-reported after a throwing
  merge) fixed with a regression test; L2 open. NOT verified: staging (0048 not applied remotely), browser look of
  the line and badge. `docs/features/fn-48d-transfer-auto-match/`.
- **Net worth report trend (2026-10-15)** — months before the space's first record are no longer drawn as gaps when
  no snapshot exists before the period; an opening taken inside the period is labelled by its date, not "Awal".
- **OCBC Rekening Koran summary currency without rows (2026-10-14, v0.16.1)** — a summary currency with no table
  block (SGD sub-account without movement) no longer refuses the file.
- **Blueprint isometric illustrations (2026-10-14)** — owner request, style mirrored from a reference studio site
  (no artwork, logo or object copied). The shared isometric material becomes near-flat faces with a hairline edge
  (accent and gold edges in their own colour, device the one solid ink block); every `<Illustration>` scene stands on
  a faint ground grid with dashed construction lines and diamond corner handles instead of the soft shadow, and
  Beranda's HeroScene city stands on a blueprint street band (still ≤ 40 shapes and 8 KB). Theme tokens only, so
  light, dark, mono and Pro themes repaint. Gates: lint, check, test 387 files / 6545 tests, build. Checked in a light
  and dark render of all 11 scenes and the strip. Not verified: in-app pages, real phones, 200 % zoom.

- **BNI and OCBC statement fixes (2026-10-13)** — owner-reported files that were refused as `inconsistent`. BNI:
  rows now print English month abbreviations (`01 Aug 2026`); the parser accepts `May`, `Aug`, `Oct`, `Dec` next to
  the Indonesian ones. OCBC Rekening Koran: the summary can follow the last row on the last table page; its opening
  (`Mata Uang /`, `Currency`, `Tunggakan Bunga /`) now ends the table, and a copy of it in a note still refuses the
  file or only trims that note. 4 regression tests on fictional fixtures (fail before, pass after). Local
  `compat:statements` on the owner's files: BNI August 59 rows, OCBC January IDR 7 rows, OCBC April IDR 21 rows, all
  balance check pass with a Rp0 gap; SGD sections listed as unsupported. Not verified: an upload on staging.

- **Liquid glass material (2026-10-13)** — the shared `.glass` material moves toward Apple's liquid glass: a
  clearer fill (`--glass-bg` 78 % to 64 % in every theme), a deeper blur (16 to 24 px, saturate 200 % where themes
  saturate), a top light sheen and a specular rim (bright top edge, faint lower edge), light only. `.glass-soft` and
  every solid fallback (reduced transparency, no backdrop-filter, under a sheet) unchanged. Glass budget, contrast
  and shell tests pass; checked in a light and dark render over busy rows. No refraction (SVG displacement in
  backdrop-filter is Chromium only). Not verified: real iPhone and Android, 200 % zoom.

- **Dead code cleanup (2026-10-13)** — knip pass: 363 `export` keywords nothing imported were dropped across 176
  files, then 27 symbols that became unused were deleted (for example `getBelonging`, `countRules`,
  `receiptDedupeKey`, `GMAIL_REASON_LABELS`, test helper `deflateBomb`) with their orphaned imports. Four versioned or
  type-feeding constants and two symbols the jobs Worker imports stay exported. No behaviour change. Gates: lint
  clean, check 0 errors and 0 warnings, test 387 files / 6541 tests. 18 merged worktrees under
  `montra-worktrees/` removed (branches kept) and 3 merged branches deleted; `fn-52-languages` (unfinished) and
  `lows-batch-1` (uncommitted screenshots) kept.

- **FN-56 Auth ASCII field (2026-10-13)** — a decorative field of tiny monospaced glyphs ("MONTRA", digits, "Rp")
  shown only inside slowly morphing value-noise blobs, on /masuk and /daftar: a 140 px band above the form on phone,
  a 360×560 card beside the form (Koko kept) from 1024 px. Brand-blue card in light, black in dark (new tokens
  `--brand-surface` / `--on-brand-surface`, 7:1); pure seeded generator `src/lib/shared/ascii-field.ts`, rAF player
  at about 15 fps that pauses when hidden or off-screen, freezes after 60 s and shows one server-rendered still
  frame under reduced motion. No migration, no new dependency, +2 KB gzip. Small tier: engineer plus orchestrator
  review (2 cycles: density, glyph size, coverage, right-edge clipping). Not verified: real phones with Geist Mono
  loaded or blocked, 200 % zoom. The app-wide blue accent is FN-57.
- **FN-55 Credit cards and card statement import, Parts a and b (2026-10-13)** — credit card as a wallet kind
  (limit, statement and due day, card page, due chip, bill payment as a transfer paired with imported "KARTU KREDIT/PL"
  debits, card debt on Utang); card statement import infrastructure that refuses a statement as a whole on any
  inconsistency, with row-date bounds, masking and card dedupe, proven with a test-only fictional issuer. Migration
  0047. QA PASS and red team PASS in cycle 3. Issuer parsers (FN-55c) wait for samples.

- **FN-54 Greeting hero, calendar, daily greeting and feature icons (2026-10-13)** — feature icons on coloured chips
  and a Fitur tile grid; a WIB-time greeting hero with vs-last-month and budget-left chips and Montra's own scene;
  `/kalender` from the date badge (figures equal to Riwayat, closed days, bill marks); a once-a-day sheet from the
  user's own figures with an off switch; an empty, validated "on this day" file. No migration. QA PASS and red team
  PASS in cycle 2. Not verified: real devices, screen reader, staging; home-screen icon waits for the logo.

- **FN-53 Quarterly and yearly money flow and net worth report (2026-10-13)** — Alur uang gets Bulan | Kuartal |
  Tahun with link stepping (no-JS), bounded aggregation, "Lainnya" folding, a rupiah comparison with the previous
  period and average per month; `/kekayaan/laporan` reports opening, closing, monthly trend and change by asset group
  from stored snapshots only (carry-back ≤ 7 days, gaps never bridged). Hidden amounts also hide direction. Migration
  0046 (`net_worth_snapshots.classes`). QA PASS and red team PASS in cycle 2. Not verified: staging.

- **Open source: public release (2026-10-13)** — https://github.com/studiomicro/montra (the owner's
  studiomicro/strategies, backed up, force-pushed and renamed) holds one commit, "Montra: initial public release",
  built by `~/Documents/projects/montra-export-tools/export.sh` from main 7d9ac3b: real ids, hosts, bookmarks, local
  paths, personal data and reference-app mentions scrubbed; the private repo keeps the originals. Description and
  topics set. Not verified at release time: the first GitHub CI run.

- **Fix: open lows outside import before going public (2026-10-13)** — FN-19 Gmail (AI read cap per connection on
  a sliding window, token re-seal plus an hourly sweep, captures never verified), FN-19 forwarding masking, FN-20 (AI
  merchant name only as a "Pakai nama" suggestion, sliding hourly cap), FN-22 and FN-23 (normalised answer guard and
  lure filter, run deletion counts, status scoping, report CSP hash), FN-25b (hidden amounts cover trend and shares,
  applied before any figure), FN-30 address normalisation, FN-34b reminders, FN-45 drop handling, FN-47 guard and
  copy, account-number masking; accepted items keep their rationale. Migration 0045. QA PASS and red team PASS after
  two cycles; leftovers logged. Still owner items: FN-13b provider, FN-23 S7, FN-30 `CLAIM_HASH_KEY`.
- **Fix: Pro accounts no longer see the voucher upsell (2026-10-13)** — the sidebar's "Montra Pro · Punya voucher?"
  card shows only on Gratis (`test/pro-look-ui.test.ts`, failed before; shell e2e 43 passed).

- **Fix: open import lows before going public (2026-10-13)** — every open low of FN-16a, 16b, 16c, 16d, 16f, 16g,
  16h, 16j, FN-17 and FN-48 Parts A and C is fixed with a regression test or accepted with its report's rationale:
  sliding upload throttle counting only accepted uploads, byte-charged statement lane, forged BCA header refused,
  BCA CSV quote/comma/`=` remarks, OCBC row starts from per-page positions, OCR asset and HEIC checks, FN-16j
  `source_archived` and 404 for a removed member, bank-only category words, FN-48C undo paging and deleted merges,
  CI `.ocr-cache`. No migration. QA PASS and red team PASS after two cycles. Not verified: the owner's sample PDF,
  `test:pdf-workerd` (Linux only), the CI cache on GitHub.

- **CI/CD with GitHub Actions (2026-10-13)** — CI on pull requests and `main` (check, lint, sharded Vitest,
  build, Playwright on chromium and webkit with a fresh local D1), CodeQL, Dependabot, actions pinned to SHAs. CD to
  staging only, on a `v*` tag of a commit on `main`, behind the `staging` environment's reviewer, skipped when that
  version already runs. Real Cloudflare ids, the staging host and the Turnstile site key moved out of committed
  configs into environment values or the gitignored `.staging.env`. Red team PASS in cycle 2 (cycle 3 fixed two of
  its lows). Not verified: no workflow has run on GitHub; the token scope is untested against a live deploy.

- **FN-50 Passkeys and bot check on sign-in (2026-10-13)** — passkey sign-in, add and remove in Pengaturan › Akun
  (hand-rolled WebAuthn verifier on WebCrypto, ES256/RS256, attestation none, single-use 5-minute challenges, exact
  origin and rpId, counter rollback refused); after a passkey sign-in the password is asked once per page session to
  open the account key; removing a passkey revokes its other sessions. Cloudflare Turnstile (managed, visible) on
  /masuk and /daftar, checked after the throttle and before PBKDF2, fail closed when configured, absent when the
  keys are unset. Migration 0044. Tests: verifier, flow, turnstile unit and integration, `passkeys.test.ts`,
  `e2e/passkey.spec.ts`, `e2e/turnstile.spec.ts`. QA PASS, red team PASS (5 lows). Not verified: real Turnstile keys
  on staging, a real-device passkey, Safari and Firefox.

- **Open-source preparation, part 1 (2026-10-13)** — owner decision to publish under AGPL-3.0 as a fresh public
  repo. Added `LICENSE` (AGPL-3.0 verbatim), `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor
  Covenant 2.1), `SECURITY.md`, `docs/SELF_HOSTING.md`, issue and PR templates, `"license": "AGPL-3.0-only"`; a
  "Kode sumber" link on Pengaturan › Tentang from an optional `SOURCE_URL` var (AGPL §13; unset shows "Belum
  dikonfigurasi"). The owner's name in fixtures and PRDs became a fictional one; the company name, e-mail and one
  account id in docs became placeholders. Tests: `test/release-pages.test.ts` (+2). Not done yet: Cloudflare ids out
  of the wrangler configs (CI/CD branch), the sanitised export (bookmarks, paths, reference-app mentions).

- **FN-48 Part C own-transfer matching (2026-10-13)** — "Cocokkan transfer" on Impor: finds same-amount Transfer
  keluar / Transfer masuk rows across two wallets of a space within ±1 WIB day (newest 200 pairs, true total shown),
  the user confirms each pair, the pair merges into one transfer row, and undo restores both rows exactly. Import undo
  settles the links of its rows (the other import's row comes back, also into an archived wallet; a note shows when
  the user edited the merged transfer); FN-16j refuses to move a batch with a live link (`transfer_linked`).
  Migration 0043. Tests: `cocokkan-transfer.test.ts`, `cocokkan-transfer.qa.test.ts`, `migration-0043.test.ts`,
  `match.test.ts`, `e2e/cocokkan-transfer.spec.ts`, `e2e/cocokkan-transfer-move.qa.spec.ts`. QA PASS, red team PASS
  in cycle 3 (cycles 1 and 2 failed on M1–M3). Not verified: staging and the owner's sample rows.

- **FN-51 More motion on phone PWA and desktop (2026-10-12)** — subtle route transition, list enter/exit (Kotak
  masuk row exit), chart draw-in on Laporan and Kekayaan, skeleton shimmer, desktop hover/focus lift without shadow
  and scale-in dialog, phone Tambah button rotation, streak-chip hop, banner fade-in, Koko welcome-back wave once per
  WIB day and pull-to-refresh on Beranda and Riwayat (installed app only). All inside `prefers-reduced-motion:
  no-preference`, transform/opacity/stroke-dashoffset only, paused while hidden. No migration. Tests:
  `test/motion-css.test.ts`, `src/lib/ui/motion.test.ts`, `pull-to-refresh.test.ts`, `e2e/motion.spec.ts`. QA PASS,
  red team PASS (2 lows). Not verified: CLS and 60 fps on a real Android phone.

- **FN-16j Move an import to another wallet (2026-10-11)** — owner request after statements landed in
  the wrong wallet. Impor › Riwayat impor gets "Pindahkan ke dompet lain" next to Urungkan: pick a live wallet of the
  same space and currency, confirm; every live row of the batch and the batch's own `wallet_id` (FN-48B continuity)
  move in one guarded `db.batch` (`moveImportBatch` in `src/lib/server/imports/repo.ts`; seq and `updated_at`
  bumped; live membership re-checked in the write; audit `import_batch_moved`). Owner decisions: a transfer that
  would become from = to is skipped and counted; a batch whose live rows are not on one wallet is refused with a
  reason. Migration 0042 rebuilds `audit_events` to widen its action CHECK. Tests: `imports-move.test.ts` (16, two
  users and two spaces, 20-way race), `migration-0042.test.ts` (2), 4 e2e specs in `impor.spec.ts`. QA PASS, red
  team PASS with 2 lows (TASKS). NOT verified on staging.
- **Fix: BCA PDF row wrapped on a dated line (2026-10-11)** — owner report: a real BCA e-Statement was
  refused as "does not match its printed balances". A transfer row's wrapped description had a line starting with
  `DD/MM` (`TANGGAL :09/03`, then `09/03 /ZW7Q1/00000`), which `segment()` in `src/lib/shared/statements/bca.ts`
  read as a new row, leaving the real row without an amount. Now a `DD/MM` line starts a new row only once the open
  row has its amount line; reconciliation rules unchanged (any mismatch still refuses the whole file). Regression
  test "a wrapped line that starts with a date continues the open row until its amount line"; red-team M1 tests
  updated (a dated remark stays in the description; one carrying an amount is unreadable). Verified locally against
  real BCA PDFs: all read, printed balances chain month to month. No migration.
  NOT verified: the re-import on staging.
- **UI audit "Audit everything", Koko v2, phone settings entry (2026-10-10/11)** — owner requests. Merged on
  `integrate/2026-10-10`.
  - Koko v2 (625277c): a cuter pixel coin (round dark eyes with a glint, pink cheeks, lit side), new pixel classes
    coloured from tokens (`light-dark()`, `color-mix()`); icons and splash screens regenerated.
  - Phone settings entry (05837b8): gear on Beranda's top bar; plus every sub-page now has a ScreenTitle `back` link.
  - Audit: every (app) page captured at phone light/dark and desktop light, reviewed against APP_PARITY and
    DESIGN_SYSTEM (81 findings). Batch 1 (shared): back links, scrolling sidebar, field/Badge hairlines, GroupList
    inset, Tambah sheet rows, Beranda top bar, dark illustration floor. Batch 2: Impor in one card (phone page
    13,000 → 2,800 px), core money pages (neutral compare line when the previous month has no data, compact Riwayat
    filters), feature pages (Kekayaan hero, Tanya composer, show/hide password), settings pages (Paket cards,
    Kategori icon toggles, release notes as bullets, API docs index). The install guide keeps the sidebar space card
    when signed in (`isAppRoute`).
  - Fix found by the merged e2e run: Batal while the OCR engine was still downloading left the engine's worker
    alive once it started (`runOcr` now terminates a late engine; `pipeline.test.ts`).
  - Skipped (owner decisions): "Lupa kata sandi" (the password unwraps the account key, needs a recovery design)
    and the draft legal notes.
  - Evidence: `npm run gates` passed (313 files / 4550 tests before the last fix); full Playwright run 566 passed,
    75 skipped, 4 failed, of which tabungan (duplicate back link) and impor-ocr (worker leak) were fixed and pass, and
    offline-queue passes on rerun.

- **Fix: FN-19 Gmail red team L1–L4 (2026-10-10)**: branch `fix/gmail-lows` (from `integrate/2026-10-10`), not
  merged. Migration `0035_gmail_lows.sql` adds `gmail_revocations` and `inbound_mail.draft_id`.
  - L1: the 90-day Gmail ledger sweep keeps a row while its draft is pending, so "Putuskan Gmail" always discards it.
  - L2: account deletion tombstones the account's pending Gmail and forwarded drafts in shared spaces that stay.
    Forwarded drafts are linked through the new `inbound_mail.draft_id`; drafts captured before 0035 stay unlinked.
  - L3: a space purge and account deletion queue the sealed token. The jobs tick (`processGmailRevocations`) revokes
    up to 20 per tick, with up to 48 tries; rows older than 7 days are dropped. A grant the user's current connection may share is dropped without a call.
  - L4: a second authorization for another known Google account queues the replaced grant. The stored address is the
    one read now (null when unknown).
  - Tests: `test/integration/gmail.test.ts` › "red team lows L1–L4" (6 tests). Each failed before its fix (recorded
    in `SECURITY_REPORT.md`).
  - Evidence: targeted Vitest passed (gmail, gmail-qa, forwarding, delete-account, drafts, spaces, export, jobs).
    `npm run check` 0 errors, `npm run lint` clean, `npm run test` 304 files / 4439 tests passed, `npm run build`
    done. After the review fixes: check and lint clean, build done. The full test run had 8 failures in untouched files
    (Miniflare ECONNRESET and timeouts at load average 67); those files passed when re-run, and gmail.test.ts passed
    46/46.
  - NOT verified: real Google revocation.
- **Geist font (2026-10-10)** — branch `feat/geist-font` (from `integrate/2026-10-10`), not merged; owner request
  "adjust the font, add Geist font"; tier Low, no migration. Package `geist@1.7.2` (npm `latest`, published 2026-06-01,
  tarball integrity checked), SIL OFL 1.1, text kept as `OFL.txt` beside each file. Added
  `static/fonts/geist/1.7.2/Geist-Variable.woff2` (69,652 B) and `static/fonts/geist-mono/1.7.2/GeistMono-Variable.woff2`
  (71,368 B), unmodified; the package ships one variable file per family (wght 100-900, Latin + Latin-Ext), so no
  `unicode-range`. Checked with fontTools: U+2212, U+2013/2014, U+2026 and `tnum` are in Geist, so rupiah columns and
  the minus sign need no fallback. `@font-face` (swap) in `src/app.css`; `--font` is `'Geist', system-ui, -apple-system,
  'Segoe UI', Roboto, sans-serif` and the new `--font-mono` token replaces seven ad-hoc `ui-monospace` stacks (keys and
  code samples only); `<link rel="preload" as="font" crossorigin>` in `app.html`; `static/offline.css` uses the same file.
  CSP unchanged (`font-src 'self'` already covers it). `_headers`: `/fonts/*` immutable for a year. Service worker
  (`sw-policy.ts`): precaches only the preloaded Geist file (70 KB); Geist Mono, licence texts and later versions stay
  in the HTTP cache. Docs: DESIGN_SYSTEM § Typography and APP_PARITY record the decision; CLAUDE.md UI line updated.
  - Fit: Geist is 1-5 % wider than the system stack. Probed 11 screens on WebKit at 375, 430 and 360 px with the long
    wallet, long merchant and Rp 1.264.255.000 data, Geist against the system font: no new clipped text; the hero figure
    fits. One element already overflowed before the change (Laporan heat-map cell detail "100% · Rp126 jt/hari",
    visible overflow, no scroll), left alone. No size or tracking token changed.
  - Tests: `test/font.test.ts` (7), `src/lib/shared/sw-policy.test.ts` (+2), `e2e/font.spec.ts` (body computed
    font-family starts with Geist, file served from the app origin with `font/woff2` and `immutable`, `document.fonts`
    loaded, no foreign font request, no CSP violation).
  - Evidence: `e2e/font.spec.ts` phone and desktop 5/5; `e2e/ios-responsive.spec.ts` ios-se and ios-pro-max 2/2;
    `e2e/shell.spec.ts` 40 passed, 1 skipped; `e2e/pwa.spec.ts -g 360` phone 10/10. NOT verified: a real device.
- **ios-responsive: iPhone responsive pass and phone layout v3 (2026-10-10)** — branch `fix/ios-responsive`, not merged;
  tier Medium, no migration. Audit in Playwright WebKit (iPhone SE 375×667, 15 393×852, 15 Pro Max 430×932, 15 landscape
  852×393; light and dark; emulated notch and home-indicator insets; 49 screens, 392 page states) with a wallet named 50
  characters long, a 120-character merchant and −Rp 1.264.000.000: `docs/features/ios-responsive/AUDIT.md`. Fixed: wallet
  `<select>` and picker grids widening the page by up to 130 px (Riwayat baru/edit, Berulang baru, Impor), Beranda hero
  figure breaking before its last digit, a truncated purchase price (Koleksi), 40 px targets (avatar, hide-amounts eye,
  chart link, "Batal"). Phone layout v3 (APP_PARITY § 3b): `TabBar` is an icon-only glass pill bottom-left plus a round ink
  "+" bottom-right, `Chip` outlined/ink, `ScreenTitle` text links and square "+", `GroupList records` rows with a 48 px
  tile and a label over the amount (Riwayat, Beranda, Dompet, Langganan, Kotak masuk). One i18n phrase ("Saldo"). Tests:
  new `e2e/ios-responsive.spec.ts` (WebKit; fails with 124/69 px overflow without the select rule), `nav.test.ts`,
  `glass-budget.test.ts`, `shell`, `fitur`, `pwa` specs updated; `getByLabel('Dompet')` in `berulang` and `riwayat` specs
  scoped to `main` (the tab now has that aria-label). Not verified: a real iPhone (keyboard, select height, Dynamic Island).
- **FN-23 Agent (beta) (2026-10-10)** — branch `feat/fn-23-agent`, not merged. `/agen` (Agent plan only, enforced on
  load, actions, download and every job step): monthly report, annual recap and year-end asset list; steps run as Queue
  messages on `JOBS_QUEUE` with state in D1 (no Workflow, documented deviation), figures from code, optional narrative
  on the user's own key through `guardAnswer`; CSV + printable HTML in private R2, deleted after 30 days by the cron
  sweep. Migration `0036_agent_runs` (35 skipped). Tests: `test/integration/agen.test.ts` 47 + QA 9, render, shared,
  compat script, queue/nav extensions, `e2e/agen.spec.ts` 5. QA PASS and red team PASS in cycle 1; open lows S1–S7.
  NOT verified: real Anthropic call (`npm run compat:agent`), real Queue/R2, touch targets/contrast.
- **FN-45 Camera and gallery photo picker (2026-10-10)** — branch `feat/fn-45-camera-gallery`, not merged. Shared
  `PhotoPicker.svelte` ("Kamera" with `capture="environment"`, "Galeri"; "Pilih foto" plus drag-and-drop on mouse-only
  desktops, detected with `matchMedia`, no user-agent sniffing; no-JS keeps the single `name="photo"` input) used in
  Struk, the receipt review form and Barang/Koleksi photos. HEIC/HEIF: Indonesian how-to-fix message on the client and a
  named `PHOTO_HEIF` server refusal (accepted types unchanged); shared client re-encoder (upright, 2560 px, JPEG 0.85);
  multi-pick uses the first photo and says so. No migration. Tests: `photos.test.ts`, `picker-mode.test.ts`,
  `PhotoPicker.test.ts`, `barang.test.ts` rows, `e2e/photo-picker.spec.ts`. QA PASS, red team PASS (2 low, 1 info
  open). NOT verified: real iOS Safari and Android Chrome camera/gallery.
- **FN-13b PWA platform compatibility (2026-10-10)** — branch `feat/fn-13b-pwa-platforms`, not merged. iOS: app
  title and status-bar meta, 36 generated light/dark splash screens linked for Apple UAs only (not precached), Safari
  install steps and other-browser note on `/pengaturan/instal`, one-time iOS hint, iOS 16.4+ push explanation on
  `/pengaturan/notifikasi`, ≥16 px inputs, `--sai-*` safe-area insets on every fixed/sticky element, `dvh`.
  Android: manifest shortcuts, demo-seed screenshots (narrow + wide), maskable 192 and monochrome icons,
  categories, `prefer_related_applications: false`; theme toggle updates `theme-color`. 733,570 B of assets. No
  migration. Tests: manifest and platform-css suites, UA/push/sw-policy/theme/splash units, `e2e/pwa.spec.ts`
  extended. NOT verified: real iPhone/Android install, splash/theme-color honoured in iOS standalone, push delivery.
- **FN-19 Gmail auto-capture via own OAuth app (2026-10-10)** — branch `feat/fn-19-gmail` (from `integrate/2026-10-10`),
  not merged. `/pengaturan/aplikasi/gmail` with explanation, "Belum dikonfigurasi" reason, OAuth code flow with PKCE
  S256 and single-use session-bound state, scope `gmail.readonly`, refresh token sealed with the connected-apps key;
  "Periksa otomatis" hourly 06–23 WIB via jobs cron + `gmail_check`/`gmail_read` Queue steps with quota pacing and
  backoff; "Dicatat ke" space; sender/subject query excluding Promotions/Social, no attachments, no AI without an
  amount; drafts with source `gmail` through the shared capture path and dedupe (no mail text stored); look-back 7 days
  on Gratis, longer via `gmailLookbackMaxDays`; disconnect and account deletion revoke at Google and delete mail
  records and pending drafts, transactions stay. Migration `0033_gmail_connection.sql`. Tests: `gmail.test.ts`,
  `gmail-qa.test.ts`, shared/server gmail units, jobs cron/queue cases, `e2e/gmail.spec.ts`, opt-in
  `e2e/gmail-configured.spec.ts`. QA PASS, red team PASS (7 lows tracked). NOT verified: real Google OAuth/Gmail API,
  revocation at Google, real Anthropic read (all fakes).
- **FN-17 Spreadsheet import (2026-10-10)** — `.xlsx` (Excel / Google Sheets download) on the Impor screen in a
  separate `SpreadsheetImport.svelte` section. Own minimal XLSX reader on `fflate` 0.8.3 (MIT, pinned): zip-bomb,
  DOCTYPE, tag/format caps, macros/.xls/encrypted refused, cached formula values only, in memory only. Deterministic
  layout mapping (tab per month, in/out or amount+type, titles, repeated headers, 1900/1904 serials, total rows
  skipped), user-confirmed; optional AI mapping suggestion on the user's own key (header + 5 masked samples). Numbers
  copied by code; categories matched, never created. Source `spreadsheet`, CSV dedupe/undo, new throttles. No
  migration. Tests: unit suites, `test/integration/impor-spreadsheet{,-qa}.test.ts` (3,000-row identical totals),
  `e2e/impor-spreadsheet.spec.ts`. QA PASS; red team PASS after cycle 2 (lows L1, L4, L5 open). NOT verified: real
  Anthropic mapping call, real user workbooks. Branch `feat/fn-17-spreadsheet`, not merged.

- **FN-16g On-device OCR for scanned statements, screenshots and camera photos (2026-10-10)** — branch
  `feat/fn-16g-ocr`, not merged, no migration.
  - Engine: Tesseract (tesseract.js 7.0.0, tesseract.js-core 7.0.0) runs in the browser, and pdfjs-dist 6.4.299 renders scanned PDF pages. All are self-hosted under `/_ocr/<version>/` with SHA-256-pinned assets, including tessdata_fast `ind`/`eng` at commit `8741641`. They load lazily; one image run is about 9.3 MB decoded (about 4.1 MB gzip).
  - Inputs: scanned PDFs, e-wallet and mobile-banking screenshots, and a camera action that handles EXIF orientation, downscaling and deskew.
  - Parsing: OCR words go through shared deterministic parsers, the per-bank rows and new screenshot layouts. The server re-parses the words in `?/previewOcr` and `?/importOcr`, with the `statement-upload` throttle, a 512 KB cap and dedupe by institution, account, wallet, date, amount and balance or time. `source` is `statement`, and no image or OCR text is stored.
  - CSP: pages get `worker-src 'self'`. Only `/_ocr/*` gets `'wasm-unsafe-eval'`, set in `_headers`.
  - Tests: 13 or more Vitest files and `e2e/impor-ocr.spec.ts`.
  - Not verified: accuracy on real samples, real phones and cameras, real HEIC files, and the full e2e suite.
- **FN-30 Pro hardening before a real provider (2026-10-10)** — branch `feat/fn-30-pro-hardening`, not merged. Refund
  records (`billing_refunds`, pending → refunded/cancelled once, never deleted, never moves money) for `paid_not_applied`
  payments, shown on `/pengaturan/paket` and read-only on the admin page; re-claim markers (`claim_markers`, keyed HMAC
  with `CLAIM_HASH_KEY`, no raw e-mail or user id, written at account deletion, checked at sign-up and voucher redeem,
  swept after 730 days by the jobs Worker); admin gated by `ADMIN_ACCOUNT_IDS` instead of `ADMIN_EMAILS` (FN-41 L1).
  Migration `0031_billing_hardening.sql` (renumbered from 0030 at merge). Tests: billing-hardening
  (+QA), migration-0030, admin-page, claims, refunds, e2e admin 404 body. QA PASS, red team PASS (6 Lows deferred). NOT
  verified: real provider, refunds through a provider, staging secrets, full e2e; FN-41 L4 re-seal job still open.
- **Project setup (2026-10-07)** — Claude Code pipeline ported from the earlier project: `CLAUDE.md`, agents
  (`cto-strategist`, `senior-software-engineer`, `qa-tester`, `red-team-pentester`), commands (`/resume`,
  `/build-feature`, `/fix-bug`, `/verify`, `/ship`), trackers, engineering checklist; product PRD and feature catalog
  FN-00 – FN-23. No code, no tests.
- **Feature catalogue and design system v1 (2026-10-07)** — catalog written as FN-00 – FN-33 with mirror/ours notes;
  CLAUDE.md, PRD v0.2, ARCHITECTURE (local-first sync, account key), TASKS and ACCEPTANCE updated; design system v1
  in `docs/design/` (neutral system, own brand accent, mascot and copy). No code, no tests.

- **FN-00 Foundation + component kit (2026-10-08)** — SvelteKit 3.0.1 + adapter-cloudflare on Workers, Tailwind v4
  with design tokens, i18n (`tr`/`trf`, Indonesian default, English table with coverage test), host routing (app vs
  site host), strict CSP, D1 + Drizzle migrations with local migrate/seed/reset guards, health and queue ping
  routes, `workers/jobs` (queue consumer, cron) and `workers/inbound` skeletons, shell with floating tab bar and
  sidebar, money formatting (IDR exponent 2), contrast test, `/dev/ui` component kit (button, chip, badge, group
  list, transaction row, hero block, comparison pill, sheet, inputs, bar chart), Playwright journeys, `deploy:staging`
  guard and RUNBOOK. Rulings and deferred minors: `.superpowers/sdd/2026-10-07-fn-00-foundation/progress.md`. Not
  done: staging (needs Cloudflare account), real-provider checks (none in scope).

- **FN-01 Account and sign-in (2026-10-08)** — e-mail + password accounts ported from the earlier project, sessions, route
  protection, account page with delete, personal space at sign-up; migration 0001; QA PASS (2 cycles), red team PASS
  (Lows documented). Not verified: Cloudflare edge `CF-Connecting-IP` behaviour (no staging deploy yet). See
  `docs/features/fn-01-accounts/SUMMARY.md`.

- **FN-03 Spaces and sharing (2026-10-08)** — shared spaces up to 5, roles, invite links, space switcher, the
  `requireSpaceAccess` gate, account-deletion handover and purge; migration 0002; QA PASS, red team PASS after 2 fix
  cycles. See `docs/features/fn-03-spaces/SUMMARY.md`.

- **FN-04 Wallets (2026-10-08)** — wallets per space with favourite, archive/restore, currency allow-list,
  balance contract; migration 0003; QA PASS, red team PASS (2 Lows fixed). See `docs/features/fn-04-wallets/SUMMARY.md`.

- **FN-05/06 Transactions, history and categories (2026-10-08)** — manual entry, Riwayat, transfers, categories,
  exact totals, content-free tombstones; migration 0004; QA PASS, red team PASS after 2 fix cycles. See
  `docs/features/fn-05-transactions/SUMMARY.md`.

- **Money and date parser (Phase 2 prerequisite, 2026-10-08)** — shared parser for voice, statements and CSV;
  QA PASS, red team PASS after 2 fix cycles. See `docs/features/fn-14a-money-parser/SUMMARY.md`.

- **FN-10 Savings goals (2026-10-08)** — goals with append-only contributions on Kekayaan; migration 0005; QA PASS,
  red team PASS (Lows fixed). See `docs/features/fn-10-goals/SUMMARY.md`.

- **FN-11 Drafts inbox (2026-10-08)** — Kotak masuk with atomic bulk save into transactions; migration 0006; QA PASS,
  red team PASS (Lows fixed). See `docs/features/fn-11-inbox/SUMMARY.md`.

- **FN-12 Feature toggles (2026-10-08)** — per-user module toggles hiding nav entries; migration 0007; light review
  approved. See `docs/features/fn-12-feature-toggles/SUMMARY.md`.

- **FN-07/08 Budgets, safe-to-spend and Beranda (2026-10-08)** — the one-number home screen with comparison, daily
  average, safe-to-spend and charts; migration 0008; QA PASS after 1 fix cycle, red team PASS. See
  `docs/features/fn-07-budgets-beranda/SUMMARY.md`.

- **FN-09 Laporan (2026-10-08)** — reports by period, category, merchant and trend with totals equal to Riwayat and
  Beranda; no migration; QA PASS, red team PASS. See `docs/features/fn-09-laporan/SUMMARY.md`.

- **FN-13 PWA install and notifications (2026-10-08)** — installable app, safe offline cache, install guide, per-device
  Web Push; migration 0009; QA PASS, red team PASS (Lows fixed). Real push delivery not verified (no VAPID keys yet).
  See `docs/features/fn-13-pwa/SUMMARY.md`.

- **FN-14 Voice and quick text entry (2026-10-08)** — "kopi 25rb dan parkir goceng" → 2 rows → save; typed entry
  without JS; QA PASS, red team PASS (Lows fixed). Real microphone not tested. See `docs/features/fn-14-voice/SUMMARY.md`.

- **FN-18 CSV import and export (2026-10-08)** — template and Money Manager import with preview, dedupe and undo;
  streamed safe export; migration 0010; QA PASS, red team PASS after 2 fix cycles. See `docs/features/fn-18-csv/SUMMARY.md`.

- **FN-21 Account key and sealed results (2026-10-08)** — device-generated X25519 key wrapped with a scrypt password
  key; sealing primitives for future upload results; migration 0011; QA PASS, red team PASS after fixes. See
  `docs/features/fn-21-account-key/SUMMARY.md`.

- **FN-24 Notifications and reminders (2026-10-08)** — cron-driven budget, daily, goal and weekly notifications with
  in-app list and Web Push; migration 0012; QA PASS, red team PASS (Lows fixed). See `docs/features/fn-24-reminders/SUMMARY.md`.

- **FN-26 Subscriptions (2026-10-08)** — Langganan with catalogue, billing cycles, mark-paid and bill reminders;
  migration 0013 (incl. a verified table rebuild); QA PASS, red team PASS (Lows fixed). See
  `docs/features/fn-26-subscriptions/SUMMARY.md`.

- **FN-25 Net worth (2026-10-08)** — items with manual or provider prices (Indodax, gold-api.com, Frankfurter),
  daily WIB snapshots, 30-day change; migration 0014; red team FAIL → fixed → PASS, QA PASS 14/14. See
  `docs/features/fn-25-net-worth/SUMMARY.md`.

- **FN-27 Belongings (2026-10-08)** — Barang with depreciation estimate and photos in R2 (byte sniffing, metadata
  allow-list, access-checked serving, deletion sweep); migration 0015; red team FAIL (stripper memory exhaustion) →
  fixed → PASS, QA PASS 12/12. See `docs/features/fn-27-belongings/SUMMARY.md`.

- **FN-29 Connected apps (2026-10-08)** — settings screen with every app "Belum dikonfigurasi", encrypted token
  storage, creator/Pemilik-only and automatic disconnect, export builders and Slack draft parser; migration 0016
  (renumbered from 0017 at merge); red team PASS, QA PASS 12/12. See `docs/features/fn-29-connected-apps/SUMMARY.md`.

- **FN-28 Collectibles (2026-10-08)** — Koleksi with manual values and gain, photos through the shared FN-27 module;
  migration 0017; red team PASS, QA PASS 11/11. Phase 4 complete. See `docs/features/fn-28-collectibles/SUMMARY.md`.

- **Staging deploy, Phase 4 (2026-10-08)** — `npm run deploy:staging` from 61520ce: Time Travel bookmark taken by
  the script, remote migrations 0013–0017 applied (staging had 0 rows in the rebuilt notification tables), jobs,
  inbound and app Workers deployed (app version f77b1ada). Smoke: `/api/v1/health` ok/db true; `/`, `/kekayaan`,
  `/langganan`, `/barang`, `/koleksi` 303 to sign-in; `/masuk`, `/daftar`, manifest, offline 200. Real R2 photo
  upload and provider price fetches on staging not yet exercised.

- **FN-30 Billing (2026-10-08)** — plans, append-only credits, vouchers, gating helper and a signed, replay-safe
  webhook against a test-mode provider; migration 0018; red team PASS, QA PASS 12/12. See
  `docs/features/fn-30-billing/SUMMARY.md`.

- **FN-31 Privacy (2026-10-08)** — Privasi settings page, usage statistics with an opt-out and a closed vocabulary,
  append-only consent records at sign-up, full-account zip export (incl. billing history, no secrets); migration
  0019; QA PASS 12/12, red team PASS with three lows deferred. See `docs/features/fn-31-privacy/SUMMARY.md`.

- **FN-32 Public site (2026-10-08)** — landing, `/en`, blog, `/pasang`, draft legal pages, sitemap and robots,
  18 prerendered pages on the site host only; red team L1 fixed; QA PASS 11/11, red team PASS. Real domain not set.
  See `docs/features/fn-32-public-site/SUMMARY.md`.

- **App layout parity wave A (2026-10-08)** — design system v2 (ink-only actions, panel fills, data accent and
  heatmap tokens, warn tokens, type scale; contrast test extended), restyled kit plus HeroAmount with hide toggle,
  ComparePill, PeriodStepper, PickerSheet, SearchField, IconButton, ToggleRow; sectioned sidebar, `N` shortcut, phone
  tab bar with Dompet; Beranda and Transaksi per `docs/design/APP_PARITY.md`. No migration. QA PASS. Not verified: real
  devices, screen readers, 200 % zoom; emoji render as boxes in this machine's headless Chromium (no emoji font).

- **App layout parity wave B (2026-10-08)** — Laporan monthly and yearly per `docs/design/APP_PARITY.md`: heatmap
  calendar, cumulative trend vs last month, donut and category list, top places, biggest expenses, yearly stacked bars
  and categories over time; SVG charts in `src/lib/ui/charts`; server aggregates with exact sums, WIB buckets and space
  access; no-JS Bulanan/Tahunan switch. No migration. QA FAIL (desktop two columns, dark heatmap level-4 contrast) →
  fixed in cycle 2 → PASS. Not verified: English-locale e2e.

- **App layout parity wave D (2026-10-08)** — § 3a visual language on Pengaturan and sub-pages, Notifikasi, Kotak
  masuk, Ruang, Tanya, Langganan, Barang, Koleksi, Tambah forms and auth pages; new shell pieces IconRow and
  PageAction; sidebar compact below 940 px height. No data changes. Small tier: orchestrator review of screenshots
  instead of QA; branch ran the full Playwright suite (284 passed, 16 skipped, 1 locator fix re-run green).

- **App layout parity wave C (2026-10-08)** — `/anggaran` (pace marker, projection, per-category budgets), `/dompet`
  (wallets + goals), `/kekayaan` as the net-worth page, Fitur sheet, Impor layout with picker sheets; migration 0020
  `category_budgets` (same-space composite FK, tombstone trigger). QA FAIL on a duplicate i18n key from a rebase →
  fixed; red team PASS, L1/L2 fixed in cycle 3. Layout parity waves A–D complete.

- **FN-34 Streak (2026-10-08)** — "Tutup hari ini" on Beranda, streak chip on the phone top bar, migration 0021
  `day_closures` (one per user per WIB day), export and deletion coverage. QA FAIL (zero-streak chip wrapped at
  360 px) → copy "0 hari berturut-turut" + one-line chip with an e2e check → PASS. Red team deferred to the phase review.

- **FN-35 Money flow (2026-10-08)** — `/alur-uang`: income sources → wallets → spending categories for a month, SVG
  chart plus row list, income/expense rows only, one currency per chart, reconciles with Laporan; links from Laporan,
  sidebar and Fitur sheet. No migration. QA FAIL on a stale sidebar count in `e2e/shell.spec.ts` → fixed → PASS
  (contrast measured AA in both themes, 15-category layout, keyboard focus on chart links).

- **FN-37 Balance adjustment (2026-10-08)** — "Penyesuaian saldo": server computes the difference to the stated
  balance; adjustments change wallet balances only, excluded from every money total (Beranda, Riwayat, budgets,
  Laporan, Alur uang, CSV, reminders). Migration 0022 rebuilds `transactions` and restores draft/subscription links
  (QA verified on a populated DB). Account export gains `transactions.json` with every type — transfers were missing
  before. QA PASS, red team PASS (L1 dead picker option fixed; two lows deferred).
- **UI polish (2026-10-08)** — Alur uang curved proportional ribbons (3 px minimum), Struk button with "Segera" badge,
  Langganan two-line rows, compare pill hidden when both periods are zero; `closeDay` account-scoped only;
  `moneyFlowTotals` LIMIT 1000 with a truncation note. Orchestrator review of 34 before/after screenshots.

- **FN-36 Recurring transactions (2026-10-08)** — series under `/riwayat/berulang` (edit series or one, pause, stop),
  occurrences created by the hourly jobs Worker per series and WIB date (deleted ones never recreated), shared D1 budget
  of 300 statements per invocation with follow-up messages, "Perlu perhatian" flags, Aktif berulang chip. Migration 0023
  (no rebuild; `recurring_series_id` ON DELETE set null). QA PASS 14/14 (populated-DB migration); red team FAIL (M1 D1
  per-invocation budget) → cycle 2 → PASS with L3 deferred. Limits checked on developers.cloudflare.com: D1 1,000
  queries per invocation on Paid. Not verified: real Cloudflare cron/queue delivery.

- **Staging deploy v0.1.0 (2026-10-08)** — `npm run deploy:staging` from cbee668: Time Travel bookmark
  `<bookmark>`, remote migrations 0018–0023 applied (incl. the 0022
  `transactions` rebuild), jobs, inbound and app Workers deployed (app version c84d44df). Smoke: health ok/db true,
  version 0.1.0; `/`, `/anggaran`, `/dompet`, `/alur-uang`, `/riwayat/berulang`, `/laporan` 303 to sign-in; `/masuk`,
  `/daftar`, manifest, offline 200. Not exercised on staging: signed-in flows, real cron/queue recurring runs, R2 uploads.

- **FN-02 Offline write queue (2026-10-08)** — IndexedDB queue on the device for transaction create/edit/delete and
  voice saves, drained to `POST /api/v1/sync/push` (Origin, session, queued account, per-item space access, per-user
  rate limit); idempotent client ids, stale edits refused, identical resends applied; pending/waiting/failed states;
  queue cleared on sign-out and account switch, 200-item cap. No migration. QA PASS 15/15 (incl. offline reload);
  red team PASS, L1/L2/L4 fixed. Not verified: iOS Web Locks on a real device.
- **Hardening batch (2026-10-08)** — FN-31 L1–L3, FN-36 L3 (D1 budget per batch), FN-37 demo rows, ISO 4217 table,
  44 px small buttons, Langganan long names, `clean:tmp`; each with a fail-before regression test.

- **Hardening batch 2 (2026-10-08)** — Workers invocation logs off (they stored invite tokens), masked request line
  instead; account deletion purges spaces chosen inside its own batch; 300 creating actions per user per 10 min;
  migration 0024 `closed_on` format triggers; net-worth snapshots use the remaining D1 budget (~3,400 spaces/day);
  `data-hydrated` marker for e2e. Fail-before tests for each.

- **Staging deploy v0.2.0 (2026-10-08, owner "Deploy now")** — `npm run deploy:staging` from 0d95e11: Time Travel bookmark
  `<bookmark>`, remote migration 0024 applied, jobs/inbound/app deployed
  (app version 9c78c149). Ships FN-02 offline queue and hardening batches 1–2. Smoke: health ok/db true, version 0.2.0;
  app routes 303 to sign-in; `/masuk`, `/daftar`, manifest, offline 200. Not exercised: signed-in offline replay on staging.

- **Database normalisation (2026-10-08)** — audit of 43 tables (`docs/features/db-normalize/PRD.md`): FKs, ON DELETE
  paths, deletion order and indexes sound; legacy free-text `transactions.recurrence` and `subscriptions.category` kept
  by earlier decisions. Added `test/integration/schema-enum-sync.test.ts` (D1 CHECK enums vs TS arrays) and migration
  0025 `is_demo` on belongings and net_worth_items (demo rows excluded from totals, read-only). No rebuilds.

- **FN-38 Public API (2026-10-08)** — personal access tokens (hashed, shown once, scopes, optional space restriction,
  password re-auth to create, revoked on password change), `/api/v1` spaces/wallets/categories/transactions/budgets/
  laporan endpoints with cursor paging and idempotent writes, OpenAPI 3.1 (validated) and docs page. SvelteKit CSRF
  disabled in config and re-implemented in `hooks.server.ts` with Kit's rule for every non-token route (red team: 31
  live probes refused). Migration 0026. QA FAIL (bodyless DELETE blocked by Kit CSRF over real HTTP) → cycle 2 → PASS.

- **FN-16a E-statement upload (2026-10-08)** — statement PDF/CSV upload through the FN-18 preview/dedupe/undo flow,
  in memory only; PDF.js patched at build time with a decode allowlist and byte budget (8 MiB/page, 40 MiB/file),
  images never decoded; per-isolate and per-user read slots, upload throttle, create-limit counting;
  `npm run compat:statements` (counts only) and `npm run test:pdf-workerd` (fresh-workerd RSS per bomb). Red team FAIL
  twice (regex pre-scan bypass, encrypted bombs; then workerd native decompression) → cycle 3 allowlist → PASS, all 16
  bombs ≤ 23 MiB growth (was up to 1,645 MB). Bank parsers wait for owner samples; XLSX refused (npm `xlsx` advisories).

- **FN-39 Ride-hailing and food delivery options (2026-10-09)** — two new preset expense categories, Ojek Online and
  Pesan Antar Makanan (17 tile keys), topped up lazily for existing spaces (never recreating a renamed, hidden, moved or
  deleted preset); one shared keyword table (whole words, food beats ride) for voice, Slack drafts and blank-category
  CSV/statement expense rows; GoPay/OVO/ShopeePay/DANA quick-picks in the wallet form (no-JS via `?dompet=`); GoPay Plus,
  GoFood Plus and GrabUnlimited in the Langganan catalogue without prices. Migration 0027 rebuilds categories (wider
  tile check) with category_budgets and recurring_transactions around it; `test/integration/migration-0027.test.ts`
  proves rows, links, FKs and the trigger survive and a re-run is stable. QA PASS, red team PASS (L1: remote apply is
  not atomic, take a Time Travel bookmark). Not verified: 0027 on staging D1.

- **FN-40 parts 1+4 Hitam-putih theme and glass (2026-10-09)** — fourth theme choice following the system scheme
  (achromatic except money colours and brand), `/pengaturan/tampilan` (no-JS), sidebar toggle cycling all four;
  glass material on chrome and sheets with solid fallbacks (reduced transparency, no `backdrop-filter`, under an open
  sheet) and a 3-blurred-layer budget. No migration. QA FAIL (sheet title band) → cycle 2 → PASS; red team PASS (two
  lows fixed). Not verified: Safari/WebKit glass, real-device `theme-color`, CLS.

- **FN-40 parts 2+3 motion and isometric illustrations (2026-10-09)** — duration tokens; sheet rise/sink, Beranda
  count-up after a change, chart grow-in, 8-row stagger, press feedback, 200 ms page fade on `<main>` (View
  Transitions dropped taps in Chromium); all off under reduced motion; Playwright defaults to reduced motion with
  `e2e/motion.spec.ts` covering motion on. 11 original isometric SVG scenes behind a Rive-ready `<Illustration>` on 17
  empty states, error pages, auth pages (≥ 768 px) and a Beranda first-wallet card. No migration. QA PASS, red team
  PASS; cycle 3 fixed a one-frame blur glitch under reduced motion (0.01 ms transitions → 0s) and both red team lows.
  Not verified: CLS, Safari/WebKit.

- **FN-41 Integrations, per-user AI keys (2026-10-09)** — `/pengaturan/integrasi` with a sealed per-user Anthropic
  key (masked, replace, delete, audit), a rate-limited "Tes koneksi" through the app's AI Gateway, and an
  `ADMIN_EMAILS`-gated status page of app-wide secrets. Migration 0028. QA PASS, red team PASS (cycle 2: current test
  model id and a model-unavailable outcome, gateway no-cache/no-log headers). Not verified: real Anthropic call
  through a real gateway.

- **FN-42 Version, updates and usage (2026-10-09)** — `/pengaturan/tentang` (version, release date, bilingual "Apa yang
  baru", update check), a service-worker update prompt that keeps the offline queue safe, and `/pengaturan/pemakaian`
  (plan, credits, limits used vs allowed, photo counts, AI row). No migration. QA PASS, red team PASS (two lows). Not
  verified: an update between two real deploys.

- **FN-42b Changelog and automatic update checks (2026-10-10)** — `/pengaturan/tentang/catatan-rilis` lists every
  release newest first from the bilingual release-notes files (server-rendered, works without JS; not on the
  marketing site), linked by "Lihat semua" from "Apa yang baru". While the app is open it checks for a new version
  when the tab becomes visible, on reconnect and every 45 min while visible (10 min minimum gap, one check at a
  time, never auto-reloads; the update still waits for the user's tap so FN-02 queue writes are safe). After an
  applied update a one-time dismissible "Baru di Montra {versi}" notice shows that version's notes (last seen
  version in localStorage, never on a first install). RUNBOOK "Release notes" rule plus a Vitest check that the
  newest CHANGELOG.md version has an id/en notes pair. No migration, no server write. QA PASS, red team PASS (one
  low carried over from FN-42). Not verified: an update between two real deploys (simulated in e2e).

- **FN-16b BCA e-statement parser (2026-10-09)** — BCA text-PDF statements detected by layout and read through the
  FN-18 pipeline; refused whole unless running balances, opening/closing, totals and period all match. Red team FAIL
  (remark text could forge amounts) → cycle 2 → PASS; QA PASS. Owner's real statement: 9 rows, Rp0 gap. Not verified:
  multi-page statements.

- **FN-15 Receipt scan (2026-10-09)** — Struk reading with Claude vision through the AI Gateway on the user's own key:
  strict schema, reconciliation flags, one transaction or split per item, wallet guess, kept photos in R2 with
  member-only access, dedupe, throttle. Migration 0029. QA PASS; red team PASS (cycle 2 fixed a photo attaching to
  another member's row). Not verified: a real Anthropic read.

- **FN-16c BCA CSV mutasi parser (2026-10-09)** — KlikBCA/myBCA CSV read from each row's right end under the `bca`
  id, refused whole unless the balance chain and footer totals match. QA PASS, red team PASS (lows on unimportable
  remarks and cross-format duplicates). Owner's real export: 8 rows, Rp0 gap.

- **Fix: lows batch 2 (2026-10-10, branch `fix/lows-batch-2`, no migration)** — FN-20 L1: `/riwayat/saran` counts each
  request per user in a new throttle scope `merchant-suggest` (300 per 10 minutes, `MERCHANT_SUGGESTS_PER_WINDOW`),
  before the body or any history row is read; over it, 429 with Retry-After (the chip just does not appear). FN-20 L3:
  `writeCache` takes the `SpaceScope` and repeats `isLiveMember` in its `INSERT … SELECT`, so a member removed during the
  30 s AI call writes nothing. FN-17 L4: the spreadsheet reader slot is released before the AI provider call
  (`inSheetLane` passes `release`); it stays held while the body uploads (bounds buffered bytes). `/riwayat/berulang`:
  creates, edits, pause, resume, stop and delete set a one-shot `series_saved` cookie (`saved-notice.ts`, shared helpers
  with the `tx_saved` notice), and the list shows its success text only with it. FN-45 L1/L2 server side already held
  (first `photo` part only, bytes sniffed as JPEG/PNG/WebP, HEIC gets its own message): tests added, no code change.
  Not fixed: FN-16a fixed-window throttle (shared `countAttempt`, needs two rows per key and a new sweep: not small).
- **Fix: lows batch 1 (2026-10-10, branch `fix/lows-batch-1`, no migration)** — FN-44 L1: transaction writes set a
  one-shot httpOnly cookie (`src/lib/server/transactions/saved-notice.ts`) before the `/riwayat?saved=` redirect, and
  Riwayat shows "Transaksi dicatat" and Koko's hop only when that cookie matches, so a crafted or reloaded URL shows
  nothing. FN-43 L2: `matchBrand` counts a brand word only at the start or end of a name or after an account word,
  never after a mention word ("Bayar ke BCA teman" keeps its initials tile). FN-16e coverage: no-JS Playwright test
  for the Mandiri multi-account picker. Not run: riwayat, beranda and struk e2e specs (they reach `?saved=` in the
  browser; unchanged URLs).
- **FN-19 e-mail forwarding fallback (2026-10-10)** — branch `feat/fn-19-forwarding` (not merged, not deployed):
  per-user secret forwarding address on `/pengaturan/aplikasi/email` (rotate, turn off, Gmail confirmation code),
  Tambah › Otomatis links there or says "Belum dikonfigurasi"; `workers/inbound` with size cap, rate limit, fail-closed
  `Authentication-Results` check, four deterministic parsers and drafts only; AI read via `inbound_read` on the jobs
  queue with the user's own key. Migration 0030 (`inbound_addresses`, `inbound_mail`). Tests: shared inbound units,
  `workers/inbound/src/process.test.ts`, `test/integration/forwarding.test.ts`, `e2e/email-forwarding.spec.ts`. QA PASS,
  red team PASS after one fix cycle (M1 dedupe on masked reference); lows L3, L4 open. NOT verified: real mail
  through Email Routing, real Anthropic/AI Gateway reads, Cloudflare's `Authentication-Results` shape, real bank
  sender shapes.
- **FN-22 Assistant "Tanya" (2026-10-10)** — `/tanya` replaces the stub: chips, no-JS chat form, 8 read-only tools
  scoped to the session space over a read-only DB facade, server-formatted figures via `[[f:id]]` placeholders and an
  allowlist answer guard, BYOK through the AI Gateway (unavailable state when the gateway or the user's key is missing),
  throttle 30/10 min and one in flight, 30-day retention and `/pengaturan/ingatan`. Migration 0032 (built as 0030,
  renumbered at merge). Tests: guard, tools, loop (mocked), lane, integration (27), `e2e/tanya.spec.ts`. QA PASS (cycle 4), red team
  PASS (cycle 3, lows S11–S14 open). NOT verified: a real Anthropic call (`npm run compat:tanya` not run), browser ask
  and clear. Branch `feat/fn-22-tanya`, not merged.
- **FN-20 Merchant recognition and auto-categorisation (2026-10-10)** — one shared resolver (user rule → space
  history → cache → curated generic dictionary/keywords → AI) cleans descriptors (QRIS prefixes, e-wallet/bank
  descriptors, masked numbers) and sets a category with a reason chip ("Dari aturanmu", "Dari riwayat"…); corrections
  learn a per-space rule. Wired into voice, CSV, statements, forwarding drafts and manual-entry suggestions; per-row
  "Ubah kategori" on draft review; `/pengaturan/pedagang` lists and deletes rules. AI step: BYOK via the AI Gateway,
  batched, zod-checked, only the space's existing categories, never amounts, cached 90 days per space, 20/hour; off
  without a key. Migration 0034, renumbered from 0035 at merge (`merchant_rules`, `merchant_cache`). Tests: clean, dictionary, resolve, ai (mocked),
  merchant-suggest, `test/integration/merchants.test.ts`, `merchants-redteam.test.ts`, `e2e/fn20-merchants-qa.spec.ts`.
  QA PASS (cycle 2), red team PASS (lows L1–L4 open). NOT verified: a real Anthropic call (mocked only). Branch
  `feat/fn-20-merchants`, not merged.

- **Fix: FN-17 xlsx lows L1 and L5 (2026-10-11, branch `fix/xlsx-memory-sqref`, no migration)** — L5: a sheet whose
  `dataValidation`, `conditionalFormatting`, `ignoredError` or `selection` open tag carries a `sqref` over 32 KB now
  imports (`scanXml` takes a `longTags` set; only the worksheet scan passes it; over-long tags the reader uses still
  refuse `too_complex`). L1: `inflateEntry` writes each part into one buffer of the declared size, with no chunk list
  and no joined copy; a declared size past the 100:1 ratio is refused before the buffer exists. Forced-GC retained
  memory 33.5–34.5 MB → 20.1 MB; the live peak (~57.5 MB, the UTF-8 decode) is unchanged, so `SHEET_READ_LANE_MAX`
  and the caps stay. Tests: `xml.test.ts`, `xlsx-cpu.test.ts` "L5: a very long sqref", `xlsx-read.test.ts`
  "inflateEntry: one preallocated buffer (FN-17 L1)", `qa-ac-extra.test.ts`. QA PASS, red team PASS (low: a lying
  header can make one 16 MB allocation per read before `corrupt`). Not done: the returned grid keeps the
  `sharedStrings.xml` text alive (~9 MB). Fixtures only.

- **FN-46 Pro look (2026-10-11)** — paid plans (Pro, Agen) get Pro themes "Emas" and "Hijau tua", a Pro badge with
  Koko's crown, a Pro card on Paket, a crowned Koko, a Beranda hero frame and Pro home-screen icons (install time);
  Gratis sees locked rows. Plan read server-side per request; forged or lapsed Pro theme renders `system`, forged post
  403. Manifest moved to a per-account route (`private, no-store`, `crossorigin="use-credentials"` link). No
  migration. Tests: `pro-look.test.ts`, `pro-look-ui.test.ts`, `test/integration/pro-look.test.ts`,
  `e2e/pro-look.spec.ts`, extended contrast/icons/manifest/Mascot/paket/theme tests. QA PASS, red team PASS (L1, L2
  fixed). NOT verified: real-phone install of the Pro icon.

- **FN-47 More currencies and decimal amounts (2026-10-11)** — TWD, HKD, CNY ("CNY (RMB)") added; cents for
  2-decimal currencies in every amount field, read with the UI language's separators (`12,50` id, `12.50` en), a 3rd
  fraction digit refused, never rounded; IDR/JPY unchanged; one strict server reader for all amount paths (closes an
  `12.50`-into-IDR ×100 misread); queued offline writes carry their locale; TWD FX up to 40 days old. No migration.
  Tests: amount-input, forms, validation suites, sync-push, answer-guard, `e2e/mata-uang-sen.spec.ts`. QA PASS, red
  team PASS (cycle 2). Not verified: a real Frankfurter TWD/HKD/CNY fetch.

- **FN-16h OCBC Rekening Koran parser (2026-10-11)** — OCBC single-account "Rekening Koran" statements import under
  the one `ocbc` parser: per-currency sections (IDR importable, foreign listed), slash dates, wrapped descriptions with
  Berita lines kept, closing from the last-page summary, refused whole on any mismatch. No migration. Tests:
  `ocbc-rekening-koran.test.ts` (37), detect conflicts, impor-statements integration; fictional fixtures. Verified on
  a real PDF (21 rows, Rp0 gap). QA PASS, red team PASS (L1, L2 low, open).

- **FN-48 Categories for imported rows, Part A (2026-10-11)** — imported rows are categorised from the bank's own
  mutation codes (fees, tax, interest, ATM cash, card payments, transfers out/in) through FN-20's resolver, with six
  new preset tiles; "Rapikan kategori" re-sorts older imported rows with preview, confirm and undo, never touching
  hand-set rows. Migration 0037 (table rebuilds + `category_source`). Tests: `bank-narratives.test.ts`,
  `migration-0037.test.ts`, `rapikan-kategori.test.ts`. QA PASS, red team PASS (L1–L2 low open). Parts B and C open.

- **FN-16i Impor page layout (2026-10-11)** — two-column Impor like the reference, one wallet picker for every format,
  honest institution picker (only readable banks selectable; others disabled with the alternative), Scan struk link,
  disabled "Pintasan — Segera hadir" row, Rapikan kategori card kept in the left column. Shared PickerSheet gains
  `disabled`. No migration. Tests: `catalogue.test.ts`, `PickerSheet.test.ts`, statements validation, `e2e/impor.spec.ts`.
  QA PASS, red team PASS.

- **FN-25b Kekayaan page parity, pass 1 (2026-10-11)** — trend chart from stored snapshots with four ranges,
  assets-only allocation bar and chips with debts on their own line, Belum dihitung suggestions, grouped Dompet /
  Investasi / Kripto sections, credit-card 30-day spend cards, eye toggle on every amount, two-column desktop. No
  migration. Tests: `wealth.test.ts`, `sections.test.ts`, chart geometry, `wealth-ui.test.ts`,
  `kekayaan-page.test.ts`, `e2e/kekayaan-halaman.spec.ts`. QA PASS, red team PASS (2 lows). Pass 2 (Piutang,
  card dates) open.

- **FN-34b Streak extensions (2026-10-11)** — `/beruntun` page with calendar and milestones, computed freezes (1 per
  7 closes, max 2), an evening close-the-day reminder (default 20:00 WIB), and a per-space budget streak snapshotted
  each morning. Migration 0038. Tests: `count.test.ts`, budget streak, cron/queue, `streak-plus.test.ts`,
  `migration-0038.test.ts`, `e2e/beruntun.spec.ts`. QA PASS, red team PASS (2 lows). Not verified: real push.

- **FN-26b Subscription check (2026-10-11)** — Langganan reads the last 90 days of expenses and suggests likely
  subscriptions (known names or a regular rhythm), each addable through the pre-filled form or dismissed for good;
  never auto-added. Migration 0039. Tests: `subscriptions-detect.test.ts`, `langganan-check.test.ts`,
  `e2e/langganan.spec.ts`. QA PASS, red team PASS (3 lows).

- **FN-48 Part B month continuity (2026-10-11)** — statement imports record wallet, period and printed balances;
  breaks between months (or before the first statement) are listed per wallet on Impor and closed with one visible
  balance-adjustment row after the user confirms. Migration 0040. Tests: `continuity.test.ts` (unit + integration),
  `migration-0040.test.ts`, impor e2e. QA PASS, red team PASS (2 lows).

- **FN-49 Patungan pass 1 (2026-10-11)** — split bills by name (equal or exact), link a split to the bill row so every
  total counts only the payer's share, mark each person Lunas; Pemilik can rescue a split whose payer left; demo
  splits read-only. Migration 0041. Tests: `patungan.test.ts` (unit + integration), `patungan-aggregates.test.ts`,
  `migration-0041.test.ts`, `e2e/patungan.spec.ts`. QA PASS, red team PASS (cycle 2). Share link, percentage and
  per-item splits, partial payments are later passes.

## Test evidence log

- 2026-10-15 polish/design-pass 9259663 (squashed on main): 208 screenshots before and after (local only); affected e2e 316 passed 10 failed first run (6 parallel local-D1 races passed alone 25/25, 3 restored chart passing, `motion.spec.ts:66` broken since the 2026-10-14 illustration restyle), final rerun beranda/riwayat/laporan/kalender/kotak-masuk/kekayaan 88 passed 7 skipped; gates on main 390 / 6589.
- 2026-10-15 feat/fn-48d-transfer-auto-match c64cb5e → 0fe866e (squashed on main): engineer gates 389 / 6575; QA PASS (gates 389 / 6575, fresh D1 0000–0048, targeted 5 files / 62 tests); red team PASS with L1, L2 (probe 24 tests, max 76 bound parameters, removed); L1 fix: new test failed without it (1 failed / 16 passed), 17 passed with it; gates on main 389 / 6576.
- 2026-10-13 feat/fn-55-credit-cards 53defaf → 550be5d (rebased on 9b01add, FEATURES and i18n-en kept both sides) → 59a5b9e: engineer gates 373 / 6159, 383 / 6501, 384 / 6508; fresh D1 0000–0047 + no-op rerun, drizzle check fine; e2e kartu-kredit 7/7 then 76/76 then 68/68. QA cycle 1 FAIL (three specs, test-side; 373 / 6159), cycle 2 PASS (6500 / 6501, the one untouched file passed alone; e2e 109 passed), cycle 3 PASS (384 / 6508; e2e 81 passed 10 skipped). Red team PASS cycles 1–3 (L1–L3, then L1-R and retype, 19 date vectors); L2-R open.
- 2026-10-13 feat/fn-54-greeting-calendar 1a5d0ef → 4359a99 (rebased on 9414412, FEATURES and i18n-en conflicts kept both sides) → 1e8ccd4: engineer gates 370 / 6312, full e2e 669 passed 94 skipped 0 failed; QA cycle 1 FAIL (criterion 7, /kalender cold load with hidden amounts) with 375 / 6393 and 252 e2e passed; red team cycle 1 PASS with L1 (q in URL) and L2 (link prefill). Cycle 2: gates 376 / 6398, e2e 39 passed; QA PASS (each new test failed on 4359a99; cold load 15 masks, 0 digits; e2e 96 passed 3 skipped); red team PASS.
- 2026-10-13 feat/fn-53-period-reports b68bd11 → 2c0f074 (rebased on 73694d2) → cd3822f: engineer gates 367 / 6056, then 368 / 6066; fresh D1 0000–0046 + no-op rerun; e2e period-reports 17 passed, related specs 47. QA cycle 1 PASS (migration upgrade from 0045 intact, FK check empty; seeded snapshots checked at 360 and 1280 px light/dark; e2e 17 + 46 passed); red team cycle 1 PASS with L1 (2000 floor) and L2 (direction while hidden). Cycle 2: each new test failed on 2c0f074; QA PASS (368 / 6066, e2e 63 passed 8 skipped); red team PASS (16 hostile URLs, no throw).
- 2026-10-13 fix/lows-services f4231ea…24c5fc5 → 695c156 (0045) → 41f0cb1 → ec73820: engineer gates 354 / 5758, 360 / 5872, then 5967 passed with 2 untouched net-worth timeouts (16/16 alone). QA cycle 1 PASS: 13 source groups reverted, each named test failed; fresh D1 0000–0045, 30 seeded gmail_mail rows identical across the rebuild, FK check empty; e2e 50 passed 13 skipped. Red team cycle 1 PASS with N1–N5 (15 files). QA cycle 2 PASS: 363 files / 5984 tests, e2e 39 passed 4 skipped plus hidden-amounts on phone and desktop. Red team cycle 2 PASS (11 files, PoC deleted).
- 2026-10-13 fix/lows-imports a6da3fc…13cb08f → 15accec: engineer gates 349 / 5711 then 356 / 5831, import e2e 57 passed 4 skipped; every new test failed on the unfixed code. QA cycle 1 PASS: 355 files / 5825 tests, 13 fixes reverted one by one and each named test failed, e2e 59 passed 4 skipped. Red team cycle 1 PASS with 3 new lows (16 files run one at a time), cycle 2 PASS (6 files, 2 PoCs deleted; sliding window never above 30 per 10 minutes over 25 minutes). QA cycle 2 PASS: 356 / 5831, parents fail the 3 new tests, 579-string narrative comparison listed; `impor-ocr.spec.ts:207` timed out once under load and passed alone (5 passed 4 skipped).
- 2026-10-13 chore/ci-cd 9de5b1f → f658aef → 41f0d36: actionlint 1.7.12 with shellcheck 0 errors; CI steps on Node 24: check 0 errors, lint clean, Vitest shards 87/86/86/86 files passed; e2e CI mode `--workers=1` 624 passed, 85 skipped, 0 failed; `npm run gates` 345 / 5655; cycle 2: `deploy-staging.test.ts` 24 passed, `npm test` 355 files / 5801 tests; `deploy:staging --dry-run` 4/4 steps, nothing uploaded; SIGINT/SIGTERM give 130/143 with 0 generated files left; cycle 3: local `--skip-build` refused, CI-mode dry run finished after a fresh build. Red team: all 4 action SHAs match their tags (read-only `gh api`).
- 2026-10-13 feat/fn-50-passkey-turnstile 7e0883d → cef2bfc → 90e9b53 (rebased on 19af7cc; 0043 byte-identical to main, journal conflict resolved): QA PASS: check 0 errors, lint clean, build ok; fresh local D1 0000–0044, rerun "No migrations to apply!"; feature Vitest 41 + 17 + 18 + 8 + 5 + 5 + 3 passed; `npm run test` 351 files, 5741 tests passed; e2e passkey, accounts, account-key 27 passed `--workers=1`; `e2e/turnstile.spec.ts` with Cloudflare dummy keys: AC 11–13 pass, success path needs real keys. Red team PASS: verifier 18, turnstile 8, passkeys 41, turnstile integration 17; PoCs unit 6 and integration 5 (deleted), 20 concurrent posts give one winner.
- 2026-10-13 chore/public-prep 346ff46 (rebased on 6b7f496): check 2268 files 0 errors, lint clean, bank-narratives + rapikan-kategori + release-pages + i18n-coverage `Test Files 4 passed (4)`, `Tests 47 passed (47)`. Full gates not rerun after this docs-and-one-page change (last full run on 6b7f496: 349 / 5685).
- 2026-10-13 feat/fn-48c-transfer-matching 34fec61 → b995b39 → 3bcbe23 (rebased on 3265fb6) → ff013ec: cycle 3 regression test "M3: undoing the debit's import restores the credit into its wallet archived since; restoring the wallet shows it" and the edited-debit test failed on cycle-2 code (2 failed), pass after. QA cycle 3 PASS (host load 2–8): check 0 errors, lint clean, build ok; cocokkan-transfer 25, qa 8, match 5, migration-0043 2, impor 28, imports-move 16, i18n 12; `npm run test` 348 files passed, 1 failed (`offline-forms.test.ts` collection error, passes alone 6/6); e2e cocokkan-transfer + move.qa + impor 51 passed `--workers=1`. Red team cycle 3 PASS: probe 9/9 (deleted), cocokkan-transfer 25, qa 8, imports-move 16; query plans start from `transactions_import_batch_idx`. Squashed on main (with FN-51 already there): `drizzle-kit check` fine, `npm run gates` exit 0, `Test Files 349 passed (349)`, `Tests 5685 passed (5685)`, build ok; this is also the clean gates run FN-51 was owed.
- 2026-10-12 feat/fn-51-motion 80e0fce → dbc5640: engineer check 0 errors, lint clean, build ok; fail-before `motion-css.test.ts` 1 failed / 137 passed with a planted `width` keyframe; e2e motion phone 15 passed; shell + ios-responsive + kit 53 passed 4 skipped; impor + kotak-masuk + pwa 145 passed 8 skipped. Full Vitest failed in 3 runs at host load 36–94 in untouched integration files only. QA PASS: check 2256 files 0 errors, lint clean; by-file Vitest 45 passed (offline-queue `sync.test.ts` timer race passes alone, 16); full run at load 74 had 43 failed files, all untouched; reruns left net-worth-scale, net-worth and recurring, which fail the same way on main a45585f; e2e motion 15 passed 14 skipped, shell + ios-responsive 45 passed 2 skipped. Red team PASS (read-only review, 2 lows). Squashed on main; a clean `npm run gates` on a quiet host is still owed before `/ship`.
- 2026-10-11 FN-16j on main (squash): `npx drizzle-kit check` "Everything's fine"; `npm run gates` 0 errors,
  344 files / 5515 tests passed, build ok. QA: `e2e/impor.spec.ts` 45 passed (phone + desktop, --workers=1);
  fresh local `db:migrate:local` applies 0000–0042. Red team: imports-move + migration-0042 18 tests passed.
- 2026-10-11 Fix BCA dated wrap line: `npx vitest run src/lib/shared/statements/` 9 files / 187 tests passed;
  `npm run gates` on main: 342 files / 5497 tests passed, build ok. Real sample PDFs read ok
  through `readStatement` (one was refused before the fix as `inconsistent`).
- 2026-10-08 `npm run gates` (check, lint, test, build) exit 0 on the FN-00 branch: Vitest `Test Files 21 passed
  (21)`, `Tests 130 passed (130)`.
- 2026-10-08 `npm run test:e2e`: 41 passed, 1 skipped (phone 21/21, desktop 20/20). Result of Task 12 (run
  2026-10-08 by Task 12 with LD_LIBRARY_PATH workaround). Not re-run by Task 13: a rerun here
  gave only 5 passed with the rest failing (Chromium system libraries are missing on this machine).
- 2026-10-08 controller verification on 6e17051: `npm run gates` exit 0 (21 files / 130 tests, build ok); Playwright
  41 passed, 1 skipped (9.8 s) with LD_LIBRARY_PATH workaround.
- 2026-10-08 `npm run deploy:staging` exits 1 with "staging is not configured (placeholder D1 id in wrangler.jsonc)".
- 2026-10-08 FN-01 (QA cycle 2 re-check on bda940e+74e06e4): `npm run gates` exit 0 — Vitest 36 files / 283 tests; Playwright 68 passed, 7 skipped, 0 failed (LD_LIBRARY_PATH workaround).
- 2026-10-08 first staging deploy of main 0e01a08 (`npm run deploy:staging`, owner account): Time Travel bookmark `<bookmark>`; remote migrations 0000, 0001 applied; jobs, inbound, app Workers deployed. Smoke: `/api/v1/health` → `{"ok":true,"db":true,"version":"0.0.1"}`; `/` → 303 /masuk; `/masuk`, `/daftar` 200; `/api/v1/dev/ping` 404; HSTS, nosniff, CSP present. App: https://financer-app-staging.<subdomain>.workers.dev
- 2026-10-08 staging redeploy of main e0eacf5 (Phase 1 complete): Time Travel bookmark `<bookmark>`; remote migrations 0002–0009 applied; jobs, inbound, app deployed. Smoke: health `{"ok":true,"db":true}`; `/` 303; `/masuk` 200; manifest 200 `application/manifest+json`; `/offline.html` 200 with script-free CSP and `X-Frame-Options: DENY`; dev ping 404. First attempt failed with a transient Cloudflare auth error (code 10000) during token refresh; retry succeeded. main verification before deploy: gates 1164 tests; Playwright 172 passed, 15 skipped.
- 2026-10-08 staging redeploy of main 1b098e2 (Phases 2–3 credential-free complete): Time Travel bookmark `<bookmark>`; remote migrations 0010–0012 applied; jobs (cron now creates reminders), inbound, app deployed. Smoke: health ok/db true; `/` 303; `/masuk`, `/daftar`, manifest, offline page 200. main verification: 1494 unit/integration tests; Playwright 206 passed with 1 load flake that passed on rerun (kekayaan 14/14).
- 2026-10-08 main d465e97 (FN-31 squash): `npm run gates` exit 0 — check 0 errors, lint clean, Vitest 138 files / 2077 tests, build ok.
- 2026-10-08 main a4fd902 (FN-32 squash on FN-31; conflicts in hosts.ts, hosts.test.ts and the legal page resolved, privacy page keeps FN-31's sections): `npm run gates` exit 0 — Vitest 147 files / 2133 tests, 18 prerendered site files, build ok. Playwright site + privasi + pwa: 51 passed, 2 failed on the renamed legal heading; spec updated, site.spec rerun 31 passed (LD_LIBRARY_PATH workaround). Full e2e suite not run.
- 2026-10-08 main d0de5dd (wave A squash; rebased on FN-31/32 with conflicts in (app)/+layout.svelte, dates, icons, i18n-en resolved): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 153 files / 2199 tests, build ok. QA Playwright shell/kit/beranda/riwayat `--workers=1`: 61 passed, 2 skipped. Full e2e suite not run.
- 2026-10-08 main e47e343 (wave B squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 154 files / 2233 tests, build ok. QA Playwright laporan + shell `--workers=1`: 33 passed; re-check laporan 7 passed.
- 2026-10-08 main 253a939 (wave D squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 155 files / 2236 tests, build ok.
- 2026-10-08 main (wave C squash on wave D): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 160 files / 2277 tests, build ok. QA Playwright anggaran/kekayaan/fitur/impor/beranda/laporan/shell `--workers=1`: 85 passed, 4 skipped. Fresh `db:migrate:local` 0000–0020 applied.
- 2026-10-08 FN-34 rebased on wave C (migration re-chained after 0020; `enhance` import restored): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 162 files / 2300 tests, build ok, fresh `db:migrate:local` 0000–0021 applied, Playwright beranda `--workers=1` 16 passed / 1 skipped.
- 2026-10-08 FN-35 (QA on 8083d77): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 165 files / 2329 tests, build ok; Playwright alur-uang + laporan + QA spec passed, shell 1 failure (stale count) → fixed, shell.spec rerun 27 passed. Merged as e8b856c.
- 2026-10-08 main ada98b0 (FN-37 squash on FN-35, i18n conflict unioned on main): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 167 files / 2361 tests, build ok, fresh `db:migrate:local` 0000–0022 applied. Branch e2e: riwayat 17 passed after the L1 fix; QA riwayat+beranda+kekayaan+laporan 51 passed.
- 2026-10-08 ui-polish rebased on ada98b0: check 0 errors, lint clean, vitest 167 files / 2372 tests, build ok; branch Playwright 121 passed, 8 skipped. Merged as 4097eb3.
- 2026-10-08 main ef89a3f (FN-36 squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 170 files / 2429 tests, build ok, fresh `db:migrate:local` 0000–0023 applied. QA Playwright berulang/riwayat/parity-d/shell/beranda 65 passed, 2 skipped.
- 2026-10-08 main ef89a3f full Playwright suite `--workers=1` (LD_LIBRARY_PATH workaround): 316 passed, 23 skipped, 0 failed (11.3 min).
- 2026-10-08 main 3cd2acd (FN-02 squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 179 files / 2544 tests, build ok. Branch Playwright offline-queue + reload + suara 35 passed; riwayat/suara/accounts/berulang/offline-queue 79 passed.
- 2026-10-08 hardening rebased on FN-02 (throttle scope lists unioned): check 0 errors, lint clean, vitest 180 files / 2558 tests, build ok. Merged as ba66e6a.
- 2026-10-08 main (FN-02 + hardening): full Playwright `--workers=1` 337 passed, 24 skipped, 2 failed (health spec hard-coded version 0.0.1 after the v0.1.0 bump) → spec reads package.json; security + offline-queue rerun 25 passed.
- 2026-10-08 main (hardening-2 squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 183 files / 2573 tests, build ok, fresh `db:migrate:local` 0000–0024. Branch full Playwright 339 passed, 24 skipped, 2 failed (old health version test, fixed on main); main security/shell/offline-queue/accounts 77 passed, 6 skipped.
- 2026-10-08 db-normalize rebased on 0024 (0025 re-chained; `drizzle-kit generate` no changes): check 0 errors, lint clean, vitest 185 files / 2586 tests, build ok, fresh migrate 0000–0025. Merged as 85cfa30.
- 2026-10-08 main (FN-38 squash): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 190 files / 2646 tests, build ok, fresh migrate 0000–0026. QA re-check live: wrangler dev + curl, Playwright api/accounts/riwayat/ruang/privasi 67 passed.
- 2026-10-08 main (FN-16a squash on FN-38): check 0 errors, lint clean, `npx vitest run --maxWorkers=2` 197 files / 2738 tests, build ok, `npm run test:pdf-workerd` all passed; Playwright impor + api + security `--workers=1` 31 passed.
- 2026-10-09 main (FN-39 squash): check 0 errors (1715 files), lint clean, `npx vitest run --maxWorkers=2` 201 files / 2796 tests, build ok. Branch: Playwright kekayaan, langganan, suara, impor, riwayat, anggaran `--workers=1` 80 passed, 3 skipped; fresh-DB `db:migrate:local` with 0027 ok.
- 2026-10-09 main (FN-40 parts 1+4 squash on FN-39): check 0 errors (1722 files), lint clean, `npx vitest run --maxWorkers=2` 202 files / 2888 passed + 2 failed (mono test caught FN-39's two category colours without mono greys; fixed in the merge, contrast + glass + kit 13 files / 210 passed), build ok; Playwright shell, tampilan, kit, riwayat, dompet `--workers=1` 64 passed, 3 skipped.
- 2026-10-09 main (FN-40 parts 2+3 squash + cycle 3): check 0 errors (1743 files), lint clean, `npx vitest run --maxWorkers=2` 206 files / 2965 tests, build ok; Playwright motion, shell, kit, beranda, tampilan, kekayaan, dompet, langganan, fitur, tabungan `--workers=1` 126 passed, 17 skipped; shell desktop 3 consecutive full-file runs 18/18 each.
- 2026-10-09 main before v0.4.0 deploy: full Playwright suite `--workers=1` 415 tests: 381 passed, 33 skipped, 1 failed (suara.spec.ts:144 desktop, button never stable); the file rerun passed 15/15. Staging after deploy: health `{"ok":true,"db":true,"version":"0.4.0"}`; /masuk and /daftar 200, / and /pengaturan/tampilan 303 to sign-in, unknown path 404; 0027 row counts unchanged (categories 15, budgets 0, recurring 0, transactions 0, 1 space).
- 2026-10-09 main (rename to Montra squash): check 0 errors (1743 files), lint clean, `npx vitest run --maxWorkers=2` 206 files / 2965 tests, build ok; Playwright shell, site, security, api `--workers=1` 80 passed, 1 skipped.
- 2026-10-09 main (FN-41 squash): check 0 errors (1765 files), lint clean, `npx vitest run --maxWorkers=2` 211 files / 3030 tests, build ok, fresh-DB `db:migrate:local` through 0028 ok; Playwright integrasi, aplikasi, api, privasi, shell `--workers=1` 60 passed, 1 skipped.
- 2026-10-09 main (FN-42 squash): check 0 errors (1781 files), lint clean, `npx vitest run --maxWorkers=2` 214 files / 3062 tests, build ok; Playwright pwa, offline-queue, shell, integrasi, paket `--workers=1` 88 passed, 1 skipped.
- 2026-10-09 main (FN-16b squash): check 0 errors (1784 files), lint clean, `npx vitest run --maxWorkers=2` 215 files / 3095 tests, build ok; `compat:statements` on the owner's BCA sample: bca, 1 page, 9 rows, 0 rejected, pass (Rp0 gap); Playwright impor + shell `--workers=1` 50 passed, 1 skipped.
- 2026-10-09 main (FN-15 squash): check 0 errors (1813 files), lint clean, `npx vitest run --maxWorkers=2` 222 files / 3205 tests, build ok, fresh-DB `db:migrate:local` through 0029 ok; Playwright struk, riwayat, beranda, shell `--workers=1` 71 passed, 2 skipped.
- 2026-10-09 main before v0.5.0 deploy: full Playwright suite `--workers=1`: 404 passed, 33 skipped, 0 failed; after the version bump full Vitest 222 files / 3205 tests (two release-note tests made version-independent). Montra staging after deploy: health `{"ok":true,"db":true,"version":"0.5.0"}`; /masuk and /daftar 200 (title and manifest say Montra), signed-in pages 303 to sign-in, `/pengaturan/integrasi/admin` 404 (ADMIN_EMAILS unset), `/api/v1/transactions` 401 without a token, unknown path 404; remote `d1_migrations` 30 rows ending at 0029.
- 2026-10-09 main (FN-16c squash): check 0 errors (1816 files), lint clean, `npx vitest run --maxWorkers=2` 223 files / 3225 tests, build ok; `compat:statements`: BCA PDF 9 rows pass, BCA CSV 8 rows pass (Rp0 gap); Playwright impor `--workers=1` 19 passed.
- 2026-10-09 main (FN-16d squash): check 0 errors (1819 files), lint clean, `npx vitest run --maxWorkers=2` 224 files / 3257 tests, build ok. Branch: QA PASS, red team PASS (L1 symlinked `.pdf-password` fixed in cycle 3; compat + statements tests 6 files / 97 passed).
- 2026-10-09 main (FN-38 red team L6): `test/integration/public-api.test.ts` finds the CSRF-exempt `+server.ts` files from the tree, checks each exports only its ENDPOINTS methods and that every export answers a signed-in cross-site form request with 401; 33 passed. Mutation check: a stray `PUT` export in the spaces route fails both new tests. check 0 errors, eslint clean.
- 2026-10-09 main (FN-15 red team L3): read ticket sealed with the AI-keys secret under its own labels, bound to user, space and photo dedupe prefix, 24 h. check 0 errors (1822 files), lint clean, `npx vitest run --maxWorkers=2` 225 files / 3264 tests, build ok; struk integration + receipts 5 files / 86 passed; mutation check (ticket check disabled) fails the new L3 test; Playwright `e2e/struk.spec.ts --workers=1` 7 passed (mocked read mints the ticket with the e2e server's fixed key).
- 2026-10-09 main (FN-02 resent delete): `/api/v1/sync/push` answers `ok` when a queued delete finds its own tombstone in the item's space (other spaces still get 404 `missing`; nothing is written). check 0 errors (1822 files), lint clean, `npx vitest run --maxWorkers=2` 225 files / 3264 tests, build ok; sync-push + offline-drain 49 passed.
- 2026-10-09 main (FN-43 squash): check 0 errors (1829 files), lint clean, build ok; `npx vitest run --maxWorkers=2` 228 files / 3425 tests: 3421 passed, 4 failed with `SocketError: other side closed` from local D1 in barang, drafts, net-worth and spaces (unrelated to FN-43); those 4 files rerun 97 passed. Branch QA PASS (24 criteria; Playwright 85 passed, 6 skipped + QA spec 3 passed), red team PASS (L1 trade dress to owner, L2 cosmetic).
- 2026-10-09 main (ScreenTitle flicker / suara e2e flake): cause traced with a frame probe: a few pixels from the top the sticky title shrank, scroll anchoring moved the page about 16 px, the sentinel flipped, and the title grew again on every frame, so Playwright never saw the save button stable (suara.spec.ts:144 desktop failed 6 of 10 repeats). Fix: two sentinels above the header with 64 px hysteresis. suara.spec.ts:144 desktop 10/10 passed; shell, beranda, riwayat, suara, motion `--workers=1` 87 passed, 10 skipped; new shell test fails 3/3 on the old component and passes on the new one (shell 36 passed). check 0 errors (1829 files), lint clean, build ok; full Vitest had 11 files fail with `SocketError: other side closed` from local D1 while another worktree's Vitest ran, and those 11 files reran 270 passed.
- 2026-10-09 main (FN-16e squash): check 0 errors (1833 files), lint clean, `npx vitest run --maxWorkers=2` 230 files / 3464 tests: 3463 passed, 1 failed with `fetch failed` from local D1 in recurring.test.ts (rerun 33 passed). Branch: QA PASS (Playwright impor 23 passed; `compat:statements` Mandiri 29 rows, BNI 170, BCA PDF 9, BCA CSV 8, all Rp0 gap), red team cycle 1 FAIL (M1), cycle 2 PASS (L3), cycle 3 fixed L3 (`institution_conflict`, `institution_mismatch`).
- 2026-10-09 main (FN-44 squash): check 0 errors (1845 files), lint clean, build ok; `npx vitest run --maxWorkers=2` 235 files / 3567 tests: 3563 passed, 4 failed (public-api throttle 429, struk 11th read, recurring and spaces local D1 socket errors); those 4 files rerun 121 passed. Branch QA PASS (30 criteria; Playwright 175 passed, 20 skipped; icon generator byte-identical twice), red team PASS (L1 low).
- 2026-10-09 main 212ac7f full Playwright `--workers=1`: 426 passed, 41 skipped, 2 failed (kekayaan.spec.ts:295 phone+desktop: FN-43's aria-hidden brand badge is in the quick-pick chips' textContent; the spec now asserts accessible names). kekayaan rerun 18 passed, 3 skipped. Screenshot specs regenerated fn-35/fn-40/fn-44 shots; reverted.
- 2026-10-09 main (FN-16f squash): check 0 errors (1848 files), lint clean; `npx vitest run --maxWorkers=2` 236 files / 3598 tests: 3596 passed, 2 failed with local D1 socket errors (barang, recurring 20-concurrent tests), rerun 57 passed; build ok; Playwright impor `--workers=1` 25 passed. Branch QA PASS (`compat:statements` OCBC 4 pages, 15 rows, 0 rejected, Rp0 gap), red team PASS (L1, L2 low).
- 2026-10-09 staging deploy v0.6.0 from 73db883: Time Travel bookmark <bookmark>, no migrations to apply (remote at 0029); jobs, inbound and app Workers deployed. Wrangler's OAuth refresh timed out under Node's default dual-stack connect; worked with `NODE_OPTIONS="--no-network-family-autoselection --dns-result-order=ipv4first"`. Smoke: health `{"ok":true,"db":true,"version":"0.6.0"}` on app.example.com and workers.dev; /masuk and /daftar 200 (Koko wave present), / and /impor 303, `/api/v1/transactions` 401, /favicon.svg 200, unknown path 404. Pre-deploy: full Playwright 426 passed / 41 skipped / 2 failed (kekayaan spec, fixed and rerun 18 passed); impor 25 passed after FN-16f.
- 2026-10-10 `fix/lows-batch-1`: regression tests failed before the fix (riwayat-routes 2 failed: `expected 'created' to be null`; brands 6 failed on incidental mentions) and pass after; affected files (riwayat-routes, saved-notice, balance-adjustment, offline-forms, struk, mascot-moments, mascot-placements) 108 passed; brands, BrandBadge, brands-contrast 171 passed. Playwright `impor.spec.ts -g "Mandiri account picker works as plain"` (E2E_PORT=8917) 3 passed (setup + phone + desktop). `npm run gates` exit 0: check 0 errors (1850 files), lint clean, Vitest 237 files / 3612 tests passed, build ok.
- 2026-10-10 branch feat/fn-42b-changelog (QA cycle 1): `npm run gates` exit 0 (check 1864 files 0 errors, lint clean, vitest 241 files / 3638 tests passed, build ok); Playwright `catatan-rilis.spec.ts` + `pwa.spec.ts` parallel 42 passed / 3 failed (banner 5 s timeout under load, two in untouched FN-42 test), rerun `--workers=1` 11 passed; `catatan-rilis-qa.spec.ts` phone 6 passed; AC20 fail-before 1 failed / 12 passed, restored 13 passed. Red team: targeted vitest 7 files / 52 tests passed. Full e2e suite not run.
- 2026-10-10 feat/fn-19-forwarding fe81e8b (QA cycle 2): `npm run gates` exit 0; svelte-check 0 errors 0 warnings; `Test Files 242 passed (242)`, `Tests 3666 passed (3666)`; build ok (fixtures and stubs only, no real mail or AI).
- 2026-10-10 feat/fn-19-forwarding fe81e8b (QA): `E2E_PORT=8927 npx playwright test e2e/email-forwarding.spec.ts e2e/shell.spec.ts` 40 passed, 1 skipped; `e2e/privasi.spec.ts` 5 passed (local server, flock shim on macOS).
- 2026-10-10 feat/fn-19-forwarding f2a3726 (QA cycle 1): fresh local D1 `npm run db:migrate:local` applied 0000–0030; `e2e/aplikasi.spec.ts` 7 passed.
- 2026-10-10 feat/fn-19-forwarding fe81e8b (red team cycle 2): feature suites plus temporary attack file `Test Files 10 passed (10)`, `Tests 112 passed (112)`; privacy + export `Test Files 2 passed (2)`, `Tests 34 passed (34)`; `npm audit --omit=dev` found 0 vulnerabilities (cycle 1).
- 2026-10-10 feat/fn-19-forwarding orchestrator final check after tracker edits: `npm run gates` exit 0; svelte-check 1872 files 0 errors 0 warnings; Prettier clean; `Test Files 242 passed (242)`, `Tests 3666 passed (3666)`; build ok (fixtures and stubs only).
- 2026-10-10 branch feat/fn-30-pro-hardening: engineer `npm run gates` run 1 EXIT 1 (export decisions for new tables, fixed; 4 load timeouts), run 2 EXIT 0 (241 files / 3639 tests); Playwright paket+integrasi+accounts+site 65 passed, 6 skipped; fail-before 11/17 billing-hardening tests failed with guards removed. QA PASS (targeted Vitest 84 passed; e2e admin 404 body 3 passed). Red team PASS (35 targeted tests). Final gates on ebd9e5a at load avg ~30–43: check + lint ok, test 3639 passed / 3 failed in untouched files (net-worth 30 s timeout, offline-queue sync; sync rerun 15 passed, net-worth rerun alone still 1/16 timeout under load), `npm run build` ok.
- 2026-10-10 feat/fn-22-tanya 9918515: `npm run gates` exit 0: check 0 errors 0 warnings (1878 files), Prettier clean, Vitest `Test Files 245 passed (245)`, `Tests 3793 passed (3793)`, build ok (orchestrator, and again by QA cycle 4). `npx vitest run test/integration/tanya.test.ts` 27 passed x3 (QA), x10 under load 23–41 (engineer). Fresh-DB local migrate through 0030 ok. Playwright with a no-op `flock` shim (flock missing on macOS) `e2e/shell.spec.ts e2e/tanya.spec.ts` 42 passed, 1 skipped (QA cycle 2/3; local wrangler, no provider). All AI mocked; real provider not run. Earlier gates runs at load 21–50 failed 2–5 timing-sensitive integration tests (net-worth, recurring; pass alone).
- 2026-10-10 feat/fn-45-camera-gallery 485b4d6: engineer `npm run gates` exit 0 (svelte-check 0 errors 0 warnings,
  Prettier and eslint clean, `Test Files 266 passed`, `Tests 3976 passed`, build ok); targeted Vitest 7 files 76
  passed; `e2e/photo-picker.spec.ts` 9 passed, 8 skipped (phone project skips by design); struk + barang + koleksi
  e2e 27 passed. QA: targeted Vitest 9 files 98 passed; throwaway light/dark/mono probe at 360 and 1280 px passed.
- 2026-10-10 feat/fn-13b-pwa-platforms d98fa8e (engineer): `npm run gates` exit 0; svelte-check 1942 files 0 errors 0 warnings; Prettier clean; `Test Files 267 passed (267)`, `Tests 4029 passed (4029)`; build ok. `e2e/pwa.spec.ts` 91 passed, 8 skipped.
- 2026-10-10 feat/fn-13b-pwa-platforms d98fa8e (QA): `npm run gates` exit 0 (267 files / 4029 tests); `e2e/pwa.spec.ts --workers=2` 93 passed, 8 skipped; `notifikasi.spec.ts` + `catatan-rilis*.spec.ts` 22 passed, 5 skipped; splash/icon scripts rerun byte-identical. No real device or push provider.
- 2026-10-10 feat/fn-19-gmail f6e95d7 (engineer): `npm run gates` exit 0, check 0 errors, lint clean, 266 files / 4027 tests passed, build ok; Playwright with flock shim `e2e/gmail.spec.ts e2e/aplikasi.spec.ts` 13 passed (fakes only).
- 2026-10-10 feat/fn-19-gmail 14cffa5 (QA cycle 1): `npx vitest run test/integration/gmail.test.ts src/lib/server/gmail src/lib/shared/gmail workers/jobs` 5 files / 101 tests passed; fresh-DB `npm run db:migrate:local` applied 0033, rerun "No migrations to apply!"; `e2e/gmail.spec.ts e2e/aplikasi.spec.ts` 13 passed; `QA_GMAIL_CONFIGURED=1 ... e2e/gmail-configured.spec.ts --project=phone` 5 passed; `gmail-qa.test.ts` 4 passed; `npm run gates` exit 0 (267 files / 4031 tests, build ok). No real provider.
- 2026-10-10 feat/fn-19-gmail 762bef5 (red team cycle 1): temporary PoC file 3 passed (confirms lows L1–L3, deleted); gmail suites 6 files / 105 tests passed. No real provider.
- 2026-10-10 feat/fn-17-spreadsheet 09f7a4f (engineer cycle 1): `npm run gates` exit 0: check 1955 files 0 errors 0 warnings, Prettier + eslint clean, `Test Files 270 passed (270)`, `Tests 4074 passed (4074)`, build ok; `E2E_PORT=8811 npx playwright test e2e/impor-spreadsheet.spec.ts` 3 passed (flock shim). AI mocked.
- 2026-10-10 feat/fn-17-spreadsheet 463f7f1 (QA cycle 1): `npm run check` 0 errors; targeted Vitest 13 files / 223 tests passed; QA-added 2 files / 13 tests passed; i18n 15 passed; `E2E_PORT=8821 npx playwright test e2e/impor-spreadsheet.spec.ts` 3 passed.
- 2026-10-10 feat/fn-17-spreadsheet ed847fd (engineer cycle 2, red-team M1 fix): `npm run gates` exit 0: check 1958 files 0 errors, Prettier + eslint clean, `Test Files 273 passed (273)`, `Tests 4102 passed (4102)`, build ok. Repro timings: 73 s → 22 ms, 11 s → 1 ms. Re-check (329eb3a): targeted Vitest 10 files / 141 tests passed.
- 2026-10-10 feat/fn-16g-ocr d7a72b7 (engineer cycle 1): `npm run gates` exit 0, `Test Files 275 passed (275)`, `Tests 4048 passed (4048)`; Chromium against `wrangler dev` ran OCR and pdf.js with no CSP violation and no other origin; the negative control without `'wasm-unsafe-eval'` on the worker gave a CompileError. Fixtures only.
- 2026-10-10 feat/fn-16g-ocr c50e83f (QA cycle 1, PASS): `npm run gates` exit 0 (275 files, 4048 tests); `E2E_PORT=8963 npx playwright test e2e/impor-ocr.spec.ts e2e/impor.spec.ts --project=phone` 18 passed (real Tesseract and pdf.js engine, localhost); `npx vitest run test/integration/impor-ocr-qa.test.ts` 7 passed; `npm run compat:ocr` reported no samples.
- 2026-10-10 feat/fn-16g-ocr 2992eac (red team cycle 1, FAIL M1 dedupe collision): targeted Vitest 6 files, 38 passed, plus integration 2 files, 16 passed.
- 2026-10-10 feat/fn-16g-ocr 4f22c43 (engineer cycle 2): M1 regression fail-before `Tests 2 failed | 1 passed`, pass-after 18 passed; `npm run gates` exit 0, svelte-check 2023 files 0 errors 0 warnings, `Test Files 276 passed (276)`, `Tests 4062 passed (4062)`, build ok.
- 2026-10-10 feat/fn-16g-ocr bbf3e66 (QA cycle 2, PASS): targeted Vitest 6 files, 49 passed. 1046ea0 (red team cycle 2, PASS): targeted Vitest 3 files, 27 passed; CSP files unchanged since cycle 1.
- 2026-10-10 feat/fn-20-merchants 1317ef1 (orchestrator, end of cycle 2): `npm run check` 1954 files 0 errors 0 warnings; `npm run lint` exit 0 (Prettier clean, eslint clean); `npm run test` `Test Files 270 passed (270)`, `Tests 4029 passed (4029)`; `npm run build` exit 0 (run as separate steps; full gates exceed 10 min). `e2e/fn20-merchants-qa.spec.ts` 9 passed (58.4s). QA: fresh local D1 `db:migrate:local` applied 0035; targeted vitest 138/138. Red team: `merchants-redteam.test.ts` 6/6. AI mocked only.
- 2026-10-10 `fix/lows-batch-2`: regression tests failed with the source fix reverted (9 failed: saved-notice 3, recurring 2, merchants-redteam 3 incl. the old `writeCache` call shape, impor-spreadsheet L4 1) and pass after; new `photos/upload.test.ts` 4 passed on the existing code (FN-45 server side held). Separate steps: `npm run check` 0 errors 0 warnings (2124 files), `npm run lint` clean, `npm test` 305 files / 4447 tests passed, `npm run build` ok. After the review pass (cavecrew-reviewer): the spreadsheet AI step now drops the file bytes before releasing the slot (`prepareSuggestion`), the saran test proves the count precedes the body read, and the series tests cover the update notice and a refused write leaving none. Final `npm test` under machine load (load average 90): 8 timeouts in unrelated files (gmail, koleksi, net-worth, net-worth-scale, recurring jobs, streak) that passed on rerun (6 files 141 passed, then 2 files 35 passed once load fell).
- 2026-10-10 feat/fn-23-agent c3f3ff7 (engineer cycle 1): `npm run check` exit 0 (0 errors, 0 warnings); `npm run lint` exit 0; `npm test` exit 0, 308 files, 4501 tests; `npm run build` exit 0; `npx playwright test e2e/agen.spec.ts` 5 passed. Mock provider.
- 2026-10-10 feat/fn-23-agent c3f3ff7 (QA cycle 1, PASS): targeted Vitest 12 files 281 passed; `npm run check` 0 errors; `npm run lint` clean; `npm test` 309 files, 4509 passed; `npm run build` exit 0; fresh-DB `db:migrate:local` 0036 applied, re-run no-op; `e2e/agen.spec.ts` 5 passed. Mock/fixture only.
- 2026-10-10 feat/fn-23-agent bf7af76 (red team cycle 1, PASS): `npx vitest run` render.test.ts, queue.test.ts, agen.qa.test.ts: 3 files, 40 passed (mock provider).
- 2026-10-11 fix/xlsx-memory-sqref 811eada: repro on main 4da075f, a 48 595-character `sqref` gave `{"ok":false,"error":"too_complex"}`. Engineer fail-before with the fix reverted: L5 9 failed / 16 passed, L1 2 failed (`expected 'push' to be 'alloc'`); pass after. QA: AC7 targeted Vitest 11 files / 161 tests passed; own fail-before rerun failed as expected, restored 47/47 passed; `qa-ac-extra.test.ts` 4/4 passed; `npm run gates` exit 0 (315 files / 4574 tests). Red team: PoC 7 passed (deleted); `npx vitest run src/lib/server/spreadsheet` 6 files / 85 tests passed. Orchestrator on main tree with the diff applied: `npm run gates` exit 0, check 2160 files 0 errors 0 warnings, Prettier clean, `Test Files 315 passed (315)`, `Tests 4574 passed (4574)`, build done. Also 2026-10-11 main 4da075f: gates first failed (`Cannot find module 'tesseract.js'`, 14 errors) until `npm install` restored locked deps missing from node_modules; then `Test Files 313 passed (313)`, `Tests 4551 passed (4551)`.
- 2026-10-11 feat/fn-46-pro-look 8fabb21 (engineer cycle 1): `npm run gates` exit 0, 318 files / 4979 tests; e2e pro-look, tampilan, paket, pwa, mascot, shell, beranda 175 passed, 20 skipped; fail-before: hook downgrade removed 3 failed, action check removed 3 failed. QA PASS: gates exit 0 (318 / 4979); `e2e/pro-look.spec.ts e2e/pwa.spec.ts --project=phone` 52 passed, 1 skipped. Red team PASS: PoC 4 passed (deleted); `pro-look.test.ts` + `manifest.test.ts` 37 passed. Cycle 2 a2fe900 (orchestrator): new icons test fails without `crossorigin="use-credentials"` (1 failed / 18 passed) and passes with it; icons + pro-look + manifest 56 passed; `e2e/pro-look.spec.ts e2e/pwa.spec.ts --project=phone` 52 passed, 1 skipped; temporary CDP probe: Pro manifest icons `icon-192-pro.png`, `icon-512-pro.png` with the fix, `icon-192.png` without (probe deleted). Squashed on main: `npm run gates` exit 0, check 2171 files 0 errors, `Test Files 318 passed (318)`, `Tests 4980 passed (4980)`, build done.
- 2026-10-11 feat/fn-47-currencies-decimals: cycle 1 81c9c19/d4f8444 engineer gates 315 files / 4650 tests, e2e 111 passed 5 skipped; QA PASS (gates 318 / 5056; mata-uang-sen 5 passed; riwayat + pro-look 10 passed); red team PASS (vitest 282 + 102 passed) with L1–L3. Cycle 2 c2d6bee: fail-before L2 `expected 125000 to be null`, L1 3/5 failed, L3 13 failed, QA#2 10 failed, QA#3 4 failed, all pass after; gates 318 / 5089; e2e mata-uang-sen + offline-queue + qa-fn02-offline-reload 15 passed. QA re-check PASS (gates 318 / 5089; 5 e2e specs 30 passed). Red team re-check PASS (293 + 105 passed). Squashed on main: `npm run gates` check 2172 files 0 errors, lint clean, 1 failed / 5088 passed — `xlsx-cpu.test.ts` "reads in linear time" under load average ~27; rerun alone 19/19 passed (flake).
- 2026-10-11 feat/fn-16h-ocbc-rekening-koran 75fa558: engineer gates check/lint/build clean, `npm run test` 5019 passed (load timeouts in recurring and net-worth-scale on full runs, pass alone); fail-before against the old `ocbc.ts` 13 unit + 2 integration failed. Orchestrator `FIN_SAMPLES_DIR=<scratch> npm run compat:statements` on the owner's real encrypted PDF (password from env, not stored): `ocbc` 4 pages, 21 rows parsed, 0 rejected, `pass (Rp0 gap)`; second section "not an IDR savings/current account". QA PASS: 4 diff test files 118 passed; gates 5018/5019 (net-worth.test.ts timeout, alone 16/16). Red team PASS: `src/lib/shared/statements/` 8 files 182 passed. Squashed on main: `npm run gates` exit 0, check 2176 files 0 errors, `Test Files 319 passed (319)`, `Tests 5128 passed (5128)`, build done.
- 2026-10-11 feat/fn-48-statement-categories 98c5147 (Part A): engineer gates 322 files / 5182 tests; fresh local D1 0000–0037, second run no-op; e2e riwayat + impor 22 passed, Tambah-sheet specs 53 passed 2 skipped; fail-before 3 tests fail with the resolver reverted. QA PASS: gates 322 / 5182; seeded-at-0036 migrate keeps categories 18, budgets 1, recurring 1, merchant_rules 1, merchant_cache 1, transactions 8, FK check empty; e2e riwayat/impor/berulang/anggaran 27/27. Red team PASS: 6 files 77 tests; PoCs 5 passed (deleted). Squashed on main: check, lint and build clean; `npm test` at load ~60 had 17 files fail with local D1 `ECONNRESET`/poisoned-stub errors; those 17 files rerun with `--maxWorkers=1`: `Test Files 17 passed (17)`, `Tests 404 passed (404)`.
- 2026-10-11 feat/fn-16i-impor-layout 0740c0d: engineer gates 321 / 5134; e2e impor, impor-ocr, impor-spreadsheet, kit, langganan, brand badges, shell 107 passed 8 skipped. QA PASS (catalogue + PickerSheet 6/6; impor + riwayat e2e 55 passed 4 skipped, 1280 px column test run in the desktop project; added validation test proving a posted disabled institution id is refused). Red team PASS (PickerSheet + catalogue 6, wallet/space integration 12 + 4 passed). Cycle 2 (orchestrator): disabled-over-href fix; new PickerSheet test fails before (1 failed / 2 passed), passes after (3/3). Squashed on main after resolving the FN-48 card conflict: check 2189 files 0 errors, lint clean, impor-related Vitest 32 files / 533 tests, `e2e/impor.spec.ts --project=phone --workers=1` 17 passed; full `npx vitest run --maxWorkers=3` `Test Files 324 passed (324)`, `Tests 5191 passed (5191)`; build ok.
- 2026-10-11 feat/fn-25b-wealth-page 3463f73 (pass 1): engineer gates 323 / 5259; e2e fitur, koleksi, tabungan, kekayaan-halaman, kekayaan-bersih `--workers=1` 42 passed 5 skipped. QA PASS (gates clean; `e2e/kekayaan-halaman.spec.ts --workers=1` 4 passed 3 skipped; 360 light/dark/mono and 1280 light screenshots reviewed). Red team PASS (3 files 25 tests). Squashed on main after keeping both FN-48 and FN-25b blocks in tokens.css and i18n-en.ts: check 2202 files 0 errors, lint clean, `npx vitest run --maxWorkers=3` `Test Files 328 passed (328)`, `Tests 5322 passed (5322)`, build ok.
- 2026-10-11 feat/fn-34b-streak-plus c48df4c: engineer gates 326 / 5235 after rebase on 0037; fresh local D1 0000–0038, rerun no-op; `drizzle-kit check` "Everything's fine"; e2e beruntun + beranda + notifikasi `--workers=1` 26 passed 1 skipped (phone-only test on desktop); fail-before `count.test.ts` 8 failed / 9 passed with the old count.ts. QA PASS: seeded 0037→0038 row counts np=4 un=2 identical, FK check empty; beruntun 7/7. Red team PASS: 5 files 90 tests; PoCs 3 passed (deleted). Squashed on main: check 2214 files 0 errors, lint clean, `npx vitest run --maxWorkers=3` `Test Files 332 passed (332)`, `Tests 5375 passed (5375)`, build ok.
- 2026-10-11 feat/fn-26b-subscription-check 19bfed3 → f5ac645 (rebased on b6fe074): engineer gates 321 / 5159, then 334 / 5406 after rebase; journal chain regenerated, `drizzle-kit check` "Everything's fine"; fresh local D1 0000–0039 and a no-op rerun; `langganan.spec.ts` phone `--workers=1` 10 passed. QA PASS (31 unit+integration; langganan e2e 19/19). Red team PASS (31 passed; PoC deleted). Squashed on main: check 2220 files 0 errors, lint clean, `Test Files 334 passed (334)`, `Tests 5406 passed (5406)`, build ok.
- 2026-10-11 feat/fn-48b-continuity 2d6bd03 → 257191e (rebased, migration renumbered 0041 → 0040) → b252ae5: engineer gates 325 / 5210, then 337 / 5435; e2e impor 27 passed, then phone 19 passed; fresh D1 0000–0040 + no-op rerun; `drizzle-kit check` fine. QA PASS (continuity 19 incl. 1 QA test; impor e2e 31/31). Red team PASS (3 files 29 tests; PoC forged gaps all 409). On main the QA overlap test failed 1/19 (also alone): statements starting the same day were ordered by random id; fixed by ordering on period_to and created_at. Squashed on main: continuity file 4× `19 passed (19)`; check 2224 files 0 errors, lint clean, `Test Files 337 passed (337)`, `Tests 5435 passed (5435)`, build ok.
- 2026-10-11 feat/fn-49-patungan 3d46e1c → e3f458c: engineer gates 327 / 5237 (cycle 1), 339 / 5467 (cycle 2), 342 / 5496 (rebased on 0040); fail-before aggregates 9 failed / 2 passed on the old aggregate.ts, link lock 2 failed, L1/L2 tests failed before; patungan e2e 7 passed; fresh D1 0000–0041 + no-op rerun. QA PASS cycle 1 (35 criteria) and cycle 2 (56 patungan tests, migration-0041 4, FK check clean, e2e patungan 7, shell 21). Red team PASS cycle 1 (33 tests, PoC 5) and cycle 2 (35/35, PoC 3/3, deleted). Squashed on main: `drizzle-kit check` fine, check 2251 files 0 errors, lint clean, `Test Files 342 passed (342)`, `Tests 5496 passed (5496)`, build ok.
- 2026-10-13 feat/fn-56-auth-ascii 0ed04a0 → e2a35d1: engineer gates 387 / 6541; e2e motion, accounts, turnstile, passkey, parity-d, ios-responsive, pwa, offline-queue, catatan-rilis, ruang, site, account-key `--workers=1` 231 passed 40 skipped 0 failed (cycle 1); cycle 2 motion, accounts, parity-d 42 passed 23 skipped 0 failed; generator 0.40 ms per desktop frame. Squashed on main: check 2375 files 0 errors 0 warnings, Prettier clean, `Test Files 387 passed (387)`, `Tests 6541 passed (6541)`, build ok.
