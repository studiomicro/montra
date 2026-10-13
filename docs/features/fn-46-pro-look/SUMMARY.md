# FN-46 Pro look — SUMMARY

Status: **complete** (2026-10-11). Goal: accounts with an active paid plan (Pro or Agen) get a distinct look; Gratis
sees the Pro items locked with a link to Pengaturan › Paket.

- Built: plan read once per request into `locals.plan` (hooks); Pro themes "Emas" and "Hijau tua" (light and dark,
  AA contrast) refused server-side for Gratis or lapsed accounts (403 on a forged post, `system` for a forged or
  lapsed cookie); Pro badge with Koko's crown (sidebar, Pengaturan, Akun); Pro card on Paket; crowned Koko through a
  layout context; Beranda hero background frame; per-account manifest route and apple-touch icon (Pro icons apply
  at install or reinstall; note on Pengaturan › Instal). Agen looks like Pro.
- Migrations: none. The service worker no longer precaches the manifest.
- QA: PASS. Red team: PASS; L1 (manifest fetched without cookies) and L2 (comment) fixed in cycle 2 and confirmed in
  Chromium (`Page.getAppManifest` lists `icon-192-pro.png` with the fix, `icon-192.png` without).
- Not verified: install on a real iPhone or Android phone.
