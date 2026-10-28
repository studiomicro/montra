# MONTRA — Task Tracker

Last updated: 2026-10-10 (WIB): merging on `integrate/2026-10-10`: Mutasi path, lows batch 1, FN-42b changelog, FN-19 forwarding fallback, FN-30 Pro hardening (refund records, re-claim markers, admin by account id), FN-22 Tanya; FN-19 Gmail (own OAuth app) built on `feat/fn-19-gmail` (migration 0033, not merged). Phases 0–4 credential-free work done; Phase 5 FN-29, FN-30, FN-31 and FN-32 done (FN-29/FN-30 to the credential boundary). App layout parity: waves A–D merged (layout parity complete); FN-34 – FN-37, FN-02, UI polish and a hardening batch done. Keep this file current so a new session can resume. Last updated: 2026-10-10 (WIB): merging on `integrate/2026-10-10`: Mutasi path, lows batch 1, FN-42b changelog, FN-19 forwarding fallback, FN-30 Pro hardening (refund records, re-claim markers, admin by account id), FN-22 Tanya; FN-20 merchants built on `feat/fn-20-merchants` (not merged)
The **To do** checklist is the source of truth for open work. When an item is done, tick it, then move it with its
evidence to `docs/HISTORY.md`.

## Status summary

Done: Claude Code setup, PRD v0.2, feature catalog FN-00 – FN-33, design system v1, FN-00 Foundation (SvelteKit 3 on
Cloudflare, three Workers, i18n, shell, D1 migrations, guards) and the component kit with `/dev/ui` (evidence in
`docs/HISTORY.md`). PRDs written (owner accepted defaults): FN-01 accounts, FN-03 spaces, FN-04 wallets, FN-05/06 transactions, FN-07/08 budgets and Beranda (`docs/features/*/PRD.md`). FN-09–FN-13 PRDs also written (defaults auto-accepted). Next: app layout parity waves A–D, then FN-34/FN-35 and FN-02. FN-19 forwarding fallback built and reviewed on `feat/fn-19-forwarding` (2026-10-10, migration 0030, not merged; real mail and the Email Routing domain are owner items). FN-19 Gmail via Montra's own OAuth app built and reviewed on `feat/fn-19-gmail` (2026-10-10, migration 0033, not merged; Google Cloud setup, real-provider test, verification and CASA are owner items). FN-17 spreadsheet import built and reviewed (no migration). Staging: redeployed. FN-16g on-device OCR built and reviewed on `feat/fn-16g-ocr` (2026-10-10, no migration, not merged; real samples and phones are owner items). FN-20 merchant recognition built and reviewed on `feat/fn-20-merchants` (2026-10-10, migration 0034 after renumbering, not merged; real AI not verified)
Staging deploy ledger (commits, versions, hosts, bookmarks): kept in the private tracker, omitted here.

## To do

Owner: **You** = needs your account, credentials, a decision or a dashboard action; **Claude** = code or
verification work that can run in a session.

### Owner decisions (before FN-00/FN-01)

- [ ] **You** — Product name, domain, logo and brand hue (design system v1 uses blue `#1F6FEB` as a placeholder).
- [x] **You** — Local-first scope: decided 2026-10-07, server-first like the earlier project with an offline write queue; guest
      mode and full local-first deferred.
- [x] **You** — Google sign-in: decided 2026-10-07, e-mail + password only.
- [x] **You** — Gmail access: decided 2026-10-10, Montra's own Google OAuth app (not a connection partner). It starts
      in Google's "Testing" publishing status (listed test users only, up to 100); Google verification and the CASA
      assessment happen before public launch. Forwarding fallback stays.
- [ ] **You** — Payment provider: Xendit (proposed) or Midtrans. Plan prices and credit name (FN-30, not before
      Phase 5).
- [x] **You** — Git remote for `/ship`: https://github.com/studiomicro/montra.

### Owner accounts and secrets

- [ ] **You** — Install Chromium system libraries for Playwright on this machine:
      `sudo npx playwright install-deps chromium` (libnspr4, libnss3, libnssutil3, libasound2). Until then
      `npm run test:e2e` cannot launch the browser here.
- [ ] **You** — Phase 0 review: per-phase review of the foundation (shell, kit at `/dev/ui`, runbook) before
      Phase 0 continues beyond FN-01/03/04.
