# FN-46 Pro look — Security report (cycle 1)

Reviewed: `git diff 93cf1e0..8fabb21` (worktree `montra-worktrees/fn-46-rt`, detached at 8fabb21), against the PRD,
QA report and `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. Two low findings are tracked below.

## What was checked

- **Entitlement source.** `locals.plan` comes from `planOf(locals.db, locals.user.id, Date.now())` in
  `src/hooks.server.ts:104`. It reads only the session user's id and never a client value. `effectivePlan` uses
  `currentPeriodEnd > now`, so a period that ends exactly now counts as lapsed (PoC confirmed). Agen gets the Pro
  look through `PAID_PLANS`.
- **Theme downgrade.** `allowedTheme` runs on every resolved request (`hooks.server.ts:105`) and in the
  `building` branch. `resolveTheme` matches the exact set of values, case-sensitively. PoC: `GOLD`, `Gold`,
  ` gold`, `gold `, `gold%00`, `gold;x`, `"gold"`, `gold,emerald`, `__proto__` and `constructor` from a Gratis
  session all render `system`. When the cookie header holds two `theme` cookies, the parser takes one value, and
  that value is checked the same way.
- **Tampilan action** (`src/routes/(app)/pengaturan/tampilan/+page.server.ts:29-30`). The action re-reads the
  plan from D1 and refuses a posted Pro theme with 403. CSRF is covered by the hook's cross-site check. The body
  is read through `readFormBody`.
- **Plan read failure.** The plan read is wrapped in try/catch, so the page falls back to Gratis and still renders.
  The log line holds `errorLabel` only, with no e-mail and no user id. PoC: renaming `user_plan_state` on a Pro
  account renders `system`, sets `plan=gratis` and does not return a 500.
- **`/manifest.webmanifest`.** The body is derived only from `locals.plan`, and its headers are static:
  `application/manifest+json`, `private, no-store`, plus `nosniff` from the hook. No header is built from user
  input, so there is no header injection. There is no `Access-Control-Allow-Origin`, so another origin cannot read
  the body. Signed out, the response is the Gratis file, byte for byte. Because of `no-store`, no CDN, shared cache
  or HTTP cache can serve one account's manifest to another, so a `Vary` header is not needed. The service worker
  no longer precaches the manifest and does not intercept it (it is not in `SHELL_SET`). Browsers read the manifest
  only at install time, so offline use does not regress. PoC: user B's session with `?user=<A's id>` gets the
  Gratis manifest.
- **`%fin.appleTouchIcon%`** (`src/app.html:16`, `hooks.server.ts:42`). The replacement is one of two constant
  file names, chosen by the plan. `lang` and `theme` are enums, so no earlier replacement can inject the
  placeholder, and there is no user-controlled value. The page is HTML for a signed-in user, so it already gets
  `private, no-store`. Prerendered site pages always get the Gratis icon.
- **Page data exposure.** `shell.plan` is the caller's own plan enum only. No period end, billing id or other
  user's data is added to the shell. The Paket page's `data.state` was already exposed before this change and
  only shows the caller's own state.
- **Cost.** The change adds one primary-key read for each signed-in request that reaches `resolve`. Signed-out
  requests and requests stopped early by `authGate` add no D1 read. There is no amplification for unauthenticated
  callers.
- **Checklist.** No new SQL, no `{@html}`, no CSV, no new CSP entries and no secrets in loaders. The form guard is
  reused, and the new phrases have English entries (QA).

## Findings

### L1 (low, functional): browsers never receive the Pro manifest icons

`src/app.html:8` declares `<link rel="manifest" href="…/manifest.webmanifest">` without `crossorigin="use-credentials"`.
Under the HTML spec, a manifest link without that attribute is fetched with credentials mode `omit`. Chromium does
this even for same-origin manifests. The Worker therefore sees no session cookie, `locals.plan` is `gratis`, and an
Android or desktop install by a Pro account gets Koko's normal icons. This fails closed, so it is not a security
issue. However, FN-46 Part 3 (manifest icons) probably never works in a real browser. The integration test sends
the cookie by hand, so it cannot catch this.

Reproduction: sign in as Pro in Chromium, open DevTools › Application › Manifest. The icons show
`/icons/icon-192.png`, and the Worker log shows the request without a session.

Fix options: add `crossorigin="use-credentials"` to the link, or accept that the manifest icons stay Gratis and keep
the Pro icon to iOS `apple-touch-icon`. The link fix is safe: the response already has `private, no-store` and no
CORS headers.

### L2 (low, accuracy): the lapsed-plan comment claims the cookie is dropped

`src/routes/(app)/pengaturan/tampilan/+page.server.ts` (action doc comment) says "hooks.server.ts also drops a Pro
theme cookie on every request once the plan has lapsed". The hook only renders `system`; it leaves the `theme=gold`
cookie in place. If the account pays again later, the Pro theme comes back by itself. That matches the entitlement,
so there is no exposure, but the comment is misleading. A forged Pro theme set through the client (DevTools
`data-theme="gold"`) is cosmetic only and grants no server feature.

## Commands run

- `npm ci --no-audit --no-fund`: installed (esbuild postinstall warning only).
- Temporary PoC `test/poc/fn46-redteam.test.ts` (cookie variants, period-end boundary, plan read failure, manifest
  cross-account): `Test Files 1 passed (1)`, `Tests 4 passed (4)`. The file has been deleted.
- `npx vitest run test/integration/pro-look.test.ts test/manifest.test.ts`: `Test Files 2 passed (2)`,
  `Tests 37 passed (37)`.
- E2E: not run. The manifest credentials behaviour (L1) was not reproduced in a browser.
