# FN-32 Public site, blog and legal pages

Slug: `fn-32-public-site`. Phase 5 (Connect, plans, trust). Catalog entry: `docs/FEATURES.md` › FN-32 (lines
314-318). Tracker: `docs/TASKS.md` › "Product name, domain, logo and brand hue" (**You**, unchecked) and
"Legal review of privacy policy, terms, UU PDP consent and cross-border notice (before launch)" (**You**,
unchecked); `docs/PRD.md` § 5 — "FN-32 (site and legal pages) ships before public launch." Risk tier: **Medium**
(no migration, no auth change, no money — but a real host-boundary and prerendering decision, per FN-00's own
deferral: "FN-00 prerenders nothing; FN-32 decides prerendering for the site"
(`docs/superpowers/specs/2026-10-07-fn-00-foundation-design.md:80-81`), which is more than "UI text, nav,
tooling" per the Small-tier definition).

Owner rule applied: the production domain is still open (`docs/TASKS.md` line 21: "Product name, domain, logo
and brand hue"); the site currently only resolves on `site.localhost` (`src/lib/shared/hosts.ts:5`). This pass
builds the full structure against that one local host, so adding the real domain later is the one-line change
`hosts.ts`'s own comment already promises (`src/lib/shared/hosts.ts:1-4`), not a restructuring. Legal review of
privacy/terms/consent copy is a separate **You** item (`docs/TASKS.md` line 46, "before launch" — not before
this PRD); every legal page stays marked draft until that review happens.

## Goal

The usual launch sequence puts the public site before paid plans ("launch with paid plans
'coming soon'", `docs/PRD.md` § 5), and MONTRA's plan is the same: FN-32 ships before public launch. A visitor
who has never opened the app needs, on the marketing host, everything that decides whether to install it — what
it does, how capture works, why their receipt photo is safe, what it will eventually cost, and how to delete
their account without even opening the app — with the usual structure (home page, blog, privacy,
terms, delete-account page, per `docs/FEATURES.md`) in MONTRA's own words, design and
brand, never another product's name, mascot, copy or illustrations.

## Scope

1. **Landing page** (`src/routes/(site)/site/+page.svelte`, today a near-empty scaffold). Structure follows
   the usual sections per FEATURES.md FN-32's mirror line — hero, how-it-works (one capture path per
   card: Gmail, voice, receipt, statement), features overview, security section (uploads never stored, sealed
   results, no ads/trackers — the same facts CLAUDE.md states, in visitor-facing language), a pricing section
   that reuses FN-30's plan catalogue (`src/lib/shared/billing/plans.ts`) with the same "harga sementara"/
   placeholder badge FN-30's own settings page uses — **never a second, drifted copy of the prices** — and FAQ.
   ID/EN switch reuses the existing locale mechanism (`locals.locale`, the same switch already in the app
   shell) rather than a second one built for the site. Footer links to `/blog`, `/privasi`, `/ketentuan`,
   `/hapus-akun`, `/pasang` (scope item 3).
2. **Blog** `/blog` (index, replacing the current placeholder at
   `src/routes/(site)/site/blog/+page.svelte`) and `/blog/[slug]`. Posts are **Markdown files in the repo**
   (e.g. `src/lib/content/blog/*.md`, frontmatter: `title`, `slug`, `date`, `excerpt`), rendered server-side (no
   client-side Markdown parsing, no `{@html}` of anything except this trusted, repo-authored content — these
   are not user input, so the "never render untrusted text as HTML" checklist item does not apply, but the
   renderer itself still must not introduce a new dependency without checking `package.json` first, matching
   FN-31's own "no new dependency without checking" instinct for its ZIP writer). **Three starter outlines**
   (structure only — headings and bullet points, not finished prose; writing the full articles is a content
   task for whoever ships this PRD, explicitly not copied from any other product's articles per CLAUDE.md):
   - *"Dari struk ke transaksi dalam hitungan detik" / "From receipt to transaction in seconds"* — outline: what
     a receipt photo goes through (upload → AI reads it in memory → result sealed to your key → review screen),
     why the photo is never stored on our server, what to do when the AI misreads a total.
   - *"Satu email QRIS, satu transaksi — tanpa mengetik" / "One QRIS e-mail, one transaction — no typing"* —
     outline: how the hourly Gmail check works, which senders are read, what happens to the e-mail text after
     (deleted), how a duplicate is caught before it is saved twice.
   - *"Kenapa kami tidak pernah menyimpan file yang kamu unggah" / "Why we never store the file you upload"* —
     outline: the in-memory-only processing promise (FN-21), what "sealed to your account key" means in plain
     language, what happens if you forget your password (sealed results cannot be recovered, a new upload can
     always be made).
3. **Install guide — moved to a public page.** FN-13 already built a full install guide with its own QR code at
   the signed-in `/pengaturan/instal` (`src/routes/(app)/pengaturan/instal/+page.svelte`,
   `docs/features/fn-13-pwa/SUMMARY.md` line 7: "install guide `/pengaturan/instal` with QR to itself"). This
   PRD **moves** that content to a new public route on the site host, `/pasang` (reachable as `site.localhost/
   pasang` today, the real marketing domain's `/pasang` later), so a visitor who has not signed in — or opened
   the app at all — can still scan the QR code and get install steps, matching FEATURES.md's own "install guide
   page with a QR code for desktop visitors." The existing authenticated `/pengaturan/instal` becomes a thin
   redirect or a link to the public page (an authenticated user installing from inside the app loses nothing;
   the content now lives in one place, not two copies that can drift).
4. **Legal pages — flesh out the existing drafts, still marked draft.** `/privasi` and `/ketentuan` already
   route through `[legal=legal]`'s matcher (`src/params/legal.ts`, registered in
   `src/params/index.ts:2-9`) and already show "Draf. Isi lengkap menunggu tinjauan hukum." This PRD expands
   each with the sections CLAUDE.md and FEATURES.md already name as commitments (no ads/trackers/data sale,
   mailbox data never used for scoring, uploads never stored, the FN-31 cross-border notice paragraph that
   feature already adds) — **every section stays under the existing draft banner**; this PRD does not remove
   it, since legal review has not happened. `/hapus-akun` (already built, FN-01) needs no content change here,
   only a link from the new `/pasang`/landing footer.
5. **SEO basics.** `<title>`/meta description per page (reusing `<svelte:head>`, the pattern every existing
   route already uses, e.g. `src/routes/(app)/pengaturan/+page.svelte:11`), Open Graph tags on the landing page
   and each blog post, a `sitemap.xml` and `robots.txt` served from the site host only (the app host's
   `robots.txt`, if any, is a separate, more restrictive concern — out of scope here, named in Out of scope),
   canonical URLs that always point at whichever host is actually configured (reusing
   `appOriginForSite`/`isSiteHost`, `src/lib/shared/hosts.ts`, never a hard-coded domain string).
6. **Prerendering, and the host-boundary wrinkle it raises.** `export const prerender = true` on the landing
   page, blog index/posts, `/pasang` and the legal pages — all pure content with no per-request data. **The
   wrinkle this PRD must resolve, not leave for the engineer to rediscover:** `routeFor`
   (`src/lib/shared/hosts.ts:20-35`) decides the `(site)` vs `(app)` tree by `url.hostname`, but SvelteKit's
   prerender crawler requests pages against its own internal origin (`kit.prerender.origin`, default
   `http://sveltekit-prerender`) unless configured otherwise — so prerendering `(site)` routes needs
   `kit.prerender.origin` (or equivalent per-route `entries`) set to a site-host-recognised value, or the
   crawler's requests will not resolve through `routeFor` the way a real `site.localhost`/production-domain
   request does. This is exactly the decision FN-00 explicitly deferred ("FN-00 prerenders nothing; FN-32
   decides prerendering for the site") — this PRD is where it gets made, not a later surprise.
7. **i18n**: every new string across the landing page, blog chrome (not the three outlines' eventual prose,
   which is content, not UI copy), `/pasang`'s moved content (already has English per FN-13), and the legal
   pages' new sections.

## Out of scope

- Final, legally-reviewed privacy/terms/consent text — stays draft-labelled until `docs/TASKS.md` line 46's
  **You** item happens.
- Final brand hue, logo, product name and domain — all still **You** items (`docs/TASKS.md` line 21); this PRD
  builds against the current design tokens and `site.localhost` only.
- The three blog article outlines' full prose — outlines only, per the brief's explicit "write 3 starter
  outlines, not copied."
- A CMS, an admin UI for posts, comments, or any user-generated content on the site — posts are repo files,
  edited by a commit, matching "Markdown posts in the repo" from the brief.
- Real pricing — the pricing section reuses FN-30's placeholder-badged catalogue; it does not set or imply a
  final price.
- `robots.txt`/SEO for the **app** host (the authenticated product) — that host should generally be
  non-indexed; a separate, smaller follow-up (named in Tracker impact) rather than bundled into this PRD's
  "SEO basics" which is about the marketing site discovering well.
- The invite-token log redaction item (`docs/TASKS.md` line 92-93: "Redact invite tokens
  (`/ruang/undangan/<token>`…) from Workers request logs before public launch") — unrelated to the public site
  itself (it is about `(app)`-host request logging), kept as its own tracked item, not folded into this PRD;
  named here only because the brief asked whether it is relevant, and the answer is: not to this feature's
  scope, but it does block the same "before public launch" milestone this PRD also serves, so Tracker impact
  flags it as a sibling blocker.

## Acceptance criteria

1. Given a request to `site.localhost/` (or the configured production site host once named), then it renders
   the landing page with every section named in scope item 1, in both Indonesian and English via the existing
   locale switch, and a request to the same path on the app host continues to serve the app's Beranda
   unchanged — the existing `routeFor` dual-host behaviour (`src/lib/shared/hosts.ts:20-35`) is not altered by
   this feature, only exercised by more real pages.
2. Given a direct request to `/site/*` on the app host, then it still answers 404, exactly as today
   (`src/lib/shared/hosts.ts:33`) — this feature adds content, not a new hole in the host boundary.
3. Given the pricing section on the landing page and the plan-comparison section on `/pengaturan/paket` (FN-30),
   then both read from the same `src/lib/shared/billing/plans.ts` catalogue and show the identical
   placeholder-price badge — never two independently-maintained numbers that can drift.
4. Given `/blog`, then it lists the three starter-outline posts (once turned into minimal published drafts for
   routing purposes, even if short) with title, date and excerpt from frontmatter, and `/blog/[slug]` renders
   each post's content; a request for an unknown slug answers a clean 404 (the existing `+error.svelte`
   pattern), never a crash.
5. Given `/pasang`, then it shows the same install steps and the same QR code FN-13's `/pengaturan/instal`
   showed, reachable without signing in; given `/pengaturan/instal` (signed-in), then it links to or redirects
   to `/pasang` rather than duplicating the content.
6. Given `/privasi` and `/ketentuan`, then each still shows the draft banner ("Draf. Isi lengkap menunggu
   tinjauan hukum.") above the expanded content, in both languages, and no copy on either page is lifted from
   another product's privacy policy or terms text (original wording, matching our own facts).
7. Given `sitemap.xml`/`robots.txt` requests on the site host, then they list exactly the public, non-draft-only
   routes (landing, blog index and posts, `/pasang`, `/privasi`, `/ketentuan`, `/hapus-akun`) with correct
   canonical URLs built from `appOriginForSite`/the site host's own origin, never a hard-coded domain.
8. Given `npm run build`, then the landing page, blog index, each blog post, `/pasang` and both legal pages are
   prerendered (present as static output), and the prerender step does not silently prerender them under the
   wrong host's route resolution (criterion 1's `routeFor` behaviour must hold for the prerendered output too —
   verified by inspecting the built HTML's content, not just that a file exists at the expected path).
9. Given the existing `(site)` CSP and security-headers setup (`src/lib/server/security-headers.ts`, applied
   project-wide per `src/hooks.server.ts`), then every new page keeps the same headers and the same "no
   `'unsafe-inline'`" rule — no new inline `<style>`/`<script>` introduced for the landing page or blog
   rendering.
10. Every new Indonesian string has an English entry (the three outlines' placeholder titles/excerpts included,
    since they do render even before full prose is written); no third-party logo, mascot or brand name from
    another product appears anywhere in the landing page, blog chrome, or legal pages.
11. Given the site is viewed at 360 px width, then no section causes horizontal scroll and every tap target
    (nav links, language switch, QR-code link) is at least 44 px, matching the existing design-system rule
    applied project-wide.

## Architecture notes

- **No migration, no new table.** Blog posts are files, not D1 rows.
- **New modules/routes:** `src/lib/content/blog/*.md` (or equivalent content directory); a small frontmatter +
  Markdown render helper (check `package.json` before adding a dependency — none exists today; a minimal
  frontmatter splitter plus a conservative Markdown-subset renderer, consistent with this codebase's existing
  "hand-roll a simple, bounded format rather than add a dependency" instinct already applied to CSV/ZIP);
  `src/routes/(site)/site/blog/+page.svelte` (index, replacing the placeholder), `src/routes/(site)/site/blog/
  [slug]/+page.svelte`; `src/routes/(site)/site/pasang/+page.svelte` (moved FN-13 content); `src/routes/(site)/
  site/sitemap.xml/+server.ts`, `src/routes/(site)/site/robots.txt/+server.ts` (or the app-root equivalents the
  `routeFor` rewrite already maps onto the site host — follow whatever convention the engineer finds
  `[legal=legal]`/`hapus-akun` already using for site-only routes).
- **Reused:** `routeFor`/`isSiteHost`/`appOriginForSite` (`src/lib/shared/hosts.ts`, unchanged by this feature,
  only consumed more); the existing `[legal=legal]` param matcher and draft-banner convention
  (`src/params/legal.ts`, `src/routes/(site)/site/[legal=legal]/+page.svelte`); FN-13's install-guide content and
  QR generation (`src/lib/shared/qr.ts`, already used by `/pengaturan/instal`); FN-30's plan catalogue
  (`src/lib/shared/billing/plans.ts`, once that PRD lands — if FN-32 ships first, the pricing section renders
  with a local stand-in constant and is wired to the real catalogue when FN-30 lands, named explicitly so the
  two PRDs' landing order does not block either one).
- **Prerendering config:** `svelte.config.js`/`vite.config.ts`'s `kit.prerender` options (`origin`, `entries` or
  `crawl`) — this is the one piece of genuinely new configuration this PRD requires, per scope item 6's own
  explanation of why it is not a trivial `prerender = true` flip.
- **Worker boundary:** app Worker only (the site is served by the same Worker as the app, per FN-00's "one app
  Worker serves both" design, `docs/superpowers/specs/2026-10-07-fn-00-foundation-design.md:70-77`); prerendered
  output is static assets served by the `ASSETS` binding, same as today.
- **No AI, no new D1 table, no new Worker secret.**

## Prerequisites

- **No new credential.** Everything in this feature's scope is static content, routing and build configuration.
- **Production domain is a `docs/TASKS.md` **You** item (line 21), still open.** Until it is chosen, this
  feature ships and is fully testable against `site.localhost`; adding the real domain afterward is the
  one-line `SITE_HOSTS`/`APP_HOST_FOR_SITE` change `src/lib/shared/hosts.ts`'s own comment already promises —
  no "Belum dikonfigurasi" degraded state is needed for this, since the site works identically on any
  configured host.
- **Legal review (`docs/TASKS.md` line 46) is "before launch," not before this PRD** — every legal-adjacent
  page stays under the existing draft banner regardless of this feature shipping.

## Owner decisions

All auto-accepted per owner instruction 2026-10-08 (no open questions):

1. **Blog posts as repo Markdown files, no CMS** — auto-accepted per the brief's explicit instruction; a later
   CMS is a bigger, separate decision if content volume ever justifies it.
2. **Three starter outlines, not full articles, and not copied from any other product** — auto-accepted per the
   brief; writing the full prose is tracked as a follow-up content task, not blocked on this PRD's engineering
   work.
3. **Install guide moved (not duplicated) to a public `/pasang` page** — auto-accepted per the brief's explicit
   "moved from FN-13's signed-in page"; the authenticated settings row becomes a link/redirect, trading a
   one-extra-tap for signed-in users against never having two copies of install instructions that can drift.
4. **No dependency for Markdown rendering; a minimal in-repo renderer for a bounded, trusted content subset** —
   auto-accepted, consistent with FN-31's own ZIP-writer precedent and this codebase's lean `dependencies` list.
5. **App host gets no new SEO work this pass** (`robots.txt` for the app host is a smaller follow-up, not part
   of this PRD) — auto-accepted as the correct scope boundary: SEO is a marketing-site concern, not an
   authenticated-product one.
6. **The invite-token log-redaction item stays separately tracked, not absorbed into this PRD** — auto-accepted;
   it touches `(app)`-host request logging, unrelated code to this feature's own files, even though both are
   "before public launch" gates.

## Tracker impact

- Closes `docs/PRD.md` § 5's own milestone line: "FN-32 (site and legal pages) ships before public launch" —
  this PRD is what makes that true, modulo the two **You** items (domain, legal review) that remain open
  regardless of the engineering work.
- Adds to `docs/TASKS.md` › "Phases 3 – 5 and later": "FN-32 Public site: landing page, blog (3 starter
  outlines), `/pasang` public install guide (moved from FN-13), legal page content expansion (still draft),
  sitemap/robots, prerendering. Domain and legal review still **You**."
- Adds one follow-up `- [ ] **Claude**` item: "App-host `robots.txt` (non-indexing the authenticated product) —
  out of scope for FN-32, which covers the site host only."
- Notes the pre-existing, still-open item `docs/TASKS.md` line 92-93 (invite-token log redaction) as a sibling
  blocker of the same "before public launch" milestone, without claiming this PRD resolves it.
- No `docs/ACCEPTANCE.md` row currently names the public site directly; this PRD does not add one (nothing here
  is a security/money/design row in that table's existing shape), but its prerendered-output and host-routing
  criteria (8-9 above) are the checks a future acceptance pass should cite if one is added.