- [x] **You** — Cloudflare account on Workers Paid (the project owner, 2026-10-08). Domain on Cloudflare still open (public site has no staging host).
- [ ] **You** — Anthropic API key and an AI Gateway (Phase 2).
- [ ] **You** — Google Cloud project for Gmail (FN-19, no Google sign-in): create the project, enable the Gmail API,
      OAuth consent screen in Testing with your test users, a Web client with the local and staging redirect URIs, then
      set `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (app + jobs Workers) and `CONNECTED_APPS_ENCRYPTION_KEY`
      on the jobs Worker (`docs/RUNBOOK.md` › Gmail (FN-19)). Until then the Gmail page shows "Belum dikonfigurasi".
- [ ] **You** — FN-19 Gmail real-provider test after the Google setup: connect a test-user mailbox, one real payment
      mail becomes a `gmail` draft, a second check makes no duplicate, look-back 7 days runs, disconnect revokes at
      Google and removes mail records (PRD AC 49, 50; also confirms PKCE at the token endpoint and `users.getProfile`).
- [ ] **You** — Before public launch: Google OAuth app verification (restricted scope `gmail.readonly`) and the CASA
      security assessment; `/privasi` Google API Services User Data Policy / Limited Use text with legal review.
- [ ] **You** — Redacted sample e-mails and statements from your own banks and e-wallets (golden set, Phase 2).
      FN-19b sender registry needs the e-mails first, with full headers (owner order 2026-10-28: BCA; GoPay/Gojek;
      OVO, DANA, ShopeePay; Mandiri, BRI, BNI).
- [ ] **You** — FN-19 forwarding domain: choose the domain, enable Cloudflare Email Routing, route the catch-all to
      the inbound Worker, set `INBOUND_EMAIL_DOMAIN` (app + inbound Workers), then find the authserv-id on the Worker
      route and set `INBOUND_AUTHSERV_ID` only if Cloudflare's header comes first (`docs/RUNBOOK.md` › E-mail
      forwarding (FN-19), steps 1–5). Until then Tambah › Otomatis shows "Belum dikonfigurasi".
- [ ] **You** — FN-19 real-mail test after the domain setup: one forwarded bank mail becomes a draft, one spoofed mail
      stays flagged (RUNBOOK step 6); plus one real Anthropic read with your own key.
- [ ] **You** — Payment provider sandbox (Phase 5); Slack, Notion, Google Sheets/Calendar apps (Phase 5).
- [ ] **You** — Legal review of privacy policy, terms, UU PDP consent and cross-border notice (before launch).

### Phase 0 — Foundation

- [x] **Claude** — FN-02 offline write queue (2026-10-08, no migration; guest mode and full local-first sync stay deferred).
- [x] **Claude** — FN-04 – FN-13 done (see `docs/HISTORY.md`).
- [x] **Claude** — FN-13b PWA platform compatibility, iOS and Android (2026-10-10, branch `feat/fn-13b-pwa-platforms`,
      not merged; `docs/features/fn-13b-pwa-platforms/SUMMARY.md`).
- [x] **Claude** — UI audit "Audit everything" (owner request 2026-10-10): done 2026-10-11, see HISTORY.
- [x] **Claude** — ios-responsive: iPhone responsive audit and fixes, plus phone layout v3 (owner requests 2026-10-10;
      branch `fix/ios-responsive`, not merged; `docs/features/ios-responsive/AUDIT.md`). 392 WebKit page states audited;
      select/picker overflow, hero figure fit, truncated rupiah, 44 px targets fixed; icon-only pill tab bar + round
      Tambah button, outlined chips, record rows. Guard: `e2e/ios-responsive.spec.ts` (WebKit projects `ios-se`,
      `ios-pro-max`).
- [x] **Claude** — Geist font (owner request 2026-10-10; branch `feat/geist-font`, not merged). Self-hosted
      variable Geist (UI) and Geist Mono (code samples), npm `geist@1.7.2`, SIL OFL 1.1; replaces the "system font"
      rule (DESIGN_SYSTEM § Typography). Evidence in `docs/HISTORY.md`.
- [ ] **You** — Geist real-device look: iPhone Safari and Android Chrome, first load (swap flash) and offline page.
- [ ] **You** — ios-responsive real-iPhone check: software keyboard over sheets and forms, `<select>` height and popup,
  Dynamic Island and home-indicator clearance of the pill and round Tambah button, landscape; see AUDIT.md "Remaining".
- [ ] **You** — FN-13b real-device check: install on an iPhone (Safari, iOS 16.4+) and an Android phone (Chrome); check
      the splash, status bar, safe areas (no double top inset), shortcuts and push opt-in (PRD criteria 32–33).
- [ ] **Claude** — FN-13b follow-ups: a provider checkout opened from the iOS home-screen app may return without the
      session (separate storage). (Red-team LOW-1 fixed: `Vary: User-Agent` on HTML.)

### Phase 2 — Capture

- [x] **Claude** — Shared money and date parser (`src/lib/shared`) with the voice slang, statement and CSV vectors
      (prerequisite for FN-14, FN-16 – FN-19).
- [x] **Claude** — FN-14 Voice · FN-18 CSV (no AI, can start early).
- [x] **Claude** — FN-21 Account key and sealed results (before FN-15/FN-16 store any result).
- [ ] **Claude** — FN-15 Receipt · FN-16 Statement (blocked by AI Gateway key for Pass level).
- [x] **Claude** — FN-17 Spreadsheet import (2026-10-10, branch `feat/fn-17-spreadsheet`, no migration; not merged,
      not deployed). Evidence in `docs/HISTORY.md` and `docs/features/fn-17-spreadsheet/`.
- [x] **Claude** — Merge `feat/fn-17-spreadsheet` (on main as 7523ec2; tracker caught up 2026-10-11).
- [x] **Claude** — FN-17 lows L1 and L5 (2026-10-11, branch `fix/xlsx-memory-sqref`, no migration; applied to the main
      working tree, not committed — `/ship`). See HISTORY. (L4: slot is freed for the AI call in lows batch 2; it stays
      held while the body uploads on purpose, the lane bounds the buffered bytes.)
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-17 follow-ups: L2 dedupe-key collision above row 2^20; the returned grid keeps the
      `sharedStrings.xml` text alive (~9 MB); a lying declared size costs one 16 MB allocation per read (fix-xlsx red
      team low).
- [ ] **You** — FN-17 real check: import one real Excel and one Google Sheets .xlsx export, and try "Sarankan
      pemetaan dengan AI" with your own Anthropic key (only mocked so far).
- [x] **Claude** — FN-19 forwarding fallback (2026-10-10, branch `feat/fn-19-forwarding`, migration 0030; not merged,
      not deployed). Evidence in `docs/HISTORY.md` and `docs/features/fn-19-forwarding/`.
- [x] **Claude** — FN-19 Gmail API path via own OAuth app (2026-10-10, branch `feat/fn-19-gmail`, migration 0033; not
      merged, not deployed). Evidence in `docs/HISTORY.md` and `docs/features/fn-19-gmail/`.
- [x] **Claude** — FN-19 Gmail lows L1–L4 (2026-10-10, branch `fix/gmail-lows`, migration 0035; not merged). Evidence
      in `docs/HISTORY.md`.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-19 Gmail low findings (`docs/features/fn-19-gmail/SECURITY_REPORT.md`): L5 topmost
      `Authentication-Results` trust; L6 no daily AI-read cap per connection; L7 no re-seal on key rotation
      (unopenable token cannot be revoked).
- [x] **Claude** — FN-19b Gmail follow-ups (2026-10-28, migration 0050): push per captured payment, opt-in auto-save,
      "Transaksi dari Gmail" review with undo per scan, empty sender-domain registry. See HISTORY and
      `docs/features/fn-19b-gmail-followups/SUMMARY.md`.
- [ ] **Claude** — FN-19c Gmail `history.list` incremental sync (split from FN-19b; hourly checks keep the `after:` search).
- [ ] **Claude** — FN-19b leftovers (low): F4 several hourly scans on one day show as separate groups with the same
      label (undo is per scan); I1 before the first registry domain goes in, confirm from the real samples that Gmail
      always writes its own `dmarc=` result (`docs/features/fn-19b-gmail-followups/SECURITY_REPORT.md` "Cycle 3").
- [ ] **Claude** — FN-19b sender registry: add real sender domains to `src/lib/shared/inbound/sender-domains.ts` only
      from the owner's redacted samples (owner order 2026-10-28: BCA; GoPay/Gojek; OVO, DANA, ShopeePay; Mandiri,
      BRI, BNI). Until then auto-save never fires and every Gmail push is generic.
- [ ] **You** — FN-19b real check after the Google setup: one real bank mail from a registered domain auto-saves with
      auto-save on, its push shows merchant and amount on a phone, a forwarded copy stays a draft, undo per scan works.
- [x] **Claude** — FN-20 Merchant recognition (2026-10-10, branch `feat/fn-20-merchants`, migration 0034 after renumbering at merge; not merged,
      not deployed). Evidence in `docs/HISTORY.md` and `docs/features/fn-20-merchants/`.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-20 low findings (`docs/features/fn-20-merchants/SECURITY_REPORT.md`): L2 AI-picked merchant name
      reused as title (needs an owner call: titles vs suggestion chip only), L4 fixed-window AI cap (see the fixed-window item
      under FN-16a). L1 and L3 fixed in lows batch 2.
- [ ] **You** — FN-20 real-provider check: run the merchant AI step once with your own Anthropic key through the AI
      Gateway and log it (mocked AI only so far; NOT verified).
- [x] **Claude** — (on main as 769840f; tracker caught up 2026-10-11) Merge `feat/fn-19-forwarding` to `main`: renumber 0030 if `feat/fn-22-tanya` merges first; resolve
      the conflict with the Mutasi add-path edit in `nav.ts`, `nav.test.ts`, `i18n-en.ts`, `e2e/shell.spec.ts`.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-19 forwarding low findings (`docs/features/fn-19-forwarding/SECURITY_REPORT.md`): L3 masking of
      unspaced en/em dash, U+2212, U+2010, `_`, `,`, `•` and spaced ` / ` separators (and `Rp150.000*12` over-masked);
      L4 separate per-address AI-read cap (needs a CHECK/migration change).
- [ ] **Claude** — Capture golden set and accuracy script per institution and path.
- [x] **Claude** — FN-45 Camera and gallery photo picker (2026-10-10, branch `feat/fn-45-camera-gallery`, no
      migration; not merged, not deployed). Evidence in `docs/HISTORY.md` and `docs/features/fn-45-camera-gallery/`.
- [ ] **You** — FN-45 real-device check: on an iPhone (Safari) and an Android phone (Chrome) take a photo with
      "Kamera" and pick one from "Galeri" on Struk and Barang; on Android pick a HEIC and confirm the how-to-fix message.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-45 follow-ups (`docs/features/fn-45-camera-gallery/SECURITY_REPORT.md`), client side only (the
      server already reads the first `photo` part and sniffs JPEG/PNG/WebP, tests added in lows batch 2): drop zone ignores
      `accept`; multi-file drop fallback posts N parts; block a second drop while preparing; PRD AC 15 vs `novalidate`.
      `feat/fn-16g-ocr` adopts `PhotoPicker.svelte` after merge.

- [x] **Claude** — FN-46 Pro look (owner request 2026-10-11; no migration; on main, uncommitted until `/ship`). See HISTORY.
- [ ] **You** — FN-46 real-phone check: as a Pro account, install Montra on an iPhone and an Android phone and confirm
      the Pro home-screen icon, the crowned Koko and the Emas and Hijau tua themes.
- [x] **Claude** — FN-47 more currencies (TWD, HKD, CNY) and decimal amounts (2026-10-11, no migration). See HISTORY.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-47 follow-ups: answer guard misses codes spelled with spaces (`R M B 500`, red team L4);
      `QUEUE_AMOUNT_MISSING` and the net-worth hint still say whole numbers; no-JS budget form re-shows the stored
      amount after a refusal; `xlsx-cpu.test.ts` linear-time bound flakes under machine load.
- [x] **Claude** — FN-48 Part A categories for imported rows (2026-10-11, migration 0037). See HISTORY.
- [x] **Claude** — FN-48 Part B month continuity (2026-10-11, migration 0040). See HISTORY.
- [x] **Claude** — FN-16j move an import batch to another wallet, "Pindahkan ke dompet lain" (2026-10-11, migration
      0042). See HISTORY.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16j red team lows: L1 refusal re-read at `src/lib/server/imports/repo.ts:393` lacks
      `isLiveMember` (removed-mid-request member gets 409 not 404; nothing leaks or is written); L2 a batch can move out
      of a deleted wallet (rows reappear in a live wallet of the same space; misleading `currency_mismatch` when the
      wallet row is gone). See `docs/features/fn-16j-move-import/SECURITY_REPORT.md`.
- [x] **Claude** — FN-51 more motion on phone PWA and desktop (2026-10-12, no migration). See HISTORY.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-51 red team lows: L1 Kotak masuk rows below a confirmed draft now shift up 150 ms later, so a
      fast tap on the next row's Abaikan can land on another row (`src/routes/(app)/kotak-masuk/+page.svelte:162`;
      the risk existed before with an instant shift); L2 the 8 px route slide can move a tap target during 200 ms
      (`src/routes/+layout.svelte:66`, informational). See `docs/features/fn-51-motion/SECURITY_REPORT.md`.
- [ ] **You** — FN-51 manual check: CLS and 60 fps of the new motion on a real Android phone (AC 6).
- [x] **Claude** — FN-48 Part C own-transfer matching (2026-10-13, migration 0043). See HISTORY.
- [x] **Claude** — FN-48d transfer auto-match after a statement import (2026-10-15, migration 0048). See HISTORY.
- [ ] **You** — Design polish B6: a new account still shows "Atur/Lihat anggaran" and "Tutup hari ini" on Beranda
      (kept for FN-34 decision B); decide whether an empty account shows them. See `docs/design/POLISH_AUDIT.md`.
- [ ] **Claude** — Design polish leftovers (`docs/design/POLISH_AUDIT.md` § Status): B4 Dompet "tersedia" figure
      (needs a computed value), B13 DailyStory focus (waits for the owner's uncommitted DailyStory change), record-row
      titles still cut early beside a wide amount at 360 px ("Gaji bulana…"), `e2e/motion.spec.ts:66` waits for an
      illustration shadow removed on 2026-10-14; uncovered: mono/Pro themes, 601–1023 px, Langganan, Barang,
      Koleksi, Patungan, Agen, public site.
- [ ] **Claude** — FN-48d red team L2: the auto-match read and `pairsAround` (`src/lib/server/transfers/match.ts`)
      compare all same-amount rows of a space before the ±1-day filter and sort before the scan limit; bounded and
      caught, but slow for thousands of same-amount transfers. See `docs/features/fn-48d-transfer-auto-match/SECURITY_REPORT.md`.
- [x] **Claude** — FN-50 passkeys and Turnstile bot check (2026-10-13, migration 0044). See HISTORY.
- [x] **Claude** — CI/CD with GitHub Actions (2026-10-13). See HISTORY and `docs/features/ci-cd/SUMMARY.md`.
- [x] **Claude** — FN-53 quarterly and yearly money flow and net worth report (2026-10-13, migration 0046). See HISTORY.
- [x] **Claude** — FN-54 greeting hero, calendar, daily greeting and feature icons (2026-10-13, no migration). See HISTORY.
- [x] **Claude** — FN-55a/b credit cards and card statement import infrastructure (2026-10-13, migration 0047). See HISTORY.
- [x] **Claude** — FN-56 ASCII field on sign-in and sign-up (2026-10-13, no migration). See HISTORY.
- [x] **Claude** — FN-57 app-wide brand-blue accent (2026-10-26, no migration). See HISTORY.
- [x] **Claude** — FN-58 pass 1 manual "Kartu e-money" wallet, seven issuers (2026-10-26, migration 0049). See HISTORY.
- [ ] **You** — FN-56: real-phone check of the sign-in animation (iPhone and Android, light and dark).
- [ ] **You** — FN-58 real-card check: install the debug APK (`native/android-app/README.md`), open Dompet › Baca kartu
      e-money, tap a KMT and each other e-money card you have, compare the KMT balance with a station machine, and send
      the copied logs. Also decide on Mandiri (earliest licensed source is decompiled) and Flazz Gen 2 (tainted).
- [ ] **You** — CekSaldo research (`docs/FEATURES.md` § Second reference, 2026-10-26): decide FN-58 pass 2
      (NFC tap, needs the FN-33 native apps; pass 1 done 2026-10-26), FN-59 toll receipts (not planned; legal read of
      the operators' terms first), FN-60 print/PDF export (Pro only?), FN-61 share image, FN-62 manifest shortcuts and
      spoken number, and whether a lifetime plan belongs in FN-30.
- [ ] **Claude** — FN-55 red team L2-R (low): a retype to card that lands while a bank-statement import runs still writes
      the bank rows into the card; guard the import's write so the wallet must not be `kartu_kredit`. Also: "Bayar
      tagihan" records whole rupiah only, so a bill with sen leaves the sen remaining.
- [ ] **Claude** — FN-55c card statement parsers, one per issuer, each only after its sample arrives (BRI, BCA, Mandiri,
      BNI, CIMB Niaga, OCBC); every parser bounds rows by the printed period or the statement date (PRD).
- [ ] **You** — FN-55c: one card statement PDF per issuer you hold (BRI, BCA, Mandiri, BNI, CIMB Niaga/OCBC), plus its
      password if protected.
- [ ] **You** — FN-54: approve "on this day" entries (drafts with sources in
      `docs/features/fn-54-greeting-calendar/ON_THIS_DAY_REVIEW.md`); real-phone check of the hero, badge and calendar.
- [x] **Claude** — Open lows outside import fixed or accepted before going public (2026-10-13, migration 0045). See
      HISTORY and `docs/features/fix-lows-services/SUMMARY.md`.
- [ ] **Claude** — fix-lows-services cycle 2 leftovers (low, `docs/features/fix-lows-services/SECURITY_REPORT.md` "Cycle 2"):
      `maskAccountNumbers` leaves digits split by 3+ spaces, `:` or a spaced ` . ` unmasked; answer guard passes `R/p 500`,
      `{B} dikalikan 12`, `rugi {B}`, `{B} / {A}`, `2 jeti` and over-blocks "Tiga terbesar: {A}, {B} dan {C}." and
      "Kurang {A} dari anggaran."; lure filter passes `[dot] com`, `. shop`, `kode verifikasi`, `kata kunci`;
      `resealGmailTokens` stalls behind 100+ rows no key opens (mark them, or page past them).
- [ ] **You** — FN-23 S7: may a user delete agent reports without the Agen plan? (changes AC 1). FN-30 L4: set
      `CLAIM_HASH_KEY` on staging before a real payment provider goes live.
- [ ] **Claude** — FN-52 Part A multi-language framework, picker and Spanish: **incomplete** after 3 fix cycles (QA
      cycle 3 failed on the CONTRIBUTING `npm run i18n:missing -- fr > …/fr.json` command crashing on the empty file;
      red team L1 content-check gaps open). Work is on `feat/fn-52-languages` (b746816), not merged. See
      `docs/features/fn-52-languages/SUMMARY.md` on that branch. Next: a new pipeline run for the remaining findings,
      then Parts B (Arabic RTL), C (other languages) and D (account language, push, Tanya).
- [ ] **You** — FN-52: turn on "Require review from Code Owners" for `main` on GitHub once CODEOWNERS lands.
- [ ] **You** — CI/CD setup on GitHub (`docs/RUNBOOK.md` › CI/CD): `staging` environment with you as required
      reviewer; secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_D1_DATABASE_ID`, `STAGING_KV_CACHE_ID`,
      `STAGING_APP_HOST`; optional var `STAGING_TURNSTILE_SITE_KEY`; a `v*` tag ruleset (only you create tags) before
      the first CI deploy; branch protection on `main` requiring `CI ok` and `analyze`.
