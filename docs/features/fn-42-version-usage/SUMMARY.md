# FN-42 Version, updates and usage in Pengaturan — summary

Status: **complete** (2026-10-09). No migration.

- `/pengaturan/tentang`: `APP_VERSION` (the value `/api/v1/health` reports), release date and "Apa yang baru" for
  the last three releases from bilingual build-time notes `src/lib/content/release-notes/<version>.{id,en}.md`
  (0.1.0–0.4.0 backfilled in plain language). "Periksa pembaruan" checks for a new version.
- Service worker: a first install still activates silently; an update now waits and the app shows "Versi baru
  tersedia — Muat ulang", which activates it and reloads once. The FN-02 offline write queue survives the reload and
  saves exactly once (e2e). Tabs on the pre-FN-42 build show no banner, so the first FN-42 worker waits until they close.
- `/pengaturan/pemakaian`: plan, credit balance, credits spent this WIB month and recent ledger rows; spaces,
  categories, API tokens, members per shared space and Barang/Koleksi photo counts against real limits; connected apps
  and Gmail look-back as plain numbers (no limit exists); the AI row links to Pengaturan › Integrasi. Bounded at 10
  statements per load, through the space-access helper.
- Tests: `sw-update.test.ts`, `release-notes.test.ts`, `test/integration/pengaturan-pemakaian.test.ts`, FN-42 cases in
  `e2e/pwa.spec.ts` (the update is simulated with a second registration, `?build=old`; a deploy with different bytes is
  not tested end to end).
- QA PASS, red team PASS (lows: own ledger ids in page data; the worker's message handler does not check
  `event.source`).
