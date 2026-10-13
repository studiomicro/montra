# FN-29 Connected apps (Aplikasi terhubung) — summary

**Status: complete up to the credential boundary** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0016_connected_apps.sql` (written as 0017 in the PRD and engineer report; renumbered at merge);
  `/pengaturan/aplikasi` listing Gmail, Sheets, Calendar, Notion and Slack, all "Belum dikonfigurasi" until owner
  credentials exist; tokens sealed with `CONNECTED_APPS_ENCRYPTION_KEY` (AES-256-GCM, fresh 96-bit nonce, AAD binding
  key id + row + space + provider; `token_key_id` and a previous key for rotation); disconnect by connection id, only
  by the creator or the space's Pemilik; automatic disconnect with token deletion when the creator leaves, is removed
  or deletes their account; content-free audit events; pure Sheets/Calendar/Notion payload builders sharing FN-18's
  masking and formula guard (`ExportRow`, `exportCells`, `guardFormula` moved to `shared/csv.ts`, CSV output verified
  byte-identical); Slack draft parser producing FN-11 drafts with `source: 'slack'`.
- **Red team:** PASS (Lows fixed). **QA:** PASS 12/12.
- **Not yet (owner credentials):** real OAuth for every provider, live Slack endpoint, re-encryption job after a key
  rotation, the key on the jobs Worker.