- [ ] **Claude** — FN-50 red team lows (`docs/features/fn-50-passkey-turnstile/SECURITY_REPORT.md`): L1 sign-in
      accepts user presence without verification (PRD `preferred`; decide `required`); L2 no notice when a passkey is
      added (with decision 9 a phished password keeps access through an added passkey); L3 signed-out challenge rows,
      swept only on the next create; L4 `passkey_refused` events can be planted by anyone knowing a credential id;
      L5 hand-rolled verifier (owner-approved fallback).
- [ ] **You** — FN-50: create a Turnstile widget (managed) for the staging host, set `TURNSTILE_SECRET_KEY` (secret)
      and `TURNSTILE_SITE_KEY` (var) on staging, then check a passkey on a real iPhone and Android phone.
- [x] **Claude** — Open source: AGPL-3.0, one public commit, sanitised export of this repository.
- [ ] **You** — Open source: a security/conduct contact address (placeholder `<security-contact>` in
      `CODE_OF_CONDUCT.md` and `SECURITY.md`).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-48 Part A red team lows: L1 (note text steers category), L2 (0037 ALTERs not repeatable: apply
      only via `wrangler d1 migrations apply`). FN-16h OCBC Rekening Koran parser done 2026-10-11 (see HISTORY).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-48 Part C lows: red team L3, undoing the debit's import revives the credit after the user
      deleted the merged transfer (`src/lib/server/transfers/match.ts:499-510`; require a live debit for the credit
      restore, else settle without restoring); QA: the undo list shows only the 50 newest links; a pair straddling
      wallet B's first statement day shows a continuity gap until undo. See
      `docs/features/fn-48c-transfer-matching/SECURITY_REPORT.md` and `QA_REPORT.md`.

