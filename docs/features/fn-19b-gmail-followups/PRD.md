# FN-19b Gmail follow-ups: push per payment, auto-save, "Transaksi dari Gmail" review with undo, real sender domains

Risk tier: **large** (schema migration with table rebuilds, a path that writes transactions without a tap, a
security-sensitive capture path). Needs QA plus red team. Branch `feat/fn-19b-gmail-followups` from `main` a19d832.
Closes the `docs/TASKS.md` item "FN-19 Gmail follow-ups" except `history.list` (named later pass, see Out of scope).

## Goal

FN-19 turns bank, QRIS and e-wallet mail into drafts in Kotak masuk, but the user must open the app to find them.
This pass closes the loop: (1) a push per captured payment, (2) an opt-in auto-save that skips the inbox for
trustworthy deterministic captures, (3) a "Transaksi dari Gmail" screen that shows what Gmail brought in, per
scan, with one tap to undo a whole scan, and (4) a safe way to replace the fictional sender domains with real ones
without inventing any. Everything stays opt-in or reversible, and no mail text is ever stored (unchanged).

## Current behaviour (cite for the engineer)

- Captures are drafts, source `gmail`, trust always `unverified` (owner decision 2026-10-13):
  `src/lib/server/gmail/read.ts:122-124`, `src/lib/server/inbound/draft.ts:132-139` (`flagSql`: every Gmail capture
  is `needs_review`, or `duplicate` within 12 h of the same amount), `captureBatch` `draft.ts:174-250`.
- Ledger `gmail_mail` links `draft_id` and `scan_id` (`schema.ts:2561-2584`); scans in `gmail_scans`
  (`schema.ts` near 2500), kinds `hourly` / `lookback` (`src/lib/shared/gmail/ledger.ts`).
- Draft to transaction: `saveDrafts` `src/lib/server/drafts/repo.ts:462-540` (FN-05 validator, one insert path, draft
  tombstone with `saved_transaction_id`). Needs a wallet and a category; drafts have `wallet_id` null on capture.
- `import_batches.source` already allows `'gmail_lookback'` (`schema.ts:638`) and batches have `undone_at`; the
  "Urungkan" path of FN-18 tombstones a batch's transactions.
- Notifications: closed kind list `src/lib/shared/notifications.ts:14-34`; CHECK on `space_notifications.kind`
  (rebuilt in `migrations/0013_subscriptions.sql:54-78`, latest shape) and `notification_prefs.kind`
  (`migrations/0012_notifications.sql`; later widened, find the newest shape with `grep -l notification_prefs migrations`);
  `createIfAbsent` `src/lib/server/notifications/repo.ts:66`; push `deliverPush`
  `src/lib/server/notifications/triggers.ts:351`; grouping precedent `BILL_REMINDERS_PER_DAY` / `billGroupDataKey`
  `notifications.ts:377-379`. Quiet hours 00:00-05:59 WIB already suppress pushes (`isQuietHour`).
- Sender parsers use fictional `*.example` domains (`src/lib/shared/inbound/parsers.ts:14-16, 178-251`); the Gmail
  query uses name words, not domains (`src/lib/shared/gmail/query.ts:11-41`, comment: "real sender domains not confirmed").
- Latest migration is `0049_emoney_cards.sql`; next free number **0050**. No other worktree holds 0050 (checked
  2026-10-28: android-nfc, fn-52-languages, lows-batch-1). Renumber at merge if that changes.

## Scope

### A. Push per captured payment (FN-24 new kind `gmail_payment`)

- New notification kind `gmail_payment`, a **space** kind (the payment belongs to the connection's target space;
  recipient = the connection owner). Added to `NOTIFICATION_KINDS`, `SPACE_NOTIFICATION_KINDS`,
  `NOTIFICATION_KIND_LABELS` (settings row "Pembayaran dari Gmail"), `notificationText`, `notificationUrl`
  (target: `/pengaturan/aplikasi/gmail/transaksi`, or `/kotak-masuk` when the capture stayed a draft, see below),
  `parseParams`, with Indonesian and English strings.
