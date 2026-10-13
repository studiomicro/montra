# FN-38 Public API — Security report (red team, cycle 1)

Reviewed: `git diff main...fn-38-public-api` at 25d1910 (cycle 1b), PRD and ENGINEER_REPORT.

## Verdict: PASS

No medium or high findings. Five low/informational findings are listed so they are tracked.

## Findings

### L1 (low) — Shared-IP lockout of valid tokens by the pre-auth failure budget
`src/lib/server/api/http.ts:190`. `attemptLimitReached(…'api-auth', 20)` runs before the token lookup and is
keyed by client IP (`clientKey`: CF-Connecting-IP, IPv6 /64). Anyone sharing the public IPv4 (mobile CGNAT is
common in Indonesia, office/campus NAT) can send 20 requests with junk `Authorization` headers per 10-minute
window (2/min) and every legitimate token used from that IP gets 429 for the rest of the window.
Reproduction: the engineer's own test `public-api.test.ts:351` shows a valid token from the same IP answered 429
after 20 junk requests. No data exposure; availability only. Suggestion: for a well-formed token
(`API_TOKEN_PATTERN`), do the indexed hash lookup first and apply the IP budget only to the failure path, or
use a much higher per-IP budget (tokens are 256-bit, guessing is not the threat).

### L2 (low) — Token creation needs no re-authentication
`src/routes/(app)/pengaturan/api/+page.server.ts:66`. A hijacked session or an unattended signed-in device can
mint a 365-day `read_write` token in one POST; it outlives the session (sign-out or session expiry does not
revoke it). Only a password change (which correctly revokes all tokens atomically, `change-password.ts`)
or a manual revoke ends it. Suggestion: ask for the password on create (the throttle and PBKDF2 path already
exist), or e-mail/notify the user when a token is created.

### L3 (low/info) — OpenAPI document exposes internal D1 statement budgets
`src/lib/server/api/openapi.ts:102` emits `x-financer-max-d1-queries` per route in the unauthenticated
`/api/v1/openapi.json`. Internal capacity detail, not a secret; drop it from the public document (keep it in
tests).

### L4 (info) — Cross-space `client_id` existence oracle (pre-existing FN-02 rule, now reachable by token)
`src/lib/server/transactions/client-id.ts:26`. `POST /transactions` with `client_id` = a transaction id from a
space the caller cannot read answers 409 `gone`; an unused id answers 201. Needs a known UUID (e.g. a removed
member who remembers ids of a former shared space) and reveals only that the id exists (tombstones included),
no content. Accepted design; tracked only.

### L5 (info) — A `read` token causes a write on `GET /categories`
`src/routes/api/v1/categories/+server.ts:10` calls `ensurePresetCategories` (idempotent preset insert), the
same as every app category screen. Not a privilege issue; noted because read scope is not strictly read-only.

## Verified (no finding)

- Token format `fin_` + 32 CSPRNG bytes base64url (256 bits); only SHA-256 hex stored (unique index), last four
  shown; pattern/length check before lookup; constant-time re-compare; one fixed 401 for unknown, malformed,
  revoked, expired and non-active-user tokens. No pepper needed at 256-bit entropy.
- Shown once: raw token only in the create action's result (page response is `private, no-store`); never in
  `load`, list, export (`api_tokens` exported with `token_hash` omitted), logs (`errorLabel` only; request log
  holds route id only), Analytics Engine, or error bodies.
