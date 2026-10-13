# FN-32 Public site — summary

**Status: complete** (2026-10-08, main a4fd902). PRD: `PRD.md` (defaults auto-accepted). Legal copy is draft.

- **Built:** marketing pages on the site host only (landing with pricing from the FN-30 plan list, `/en` English
  versions, Markdown blog with a small escaping renderer and no new dependency, public install guide `/pasang` linked
  from `/pengaturan/instal`, draft `/privasi` and `/ketentuan`, `/hapus-akun`, sitemap and robots); 18 pages
  prerendered and bundled into the Worker by `scripts/site-adapter.ts`, served by exact match in
  `src/lib/server/site-static.ts`; no inline script or style, CSP unchanged. On merge the privacy page took FN-31's
  cross-border and usage-statistics sections.
- **QA:** PASS 11/11. **Red team:** PASS; L1 (language-switch link could become `//evil.com` on a 404) fixed with
  `switchedSitePath` and unit tests.
- **Not yet:** real domain (canonical links, sitemap and QR name `site.localhost` until the owner picks one), staging
  has no paired site host so `/pengaturan/instal` shows "Belum dikonfigurasi"; legal review; blog posts are outlines.
