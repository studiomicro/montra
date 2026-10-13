# FN-43 Brand badges — Summary

**Status: complete** (2026-10-09).

Goal: give the banks, e-wallets and services the owner asked for an original monogram badge in a colour close to
(never a copy of) the brand hue, wherever wallets, imports, money-flow bars and subscriptions show them, with the
generic initials tile for everything else.

Files: `src/lib/shared/brands.ts` (registry and matching, + tests), `src/lib/ui/kit/BrandBadge.svelte`,
`BrandBadgeById.svelte`, `Chip.svelte` (brand prop on e-wallet quick-picks), `PickerSheet.svelte`, `picker.ts`,
`src/lib/ui/charts/series.css`, `docs/design/tokens.css` badge tokens, and the Dompet, Langganan, Beranda, Impor
and Alur uang pages; `test/brands-contrast.test.ts`; QA browser spec `e2e/qa-fn43-brand-badges.spec.ts`.

Migrations: none.

QA: PASS (24 criteria). Notes: the registry ships 28 entries (GoFood separate, needed by criterion 2); the Chip
brand prop on wallet quick-picks went beyond the PRD's list and is kept. Red team: PASS with two lows — L1 trade
dress (tile colours close to each brand and some monograms follow word-mark casing; owner sign-off tracked) and
L2 (any name containing a brand word gets that badge; cosmetic, own space only).
