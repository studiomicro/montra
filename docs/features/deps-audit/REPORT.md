# Dependency advisories — report (2026-10-08)

`npm audit --omit=dev`: 0 before and after (nothing shipped to Workers is affected).
`npm audit` (dev/build chain): 8 findings (4 moderate, 4 high) before → 4 high after (one advisory, four entries).

## Fixed

- **GHSA-67mh-4wv8-2f99 (moderate), esbuild 0.18.20** under drizzle-kit 0.31.11 → @esbuild-kit/esm-loader →
  @esbuild-kit/core-utils. Not reachable (the advisory concerns esbuild's dev server, which core-utils never starts;
  drizzle-kit never imports esm-loader). drizzle-kit 0.31.11 is the latest stable and npm's suggested fix was a
  downgrade, so `package.json` `overrides` pins `@esbuild-kit/core-utils` → `esbuild` 0.25.12 (the version drizzle-kit
  already installs; released 2025-11-01; fix landed in 0.25.0 — https://github.com/evanw/esbuild/blob/main/CHANGELOG.md).
  `drizzle-kit export` output byte-identical before and after; `drizzle-kit check` passes.

## Added (FN-17, 2026-10-10)

- **fflate 0.8.3** (MIT; published 2026-05-16, over two weeks old; no dependencies), pinned exactly in
  `dependencies`. Used only as `import { Inflate } from 'fflate/browser'` by the server XLSX reader
  (`src/lib/server/spreadsheet/xlsx-read.ts`): the browser build has no Node API and no `eval`/`new Function`
  (checked: `grep` finds none), and its streaming `Inflate` lets the reader count output per 4 KiB input step, so the
  zip-bomb caps hold. Tests also use `zipSync` to build fictional workbooks. `npm audit --omit=dev` after adding it:
  0 vulnerabilities. Bundle: the whole `esm/browser.js` is ~91 KB unminified; only `Inflate` (the inflate core) is
  reachable from the Worker. SheetJS rejected per the FN-17 PRD (npm `xlsx` is not the vendor's distribution channel).

## Not fixed yet

- **GHSA-wq5f-xc86-pv6w (high), sharp 0.35.4** (librsvg SVG decoder) ← miniflare 5.20261006.0-alpha (exact pin) ←
  wrangler 4.148.0. Not reachable: miniflare loads sharp only to emulate an `IMAGES` binding or
  `fetch(…, { cf: { image } })` locally; we use neither, and sharp is never deployed. Fixed in sharp 0.35.5
  (2026-09-27, https://github.com/lovell/sharp/releases/tag/v0.35.5), which is under the two-week age rule today.
  npm's suggested fix (downgrade wrangler to 4.15.2) rejected. **On or after 2026-10-11:** add `"sharp": "0.35.5"` to
  `overrides` and re-run the checks below.

## Checks (each step alone under the heavy lock)

- `npm run check`: 1556 files, 0 errors, 0 warnings. `npm run lint`: clean.
- `npx vitest run --maxWorkers=2`: 185 files / 2586 tests passed. `npm run build`: done.
- `npm run deploy:staging -- --dry-run`: dry run finished, nothing uploaded.
- Playwright shell + riwayat + impor `--workers=1` (LD_LIBRARY_PATH workaround): 53 passed.