- [x] **Claude** — FN-16i Impor page layout (2026-10-11). FN-34b streak extensions (2026-10-11, migration 0038). FN-26b subscription check (2026-10-11, migration 0039). FN-25b Kekayaan page pass 1 (2026-10-11). See HISTORY.
- [ ] **Claude** — FN-25c Kekayaan pass 2: Piutang asset kind (credit-card statement/due days done in FN-55a).
      FN-25b lows: amounts flash before the eye toggle applies on reload; decide whether hiding also covers the trend
      line and percentages (owner).
- [ ] **Claude** — In flight 2026-10-11: FN-49 Patungan pass 1 done (see HISTORY).

- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-34b lows: reminder rotation queues every active user each open hour (batch by chosen hour
      before 10 000 users); re-check "day closed" at push delivery.
- [ ] **You** — VAPID keypair on staging so the evening reminder and other pushes are really sent (RUNBOOK › Secrets).

- [ ] **Claude** — FN-49 Patungan later passes: share link + WhatsApp text, percentage and per-item (Struk) modes,
      partial payments, Kekayaan Piutang (after FN-25c), auto-settle from imported repayments.
- [ ] **You** — FN-49: should a deleted payer's display name be blanked on shared-space splits? Default: kept.
- [ ] **You** — New logo (owner request 2026-10-11, "Geometric Lion Emblem on Orange"): send the image file; decide
      whether it also replaces Koko as the app icon.

