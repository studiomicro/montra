# FN-13b PWA platform fit — QA report

**Verdict: PASS** (diff `6093a3f..d98fa8e`, cycle 1). Device-only criteria 32-33 are "not verifiable here".

## Commands run

All run in `<repo>-worktrees/fn-13b-pwa`, local only, no real provider (the e2e server is `wrangler dev` with a local D1 and stub AI/payments).

- `npm run gates` — exit 0. `svelte-check`: 1942 FILES 0 ERRORS 0 WARNINGS; prettier "All matched files use Prettier code style!" and eslint clean; vitest `Test Files 267 passed (267)`, `Tests 4029 passed (4029)`; build `✓ built in 20ms` (last step).
- `E2E_PORT=4713 npx playwright test e2e/pwa.spec.ts --workers=2` — exit 0, `93 passed (1.0m)`, 8 skipped (project-gated `test.skip`: phone-only or desktop-only cases). This is the isolated rerun of the FN-42/42b spec, run once on its own: no failure, no flake.
- `E2E_PORT=4713 npx playwright test e2e/notifikasi.spec.ts e2e/catatan-rilis.spec.ts e2e/catatan-rilis-qa.spec.ts --workers=2` — exit 0, `22 passed (24.8s)`, 5 skipped (project-gated).
- `node scripts/generate-splash-screens.ts` then `node scripts/generate-mascot-icons.ts` (same machine and Chromium) — `git status` and `git diff` afterwards show no change to any tracked file: splash PNGs, `splash-screens.ts`, icons, shortcut icons and favicon are byte-identical. Output: `static/splash: 36 files, 144851 bytes (budget 1500000)`.
- `scripts/capture-store-screenshots.ts` was not re-run (needs a seeded dev server and the dates follow the demo rows; RUNBOOK says so). Its guard is covered by `scripts/local-guard.test.ts` inside the gates run.
- No migration in the diff, so no `db:migrate:local`. No background process left (checked with `ps`).

## Acceptance criteria

