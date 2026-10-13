# FN-32 Public site — Security report

Reviewer: red-team-pentester. Branch `fn-32-public-site`, head 7d32cec, scope `git diff main...HEAD` (Medium tier).

## Verdict: PASS

No medium or high findings. One low and two informational items, tracked below.

## Findings

### L1 (low): the site 404 page's language-switch link can point off-site

`src/routes/(site)/site/+layout.svelte:11-15`. The "other language" link is built from
`splitSiteLocale(page.url.pathname).path` with no normalisation. Unknown site paths render this layout
dynamically (`[...rest]` with `prerender = false`), so a crafted URL becomes a protocol-relative link.

Reproduction (local Worker, built output): `curl -H 'Host: site.localhost:8931' 'http://localhost:8931/en//evil.com'`
returns 404, and the header and footer both carry `<a href="//evil.com" hreflang="id">Bahasa Indonesia</a>`. The
same happens with `/en/\evil.com` (the URL parser turns `\` into `/`). An attacker can send a site-domain link
whose 404 page sends anyone who clicks "Bahasa Indonesia" to an attacker host. A click is needed, there is no
script and no app data is exposed, so this is low. Suggested fix: when the path does not start with exactly one
`/`, or the route status is not 200, use `/` (or collapse leading slashes) before calling `localizedSitePath`.
Prerendered pages are not affected because their paths are fixed at build time.

### I1 (info): canonical, sitemap, robots and QR name `http://site.localhost`

`src/lib/shared/hosts.ts:8` (`SITE_HOSTS[0]`) feeds `canonicalSiteOrigin()`. Until the owner picks the production
domain, a deployed build would publish `http://site.localhost/...` in canonical links, `sitemap.xml`, `robots.txt`
and the `/pasang` QR code. This is not exploitable. It is already listed as an owner decision. Recheck when the
domain is added.

### I2 (info): the root layout reads User-Agent while the site is prerendered

`src/routes/+layout.server.ts` reads `user-agent` (`inAppBrowser`, `mobileOs`), but the site layout comment
says the prerendered pages read nothing except the path. The prerendered copy holds the crawler's fixed values,
not visitor data, so nothing leaks. It is noted so the "path only" rule stays true if that loader grows.

## Checked and clean

- **Host boundary**: `routeFor` maps the site host to `/site/*`. On the app host it refuses `/site`, also when the
  path is encoded (`/%73ite/blog` gives 404). The app host's `/`, `/blog`, `/en` and `/mulai` never return site
  pages (`/` gives 303 to `/masuk`, the others give 404). On the site host, `/riwayat`, `/blog/../riwayat`,
  `/blog/%2e%2e/riwayat` and `/en/%2e%2e/riwayat` all give 404. `evil.site.localhost` is treated as the app host
  (exact host match). `X-Forwarded-Host` is not read anywhere. On Workers, the routing host and `url.hostname` are
  the same, so a spoofed Host cannot reach the site host on a deployed zone. SvelteKit's
  "rerouted prerendered path" self-fetch (`respond.js`) cannot be triggered: no reroute result is a member of
  `prerendered_routes` (site results start with `/site`, app results are unchanged or `/__not_found`).
- **Session and cookies**: session cookies are host-only, so the app's cookies are never sent to the site host.
  `/api/*` passes through on the site host, but that was already the case (`/api/v1/health` gives 200 with
  `no-store`). The `building` shortcut in `hooks.server.ts` and `hooks.ts` only applies when Kit's
  `configure({ building })` is called during analysis or prerendering. The deployed Worker never sets it.
- **site-static.ts**: lookup is an exact `Map.get` on bundled strings, with no filesystem access, so path
  traversal is not possible. `%2F` and `%5C` stay encoded and do not match. Content types come from SvelteKit's
  records (html, xml, text). `public, max-age=300` covers only build-time files with no session or cookie input.
  The theme default is built in. Only GET and HEAD are handled, and plain http to a deployed host falls through
  to the 308-to-https in hooks. The trailing-slash 308 `Location` is the request's own path minus the slash, and
  only for a known file, so it is always same-origin.
- **CSP**: `csp.ts` uses the same directives that were inline in `vite.config.ts`, unchanged. The app host still
  gets nonce-based `script-src 'self' 'nonce-…'` and no `'unsafe-inline'`. Prerendered pages contain no
  `<script>` and no inline `style=`, and have both the header CSP and Kit's meta CSP.
- **Markdown and `{@html}`**: `{@html}` is used only in `blog/[slug]`, and that HTML comes from repo files at
  build time. All text is escaped. `href` accepts only `/path` (not `//`) or `https://host/path` with a restricted
  character set, and is escaped again. `javascript:` and `data:` links throw at build. Raw HTML in a post is
  escaped. Emphasis runs only on text that is already escaped.
- **Redirects**: `/mulai` sends a 303 to `APP_HOST_FOR_SITE[host]` plus `/daftar`. It is reachable only on a
  site host. The target comes only from the request's own host, port and scheme, and is allow-listed through
  `external: [app]`. A POST to `/mulai` gives 403. `[...rest]` only returns 404. There is no open redirect.
- **/hapus-akun**: it shows only `SUPPORT_EMAIL`, which passes `isPlausibleEmail` (no whitespace or control
  characters) and is meant to be public. The subject uses `encodeURIComponent`, and the app link is the paired
  app origin. There is no account lookup and no form, so there is no enumeration path.
- **Secrets**: `_app/env.js` on the site host is `export const env={}`. The bundled prerendered files contain no
  secrets or env values (the only matches are policy text about "token"). Site loaders return only locale, posts
  and the hapus-akun fields above.
- **Sitemap and robots**: generated from the post list. The sitemap is XML-escaped, and slugs are checked
  against `^[a-z0-9]+(-[a-z0-9]+)*$`. The app host now sends `x-robots-tag: noindex`.
- **ENGINEERING_CHECKLIST (Web and output)**: CSP rule kept (no `'unsafe-inline'`). The redirect rule does not
  apply because `/mulai` takes its target from a fixed mapping and no return URL comes from the user. There are
  no form bodies, CSV exports or data-access changes in this diff.

## Commands run

- `flock … npx vitest run` for site-static, csp, content (markdown, blog, sitemap), hosts, site-locale,
  site-adapter, integration site and hapus-akun, with `--maxWorkers=2`: 10 files and 63 tests passed.
- Probes against the existing build (`.svelte-kit/cloudflare`, up to date with HEAD): a temporary
  `wrangler dev --port 8931` was run under the heavy-work lock, probed with curl as listed above, then stopped.
  Its state directory was removed.