### App layout parity (owner request 2026-10-08)

- [x] **Claude** — Parity wave A (2026-10-08, main d0de5dd): design system v2 visual revamp, shell, kit, Beranda,
      Transaksi. Left for later: Transaksi bulk select ("Pilih") and sort select (need server work).
- [x] **Claude** — Parity wave B (2026-10-08, main e47e343): Laporan monthly/yearly with heatmap, cumulative trend,
      donut, top places, biggest expenses, stacked monthly bars, categories over time.
- [x] **Claude** — Parity wave C (2026-10-08): Anggaran, Dompet, Fitur sheet, Impor layout; per-category budgets
      (migration 0020) — reverses FN-07 decision B for parity (owner to confirm). "Awal periode anggaran" disabled
      until budgets have a period start.
- [x] **Claude** — Parity wave D (2026-10-08, main 253a939): visual language on every remaining screen; sidebar fits
      at 768–900 px; "Lihat semua" in bold ink. Polish left: Langganan rows wrap to 3 lines at 360 px.
- [x] **Claude** — FN-34 streak / close the day (2026-10-08, migration 0021).
- [x] **Claude** — FN-35 money flow `/alur-uang` (2026-10-08, no migration).
- [x] **Claude** — FN-37 balance adjustment (2026-10-08, migration 0022 rebuilds `transactions`; account export
      now has every transaction type in `transactions.json`). Before the first remote apply: Time Travel bookmark
      (the deploy script takes one) and apply only through `wrangler d1 migrations apply` (atomic per file).
