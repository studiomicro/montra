# FN-32 Public site — QA report

## Verdict: PASS

Branch `fn-32-public-site`, head `2c6e993`, rebased on `main` `780f1cb`. Worktree
`<repo>`.

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` — `COMPLETED 1395 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npm run lint` — `All matched files use Prettier code style!`, eslint clean, exit 0, no provider.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` — `Test Files 143 passed (143)`, `Tests 2079 passed (2079)`, exit 0, mocked/fixture only (no real provider; AI/D1 bound to stubs per project convention).
- `flock /tmp/montra-heavy.lock npm run build` — `site-adapter: 18 prerendered site files bundled into the Worker`, `✔ done`, exit 0, no provider.
- `flock /tmp/montra-heavy.lock env LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8891 npx playwright test e2e/site.spec.ts e2e/pwa.spec.ts --workers=2` — `49 passed (18.9s)`, exit 0, local `wrangler dev`/workerd (not a real external provider).
- No new migration in this diff; `db:migrate:local` not applicable and not run.
- Manual inspection of `.svelte-kit/output/prerendered/pages/*` (18 files) for titles, draft banners, other-product-name grep, inline `<style>`/`<script>` counts, `sitemap.xml`/`robots.txt` content — direct file read, no provider.

No dev server or background process left running after the run (`ps aux` checked, clean).

## Checked criteria

1. **Landing page both languages, app host `/` unaffected** — PASS. `index.html`/`en.html` titles confirmed
   (`Montra — catat uang tanpa repot` / `...without the effort`); e2e `site home: every landing section...`
   and `the English site lives under /en...` pass; `src/routes/(app)/+page.svelte` (Beranda) untouched by this
   diff (`git diff --stat` confirms); `hosts.test.ts` `'leaves app paths alone'` passes.
2. **`/site/*` on app host still 404s** — PASS. `hosts.test.ts` `'hides the site tree on the app host'` plus
   the encoded/malformed-variant test (`/%73ite/...`, `//site/...`, double-encoded) all pass; e2e `the site tree
   is not reachable on the app host, encoded or not` passes.
3. **Pricing matches FN-30 catalogue, no drift** — PASS. `src/routes/(site)/site/+page.svelte` imports
   `PLANS`/`PLAN_CATALOGUE`/`PLAN_FEATURES` from `#lib/shared/billing/plans` and `formatMoney`, same
   `tr('harga sementara')` badge text as `src/routes/(app)/pengaturan/paket/+page.svelte` — identical source, no
   second copy of numbers.
4. **`/blog` index + `/blog/[slug]`, unknown slug 404** — PASS. Six Markdown files (3 outlines × ID/EN) under
   `src/lib/content/blog/`; e2e `blog: index from the repo posts, a post with its disclaimer, unknown slug 404`
   passes; built output has `blog.html`, `blog/<slug>.html` (ID and EN) with correct titles.
5. **`/pasang` public, `/pengaturan/instal` links not duplicates** — PASS. `pengaturan/instal/+page.server.ts`
   now computes `siteOriginForApp` and links to the localized `/pasang` path, falling back to "Belum
   dikonfigurasi" when no paired site host exists (staging); e2e `install guide (/pengaturan/instal) › renders
   signed out and links the public guide on the site host, no third-party request` passes.
6. **Legal pages keep draft banner, both languages, original wording** — PASS. Built
   `privasi.html`/`ketentuan.html` both contain `Draf. Isi lengkap menunggu tinjauan hukum.`; EN pages contain
   `Draft. Full text awaits legal review.`; a case-insensitive grep for the other product's name across prerendered output, blog content and
   `(site)` routes returns zero hits. Content reads as original MONTRA-specific wording (cross-border
   paragraph, uploads-never-stored, no ads/trackers) matching CLAUDE.md's own facts, not lifted phrasing.
7. **`sitemap.xml`/`robots.txt` list exactly the public routes, canonical from site host** — PASS. Inspected the
   built `sitemap.xml`: landing (ID/EN), blog index + 3 posts (ID/EN), `/pasang`, `/privasi`, `/ketentuan`,
   `/hapus-akun` (ID/EN) — nothing else, all `http://site.localhost/...`, hreflang alternates correct;
   `robots.txt` allows all and points at the same sitemap URL; `canonicalSiteOrigin()` built from `SITE_HOSTS[0]`,
   never a literal domain.
8. **`npm run build` prerenders all named pages, correct host resolution baked in** — PASS. 18 files present
   under `.svelte-kit/output/prerendered/pages`; spot-checked titles for ID/EN landing, legal, `/pasang`, blog
   index and a post — each is the site content in the right language, not the app's Beranda; `scripts/
   site-adapter.ts` bundles them into the Worker and `site-static.ts` serves them only when `isSiteHost(hostname)`
   — verified by reading both files plus their own unit tests (`site-adapter.test.ts`, `site-static.test.ts`).
9. **Same CSP/security headers, no new inline style/script** — PASS. `grep -c "<style"` / `"<script"` across all
   18 prerendered files: 0 matches in every file; `site-static.ts` applies `cspHeader()` plus
   `securityHeaders()` to every HTML response; `csp.test.ts`/`site-static.test.ts` pass.
10. **i18n coverage, no other-product branding** — PASS. `test/i18n-coverage.test.ts` (`every Indonesian phrase has an
    English entry`) is part of the 2079 passing tests; blog outline titles/excerpts have English frontmatter
    files (`*.en.md`); other-product-name grep (criterion 6) returned zero hits.
11. **360 px, 44 px touch targets** — PASS. e2e `every public page fits 360 px in light` / `in dark` (phone +
    desktop projects) and `header links, language switch and footer links are at least 44 px tall` all pass.

## Findings

None. No ENGINEERING_CHECKLIST violations found in the diff:
- No new dependency (`package.json`/`package-lock.json` unchanged in this diff).
- Markdown renderer HTML-escapes all text and restricts link targets even though content is repo-trusted
  (defence in depth, `src/lib/server/content/markdown.ts`).
- `{#each}` lists keyed by stable ids (`post.slug`, fixed array index on hardcoded content arrays) — no
  user-input keys.
- `/mulai`'s redirect target is derived only from the request's own host via a fixed internal map
  (`appOriginForSite`), never from user-supplied input — the shared "safe-return" helper
  (`src/lib/server/return-to.ts`) does not apply here since there is no untrusted redirect target.
- Money display uses `formatMoney` only, no hand-formatting.
- Gates clean, no migration added, no credentials used, no dev servers left running.

## Not independently re-verified (consistent with ENGINEER_REPORT's own "Not verified")

- Deployed (staging/production) behaviour — only `site.localhost` and local `wrangler dev` exist; production
  domain is an open owner item per the PRD.
- Legal review of `/privasi`/`/ketentuan` content — explicitly out of scope, draft banner intact.
- Full blog article prose — intentionally outlines only, per PRD scope.
