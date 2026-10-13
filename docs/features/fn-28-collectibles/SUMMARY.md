# FN-28 Collectibles (Koleksi) — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted).

- **Built:** migration `0017_collectibles.sql`; `/koleksi` with purchase and current value (typed by the user), gain in
  rupiah first with the percent as a note, exact BigInt totals and the overflow state; photos through FN-27's shared
  photo module (now with `releasePhotoKeys` and `readPhotoForm`, used by both `/barang` and `/koleksi`), served at
  `/koleksi/[id]/foto` with identical 404s; R2 objects removed on delete and purge; archive checks access before
  reading the body (also on `/barang`); Data demo rows read-only and excluded from totals; FN-12 Koleksi toggle; Koleksi
  row on `/kekayaan` after Barang.
- **Price source:** none. The Pokémon TCG API was checked on 2026-10-08: deprecated in favour of Scrydex, with no
  terms permitting commercial use. "Harga pasar otomatis", "Kenali dari foto (AI)" and "Perkirakan nilai (AI)" show
  "Belum dikonfigurasi".
- **Red team:** PASS (Lows fixed). **QA:** PASS 11/11.