- [x] **Claude** — FN-36 recurring transactions (2026-10-08, migration 0023).
- [x] **Claude** — Phase red team FN-34 + FN-35 (2026-10-08): PASS, three lows deferred below. FN-37 gets its own.

### Phases 3 – 5 and later

FN-22 – FN-33 in `docs/FEATURES.md`; break them into items here when Phase 2 is under way.

- [x] **Claude** — FN-22 Assistant "Tanya" (2026-10-10, branch `feat/fn-22-tanya`, migration 0032 after renumbering at merge): BYOK
      through the AI Gateway, read-only space-scoped tools, retention and `/pengaturan/ingatan`. See HISTORY.
- [ ] **You** — FN-22: approve the runtime deviation from CLAUDE.md (plain tool loop in the app Worker, chat in D1; no
      Agents SDK / Durable Object until streaming or FN-23 needs it), or ask for the DO now.
- [ ] **You** — FN-22: with your own Anthropic key and the AI Gateway ids set locally, run `npm run compat:tanya` (real
      provider, not verified yet; also confirms the `thinking` request field and the answer guard on real answers).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-22 follow-ups: red team lows S11–S14 (`docs/features/fn-22-tanya/SECURITY_REPORT.md`),
      retention sweep in `workers/jobs`, removed-member chat rows in shared spaces, token usage on the usage page,
      `flock` missing on macOS breaks `scripts/e2e-build.sh`.

- [x] **Claude** — FN-23 Agent (beta) (2026-10-10, branch `feat/fn-23-agent`, migration 0036; 0035 skipped for another
      branch): `/agen`, Queue steps, R2 files deleted after 30 days, Agent plan only. See HISTORY.
- [ ] **You** — FN-23: approve the runtime deviation (Queue steps on `JOBS_QUEUE` with state in D1 instead of a Workflow),
      the defaults (limits 1/3 unfinished, 5/15 per day; no credit debit; reports visible to their creator only; CSV + HTML,
      no PDF), and run `npm run compat:agent` with your own Anthropic key and the AI Gateway ids (real provider, not verified).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-23 follow-ups (`docs/features/fn-23-agent/SECURITY_REPORT.md`, `QA_REPORT.md`): S1 URLs in the AI summary,
      S2/F1 Hapus frees cap slots (soft-delete or count deleted rows), S3/F2 cron `attempts` bump before enqueue, S4 poll cost
      (`monthsWithRows`, key decrypt), S5 CSP meta in the HTML file, S6/S7 removed-member and lapsed-plan report handling.

## Blocked (details)

Nothing yet.

## Assumptions

- Feature scope is the catalogue in `docs/FEATURES.md`; brand, copy and design identity are our own.
- Indonesia, IDR, WIB; English as a second UI language.
- Screens without a precedent (Laporan layout, app settings screens) are designed by us in our own style.

## Deferred from the FN-00 review (fix before the named milestone)

- [ ] **You** — `SUPPORT_EMAIL` address for the public `/hapus-akun` page (FN-01; staging shows the no-mailto text until set).
- [ ] **You** — On hold by owner (2026-10-08): Anthropic API key and Google OAuth client. AI capture (FN-15/16/17/19/20) and
      the assistant/agent (FN-22/23) wait for them.
