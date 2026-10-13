# FN-32 engineer report — cycle 1

Branch `fn-32-public-site`, rebased onto `main` 780f1cb (clean, no conflicts). Commits: `wip(fn-32-public-site):
cycle 1 partial` (the interrupted run's 55 files, kept as they were) and `wip(fn-32-public-site): cycle 1`.

## What works

- **Landing page** `site.localhost/` (ID) and `/en` (EN): hero with a sample Beranda badged "Contoh, bukan data
  sungguhan", four capture cards (Gmail, suara, struk, mutasi), features, security, pricing, FAQ, closing call to
  action; footer links to blog, privasi, ketentuan, hapus-akun, pasang. Our own copy; no reference-product names.
- **Pricing (AC3), finished this cycle:** the section now iterates FN-30's `PLANS`/`PLAN_CATALOGUE`/`PLAN_FEATURES`
  (`src/lib/shared/billing/plans.ts`) with `formatMoney`, the same `/bulan` label and the same `harga sementara`
  badge as `/pengaturan/paket`. The interrupted run's stand-in constants and their 11 i18n entries were removed.
  The terms paragraph "Paket dan pembayaran" now says prices are provisional, not "not set".
- **Language:** the site takes its language from the URL (`/en/…`), so each language is one prerendered file;
  `hooks.server.ts` keeps cookie/Accept-Language for the app. Switch in the site header both ways.
- **Blog:** six repo Markdown files (3 outlines × ID/EN) in `src/lib/content/blog/`, frontmatter parser and a
  bounded in-repo Markdown subset renderer (`src/lib/server/content/`), no new dependency. Unknown slug → 404
  inside the site layout.
- **`/pasang`:** FN-13's install steps and QR code, public. `/pengaturan/instal` now links to `/pasang` on the
  paired site host in the reader's language; on a host with no paired site (e.g. workers.dev staging) it shows
  "Belum dikonfigurasi".
- **Legal pages:** `/privasi` (14 sections incl. cross-border processing) and `/ketentuan` (10 sections), all
  under the unchanged draft banner, both languages.
- **SEO:** `SiteHead` (title, description, canonical, hreflang alternates, Open Graph); `sitemap.xml` and
  `robots.txt` built from `canonicalSiteOrigin()` (first `SITE_HOSTS` entry), never a hard-coded domain. App-host
  responses now carry `x-robots-tag: noindex`.
- **Prerendering (AC8):** `kit.prerender.entries` `/`, `/en`, `/sitemap.xml`, `/robots.txt` with crawl;
  `hooks.ts` resolves the crawler's paths through `prerenderRoute()` (= `routeFor` on the canonical site host)
  only while `building`. `scripts/site-adapter.ts` wraps adapter-cloudflare: the 18 prerendered files are bundled
  into the Worker and answered on the site host only by `src/lib/server/site-static.ts` (same CSP from
  `src/lib/server/csp.ts` plus the security headers), never as static assets that would shadow the app's `/`.
  Built output checked: 18 files, each page's `<title>` is the site page in the right language.
- **CSP (AC9):** no `<script>`, no `<style>`, no `unsafe-inline` in any prerendered page (counted in the built
  bundle: 0/0/0); the site ships no JavaScript (`csr = false`).

## Files (this cycle)

`src/routes/(site)/site/+page.svelte`, `src/routes/(site)/site/[legal=legal]/content.ts`,
`src/lib/shared/i18n-en.ts`, `e2e/site.spec.ts`, `test/site-landing.test.ts` (new). Previous partial: see the
`cycle 1 partial` commit (hosts, hooks, vite/vitest config, site-adapter, site-static, csp, site-locale, content
modules, site routes, tests).

## Checklist items applied

i18n (every new phrase has an English entry; coverage test passes), CSP (no new `unsafe-inline`, prerendered
pages get the same directives), currency display (`formatMoney` only), truthful state (prices badged as
placeholders, sample Beranda badged), accessibility (44 px targets, heading order), redirects (`/mulai` is a
fixed 303 to the paired app host's `/daftar`), gates. Not applicable: D1, money parsing, AI, sync, space access
(no space data on the site).

## Pre-handoff probes

- 360 px: `every public page fits 360 px in light` / `in dark` passed on phone and desktop projects (no horizontal
  scroll); `header links, language switch and footer links are at least 44 px tall` passed.
- No-JS forms: `the site works without JavaScript` passed; the site has no forms of its own (hapus-akun unchanged).
- User copy: 18 prerendered pages scanned for `src/lib`, `.ts`, `.svelte`, `space_id`, `amount_minor`, `FN-nn`:
  0 hits.
- Cross-space: N/A (no space data); host boundary instead — `the site tree is not reachable on the app host,
  encoded or not` and `app routes are not reachable on the site host` passed.
- Concurrency, two tabs, money vectors, two devices, month boundaries: N/A (no counters, state-changing forms,
  money input, sync or date buckets).

## Checks run

- `npm run gates` (under the shared lock, Vitest max 2 threads): exit 0.
  - check: `COMPLETED 1395 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
  - lint: `All matched files use Prettier code style!`, eslint clean
  - test: `Test Files 143 passed (143)`, `Tests 2079 passed (2079)`
  - build: `site-adapter: 18 prerendered site files bundled into the Worker`, `✔ done`
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8873 npm run test:e2e -- e2e/site.spec.ts
  e2e/pwa.spec.ts --workers=2`: `49 passed (19.5s)`.

## Not verified

- Deployed behaviour: the generated `_worker.js` entry imports `src/lib/server/site-static.ts` and is bundled by
  wrangler; verified under local `wrangler dev` (e2e) only, not on staging.
- A real production site host: only `site.localhost` exists until the domain is chosen (owner item). On staging
  (workers.dev, no paired site) `/pengaturan/instal` shows "Belum dikonfigurasi" instead of the guide link.
- Legal copy has had no legal review; the draft banner stays. Blog posts are outlines, not finished prose.
- Full e2e suite not run (only the two specs touched).

## Cycle 2 — red team L1

- Finding L1 (language switch could render `href="//evil.com"` on a crafted 404): fixed. New pure helper
  `switchedSitePath(target, pathname, status)` in `src/lib/shared/site-locale.ts` returns the language root
  (`/` or `/en`) for any status other than 200, and otherwise collapses leading slashes, backslashes and
  whitespace to one `/` before `localizedSitePath`. `src/routes/(site)/site/+layout.svelte` uses it for both
  switch links (header and footer).
- Tests: `src/lib/shared/site-locale.test.ts` gains 4 cases covering `//evil.com`, `/\evil.com`,
  `/%2F%2Fevil.com` (stays encoded, on-site), `/en//evil.com`, `/en/\evil.com`, normal paths and 404/500 pages.
- `npm run gates` (under the shared lock, Vitest max 2 threads): exit 0.
  - check: `COMPLETED 1395 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`
  - lint: `All matched files use Prettier code style!`, eslint clean
  - test: `Test Files 143 passed (143)`, `Tests 2083 passed (2083)`
  - build: `site-adapter: 18 prerendered site files bundled into the Worker`, `✔ done`
- Not re-run: e2e and the curl reproduction against a local Worker.
