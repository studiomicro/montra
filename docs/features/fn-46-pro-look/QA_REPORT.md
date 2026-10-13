# FN-46 Pro look — QA report

**Verdict: PASS**

Cycle 1. Worktree `montra-worktrees/fn-46-qa`, detached at `8fabb21` (`wip(fn-46-pro-look): cycle 1`), base `93cf1e0`.

## Commands run

- `npm ci --no-audit --no-fund` — installed 277 packages, exit 0, local install, no provider.
- `npm run gates` (check, lint, test, build) — exit 0; svelte-check 2171 files, 0 errors/0 warnings; prettier/eslint clean; Vitest 318 test files / 4979 tests passed; build and service-worker/site-adapter build succeeded. Mocked AI/billing only, no real provider.
- `E2E_PORT=8841 npx playwright test e2e/pro-look.spec.ts e2e/pwa.spec.ts --project=phone` (no-op `flock` shim on PATH for macOS) — 52 passed, 1 skipped (desktop-only test on phone project), exit 0; real Chromium browser against local `wrangler dev` (mock billing provider, `BILLING_MOCK_ENABLED=1`), no external network.
- Ad-hoc temp Playwright spec (`e2e/_qa-screens.spec.ts`, written and deleted by QA, not part of the diff) to capture 360 px screenshots across Gratis/light, Gratis/mono, Pro/gold, Pro/emerald, Pro/gold-dark — 2 passed, same local server.
- No new migration in the diff; `db:migrate:local` not required (PRD states no D1 migration; confirmed by grep: no new `CREATE TABLE`/`ALTER TABLE` in the diff).

## Checked acceptance criteria (PRD numbering)

1–5 (badge on sidebar/Pengaturan/Akun, paid vs gratis, Agen = Pro, never-purchased and lapsed both gratis) — PASS. `test/pro-look-ui.test.ts` parametrised over `['pro','agen']` x 3 surfaces, negative gratis case, `Agen renders exactly what Pro renders` (byte-equal HTML). Browser: `e2e/pro-look.spec.ts` confirms the badge on `/pengaturan` after a real mock-checkout upgrade.

6, 8 (locked Pro rows + forged POST refused) — PASS. `test/integration/pro-look.test.ts` POSTs `theme=gold`/`emerald` as a gratis session → `fail(403, { error: 'Perlu paket Pro atau Agen' })`, cookie not written; lapsed-pro POST refused the same way. `e2e/pro-look.spec.ts` reproduces this with a real hand-set `theme=gold` cookie and a direct form POST (403, no `set-cookie: theme=gold`), `data-theme="system"` rendered.

7 (no-JS Pro theme pick) — PASS. `e2e/pro-look.spec.ts`'s `javaScriptEnabled: false` context checks a radio, submits, and the next full load (and a second page) carries `data-theme="emerald"` and the matching `theme-color` meta (`#fbfefc`).

9 (plan lapse, no sweep) — PASS. `test/integration/pro-look.test.ts`: pro account with `theme=gold` and `current_period_end` moved to `Date.now() - 1` → the very next request shows `theme: 'system'`, `locals.plan: 'gratis'`, Gratis touch-icon, no separate job. The exact-boundary case (`currentPeriodEnd === now` → gratis) is pre-existing, unmodified `effectivePlan` logic in `src/lib/shared/billing/plans.ts`, already asserted at `plans.test.ts:64` (`currentPeriodEnd: now` → `'gratis'`); FN-46's new code reuses this helper via `planOf`/`hasProLook` and adds no new boundary logic, so no regression risk there.

10, 11, 21 (contrast, money colour, mono achromatic) — PASS. `test/contrast.test.ts` extended `THEMES` with `gold`, `gold-dark`, `emerald`, `emerald-dark` (AA 4.5:1 text, 3:1 graphics, including the new `--pro-text`/`--pro-soft`/`--pro` pairs and the gradient-fallback pairs for the Beranda card); a dedicated `describe('Pro themes (FN-46)')` block asserts `--money-in`/`--money-up`/`--brand`/`--ink` are unchanged by either Pro theme and that `--accent` never equals a money colour; `mono turns the Pro look grey` asserts `--pro`/`--pro-text`/`--pro-soft` are achromatic in both mono halves. All ran clean in `npm run gates`.

