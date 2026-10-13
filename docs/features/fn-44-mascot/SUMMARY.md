# FN-44 Mascot "Koko" — Summary

**Status: complete** (2026-10-09).

Goal: an original 24×24 pixel-art living coin, Koko, drawn in the accent colour, at the moments the owner named:
auth hero, error pages, Beranda's first-wallet hero, empty states without a scene (asleep), three success
moments that follow a server-confirmed write (transaction saved, day closed, budget safe), a client-navigation
loading indicator, and the app icon and favicon.

Files: `src/lib/ui/kit/mascot/poses.ts`, `Mascot.svelte`, `MascotLoading.svelte`, `src/lib/ui/mascot-moments.ts`,
`EmptyState.svelte` (`mascot` prop, default `sleep`), auth, error, Beranda, Riwayat, Suara, Anggaran pages, the
`(app)` layout, `scripts/generate-mascot-icons.ts`, `static/favicon.svg` and icon PNGs, design-system section,
tests (unit, component, icons, placements, `e2e/mascot.spec.ts`).

Migrations: none.

QA: PASS (30 criteria; deviations F1–F3 accepted: reduced-motion loading SVG hidden by CSS, rects per pixel run,
favicon viewBox 24×24). Red team: PASS with L1 (low): `/riwayat?saved=created` shows the existing "Transaksi
dicatat" notice, and now Koko's hop, without a write (allowlisted param, pre-existing).