- `params` JSON holds the stored figures only: `{ draftId | transactionId, merchant (cleaned title), amountMinor,
  currency:'IDR', direction, categoryName|null, saved:boolean }`. Merchant is the already-stored draft title (never
  mail text; mail text is not kept anywhere). Push text is built from fixed templates, no AI.
- Created in the same `gmail_read` flow after a `draft_created` ledger result **inserted by this delivery** and only
  for `hourly` scans (never `lookback`, never `Baca ulang`), by a new `evaluateGmailPayment` trigger using
  `createIfAbsent` (idempotent by `dataKey = draftId`), then one `send_push` per new row via the existing queue.
  Failure here never fails the read (mirror `notifyGoalMilestone`: log name only).
- Frequency cap per recipient per WIB day: `GMAIL_PUSHES_PER_DAY = 5` single notifications, then ONE grouped
  notification per user per WIB day ("N pembayaran baru dari Gmail", names nothing), `dataKey = gmailgroup:<spaceId>:<date>`
  (same pattern as `billGroupDataKey`). Past the cap only the group row exists; every capture is still a draft or
  transaction, visible in Kotak masuk and the review screen.
- Respects `notification_prefs` (kind off = no row, no push), device opt-in (FN-13 subscriptions) and quiet hours.
- Connect-screen toggle "Beri tahu di perangkat ini" is the same pref as the new settings row (one source of truth,
  `notification_prefs.kind='gmail_payment'`), default on (matches FN-24 owner decision 5: default-on).

### B. Auto-save (opt-in, deterministic captures only)

- New columns on `gmail_connections`: `auto_save integer not null default 0`, `auto_save_wallet_id text null`
  (FK `wallets`, the wallet captures go to). Appended LAST so the insert-select in `oauth.ts` (columns in table
  order) is updated and tested, as 0045 did.
- Setting on `/pengaturan/aplikasi/gmail`: switch "Simpan otomatis" plus wallet picker "Simpan ke dompet", disabled
  until a wallet is chosen. Server action `setAutoSave` validates the wallet is a live wallet of the connection's
  space and IDR (the capture currency), the user is a live member, and compares `updated_at` (stale-form rule).
- Eligibility, ALL required, evaluated in one guarded batch right after the draft insert (no read-then-write):
  1. `auto_save = 1`, connection `connected`, owner still a live member, wallet live and IDR;
  2. parser is deterministic (`parser != 'ai'`): **AI readings never auto-save** (a mail can steer an LLM);
  3. sender domain is in the **confirmed real-domain list** (section D), not a `*.example` fixture domain;
  4. direction `expense` only by default (income auto-save is an owner decision); amount within
     `GMAIL_AUTOSAVE_MAX_MINOR` (default Rp 5.000.000 per capture);
  5. draft not flagged `duplicate`; draft has a category after FN-20 (else it stays a draft: `saveDrafts` already
     refuses incomplete drafts);
  6. fewer than `GMAIL_AUTOSAVE_PER_DAY = 20` auto-saves for this connection in the current WIB day (burst cap; the
     rest stay drafts for review);
  7. scan kind `hourly` only. A look-back never auto-saves (user reviews it in the new screen, then "Simpan").
- Writes through the existing `saveDrafts` single insert path (FN-05 validator, source `gmail`, dedupe key, captured
  instant, `category_source = 'auto'`), after setting the draft's `wallet_id` in the same batch. The transaction keeps
  the note "Belum diverifikasi" (trust label) so it stays visibly Gmail-sourced. New column
  `drafts`-side link is not needed: `gmail_mail.draft_id -> drafts.saved_transaction_id` already traces mail to tx.
- Auto-saved transactions appear as normal transactions, flagged in the list/detail with "Dari Gmail (otomatis)"
  chip derived from `source='gmail'`; the pushed notification says "Tersimpan" (params `saved:true`).
- Turning auto-save off, losing the wallet, `needs_reconnect`, or `space_lost` stops it immediately (checked in the
  same guarded statement, so queued reads in flight obey it).