- [x] **Claude** — FN-30 before a real provider: refund records for `paid_not_applied` payments; re-claim markers stop starter credits and per-user vouchers being re-claimed after delete + re-sign-up (2026-10-10, branch `feat/fn-30-pro-hardening`, migration 0030 — collides with fn-22/fn-19 0030, renumber at merge).
- [ ] **You** — FN-30 hardening secrets on staging after merge: `CLAIM_HASH_KEY` (`openssl rand -base64 32`), and
      `ADMIN_ACCOUNT_IDS` (sign up, read your `users.id` with a read-only `wrangler d1 execute`, then
      `npx wrangler secret put ADMIN_ACCOUNT_IDS --env staging`). `ADMIN_EMAILS` is no longer read. See RUNBOOK › Secrets.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-services/`): FN-30 hardening red team Lows (`docs/features/fn-30-pro-hardening/SECURITY_REPORT.md`): L1 address
      variants (trailing dot, fullwidth/Cyrillic lookalikes) bypass the marker; L2 deleted-account oracle; L3 privacy copy
      calls the keyed HMAC "sidik acak"; L4 missing `CLAIM_HASH_KEY` fails open, unchecked at deploy; L5 marker age from
      first deletion; L6 privacy copy omits billing/refund rows kept after deletion.
- [ ] **You** — Production/staging VAPID keypair for Web Push (generate locally per RUNBOOK; set with
      `npx wrangler secret put VAPID_PRIVATE_KEY --env staging` etc.). Until then notifications show "Belum dikonfigurasi".
- [x] **Claude** — `Clear-Site-Data: "storage"` on sign-out also clears the FN-02 queue; FN-02 asks before signing out with unsent items. Revisit only when full local-first lands.
- [ ] **You** — Domain for the public site (FN-32): canonical links, sitemap and the install QR name `site.localhost`
      until set; staging has no paired site host.
- [x] **Claude** — Hardening batch (2026-10-08, ba66e6a): FN-31 L1–L3, FN-36 L3, FN-37 demo rows, full ISO 4217
      table (unknown codes refused), 44 px small buttons, Langganan long names, `npm run clean:tmp`.
- [x] **Claude** — Hardening batch 2 (2026-10-08): invite tokens out of logs, deletion race, create rate limit, 0024 closed_on check, snapshot capacity, e2e hydration marker.
- [ ] **You** — CLAUDE.md wording proposed by db-normalize (D2): "Every space-scoped table has `space_id`, `updated_at`,
      `deleted_at` (tombstone) and a sync sequence; account-scoped settings, device registrations and append-only audit
      rows carry only what their lifecycle needs (documented on each table)." Approve to apply.
- [x] **Claude** — FN-38 public API (2026-10-08, migration 0026).
- [ ] **Claude** — On or after 2026-10-11: add `"sharp": "0.35.5"` to `overrides` (GHSA-wq5f-xc86-pv6w, dev-only via wrangler/miniflare); see `docs/features/deps-audit/REPORT.md`.
- [x] **Claude** — FN-38 red team L6 (info, 2026-10-09): added a test that every export of the CSRF-exempt API route files goes
      through the Bearer token check, so a cookie-authenticated handler added there later cannot skip CSRF.
- [x] **Claude** — FN-16a statement upload, bounded PDF reader and compat harness (2026-10-08, no migration).
- [ ] **Claude** — FN-16a BRI row parser (BCA done in FN-16b): waiting for a redacted sample in
      `.superpowers/ref/samples/statements/` (git-ignored). Then `npm run compat:statements`.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16a red team lows: upload slot held while the body uploads (3 slow uploaders → 503 for others on
      that isolate); fixed-window throttle lets ~60 uploads through around a window edge. Both left open in lows batch 2:
      the slot bounds buffered bytes by design, and a sliding window means changing the shared `countAttempt`
      (`auth/throttle.ts`) to two rows per key with a weighted count and a new sweep, used by every scope: not a small fix.
- [x] **Claude** — FN-39 ride-hailing and food delivery options (2026-10-09, migration 0027): Ojek Online and Pesan
      Antar Makanan presets, keyword recognition (voice, CSV, statement, Slack), e-wallet quick-picks, Langganan entries.
- [x] **Claude** — 0027 on staging (2026-10-09): Time Travel bookmark taken; row counts of categories, budgets,
      recurring, transactions and drafts identical before and after; no `__fn39_*` table left; budget trigger present.
- [x] **Claude** — (fixed 2026-10-09: `ScreenTitle` compact toggle oscillated near the top) e2e flake: `e2e/suara.spec.ts:144` desktop once timed out waiting for "Simpan 2 transaksi" to be
      stable (51 stability polls) in the full pre-deploy run; the file passed 15/15 on rerun. Find what keeps the
      button moving (reduced motion is on in e2e).
- [x] **Claude** — FN-40 parts 1+4: Hitam-putih theme and glass material (2026-10-09, no migration).
- [x] **Claude** — FN-40 parts 2+3: motion and isometric illustrations (2026-10-09, no migration).
- [x] **Claude** — FN-41 Integrations: per-user Anthropic key (BYOK) and admin status view (2026-10-09, migration 0028).
- [ ] **You** — FN-41 secrets on staging: `ADMIN_ACCOUNT_IDS` (replaces `ADMIN_EMAILS` once FN-30 hardening merges), `AI_KEYS_ENCRYPTION_KEY` (`openssl rand -base64 32 | tr '+/'
      '-_' | tr -d '='`), and after creating an AI Gateway in the Cloudflare dashboard `AI_GATEWAY_ACCOUNT_ID` and
      `AI_GATEWAY_ID` (`npx wrangler secret put <NAME> --env staging`; see RUNBOOK › Secrets). Then one real
      "Tes koneksi" with your own key.
- [x] **Claude** — FN-41 red team L1: admin gated by `ADMIN_ACCOUNT_IDS`, no e-mail fallback (2026-10-10, FN-30 hardening branch).
- [ ] **Claude** — FN-41 red team L4: one sealing secret opens every stored key; add a re-seal job for rotation (needs a
      runner holding the sealing secrets; not small, left open by the FN-30 hardening PRD).
- [x] **Claude** — FN-42 version, updates and usage in Pengaturan (2026-10-09, no migration).
- [x] **Claude** — FN-42b changelog page, automatic update checks and post-update "what's new" (2026-10-10, no
      migration; on branch feat/fn-42b-changelog, not yet merged — `/ship`).
- [x] **Claude** — FN-16b BCA e-statement parser with running-balance self-checks (2026-10-09, no migration).
- [x] **Claude** — FN-16c BCA CSV mutasi parser with balance self-checks (2026-10-09, no migration).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16c lows: odd remark text can make a month's CSV unimportable; cross-format duplicates (PDF and
      CSV of one month) only flagged; FN-16f OCBC done.
- [x] **Claude** — FN-16f OCBC e-statement parser (2026-10-09, no migration).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16f red team L1 (low): positioned text from `pdf-text.ts` so an OCBC row starts only from the Trans Date column and amounts only from Debet/Kredit/Saldo (closes a planted equal income/expense pair at the exact running balance). L2: remark text can refuse the user's own statement (fail closed).
- [x] **Claude** — FN-16e Mandiri consolidated e-statement parser with account picker (2026-10-09, no migration).
- [x] **Claude** — FN-44 Koko pixel mascot (2026-10-09, no migration).
- [x] **Claude** — e2e failing on main 3867a6f (2026-10-26): `period-reports` and `period-reports-qa` seeded the newest
      space on the server, which a parallel test may own (now the test user's own space, by e-mail); `motion` reduced
      motion waited for `.illustration .shadow`, removed by the blueprint illustrations (1c93349).
- [x] **Claude** — `e2e/impor-ocr.spec.ts:207` cancel race fixed (the test holds the OCR worker script until it has
      pressed Batal; 8/8 repeats), 2026-10-26.
- [ ] **Claude** — Test flakes under load: fixed-window throttle tests (`public-api` 429 after 20 failures, `struk` 11th read) and local D1 `SocketError: other side closed` in integration files; pass on rerun.
- [x] **Claude** — FN-43 brand badges (2026-10-09, no migration).
- [ ] **You** — FN-43 red team L1 (trade dress): badge colours sit close to each brand's own colour and some
      monograms follow the word-mark casing (GoPay, blu). Sign off, or ask for neutral colours.
- [x] **Claude** — FN-16d BNI e-statement parser with balance self-checks (2026-10-09, no migration).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16h lows (`docs/features/fn-16h-ocbc-rekening-koran/SECURITY_REPORT.md`): L1 balanced fake pair
      from one note line per row (read amounts by column position from `pdf-text.ts`, as FN-16f L1); L2 structure
      words in a note refuse the statement (fail-closed).
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16d low L2 (accepted, fail-closed): third-party remark text (a wrapped date line, a copied amount
      tail, BCA header text) can make a user's own BNI statement refuse to import or need a manual bank pick.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16b lows: a remark equal to the table header can redistribute amounts between one sender's
      adjacent rows; third-party text such as `MATA UANG USD` refuses a whole statement. Needs a multi-page BCA
      sample to verify continuation pages.
- [x] **Claude** — FN-16g on-device OCR (Tesseract WASM in the browser) for scanned statement PDFs, e-wallet and
      mobile-banking screenshots and camera photos (2026-10-10, branch `feat/fn-16g-ocr`, not merged, no migration).
      Owner decisions 2026-10-10: engine tesseract.js on the device, never Claude vision; inputs are scanned PDFs,
      GoPay/OVO/DANA/ShopeePay and BCA/Mandiri/BRI/BNI mutation screenshots, plus camera photos (owner request).
- [ ] **You** — FN-16g real samples: put redacted scans, screenshots and camera photos of paper statements in
      `.superpowers/ref/samples/ocr/` (git-ignored), then run `npm run compat:ocr`. This calibrates the confidence
      thresholds (70/90) and the screenshot layout parsers, which are tested on fictional fixtures only.
- [ ] **You** — FN-16g real-phone check: one scanned PDF, one screenshot and one camera photo on an Android phone
      (Chrome) and an iPhone (Safari, including a HEIC photo), at 360 px.
- [x] **Claude** — Resolved 2026-10-13 (`docs/features/fix-lows-imports/`): FN-16g lows: L2 CI `npm ci --ignore-scripts` plus the `.ocr-cache/` CI cache (RUNBOOK); L4
      `ocrAssetsCurrent` ignores extra files planted in `static/_ocr/<version>/`; L5 a HEIC with a decoy `ispe` in the
      first 512 KB skips the 24 MP cap (crashes only the user's own tab); a valid HEIC without a readable head `ispe`
      is refused as damaged; a wallet-less import and a later explicit-wallet re-scan get different dedupe scopes
      ("Mungkin duplikat" still flags them). After FN-45 merges, swap the OCR picker for the shared `PhotoPicker`.
- [x] **Claude** — FN-15 receipt reading with the user's own Anthropic key (2026-10-09, migration 0029).
- [x] **Claude** — FN-15 low L3 (2026-10-09): `?/save` now needs the sealed read ticket `read` issues (same user, space and
      photo bytes, 24 h); without it the save is refused with "Baca struk ini dulu sebelum menyimpan.". (L2 is moot for staging: 0029 ran on
      an empty database; keep the bookmark + row-count step for production.)
- [x] **Claude** — Old `financer-*` staging resources deleted on owner request (2026-10-09): Workers app/jobs/inbound,
      Workflow `financer-statement-staging`, queues and DLQ, R2 `financer-files-staging` (empty), KV
      `financer-cache-staging`, D1 `financer-staging`. The Analytics Engine dataset expires on its own.
- [x] **You/Claude** — Domain `montra.id` active on the project owner's Cloudflare account (2026-10-09); the staging app answers
      on https://app.example.com (custom domain, owner choice) with workers.dev as a fallback. `montra.id` (public
      site) is not mapped yet; when production exists, decide where staging moves (e.g. `staging.montra.id`).
- [ ] **You** — Receipt photos (redacted) in `.superpowers/ref/samples/receipts/` and your own Anthropic key, then
      `npm run compat:receipts` for a real accuracy run.
- [ ] **You** — Rive: supply `.riv` files (made in the Rive editor) to replace any `<Illustration>` scene; the slot
      is ready.
- [ ] **Claude** — Left: `__fn37_links` in 0022
      lacks IF NOT EXISTS (already applied on staging; apply only via wrangler); FN-02 iOS Web Locks untested.
      (FN-02 resent delete fixed 2026-10-09: a resent delete that finds its tombstone answers `ok`.)
- [x] **Claude** — UI polish (2026-10-08): Alur uang ribbons, Struk button, Langganan two-line rows, compare pill
      hidden when both periods are zero; FN-34/35 lows 1 and 3 fixed. Left: Langganan names truncate hard at 360 px.
- [ ] **You** — Per-user cap on shared spaces (FN-03 gives no number; FN-36's D1 budget bounds the effect). Default: none.