12, 25 (i18n English entries) — PASS. `src/lib/shared/i18n-en.ts` carries `Emas`→`Gold`, `Hijau tua`→`Deep green`, the two hint strings, `Perlu paket Pro atau Agen`→`Needs the Pro or Agent plan`, and the install-note string; the repo's existing i18n-coverage test (part of the Vitest suite that passed in gates) would fail on a missing entry.

13, 14 (manifest route, apple-touch-icon) — PASS. `test/integration/pro-look.test.ts`'s `/manifest.webmanifest follows the session's plan` block: signed-out and gratis are byte-identical to `src/lib/server/pwa/manifest.webmanifest` with `cache-control: private, no-store`; pro/agen swap exactly the two "any" icons to `-pro.png`, keep maskable/monochrome/shortcuts/screenshots unchanged, and revert on lapse. `touchIcon` assertions in the same file cover `%fin.appleTouchIcon%` for gratis/pro/signed-out. Browser: `e2e/pro-look.spec.ts` fetches `/manifest.webmanifest` live after a real upgrade and checks `link[rel=apple-touch-icon]`.

15 (install-page notice) — PASS. `test/pro-look-ui.test.ts` and `e2e/pro-look.spec.ts` (`pro-icon-note` testid, Indonesian + English text). Computed from the plan check every render, as the PRD explicitly allows (not a dismissible one-time flag).

16, 17 (crowned Koko, never crowned for gratis) — PASS. `src/lib/ui/kit/mascot/Mascot.test.ts`'s new `describe('the Pro crown (FN-46 Part 3)')`: crown pixel count matches `crown(frame)` per pose/frame, coloured only via the `k-crown` class (`fill: var(--pro)`), absent when `pro` is false/omitted, and every existing non-crown snapshot (`svgOf(pose)`) is unchanged. It also tests the layout-context path (`pro-look-context.ts`) both ways and an explicit `pro={false}` override of a `true` context. Browser: `e2e/pro-look.spec.ts` asserts `.first-wallet svg.mascot rect.k-crown` is attached only after the real upgrade.

**Deviation judged acceptable:** the PRD's Architecture notes describe each `<Mascot>` call site passing an explicit `pro={<plan boolean>}` prop; the engineer instead set the plan boolean once in `(app)/+layout.svelte` via `setProLook`/`proLookGetter` (a Svelte context), and `Mascot.svelte` defaults to that context when `pro` is omitted, with an explicit prop still able to override it. This satisfies the same intent the PRD states for this choice — "not a fresh plan lookup per call site" — with one source of truth per request and no call site able to diverge from it; outside the `(app)` layout (sign-in/sign-up, the public site) there is no context, so Koko is never crowned there by default. The architecture-notes wording is explicitly about *not re-deriving the plan per call site*, which the context approach satisfies at least as strongly as an explicit prop thread would, so this is accepted as implementation freedom rather than a defect. No gratis-crown leak found in any call site (`+page.svelte` ×2, `riwayat`, `riwayat/suara`, `agen`, `anggaran`, `EmptyState`, `MascotLoading`, `dev/ui`) — all sit under the `(app)` layout or read `data.shell.plan` explicitly; `(auth)` pages have no context and pass no `pro` prop.

18, 19, 22 (Beranda hero frame, gratis negative, demo-independent) — PASS. `test/pro-look-ui.test.ts`'s `Beranda's hero frame` block: diffs only the `.hero.pro` class/background (figure/label/context markup byte-identical once the class is stripped), confirms the `.hero.pro` CSS rule is background/border/padding only (no `blur`, no raw hex), and greps `+page.svelte`'s `<HeroAmount>` call to assert `pro={hasProLook(data.shell.plan)}` with no `isDemo`/`demo` token nearby — the Pro frame and the "Data demo" ribbon (driven by `row.isDemo`/`bill.isDemo` elsewhere in the same file) are wired from unrelated data. Browser: `e2e/pro-look.spec.ts` confirms `section.hero.pro` with a `gradient` background only after upgrading a real account.

