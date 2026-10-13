# FN-44 pixel mascot "Koko": security report

Reviewed: `git diff main...HEAD` at 50ea2d4 (branch `fn-44-mascot`), PRD and QA_REPORT, checked against
`docs/ENGINEERING_CHECKLIST.md` (CSP, untrusted text never rendered as HTML).

## Verdict: PASS

No medium or high findings. There is one low finding, recorded so it is tracked.

## Findings

### L1 (low): `/riwayat?saved=created` shows a "saved" confirmation and the hop with no write behind it

- File: `src/routes/(app)/riwayat/+page.svelte:230-235`. It uses `data.saved`, which comes from the query string at
  `src/routes/(app)/riwayat/+page.server.ts:19-20`.
- Repro: while signed in, open `/riwayat?saved=created`. The page shows "Transaksi dicatat" (or the English text),
  and Koko hops even though nothing was written.
- Impact: the URL can fake a success moment, and the PRD asks that these follow server-confirmed data only. The
  confirmation text was already driven by the URL before FN-44; this change adds the mascot to it. The param is
  checked against an allowlist (`created|updated|deleted|adjusted`). No data is exposed and no state changes. At
  most, a crafted same-origin link could make a user think a row was saved.
- Fix (optional): replace the query param with a one-time flash cookie set by the create action's redirect and
  cleared on read. Alternatively, return the new row's id in the redirect and check that it is on the loaded page.
  Until then, treat the hop as being exactly as trustworthy as the existing text.

## Checked, no issue

- **Mascot markup** (`src/lib/ui/kit/Mascot.svelte`): `pose` and `size` come only from literals in code. No caller
  passes user, URL or form data. Every class, `x`, `y`, `w` and `transform` value comes from the fixed `POSES`
  table. There is no `{@html}`, no inline `style=`, no `fill=`, no `<use>`, `<image>` or `<foreignObject>`, and no
  `href` or `url()` (unit tests check this). Colours are applied through theme classes.
- **CSP**: `src/lib/server/csp.ts` and `vite.config.ts` are unchanged. The new CSS sits in component `<style>`
  blocks, which are bundled. There is no `unsafe-inline`.
- **Success moments**:
  - Beranda: `dayClosedCelebrates(form)` reads only the `?/closeDay` action result, which a URL cannot set.
  - Anggaran: `budgetSafeCelebrates` needs the action result `saved === 'set'` plus a server-computed
    `safeToSpend.kind === 'left'`.
  - Voice: `toast` is set only from the server action's `recorded` row.
  - The one URL-driven moment is L1.
- **Loading indicator** (`MascotLoading.svelte`, `(app)/+layout.svelte:52`): a boolean from `navigating.to`. It
  renders no route or URL data, uses `pointer-events: none` and makes no network call.
- **Error pages** (`src/routes/+error.svelte`, `src/routes/(app)/+error.svelte`): they show only fixed `tr()` text.
  They do not render `page.error`, the message or the stack. `actionHref` is the same-origin pathname and search,
  as before this change.
- **`scripts/generate-mascot-icons.ts`**: the output paths are fixed strings joined under
  `import.meta.dirname/../static`. It reads no argv or env and makes no `fetch`. It has no `exec` or `spawn`;
  Playwright `setContent` loads only SVG built from constants. Nothing about it is random. It is not part of
  `build` or `gates`.
- **Static assets**: PNGs are 180, 192 and 512 px as the manifest declares. Each has only IHDR, IDAT and IEND
  chunks, so there are no text or metadata chunks. `favicon.svg` contains only `rect` elements and no external
  references. `manifest.webmanifest`, the service worker and `app.html` are unchanged.
- **Third-party art**: Koko is an original coin character drawn on a 24x24 grid in the repo. It does not resemble
  the parity target's cat mascot, and no external asset is used.
- **Server code**: nothing under `src/lib/server`, `hooks` or any `+page.server.ts` / `+server.ts` changed.

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/ui/kit/mascot src/lib/ui/kit/MascotLoading.test.ts src/lib/ui/mascot-moments.test.ts test/icons.test.ts test/mascot-placements.test.ts`:
  5 files, 100 tests passed.
- `git diff main...HEAD --stat -- src/lib/server src/hooks* src/service-worker* vite.config.ts package.json`:
  empty.