### C. "Transaksi dari Gmail" review screen with undo-by-scan

- New route `src/routes/(app)/pengaturan/aplikasi/gmail/transaksi/` (+ link from the Gmail page and from the push).
  Lists the connection's captures newest first, grouped per WIB day and per scan (hourly scans collapse into
  "Pemeriksaan otomatis <date>", look-backs show "Lihat ke belakang <N hari>"). Each row: cleaned title, amount
  (shared money formatter), in/out, state chip `Draf` / `Tersimpan` (tx exists) / `Dibatalkan` / `Duplikat`, sender
  domain, masked subject (both already stored), and "Buka di Gmail" (`https://mail.google.com/mail/u/<address>/#all/<gmailId>`,
  built from stored ids only, opened with `rel="noopener noreferrer"`).
- Data comes only from `gmail_mail` joined to `drafts` / `transactions` of the connection's own space; paginated
  (page size 50, cursor on `received_at,id`), capped to the 90-day ledger retention.
- Per-scan actions: **"Urungkan pemindaian"** (undo-by-scan) and, for look-backs, **"Simpan semua yang lengkap"**
  (reuses `saveDrafts` with the user's wallet/category choices; bulk category/wallet reuse `setDraftsCategory` /
  `setDraftsWallet`, no new write path).
- Undo-by-scan, one `db.batch` guarded by scan id + space + owner: (a) tombstone every still-pending draft of the
  scan (`discardDraftsWhere`); (b) tombstone every transaction created from a draft of that scan (through
  `gmail_mail.scan_id` -> `draft_id` -> `drafts.saved_transaction_id`), skipping transactions the user edited after
  creation (`transactions.updated_at > created_at`) or that are linked as transfers, and counting skipped ones;
  (c) set `gmail_scans.undone_at`. Dedupe keys stay, so the same mail is never recreated (consistent with FN-19:
  a discarded draft is never recreated). The result states exact counts ("12 dibatalkan, 2 dilewati karena sudah
  kamu ubah"). Undo window: see Owner decisions (default 7 days from scan end, and always for pending drafts).
- Undo is idempotent (second call = 0 changes, "Sudah diurungkan"); a concurrent save and undo cannot both win
  (guarded on `drafts.deleted_at is null` / `transactions.deleted_at is null` and `updated_at`).
- Space authorization: the loader and every action resolve the connection from the SESSION user, then the space via
  the shared space-access helper; a removed member sees 403/empty and no row of another user's connection leaks.

### D. Real sender domains, without inventing any

- No domain is invented or guessed by Claude. A domain enters the code only from (a) a redacted real sample the owner
  puts in `.superpowers/ref/samples/` (existing **You** item, `docs/TASKS.md:50`), where the `From:` and
  `Authentication-Results` of that sample confirm it, or (b) a domain the owner pastes in the PRD answer below.
- Build the mechanism now: `src/lib/shared/inbound/sender-domains.ts` holds a typed registry
  `{ domain, institution, parserId, confirmedBy: 'owner-sample' | 'owner-statement', confirmedOn }[]`, initially
  EMPTY. `parserFor` / `isAllowlistedSender` read the registry plus the fictional fixture domains (fixtures stay for
  tests only, tagged `fixture: true`). A unit test fails if any registry entry lacks `confirmedBy`, is not a
  lowercase registrable host, or ends in `.example`/`.test`/`.invalid`; and if any `fixture` domain is used when
  `import.meta.env.PROD` (production code path never trusts a fixture domain for auto-save).
- `gmailQuery` additionally ANDs registry domains as `from:(...@domain)` terms (name-word terms stay as the
  wide net). Query length guard `GMAIL_QUERY_MAX` stays; test with a full 30-domain registry.
- A `npm run compat:senders` script (mirrors `compat:statements`) lists, per sample file, the sender domain and
  whether a parser reads it, so adding a domain is a one-line registry change plus a fixture.
- Until the registry has entries, auto-save (B.3) never fires in production, and the PRD says so honestly in the UI:
  "Simpan otomatis aktif untuk pengirim yang sudah dikonfirmasi: belum ada" (shown only when the registry is empty).

## Out of scope (named later passes)

- **FN-19c `history.list` incremental sync** (Gmail `startHistoryId`, 404 fallback to the `after:` query, historyId
  store per connection, quota 2 units). Own pass because it changes scan bookkeeping (`checked_through`) and needs
  its own failure matrix (expired historyId, label-only history). Proposed: next pass; polling with `after:` stays.
- Pub/Sub `watch` / push from Google (needs a Cloud topic), income auto-save beyond owner answer, auto-save of AI
  readings, per-merchant auto-save rules, editing a transaction from the review screen (opens the normal editor),
  CSV export of the review list, Gmail label management (read-only scope stays).

## Acceptance criteria

Verification levels: Automated = Vitest/local D1 integration with fakes; Browser = Playwright against the dev
server with a fake Google (`test/helpers/fake-google.ts`); Mocked = fake Anthropic; **Unverified** = needs the
owner's real Google setup.

Push (Automated, Browser for settings)
1. Given an hourly scan reads a deterministic payment mail, when the draft is inserted, then exactly one
   `gmail_payment` notification exists for the connection owner in that space and one `send_push` is enqueued.
2. Given the same `gmail_read` is redelivered, then no second notification and no second push (idempotent by draft id).
3. Given a look-back scan or "Baca ulang yang tertunda", then no notification is created.
4. Given 7 captures in one WIB day, then 5 single notifications and one group notification "2 pembayaran baru" (count
   updates are NOT re-pushed after the group exists), and all 7 drafts exist.
5. Given the user turned the kind off in `/pengaturan/notifikasi`, then no row and no push; given quiet hours, the row
   exists and no push is sent (existing rule), given no VAPID keys, row only ("unconfigured").
6. Given the draft is deleted or the user left the space before delivery, then the push is not sent (`gone`).
7. Push and list text come from fixed templates, Indonesian and English entries exist, amount uses the shared
   formatter, and no mail text, sender address or Gmail id is in `params` or the payload.

Auto-save (Automated)
8. Given auto-save off (default), then captures stay drafts exactly as before (regression: existing gmail tests pass unchanged).
9. Given auto-save on with a valid wallet, a deterministic capture from a registry domain, expense, under the cap,
   categorised, not duplicate, then one transaction exists with source `gmail`, the wallet, the dedupe key, and the
   draft is a tombstone pointing at it; wallet balance moves by exactly the amount (integer minor units).
10. Given any single eligibility rule fails (AI parser, fixture/unknown domain, income, over cap, duplicate flag, no
    category, look-back, 21st of the day, wallet deleted, auto-save switched off after queueing, connection
    `needs_reconnect`, owner left space), then the capture stays a draft and nothing else changes. One test per rule,
    each failing on a build without that rule.
11. Given 20 concurrent reads for one connection, then at most `GMAIL_AUTOSAVE_PER_DAY` transactions are saved
    (limit holds exactly) and the others are drafts.
12. Given the space hit its transaction cap, then the capture stays a draft (no 500, no lost mail).
13. `setAutoSave`: wallet from another space, deleted wallet, non-IDR wallet, non-member, stale `updated_at` each
    answer a clear error, nothing saved; success shown only after the confirmed write; state survives reload.
14. WIB bucketing: a mail at 23:30 WIB on the last day of a month lands on that `occurred_on`; the per-day cap rolls at 00:00 WIB.

Review and undo (Automated + Browser)
15. Given captures from two scans, then the screen groups them per day and scan, totals per day equal the sum of the
    listed rows with the same filters, and states (Draf / Tersimpan / Dibatalkan / Duplikat) match the DB.
16. Empty, loading, error and "Belum terhubung" states exist; a failed load shows a retry, not a blank page.
17. Given "Urungkan pemindaian" on a scan with 3 pending drafts and 2 auto-saved transactions (one edited by the
    user), then 3 drafts and 1 transaction are tombstoned, the edited one is kept and reported as skipped, balances
    reconcile, and the same mail is not recreated by the next hourly check.
18. Undo twice, or undo while another tab saved a draft, is safe (idempotent, counts exact, no partial state).
19. Given a user who is not the connection owner (another member, a removed member, a user of another space), when
    they request the page, a scan id, or the undo action, then they get 403/404 and no data; ids from another
    user's scan are rejected (cross-space crawl probe).
20. "Buka di Gmail" link is built only from stored ids, escapes the address, and carries `rel="noopener noreferrer"`.
21. Disconnect deletes the new per-scan state with the rest of the connection's mail data; transactions stay; account
    deletion removes `auto_save_wallet_id` references (FK `ON DELETE SET NULL` and auto-save turned off).

Sender domains (Automated)
22. Registry test rules (see D) pass; with an empty registry production auto-save never fires and the UI says so.
23. `parserFor` resolves registry and fixture domains; an unknown domain still goes to the AI path; a registry domain
    with a mismatching parser shape falls to the AI path (no wrong amounts); subdomain look-alikes
    (`evil-<domain>`, `<domain>.evil.tld`) do not match (exact match only).
24. `gmailQuery` with a 30-domain registry stays under `GMAIL_QUERY_MAX` and contains only constants (no user text).

Migration and general
25. Migration 0050 applies on a fresh DB and on a copy of staging data: existing `space_notifications` and
    `notification_prefs` rows are preserved with identical ids and `seq`, unique and normal indexes recreated, FKs
    intact, `gmail_connections` rows keep `auto_save = 0`. A test inserts a `gmail_payment` row and a prefs row and
    proves the old kinds still pass and an unknown kind is refused by CHECK.
26. Every new Indonesian phrase has an English entry (`i18n.ts`/`i18n-en.ts`, including server messages and `trf()`
    templates); touch targets >= 44 px on coarse pointers; focus returns to the opener after the undo dialog; headings
    do not skip; keyed `{#each}` by id.
27. Money is integer minor units everywhere; no float in cap/sum code; amounts in logs forbidden (counts and status only).
28. `npm run gates` is clean; every regression test shown failing on the unfixed code.

## Data and migration plan (0050, `migrations/0050_gmail_followups.sql`)

SQLite cannot alter a CHECK, so (Drizzle-style, as `0013_subscriptions.sql:54-78`):
1. `__new_space_notifications` with the same columns and both CHECKs, kind list extended with `'gmail_payment'`;
   `INSERT ... SELECT` all columns in order; `DROP TABLE`; `RENAME`; recreate the four indexes
   (`space_notifications_key_uq`, `_user_idx`, `_space_idx`, `_created_idx`).
2. Same for `notification_prefs` (kind list extended; recreate `notification_prefs_user_kind_uq`). Start from the
   NEWEST existing kind list (it already includes `bill_reminder`, `close_reminder`; read the latest migration that
   rebuilt it), never from `0012`.
3. `ALTER TABLE gmail_connections ADD auto_save integer DEFAULT 0 NOT NULL` (+ CHECK in (0,1) via rebuild only if the
   engineer prefers; a plain ALTER is allowed to omit the CHECK, mirrored by app validation), and
   `ADD auto_save_wallet_id text REFERENCES wallets(id) ON DELETE SET NULL`.
4. `ALTER TABLE gmail_scans ADD undone_at integer` (null = not undone; counts are returned, not stored).
5. Wrap the rebuilds so a foreign-key-enforcing D1 import does not cascade-delete children (follow what 0013 did:
   `PRAGMA foreign_keys` is handled by the migration runner; verify on a populated local DB first).
6. Update `schema.ts`, `migrations/meta/0050_snapshot.json`, `_journal.json`; update the insert-select in `oauth.ts`
   (columns in table order) and `docs/RUNBOOK.md` (Time Travel bookmark BEFORE applying to staging/prod; rollback
   = restore bookmark, the rebuilt tables are additive so old code still runs against them except the new kind).
7. Deploy order: migration first, then app Worker and jobs Worker (old code ignores the new columns/kind).
No new tables. No mail text columns. Ledger retention (90 days) unchanged; `undone_at` lives with the scan row.

## Architecture notes

- Shared (pure): `src/lib/shared/notifications.ts` (kind, templates, caps), `src/lib/shared/gmail/ledger.ts`
  (`GMAIL_PUSHES_PER_DAY`, `GMAIL_AUTOSAVE_PER_DAY`, `GMAIL_AUTOSAVE_MAX_MINOR`, `GMAIL_UNDO_WINDOW_MS`),
  `src/lib/shared/inbound/sender-domains.ts` (new), `src/lib/shared/gmail/query.ts`.
- Server: `src/lib/server/gmail/read.ts` (post-capture hook), new `src/lib/server/gmail/autosave.ts` and
  `src/lib/server/gmail/review.ts` (list + undo), `src/lib/server/gmail/repo.ts` (settings), `src/lib/server/notifications/triggers.ts`
  (`evaluateGmailPayment`), reuse `drafts/repo.ts` (`saveDrafts`, `discardDraftsWhere`), `inbound/draft.ts`.
- Worker: `workers/jobs` unchanged routing (`gmail_read` already enqueues; `send_push` already handled); the push is
  enqueued from the read handler's result.
- UI: `src/routes/(app)/pengaturan/aplikasi/gmail/+page.*` (auto-save), new `.../transaksi/+page.*`,
  `src/routes/(app)/pengaturan/notifikasi` (new row appears from `NOTIFICATION_KIND_LABELS`), transaction row chip.
- Tests: extend `test/helpers/fake-google.ts`, `test/integration/gmail.test.ts`, new `test/integration/gmail-followups.test.ts`,
  `src/lib/shared/inbound/sender-domains.test.ts`, `e2e/gmail.spec.ts` (review screen, undo, auto-save settings).

## Security notes

- **Spoofed mail auto-saving a fake expense** is the main new risk. Gmail trust stays `unverified` (L5). Mitigations:
  auto-save off by default; deterministic parsers only; confirmed real domains only (empty registry = never in prod);
  expense only; amount cap; per-day cap; visible chip and one-tap undo-by-scan; duplicate flag blocks it.
  Red team must try: forged `From` to a registry domain with a hostile amount, 100 mails in a burst, look-alike
  domains, a mail steering the AI to a "payment" (must stay draft), two tabs saving/undoing.
- Push content: only stored cleaned title, amount, category name, count. A hostile merchant string is already
  length-limited and masked; push text is plain, never HTML. No sender address, subject or Gmail id in `params`.
- Review "Buka di Gmail" link: constructed from our stored ids, never from mail text.
- Authorization: connection resolved from session; every query also scoped by `space_id` and `user_id`; undo guard
  asserts scan.user_id == session user. No new endpoint takes a space id from the client.
- Limited Use (Google API Services policy): the push and review show derived figures only; nothing new is sent to a
  third party; the `/privasi` text update (existing follow-up) must mention auto-save and push before public launch.
- Rate limits: new throttle bucket `gmail-undo` (10 per window per user) and `gmail-autosave-setting`; actions use the
  shared form-body guard (400/415, never 500).
- Logs carry counts and status codes only (no amounts, titles, addresses).

## Prerequisites and unverified items

- No new secrets. Real behaviour still needs the owner's Google setup (**You** items: Google Cloud OAuth app, test
  users, `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_ORIGIN`, jobs Worker secrets)
  plus VAPID keys for real pushes. Unconfigured behaviour is unchanged: `Belum dikonfigurasi` on the Gmail page;
  no VAPID = in-app row only.