| # | Result | Evidence |
|---|---|---|
| 1-2 Head, splash links, Apple-only | PASS | `pwa.spec.ts` FN-13b head cases (iPhone UA: title, status-bar `default`, no capable tags, one link per `SPLASH_SCREENS` row and scheme, media, 200 `image/png` at stated size; Pixel 7 and desktop: no startup-image link) |
| 3 Theme toggle updates `theme-color` | PASS | e2e theme case; `theme.test.ts` for `themeColors()` in `src/lib/shared/theme.ts` |
| 4 `offline.html` metas, no script, CSP same | PASS | diff adds two metas only; `_headers` and `src/lib/server/csp.ts` untouched; existing header e2e passes |
| 5-9 Manifest | PASS | `test/manifest.test.ts` in the gates run (4 shortcuts in order, 96 px icons, 3 screenshots 1080x2340 x2 narrow and 1280x800 wide, ratios, icons 192/512 any + 192/512 maskable + 512 monochrome, `categories`, `prefer_related_applications: false`, no `share_target`); `file` confirms real PNG sizes |
| 7 Screenshots hold only demo data | PASS | Looked at all 3 PNGs: only "(demo)" rows with in-row "Data demo" badges, a "Data demo" corner ribbon on each, wallet "Rekening demo", account "Akun Demo" / `demo-screens@montra.local`. No real data. Header reads "0 transaksi · Rp 0 keluar" because demo rows are excluded from totals (consistent with the PRD, nothing invented) |
| 10 Shortcut URLs, gate, no auto-record | PASS | e2e "manifest in the browser (FN-13b)" cases |
| 11 Splash and screenshots not precached | PASS | `shellPaths` filters `/splash/` and `/screenshots/` (`sw-policy.ts`, unit test in `sw-policy.test.ts`); e2e asserts the shell cache holds no such path and does hold the shortcut and monochrome icons. The built `service-worker.js` still lists the raw asset paths, but `index.ts` passes them through `shellPaths` before caching, and the e2e cache check confirms it |
| 12 FN-13 / FN-42 / FN-42b unchanged | PASS | `src/service-worker/*`, `update.svelte.ts`, `auto-check.ts`, `sw-update.ts` are not in the diff; all update-flow cases in `pwa.spec.ts` and `catatan-rilis*.spec.ts` pass (see rerun above) |
| 13 Standalone offline, no CSP violation | PASS | e2e "standalone offline (FN-13b)" |
| 14-18 Install guidance, hint | PASS | e2e "install guidance (FN-13b)" (steps, sign-in note, no button, no third-party request, no-JS render, CriOS/FxiOS/EdgiOS, standalone, English, synthetic `beforeinstallprompt`, hint once, focus to main, storage throwing); `user-agent.test.ts` for `detectIosBrowser` |
| 19-20 Notifications | PASS | `push.test.ts`; e2e "notifications on iOS (FN-13b)" incl. no `requestPermission` call and VAPID-unset order |
| 21-24 Layout, inputs, statics, overscroll | PASS | e2e "layout at 360 px (FN-13b)": notch insets, landscape insets, toast above tab bar, no horizontal scroll, every input/select/textarea ≥ 16 px on 11 routes plus the Tambah sheet and `/masuk`, `--bg` on html and body; `test/platform-css.test.ts` (no `100vh`, `env(safe-area-inset-` only in `app.css`, no `user-scalable`/`maximum-scale`) |
| 25 Server authorization | PASS | no new load/action touches space data; `+layout.server.ts` adds presentation fields only; `instal` page stays public |
| 26 i18n | PASS | coverage test passes in the gates run; e2e English-interface case |
| 27 CSP | PASS | no CSP file change; e2e `collectCspViolations` clean on `/masuk` and the install/notification pages |
| 28 Accessibility | PASS | hint is `<aside aria-labelledby>`, controls `min-height: 44px`; splash and screenshot files are not used as content images |
| 29 User copy | PASS (spot check) | no path or UA string in the new strings seen in the diff |
| 30 Budgets, reproducibility | PASS | `static/splash` 144851 B (≤ 1.5 MB), `static/screenshots` 572 KB on disk (≤ 1 MB); splash and icon scripts reproduce byte-identically (see above) |
| 31 Gates clean | PASS | see above |
| Fail-first proof | Not re-shown by QA | No `ENGINEER_REPORT.md` existed in the feature folder when QA ran, and QA did not edit production code to re-prove failures. The tests cover each rule, and `platform-css.test.ts` has a scan-not-empty guard |
| 32-33 iPhone and Android checks | Not verifiable here | Needs a real iPhone (iOS 26 and 17/18) and an Android Chrome device: Add to Home Screen, splash scheme, status bar legibility, no content under the status bar or home indicator, no focus zoom, `/tanya` composer above the keyboard, notification prompt after a tap; Android install, 3 shortcuts, richer install dialog, status-bar theme, pull-to-refresh in standalone |

## Specific checks requested

- **Inputs ≥ 16 px:** `SearchField.svelte` 15 → 16 px and Beranda `.picker select` 13 → 16 px are the only per-component size changes; global rule in `app.css` is unlayered and excludes checkbox, radio, range, file and color. e2e scan passes.
- **Photo and receipt inputs not restyled:** `git diff 6093a3f..d98fa8e` shows no change under `src/lib/ui/photos/` or `src/routes/(app)/riwayat/struk/`. Their 15 px file-input rules are unchanged, as the PRD requires.
- **No regression in update flow, offline page, CSP:** confirmed above.
- **Engineering checklist:** no violation found (no D1, money, access or CSV change; keyed lists, safe redirects and form guards not touched; external links in `(app)` have `rel="noopener noreferrer"`; the install hint stores one key with try/catch).

## Findings

None blocking. Observations only:

1. The built service worker bundle still embeds the splash and screenshot asset names; they are filtered at runtime by `shellPaths` and the e2e cache test proves they are not cached.
2. `body` now carries `padding-top: var(--sai-top)` in addition to the sticky bars' top inset. It is 0 with the `default` status bar in portrait, and the notch e2e passes, but on a real device with a non-zero top inset in standalone, check the title does not get a double offset (part of manual criterion 32).
3. The 6-way-parallel failure the engineer saw in FN-42/42b did not reproduce at `--workers=2` (load-related).
