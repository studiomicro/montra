# FN-27 Belongings (Barang) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0015_belongings.sql` (belongings, `file_deletions`); `/barang` with purchase value, straight-line
  estimate to 20 % over 5 years labelled "Estimasi" (exact integer math, overridable); photos in R2 under
  `spaces/<spaceId>/belongings/<uuid>` — JPEG/PNG/WebP only, sniffed by bytes, 8 MiB cap, pixel limit per frame header,
  allow-list rewrite that drops all metadata (EXIF/GPS, XMP, thumbnails, text chunks) and keeps only orientation and a
  validated colour profile ≤ 64 KiB; data after the image end is cut; animated, SVG and HEIC refused; body read with a
  growing buffer, 120 s total and 20 s idle limits. Served at `/barang/[id]/foto` after requireSpaceAccess +
  isLiveMember with identical 404s, sniffed type, `nosniff`, `private, no-cache` + ETag. R2 objects removed on item
  delete and space/account purge via `file_deletions` (immediate, queue job and hourly cron). AI photo reading shown
  disabled ("Belum dikonfigurasi"); FN-12 Barang toggle; Barang row on `/kekayaan`. The photo module is reusable by
  FN-28.
- **Red team:** FAIL (M1 memory exhaustion in the metadata stripper from an 8 MiB crafted JPEG) → rewritten as one
  bounded pass, re-check PASS; Lows fixed. **QA:** PASS 12/12.
- **Not yet:** belongings do not count toward FN-25 net worth (neither PRD requires it); real R2 on staging untested.
