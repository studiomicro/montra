# FN-12 Feature toggles — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted). Risk tier Small: one light review.

- **Built:** migration `0007_feature_flags.sql` (per-user flags, upsert); `/pengaturan/fitur` with `Toggle.svelte`
  (native checkbox `role="switch"`, 44 px, no-JS Simpan per row, value moves only after the server confirms); nav
  filtering in TabBar/Sidebar (auto columns, no gap); hidden Kekayaan still loads with a "Tampilkan lagi di menu"
  notice; flags purged on account deletion; `/pengaturan` index lists Akun, Ruang, Kategori, Fitur; e2e `fitur.spec.ts`.
- **Review:** Approved (no Critical/Important). Minor: one extra D1 read per (app) navigation (cache later).
