# FN-56 Auth ASCII field — SUMMARY

**Status: complete** (2026-10-13). Risk tier Small: engineer plus orchestrator review, no separate QA or red team.

**Goal:** a decorative, on-brand ASCII animation on /masuk and /daftar after the owner's reference: tiny monospaced
glyphs visible only inside slowly morphing organic blobs.

**Owner decisions:** letter field; band on phone, card beside the form from 1024 px; Koko kept; /masuk and /daftar
only; stops after 60 s; no text on the card; Geist Mono; 15 fps; electric-blue card in light, black in dark.

**Files:** `src/lib/shared/ascii-field.ts` (+ test), `src/lib/ui/auth/ascii-playback.ts` (+ test),
`src/lib/ui/auth/AsciiField.svelte`, `src/routes/(auth)/+layout.svelte`, `docs/design/tokens.css`
(`--brand-surface`, `--on-brand-surface`), `docs/design/DESIGN_SYSTEM.md`, `docs/FEATURES.md`,
`test/auth-ascii.test.ts`, `test/contrast.test.ts`, `e2e/motion.spec.ts`, 8 shots.

**Migrations:** none.

**Review:** cycle 1 worked but read as scattered text; cycle 2 filled every cell inside a blob, 8 px glyphs, 52 %
coverage, whole-column clipping. Gates on main: 387 files / 6541 tests, build ok.

**Not verified:** real phones (Geist Mono loaded or blocked), 200 % zoom. App-wide accent: FN-57.