- **Stays unverified until the owner's Google setup**: a real Gmail mailbox returning real bank mail; real sender
  domains and the real parsers' output (needs owner samples, domains come only from them); real web push on a phone;
  the "Buka di Gmail" deep link in the Gmail app; the `/privasi` wording. Everything else is tested with
  `fake-google.ts`, the fake Anthropic and the local D1.

## Owner decisions (answer once; proposed default in bold)

1. Auto-save default: **off**, per connection, opt-in with a chosen wallet. (Alternative: on after connect; not
   recommended while trust is always `unverified`.)
2. "Confidence threshold": there is no numeric confidence column. Proposed rule instead of a number: **deterministic
   parser + confirmed real sender domain + expense + complete (category) + not duplicate**; AI readings never
   auto-save. Say if AI readings may ever auto-save above a score (would need a new confidence field: bigger pass).
3. Auto-save for income: **no** (expense only).
4. Auto-save caps: **Rp 5.000.000 per capture, 20 per day per connection**; beyond, stays a draft.
5. Push wording (Indonesian, fixed templates): single **"Pembayaran Rp 45.000 di Kopi Kenangan, Kopi"** with body
   "Tersimpan otomatis" or "Perlu ditinjau"; group **"5 pembayaran baru dari Gmail"**. English equivalents. Lock-screen
   shows merchant and amount (as the reference feature does); alternative: amount hidden on the lock screen.