- Revocation/expiry/user status checked on every request; revoke scoped by `user_id` (no IDOR, 404 for another
  user's id); 10-token cap enforced in one guarded INSERT…SELECT; restricted space membership checked inside
  the insert; lifetimes limited to 30/90/365; form actions covered by SvelteKit's origin check (not disabled).
- Password change revokes all live tokens in the same `db.batch`, guarded by the new hash (atomic); account
  deletion deletes all tokens before the user row; `restricted_space_id` cascades on space purge.
- Bearer parsing: `bearer`/`BEARER` accepted (RFC 7235 case-insensitive), double space, `Basic`, bare token,
  two comma-joined credentials (multiple headers) all 401; header value >128 chars treated as unknown.
- Session cookie never authenticates an FN-38 route (handlers never read `locals.user`); no `(app)` or other
  `/api/v1` route reads `Authorization`. No CORS headers emitted. Bearer auth makes the JSON routes CSRF-immune.
- Scope: `read` token refused 403 on POST/PATCH/DELETE before any write. Restriction: other `space_id` gets the
  same 404 as a non-member; `/spaces` filtered to the restricted space. Every route admits `space_id` through
  `requireSpaceAccess` (removed member and deleted space → 404); transaction path ids and body wallet/category/
  transfer ids resolved inside the admitted space only (probe: PATCH/DELETE of another space's id → 404; another
  space's wallet/category/transfer target → 400).
- Mass assignment: zod objects strip unknown keys; probe POST with `source:'gmail'`, `is_demo:true`,
  `recurring_series_id`, `space_id`, `created_by`, `id`, `__proto__` → stored `manual`, not demo, no series, no
  prototype pollution; `type:'adjustment'` refused on POST and PATCH; adjustment rows not editable via API.
- Cursor: regex-parsed, parameterised keyset inside the space filter; forged/foreign cursors only page within
  the caller's space. `limit` 1–50, period ≤ 366 days, `q` ≤ search max.
- Bodies: `application/json` only (415), 8 KB cap (413), fatal UTF-8 + JSON.parse (400), shape errors 400 with
  field names only; 500 bodies generic. Per-token 300/10 min and per-user transaction-create limits; throttle
  fails closed. `last_used_at` written at most hourly via guarded UPDATE. Per-route D1 statement budgets tested.
- ENGINEERING_CHECKLIST: one access rule, bounded queries, guarded concurrent writes, no SQL interpolation of
  user input (all `sql` template values bound), no `{@html}` in the new pages, i18n entries present.

## Commands run

- `npx vitest run --maxWorkers=2 test/integration/zz-rt38-probe.test.ts` (temporary probe, deleted after):
  4 passed — mass assignment, cross-space PATCH/DELETE/refs, adjustment refusal, Bearer parsing edge cases.

## Re-check (cycle 2) — cf72943

Scope: `git diff 25d1910..cf72943` plus ENGINEER_REPORT cycle 2. Key change: SvelteKit's CSRF check switched off
(`csrf.trustedOrigins: ['*']`, which sets `__SVELTEKIT_CSRF_CHECK_ORIGIN__ = false` in Kit 3.0.1) and reimplemented
in `src/lib/server/csrf.ts`, called first in `hooks.server.ts` `handleRequest` for every route except the 7 FN-38
route ids (10 operations) built from `ENDPOINTS`.

### Replacement vs Kit 3.0.1 `is_csrf_forbidden` (node_modules/@sveltejs/kit/src/runtime/server/csrf.js)
- Same rule: (no Content-Type, or first media type, trimmed and lower-cased, in {urlencoded, multipart/form-data,
  text/plain, application/x-sveltekit-formdata}) AND method in {POST, PUT, PATCH, DELETE} AND `Origin` !== self
  origin (`event.url.origin`; `paths.origin` is unset, so Kit used the same value). Missing Origin and `Origin:
  null` are refused, as in Kit. Kit has no Sec-Fetch-Site check; neither does the replacement. Same 403 text/JSON.
- Stricter than Kit in one way only: Kit skips the check under `vite dev`, the hook does not.
- Coverage: Kit runs nothing from the app before `handle` other than `reroute`, route-resolution GETs, env and
  trailing-slash 308s and prerendered-asset serving (none change state). The check is the first statement of
  `handleRequest`, before `building`, the http→https 308, `authGate`, `resolve()`, actions, endpoints and error
  pages. No remote functions exist (Kit's separate remote check is unchanged anyway).

### Probes over real HTTP (`vite dev` in rt-38, local D1, under the lock; killed afterwards)
- 403 "Cross-site … forbidden": app action `?/create` with an evil Origin, no Origin, `Origin: null`;
  `Application/X-WWW-Form-Urlencoded ; charset=utf-8`; multipart; text/plain; no Content-Type;
  x-sveltekit-formdata; PUT; DELETE without a body; `/api/v1/track`; `/api/v1/sync/push` with text/plain (JSON gets
  its own Origin 403); unmatched route; `/keluar`; `/masuk`; `__data.json`. Same-origin form → passes to the gate (401).
  JSON to an app action passes the check exactly as under Kit (actions then refuse non-form bodies).
- Exemption cannot be reached for a cookie handler: exemption keys on the route id Kit matched, and every exempt id
  is served only by `apiRoute` (Bearer-only, never reads `locals.user`). Path tricks: trailing slash → 308 (the
  follow-up is checked); `//api/…`, `/API/…`, `..` → not exempt, 403; `%2F` in `[id]` and `?/create` on an exempt
  path → 405 (no page/action there); `__data.json` → 404; PATCH/DELETE/HEAD on exempt routes → API 401 JSON;
  OPTIONS → 405, no CORS headers.

### Earlier findings
- L1 fixed: the token is looked up first; only failing requests count and only failing requests get 429
  (`http.ts`), so a valid token keeps working from a busy address (test `public-api.test.ts:370`).
- L2 fixed: creating a token re-proves the password (`prove-password.ts`, throttled per client and per user,
  counts toward lockout); the INSERT joins `user_passwords.hash = provenHash`, so a create racing a password
  change either writes nothing (`credential`, 409) or writes before the change batch, which then revokes it. The
  password is never echoed in `values`.
- L3 fixed: `openapi.json` contains no `max-d1` field (probe count 0); budgets live in the test only.
- L4, L5 unchanged (informational, accepted).

### New
- **L6 (info)** `src/lib/server/csrf.ts:24`: the exemption is per route id, not per handler. A future
  cookie-authenticated method added to one of these `+server.ts` files (or a non-`apiRoute` handler) would be
  CSRF-exempt silently. Suggest a test asserting every export of the exempt route modules is an `apiRoute`.

### Commands
- `npx vitest run --maxWorkers=2 src/lib/server/csrf.test.ts test/integration/pengaturan-api.test.ts
  test/integration/public-api.test.ts src/lib/server/api/openapi.test.ts`: 4 files, 52 tests passed.
- `vite dev` HTTP probe script: 31 requests, results as above.

### Verdict (cycle 2): PASS — no medium/high findings; L4, L5, L6 low/informational.
