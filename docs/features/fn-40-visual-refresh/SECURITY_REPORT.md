# FN-40 Visual refresh — Security report (Parts 1 + 4)

Scope: `git diff main...e710274` (worktree `fn-40a-rt`), Medium tier, narrow review: the
`/pengaturan/tampilan` form action, `theme` cookie handling, `src/hooks.server.ts`, `src/lib/server/prefs.ts`,
`src/app.html` vs the CSP, glass component changes in `src/lib/ui/**` and `src/app.css`.

## Verdict: PASS

No medium or high findings. Two low/informational items below for tracking.

## What was checked

- **Allowlist.** `resolveTheme` (src/lib/server/prefs.ts:10-12) only returns one of `system|light|dark|mono`;
  any other cookie value becomes `system`. The action (src/routes/(app)/pengaturan/tampilan/+page.server.ts:19)
  refuses anything outside `isThemePref` with 400 and no `Set-Cookie` (covered by e2e/tampilan.spec.ts).
- **Reflection into HTML.** `transformPageChunk` (src/hooks.server.ts:30-39) writes `locals.theme` (allowlisted)
  into `data-theme` and `themeColors()` returns only four fixed hex constants for the two `theme-color` metas. No
  attacker-controlled bytes reach the HTML; no `$` replacement patterns are possible. `%fin.theme%` does not
  match inside `%fin.themeColorLight%`, so placeholder order is safe. The client sets
  `documentElement.dataset.theme` only from the server's allowlisted `saved` value.
- **Header injection.** Cookie value is allowlisted before `cookies.set`; no user value reaches any header.
- **Cookie attributes.** `Path=/`, `Max-Age` one year, `SameSite=Lax`, `Secure` on deployed hosts
  (`locals.secure`), not HttpOnly by design (the sidebar toggle rewrites it). Holds no secret; acceptable.
- **CSRF.** The action is a cookie-authenticated POST on a non-Bearer route, so `isCrossSiteForm` in
  hooks.server.ts:46 refuses cross-site/Origin-less form posts before the action runs; CSP `form-action 'self'`
  also applies.
- **Auth / spaces.** Route is inside `(app)` and not in `PUBLIC_APP_ROUTES`, so `authGate` rejects anonymous
  requests first; the action also redirects without `locals.user`. It reads/writes no D1, R2 or space data.
- **Open redirect.** The only redirect target is the constant `/masuk?next=%2Fpengaturan%2Ftampilan`.
- **Body handling.** `readFormBody` enforces content type, size cap and timeout.
- **CSP.** `app.html` adds no inline script/style; glass changes are scoped `<style>` blocks and classes, no
  `style=` attributes, `{@html}`, `@import` or external `url()`. No CSP directive changed; no `'unsafe-inline'`.
- **Prerendered site.** Placeholders are replaced at build time with the `system` values; no literal
  `%fin.*%` left behind.

## Findings

### L1 (low, informational) — form body read before the in-action user check
src/routes/(app)/pengaturan/tampilan/+page.server.ts:17-18. `readFormBody` runs before `if (!locals.user)`.
Not exploitable: `authGate` already refuses anonymous POSTs to `(app)` routes, and the body is size/time
capped. Defence-in-depth only: check the user first, as other actions do.

### L2 (low, integrity of a preference only) — sidebar toggle silently replaces `mono`
src/lib/ui/shell/theme.ts `nextTheme` treats `mono` as `system` and writes `light`/`dark`, dropping the
"Hitam-putih" choice. Not a security issue (same-origin, allowlisted values); tracked for the UX owner.

## Engineering checklist

- CSP: no additions, never `'unsafe-inline'` — met.
- Secrets in loaders: root layout exposes only `theme` (allowlisted) — met.
- Space-access helper: not applicable (no space data touched).

## Commands

- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2 src/lib/server/prefs.test.ts src/lib/server/csrf.test.ts src/lib/ui/kit/GroupRow.test.ts`
  → 3 files, 11 tests passed.
- Playwright not run by the reviewer (e2e/tampilan.spec.ts read only).