6. Push frequency: **max 5 individual pushes per user per WIB day, then one grouped push per day**; hourly scans only;
   quiet hours 00.00-05.59 WIB (existing rule); default on, off in `/pengaturan/notifikasi`.
7. Undo window: **7 days after the scan finished** for saved transactions; pending drafts can always be undone.
   Transactions the user edited are skipped and reported, never silently reverted.
8. Real sender domains per bank/e-wallet: **none shipped by Claude.** Domains are added only from your redacted real
   samples (BCA, Mandiri, BRI, BNI, Jago, BSI, CIMB, Permata, Jenius, SeaBank, GoPay, Grab, OVO, DANA; the FN-19
   list). Question: send which samples first? Proposed order: the two or three institutions you use most. Until then
   the `*.example` fixtures stay test-only and auto-save never fires in production.
9. `history.list` incremental sync: **defer to FN-19c** (own pass; polling with `after:` works and costs little at
   hourly cadence). Say if you want it bundled here (raises this pass from large to very large).
10. Look-back screen "Simpan semua yang lengkap": **include** (reuses `saveDrafts`); alternative: review-only, save
    from Kotak masuk.
11. Review retention: **90 days**, same as the ledger (older rows vanish from the screen; transactions stay).

### Owner answers (2026-10-28)

