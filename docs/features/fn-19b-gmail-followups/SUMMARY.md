# FN-19b Gmail follow-ups — Summary

**Status: complete** (2026-10-28). QA PASS and red team PASS in cycle 3 of 3. Not verified against real Google:
everything ran on fakes and a local D1.

## Goal (PRD)

Finish the FN-19 Gmail capture loop: a push per captured payment, opt-in auto-save for trustworthy captures, a
"Transaksi dari Gmail" review screen with undo per scan, and a sender-domain registry that ships empty until real
samples arrive. `history.list` incremental sync moved to FN-19c.

## What was built

- **Push per payment** (new FN-24 kind `gmail_payment`): fixed templates; merchant and amount only for a deterministic
  parser, a confirmed registry domain and a Gmail-authenticated sender, otherwise the generic "Pembayaran baru dari
  Gmail" / "Perlu ditinjau". At most 5 single pushes per user per WIB day, then one grouped push; hourly scans
  only; existing quiet hours; default on, its own toggle with its own throttle bucket.
- **Auto-save** (off by default, opt-in per connection with a wallet): expense only, deterministic parser,
  registry domain, complete, not a duplicate, and Gmail's top `mx.google.com` `Authentication-Results` showing
  exactly one DMARC pass for `header.from` plus an aligned DKIM pass. Caps Rp 5.000.000 per capture and 20 per day
  per connection, race-safe (`auto_save_day`, `auto_saves`). AI readings never auto-save.
- **Authentication-Results parser** rewritten to RFC 8601 (quoted strings, escapes, nested comments); refuses
  ambiguous or injected headers. Shared with the forwarding path; forwarding behaviour unchanged except malformed
  headers now fall to `unverified`.
- **Review screen** `/pengaturan/aplikasi/gmail/transaksi`: captures grouped per scan, undo per scan (7 days for
  saved rows, always for drafts; user-edited rows skipped and reported), "Simpan semua yang lengkap" on look-back
  with optional bulk wallet and category, 90-day retention. "Dari Gmail" tag on Riwayat rows and the edit page.
- **Re-read mark** stored on the mail row (`gmail_mail.reread_at`), so a re-read never pushes or auto-saves.
- **Sender registry** `src/lib/shared/inbound/sender-domains.ts`, empty; `npm run compat:senders` checks entries.

## Migration

`0050_gmail_followups.sql`: rebuilds `notification_prefs` and `space_notifications` for `gmail_payment`; adds
`gmail_connections.auto_save`, `auto_save_wallet_id` (ON DELETE SET NULL), `auto_save_day`, `auto_saves`,
`gmail_scans.undone_at`, `gmail_mail.reread_at`. Fresh local D1 applies it; a rerun is a no-op; `drizzle-kit check`
clean; `test/integration/migration-0050.test.ts` checks rows, indexes and CHECKs survive.

## Reviews

- QA (`QA_REPORT.md`): cycle 1 PASS with F1–F4; cycle 2 PASS (F1–F3 fixed; F5, F6 noted); cycle 3 PASS.
- Red team (`SECURITY_REPORT.md`): cycle 1 FAIL (M1 no sender authentication on auto-save; L1–L3); cycle 2 FAIL
  (M2 parser split on `;` inside quotes bypassed M1; L4); cycle 3 PASS (I1, I2 informational).

## Left open

- F4 (cosmetic): several hourly scans on one day show as separate groups with the same label; undo is per scan.
- I1: before the first registry domain goes in, confirm from real samples that Gmail always writes its own `dmarc=`.
- I2 (fail-closed): mail that reaches Gmail through a forwarder (ARC comment) never auto-saves.
- FN-19c `history.list` incremental sync.
- Unverified: real Gmail mail, real DMARC/DKIM headers, real sender domains, real web push, the "Buka di Gmail" deep
  link, `gmail-configured.spec.ts` (8 skipped without a configured Google app).