20 — covered by the contrast.test.ts pairs listed under 10 above (`--pro-text`/`--ink`/`--muted`/`--money-in`/`--money-up`/`--same` against `--pro-soft`), run for light, dark and mono.

23, 28 (server re-derives plan; no space-scoped read) — PASS. Every touched load/action (`hooks.server.ts`'s `planForLook`, `pengaturan/tampilan/+page.server.ts`'s action, `manifest.webmanifest/+server.ts`) calls `planOf(locals.db, locals.user.id, Date.now())` or reads `locals.plan` derived from it — never a cookie or posted field for the authorization decision (the cookie is only ever the *preference*, checked against the server-derived plan). Grepped the full diff (`git diff 93cf1e0..8fabb21 -- src workers migrations`) for `space_id`/`spaceId`: no match — confirms no new space-scoped query, matching the PRD's explicit statement that plan is account-scoped.

24 — PASS, see Commands run.

26 (360 px, 44 px targets) — PASS. `e2e/pro-look.spec.ts`'s `expectTargets`/`expectNoHorizontalScroll` on the Tampilan rows (gratis-locked and no-JS Pro-picked) and the Pro card page; QA's own screenshots (360×780, see below) show no overflow and comfortably-sized rows.

27 (loading/empty/error/saving/success unchanged) — PASS by inspection: `/pengaturan/paket`, `/pengaturan/tampilan` and Beranda's existing `Skeleton`/`ErrorState`/saved-banner/empty-state code paths are untouched in the diff except for the new badge/card/frame markup layered around them; their own tests (unchanged assertions) passed in gates.

## Visual spot-check (360 px, scratchpad screenshots)

`/private<scratchpad>`:
- `01-gratis-light-tampilan.png` — gratis, light, six theme rows, Emas/Hijau tua locked with lock icon + "Pro" badge + "Perlu paket Pro atau Agen".
- `02-gratis-mono-beranda.png` — not reviewed in detail (mono hero has no `.pro` class pre-upgrade, expected).
- `03-pro-gold-beranda.png` (viewed) — gold gradient hero card behind "Rp 0", crowned Koko on the empty-wallet card, no colour bleed into the figure.
- `04-pro-emerald-tampilan.png` (viewed) — Emas/Hijau tua now plain radios (Hijau tua selected), each still carrying its own small gold "Pro" pill (informational, not a lock) — legible on the emerald-tinted panel.
- `05-pro-gold-dark-pengaturan.png` (viewed) — dark scheme, gold "Pro" badge next to "Pencatat" on `/pengaturan`, good contrast against the dark panel.

## Engineering checklist

- i18n: every new Indonesian phrase has an English entry (checked above).
- Access: no new space-scoped query; plan re-derived server-side everywhere it gates something (badge/card are display-only, never an authorization decision themselves).
- AA contrast both themes: extended to gold/emerald × light/dark, part of the clean gates run.
- Truthful state / no fabricated figures: Pro card's `currentPeriodEnd` comes straight from `planStateOf`, no new computation.
- No D1 migration, no provider/credential, no AI/Queue/Workflow touched — matches PRD scope.

## Other deviation noted (not a defect)

`src/app.html`'s `<link rel="manifest">` href stays `%sveltekit.assets%/manifest.webmanifest` (unchanged) rather than moving to a bare `/manifest.webmanifest`, because `static/manifest.webmanifest` no longer exists (moved to `src/lib/server/pwa/manifest.webmanifest`, confirmed by `test/manifest.test.ts`'s `expect(existsSync('static/manifest.webmanifest')).toBe(false)`), so there is no static file left to shadow the new route — the PRD's conditional ("if the adapter's static-asset matching would shadow a route of the same path") does not apply, and the e2e manifest test (`e2e/pwa.spec.ts`) confirms the route serves correctly through the unchanged link. `e2e/pwa.spec.ts`'s service-worker precache test was updated to assert `/manifest.webmanifest` is *not* precached (it is account-dependent, `private, no-store`), matching the PRD's Part 3 requirement; this ran clean.

## Findings

None. No acceptance criterion failed; no `npm run gates` failure; no space-authorization gap found.