- 1–4 auto-save: accepted as proposed (off by default, opt-in with a wallet; strict deterministic rule; expense
  only; Rp 5.000.000 per capture, 20 per day per connection).
- 5–6 push: accepted as proposed (default on, merchant and amount shown, 5 per WIB day then one grouped push,
  hourly scans only, existing quiet hours).
- 8 sender domains: samples wanted from all four groups: BCA; GoPay/Gojek; OVO, DANA, ShopeePay; Mandiri, BRI,
  BNI. Until the samples arrive the registry ships empty.
- 9 `history.list`: deferred to FN-19c.
- 7, 10, 11: not asked; the proposed defaults apply (7-day undo window, "Simpan semua yang lengkap" included,
  90-day review retention).

## Tracker impact

- Closes in `docs/TASKS.md` (line ~110): "FN-19 Gmail follow-ups: push per captured payment (new FN-24 notification kind,
  table rebuild), auto-save, 'Transaksi dari Gmail' review with undo-by-scan, `history.list` incremental sync, real
  sender domains." Split on merge: push, auto-save, review/undo, domain registry mechanism = done;
  `history.list` = new open item FN-19c; real domains = open **You** item (samples) feeding a Claude registry task.
- `docs/ACCEPTANCE.md` rows: "Gmail look-back 7 days -> review -> import -> undo" (line ~15) moves to Mocked/Automated;
  "Connect Gmail -> QRIS receipt -> transaction within one check" stays Not run (real Google).
- `docs/FEATURES.md` FN-19 and FN-24 text: add the push kind, auto-save and review screen; `docs/RUNBOOK.md` Gmail:
  migration 0050 bookmark note; `docs/HISTORY.md` entry at the end of the pass.
