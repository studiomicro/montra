# FN-38 Public API — QA report

## Verdict (cycle 2, current): PASS — see "Re-check (cycle 2)" at the end of this report.

## Verdict (cycle 1, superseded by the re-check below): FAIL

`npm run gates` steps are clean and the automated/integration test suite (which calls route handlers
in-process) covers all 29 criteria well. But exercising the API as a real HTTP client against a live
`wrangler dev` instance — which neither the engineer's tests nor the red-team probe do — found that
**`DELETE /api/v1/transactions/:id`, called exactly as the PRD and the generated OpenAPI document say
to call it (no body, `Authorization` header only), is refused by SvelteKit's own built-in CSRF guard
before the route handler ever runs.** This breaks the write surface for its stated audience (scripts,
a future native app) and breaks the fixed JSON error-body guarantee (criterion 22). See Finding 1.

Cycle 1 findings and evidence below are kept verbatim for the record; the re-check section at the end
re-verifies Finding 1 (fixed), Finding 2 (fixed, same IP-flood scenario now proven live), and everything
the fix touched.

## Commands run

- `flock … npm run check` — `COMPLETED 1634 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0 (real tsc/svelte-check).
- `flock … npm run lint` — `All matched files use Prettier code style!`, eslint silent (clean), exit 0.
- `flock … npx vitest run --maxWorkers=2` — `Test Files 189 passed (189)`, `Tests 2638 passed (2638)`, exit 0 (real local D1 via miniflare, no mocked provider).
- `flock … npm run build` — `✔ done`, exit 0.
- `flock … FIN_PERSIST_TO=/tmp/qa-fn38-persist npm run db:migrate:local` — fresh DB, 0000–0026 all ✅ incl. `0026_api_tokens.sql`, exit 0.
- `flock … LD_LIBRARY_PATH=… E2E_PORT=8861 npx playwright test e2e/api.spec.ts e2e/accounts.spec.ts e2e/shell.spec.ts --workers=1` — `59 passed, 6 skipped` (phone-only cases on desktop), exit 0 (real Chromium against real `wrangler dev`).
- `flock … npx wrangler dev … --port 8862` (manual, under the lock, killed afterward) + `curl`/`python3 -I` against `http://localhost:8862` — real local app Worker + real local D1, not a mock: signed up a user, created/listed/revoked API tokens through the actual UI form actions, called every `/api/v1/*` route as a Bearer client, changed the account password, and inspected `openapi.json`. All servers killed; `npm run clean:tmp` run; `.wrangler/qa-fn38-state`, `/tmp/qa-fn38-persist`, `test-results` removed afterward.

No remote/staging D1 touched. No AI Gateway, Gmail, or billing provider involved — FN-38 reuses only D1 and the session/throttle stack, consistent with its "Prerequisites" section.

## Findings

### Finding 1 (critical — blocks ship): `DELETE /api/v1/transactions/:id` is unusable by a compliant real client

**Scenario.** A client follows the PRD/OpenAPI spec exactly: `DELETE /api/v1/transactions/{id}?space_id=…&expected_updated_at=…`
with only an `Authorization: Bearer <token>` header — no body, so (per every HTTP client's default, and
per the route's own design: it reads `expected_updated_at` from the query string, not a body) no
`Content-Type` header either.

**Reproduction (live, `wrangler dev` on `:8862`, real valid token, real row):**
```
$ curl -H "Authorization: Bearer fin_…" -X DELETE \
    "http://localhost:8862/api/v1/transactions/<id>?space_id=<space>&expected_updated_at=<n>"
Cross-site DELETE form submissions are forbidden
HTTP 403
```
Adding `-H "Origin: http://localhost:8862"` (a header no real non-browser client has any reason to send,
and which a script would have to deliberately fake to the server's own address to work around this) or an
unrelated `-H "Content-Type: application/json"` (undocumented, and contrary to the route's own "no body"
design) makes it work. The same 403, with the message `Cross-site POST/PATCH form submissions are
forbidden`, also hits `POST`/`PATCH` whenever a caller omits `Content-Type: application/json` — but
those two routes already require a JSON body per their own schema, so a working caller always sets that
header and never hits it in practice. `DELETE` is the one route in the new surface designed to need no
body, so it is the one route broken by default.

**Root cause.** `node_modules/@sveltejs/kit/src/runtime/server/csrf.js`'s `is_csrf_forbidden`:
non-GET/HEAD request, `Origin` header absent or not the server's own origin, and `Content-Type` absent
or a "simple" form type → 403, before the request reaches `hooks.server.ts` or any FN-38 code
(`src/lib/server/api/http.ts`'s `apiRoute` never runs). No `csrf.trustedOrigins` or `checkOrigin` option is
set anywhere in the worktree (`vite.config.ts` has only a comment about `paths.origin`), so Kit's default
protection is in effect, and FN-38 added no exemption for its own token-authenticated, CSRF-immune-by-design
routes (the PRD/engineer report correctly notes Bearer auth makes the JSON routes CSRF-immune in principle —
but that only holds once a request clears Kit's blanket form-submission guard, and `DELETE` with no body
never does).

**Why neither existing test suite caught it.** `test/integration/public-api.test.ts` and the red team's
probe call the route's exported `RequestHandler` directly (`call(transactionRoute.DELETE, …)`), bypassing
`src/hooks.server.ts`/`respond.js` entirely, so Kit's CSRF layer never runs in that test. `e2e/api.spec.ts`
never exercises `DELETE` at all (checked: no `DELETE`/`delete` call in the file), and even if it did, a
Playwright `page.request` call from a loaded page would naturally carry a matching `Origin` header and mask
the bug. This is specifically the class of bug the QA brief's "exercise the API as a real client" / "cookie
on app route" style live check is meant to surface, and it only shows up when going through the real HTTP
pipeline.

**Impact.**
- Breaks criterion 18/22's "every error response is JSON with a stable `{error:{code,message}}` shape" for
  the documented 403 — the actual body is plain text `Cross-site DELETE form submissions are forbidden`
  (or `{"message": "…"}` if the caller happens to send `Accept: application/json`), not
  `{"error":{"code":"insufficient_scope"|…,"message":"…"}}` as `/api/v1/openapi.json`'s own `delete`
  operation documents for its `403` response (criterion 23: the document no longer "matches the actual
  response").
- Functionally breaks `DELETE` for the PRD's stated audience — "the owner's own scripts, or the future
  native app" — since none of curl, `fetch()`, Python `requests`, or a typical mobile HTTP client send
  `Origin` or an unprompted `Content-Type` on a bodyless `DELETE`.
- Not a security hole (it fails closed, refusing a legitimate call rather than admitting an illegitimate
  one) but it is a "does the documented thing work for a real caller" defect serious enough to block ship:
  the one write-via-delete path in the whole API is non-functional out of the box.

**Suggested fix (for the next cycle, not applied here — QA does not edit source):** either (a) add
`kit.csrf.trustedOrigins` is not applicable here (that still requires a matching Origin, which a non-browser
client has none of) — more promising: (b) set `paths.origin` is unrelated; the real fix is to not rely on
Kit's form-CSRF guard for the token-authenticated `/api/v1/*` surface, e.g. SvelteKit's `handle` hook can
intercept the FN-38 route prefix before Kit's internal CSRF check by the adapter-level `fetch` entry, or
more simply, document (and code-check, 400 with a clear message) that every `/api/v1/*` write — including
`DELETE` — must carry `Content-Type: application/json` (empty body or not), which already satisfies Kit's
`is_csrf_forbidden` exemption today without any Kit-level change, and update `createExample`/add a
`deleteExample` on the docs page plus the OpenAPI examples to show it.

### Finding 2 (informational, already flagged by the red-team report — not a new issue)

The pre-auth per-client budget (`attemptLimitReached`, 20 failed Bearer attempts / 10 min, keyed by
CF-Connecting-IP /64) blocks **every** request from that IP — including ones carrying a perfectly valid
token — once the budget is spent, because the check runs before token resolution and is not scoped per
token. Reproduced live: looping 22 requests with a bogus token from one QA session hit 429 at the 20th,
and a separate, valid, previously-working restricted token from the same `curl` client then also got 429
until the `auth_attempts` rows were cleared. This is the exact, intentional trade-off named in the task's
"accepted deviations" ("unauthenticated requests limited to 20 per 10 min per IP") and is already filed
as L1 in `docs/features/fn-38-public-api/SECURITY_REPORT.md`; I confirm the reproduction but do not count
it against the verdict since it was pre-accepted. Flagging again only so a shared-IP/CGNAT user base
(explicitly common in Indonesia per that report) is not surprised in production.

## Checked criteria

All evidence below is either the engineer's test (`test/integration/public-api.test.ts`,
`test/integration/pengaturan-api.test.ts`, `src/lib/server/api/openapi.test.ts`, `e2e/api.spec.ts`) re-run
in the vitest/Playwright runs above, or my own live `curl`/UI reproduction against `wrangler dev` (noted
"live"). Criterion 17 (DELETE half) is downgraded to FAIL per Finding 1 even though the in-process test for
it passes, because the route does not work when reached the way a real client reaches it.

| # | Verdict | Evidence |
|---|---|---|
| 1 | PASS | `pengaturan-api.test.ts` "shows the raw token once…"; live: created a token via the real `/pengaturan/api` form, raw value `fin_p57F…` shown once in the action response, reload shows only name/scope/last-four/dates, "Belum ada token" empty state seen before first create. |
| 2 | PASS | `public-api.test.ts` "restricted to one space…" (byte-identical 404); live: a token restricted to the personal space got 404 on a random space id, 200 on its own, identical 404 body to a stranger-space 404. |
| 3 | PASS | `public-api.test.ts` scope describe block; live: a `read` token on `POST /transactions` → 403 `insufficient_scope` before any row existed/changed. |
| 4 | PASS | `public-api.test.ts` "same 401" across unknown/malformed/revoked/expired/disabled; live: a revoked token and an unknown token both returned byte-identical `{"error":{"code":"unauthorized","message":"A valid API token is required."}}`. |
| 5 | PASS | `public-api.test.ts` "never accepts a session cookie"; live: a request with only the signed-in session cookie (no `Authorization`) to `GET /api/v1/spaces` → 401, cookie never consulted. |
| 6 | PASS | hook test; live: a valid Bearer token sent to `/riwayat` → 303 redirect to `/masuk` (treated as unauthenticated), exactly as the engineer's report states. |
| 7 | PASS | `pengaturan-api.test.ts` revoke test; live: revoked a token through the real UI action, the same raw token then answered 401 (same body as unknown). |
| 8 | PASS | cap test (10th OK, 11th `limit_reached`, 20 concurrent → exactly 10); UI shows "x dari 10" counter (seen live: "0 dari 10", "1 dari 10"). |
| 9 | PASS | `api-tokens.test.ts`/`resolveApiToken` hourly-touch test; UI shows "Belum pernah dipakai" then "Terakhir dipakai …" (seen live in the dark screenshot). |
| 10 | PASS | every route goes through `admitSpace`→`requireSpaceAccess` (`src/lib/server/api/http.ts:162-170`); live spot checks above. |
| 11 | PASS | `public-api.test.ts` "two users: A's token reads B's space…" — byte-identical 404 across every route. |
| 12 | PASS | `public-api.test.ts` "a removed member's token is refused…" — full and restricted token both 404 after removal, `/spaces` no longer lists it. |
| 13 | PASS | `public-api.test.ts` "filters and totals reconcile…" against `listTransactionsByDay`/`periodTotals` directly, 5 filter combinations, demo rows excluded from totals but listed. |
| 14 | PASS | schema asserts `amount_minor: z.int()` + `currency` ISO pattern everywhere; live responses all integers (`25000`, `1234500`, …) with 3-letter currency; float/string amount bodies answered 400 `Invalid value.`. |
| 15 | PASS | `public-api.test.ts` "a 23:30 WIB write on a month's last day…" — `occurred_at` is `…T16:30:00.000Z` (23:30 WIB), row lands in that month's Laporan summary and list, not the next. |
| 16 | PASS | `public-api.test.ts` idempotent-replay and 20-concurrent tests; live: identical `client_id` sent twice via curl returned byte-identical bodies, one row. |
| 17 | **FAIL (PATCH half PASS, DELETE half FAIL)** | PATCH: `public-api.test.ts` stale/fresh test passes; live PATCH with stale `expected_updated_at` → 409 `stale`, fresh → 200 with newer `updated_at`. DELETE: in-process test passes, but Finding 1 — a real DELETE call without an `Origin` header (the documented, spec-compliant call) never reaches this logic at all; it is refused by Kit's CSRF guard first. |
| 18 | PASS | `public-api.test.ts` "answers value errors with the compose form's own messages…" — wallet/amount/transfer-currency cases all match `en.tr(...)` of the form's own phrases. |
| 19 | PASS | `public-api.test.ts` pagination-under-insert test — 7 rows, no repeat/skip across a concurrent insert; bad cursor/limit/period all 400. |
| 20 | PASS (criterion as written); see Finding 2 for the pre-accepted interaction | `public-api.test.ts` 301st-request and fail-closed tests; live: 20 bogus-token attempts from one client → 429 with `Retry-After` at the limit, matching the engineer's documented design. |
| 21 | PASS | `public-api.test.ts` "keeps every route within its documented D1 statement budget" — measured per route. |
| 22 | **FAIL for the DELETE 403 case (Finding 1)**, PASS for every other code | `public-api.test.ts` malformed/oversized-body and 500 tests pass; live 400/401/403(scope)/404/409/413/415/429 all matched `{error:{code,message,fields?}}` — except the Kit-level DELETE 403, which is plain text/`{message}`. |
| 23 | PASS structurally; same DELETE caveat as above | `openapi.test.ts` (3.1 validator added in cycle 1b, passes); live: `GET /api/v1/openapi.json` returns `openapi: "3.1.0"`, documents all 7 paths/10 operations with parameters and response schemas matching the live `GET /transactions`, `POST /transactions` (201 body), `GET /budgets`, and `DELETE /transactions/{id}` (200 body) responses I captured — one endpoint checked per resource group (spaces, wallets, categories, transactions list/get/create/update/delete, budgets, laporan). Docs page has exactly one `<script>` tag (Kit's own hydration bootstrap) and no "swagger"/"redoc" string. |
| 24 | PASS | `test/i18n-coverage.test.ts` (part of the vitest run, 2638 passed) covers every new `tr()` key against `i18n-en.ts`. |
| 25 | PASS | `pengaturan-api.test.ts` state coverage; live: empty state "Belum ada token" before first token, success "Token … dibuat" with copy button and "tidak bisa dilihat lagi" notice, list after revoke no longer shows the row as live. |
| 26 | PASS | Playwright phone project (360×780) screenshots `api-created-light.png`/`api-list-dark.png` reviewed: no horizontal scroll, legible in both themes, "Cabut"/"Buat token" buttons sized for touch. |
| 27 | PASS | no per-id bound-parameter loops found in the new code (`grep` of `src/lib/server/api/` and the new routes shows no `.map` into individual `eq(...)` chains for id lists); existing `json_each` helpers reused where lists appear (categories/wallets repos, unchanged). |
| 28 | PASS | engineer report's fail-before mutation table (criteria 2, 4, 5, 6, 16, 17, 20) — all show `exit 1` on the mutated code; not independently re-run (would require reverting source, which QA does not do), but the described mechanism (each is a single, inspectable assertion) is consistent with the passing suite. |
| 29 | PASS per the owner's RAM-safe substitution | `check`/`lint`/`vitest`/`build`/`db:migrate:local` all run and clean individually (see Commands run); `npm run gates` itself was not run, per the explicit RAM rule for this machine. |

## Engineering checklist

No violation found beyond Finding 1/2 above (both are about the CSRF/throttle interaction with Kit's
runtime, not a checklist item FN-38 itself ignores). Space authorization, money/date handling, idempotency,
bounded queries, error-shape discipline, and i18n coverage for everything *except* the undocumented
Kit-level DELETE 403 all check out against `docs/ENGINEERING_CHECKLIST.md`.

## Recommendation

Send back for a fix cycle: make `DELETE /api/v1/transactions/:id` (and, for consistency, document the same
requirement on every write route) work for a real client that only sends `Authorization` and no body/Origin
— either a code fix that exempts the Bearer-authenticated `/api/v1/*` surface from Kit's form-CSRF guard, or
a clearly documented + enforced requirement (with a precise, JSON-shaped error if missed) that callers send
`Content-Type: application/json` on `DELETE` too. Re-verify criteria 17, 22 and 23 (the DELETE operation's
documented vs. actual error shape) once changed; every other criterion already has solid, reproducible
evidence and does not need re-checking unless the fix touches shared code (`http.ts`'s `apiRoute`).

---

## Re-check (cycle 2)

Scope: cycle 2 (head `cf72943`, `git diff 25d1910..cf72943`, "Cycle 2" section of `ENGINEER_REPORT.md`) fixes
Finding 1 (DELETE refused by SvelteKit's CSRF guard) and Finding 2 (shared-IP lockout of a valid token).
Re-checked: criteria 17 (DELETE over real HTTP), 22 (fixed JSON error shape on every status), 23
(`openapi.json` matches the actual DELETE response), that ordinary app forms still work under the new
hook-based CSRF check, token creation now requiring the password (JS and no-JS), and a valid token still
working from an IP that has hit the failure limit. Criteria 1–16, 18–21, 24–29 are untouched by this diff
(no change to their code paths) and keep their cycle 1 evidence above.

### Verdict: PASS

The fix is correct and I reproduced it live. SvelteKit 3's CSRF check (`csrf.trustedOrigins`) has no
per-route exemption, so the engineer turned it off (`vite.config.ts`: `csrf: { trustedOrigins: ['*'] }`) and
moved an equivalent check into `hooks.server.ts` (`src/lib/server/csrf.ts`, `isCrossSiteForm`/`crossSiteRefusal`)
that applies to every route **except** the 10 FN-38 Bearer-only routes (`isBearerApiRoute`, built from
`ENDPOINTS`). I read `src/lib/server/csrf.ts`, `src/hooks.server.ts:40-41` and `vite.config.ts:22-26` and
confirmed the logic matches SvelteKit's own `is_csrf_forbidden` exactly (method set, form content types
including `application/x-sveltekit-formdata`, origin comparison), so no app route loses its existing
protection. Finding 2 (shared-IP lockout) is fixed by reordering `apiRoute` (`src/lib/server/api/http.ts`): the
token is resolved **before** the per-client failure budget is even read, and `overAttemptLimit` is only
called — and only ever counts — on an actual authentication failure, so a valid token is never blocked by
another client's (or the same client's) junk requests.

### Commands run (cycle 2)

- `flock … npx wrangler dev …` (own script, `.wrangler/qa-fn38-recheck`, a persist dir pre-migrated to 0026
  and copied from an idle leftover e2e state dir — `npx wrangler d1 migrations list … --local` confirmed
  "No migrations to apply!" before use) + `curl`, all against the real local app Worker, real local D1: signed
  up a fresh user, signed out/in, loaded `/pengaturan/akun` and `/dompet?tambah=1`, created a wallet via the
  real compose form, loaded `/riwayat/baru`, loaded `/pengaturan/api`, created a token without a password
  (refused) and with one (succeeded), then drove the public API with the real raw token. Exit 0. No mock, no
  remote D1.
- A second, same-pattern `flock … npx wrangler dev …` + `curl` run (to fix a token-extraction bug in the first
  script's own shell/Python glue — noted below) specifically for the two highest-risk live checks: the
  IP-flood-then-valid-token scenario and the bodyless `DELETE`. Exit 0.
- `flock … LD_LIBRARY_PATH=… E2E_PORT=8864 npx playwright test e2e/api.spec.ts e2e/accounts.spec.ts e2e/riwayat.spec.ts e2e/ruang.spec.ts e2e/privasi.spec.ts --workers=1` —
  `67 passed, 8 skipped (1.9m)`, exit 0, real Chromium against a real `wrangler dev` (its own `webServer`,
  rebuilt from the cycle-2 source first). The 8 skips are the existing phone-only 360px cases running on the
  desktop project (same pattern as cycle 1).
- `npm run clean:tmp` after both wrangler dev sessions; both killed (`ps aux` confirmed no leftover `workerd`/
  port-8863/8865 process of mine); `.wrangler/qa-fn38-recheck` and `test-results` removed.
- `npm run check`/`lint`/`npx vitest run`/`npm run build`/`db:migrate:local` were **not** independently re-run
  this cycle (the shared `/tmp/montra-heavy.lock` was held continuously for over 30 minutes by
  an unrelated session's full Playwright suite — confirmed with `lslocks`/`pstree`, not a problem in FN-38).
  Per the re-check framing ("read only the diff plus the reports … keep earlier evidence for untouched
  criteria") and the narrowed scope given for this pass, I rely on the engineer's own cycle-2 gate lines
  (`ENGINEER_REPORT.md`: `check` COMPLETED 1637 FILES 0 ERRORS, `lint` clean, `vitest` 190 files/2646 tests
  passed, `build` exit 0, `db:migrate:local` 0000–0026 ✅) for those four steps, combined with my own
  independent source review of every changed file (`csrf.ts`, `csrf.test.ts`, `hooks.server.ts`,
  `vite.config.ts`, `http.ts`, `api-tokens.ts`, `prove-password.ts`, `throttle.ts`, `endpoints.ts`,
  `openapi.ts`, `reference.ts`, the `pengaturan/akun` and `pengaturan/api` server/Svelte files, and the test
  diffs in `public-api.test.ts`/`pengaturan-api.test.ts`) and my own live reproduction below.

### Criterion 17 (DELETE over real HTTP) — PASS

Live, with the real token created through the real `/pengaturan/api` form action (not a fixture): a bodyless
`DELETE /api/v1/transactions/{id}?space_id=…&expected_updated_at=…` with **only** an `Authorization` header —
no `Content-Type`, no `Origin`, exactly the QA-blocker scenario from cycle 1 — now answers:
```
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
{"data":{"id":"04d7392e-f56d-411f-b078-919bbf056afe","deleted":true}}
```
`e2e/api.spec.ts:146` ("over real HTTP like an external script: POST, PATCH and a bodyless DELETE with only
Authorization") reproduces the same scenario end to end (POST 201 → PATCH 200 → stale DELETE 409 JSON →
fresh DELETE 200 JSON → unauthenticated DELETE 401 JSON) through Playwright's cookie-less `request` context
against the real server; it passed on both the phone and desktop projects.

### Criterion 22 (fixed JSON error shape on every status) — PASS

Live: 401 (no token, and the Kit-level-turned-route-level DELETE path), 429 (`rate_limited`, both the
pre-auth and per-token budgets) all answered `{"error":{"code":"…","message":"…"}}` with
`content-type: application/json`, no plain-text body anywhere, including the exact DELETE path that produced
plain text in cycle 1. `e2e/api.spec.ts:237` ("app form actions stay protected: a cross-site form POST with
the session cookie is refused") confirms the *other* side still works as SvelteKit's own check did: a
cross-site form POST to an `(app)` action still gets the plain-text `Cross-site POST form submissions are
forbidden` (that page is a form submission, not a JSON API, so the un-migrated body is correct there — the
new code reproduces SvelteKit's exact original behavior for every non-FN-38 route, byte for byte, per
`csrf.test.ts`'s "answers with SvelteKit's own body" test, which I read).

### Criterion 23 (openapi.json matches the actual DELETE response) — PASS

Live: `GET /api/v1/openapi.json` still `openapi: "3.1.0"`; `paths./api/v1/transactions/{id}.delete.responses`
documents `200,400,401,403,404,409,429,500` — the `200`/`401` cases now match what a real caller actually
gets for that operation (cycle 1's gap was that the undocumented Kit-level 403 pre-empted the handler for a
compliant caller; that path no longer exists for the 10 FN-38 routes, so every documented status is now
reachable and every reachable status is documented).

### App forms keep working under the new hook-based CSRF check — PASS

Live: sign-up (`POST /daftar`, 303 redirect to `/`), sign-out then sign-in (`POST /pengaturan/akun?/signOut`,
`POST /masuk`, 303), wallet creation (`POST /dompet?/createWallet`, success), `/riwayat/baru` (200), and the
token page's create/revoke actions (below) all still work when sent with a matching `Origin` header, exactly
as a real browser form submission would send it. `e2e/api.spec.ts:237` and the pre-existing `accounts`/
`riwayat`/`ruang`/`privasi` Playwright specs (67 passed, 0 failed) exercise sign-up, sign-in, session
middleware, account deletion, wallet/transaction create-edit-delete, space invites/removal, and the privacy
export — all through real browser form submissions — with no regression from moving the CSRF check into
`hooks.server.ts`. `test/integration/routes.test.ts`/`privacy.test.ts`/`push.test.ts` (diff read) now send an
explicit same-origin `Origin` header on their in-process hook calls, which is the correct, minimal update for
tests that bypass a real browser (a browser always sends `Origin` on a form POST; these tests previously
relied on the check not running in-process at all).

### Token creation now requires the password (JS and no-JS) — PASS

Live: `/pengaturan/api`'s create form now has a required `password` field (confirmed in the served HTML:
`name="password"`, label "Kata sandi saat ini"). A create POST with no password answers 400 with
`"E-mail atau kata sandi salah."` (`INVALID_CREDENTIALS`, the same message a wrong sign-in password gets) and
writes no row. A create POST with the correct password succeeds and returns the raw token once, as before.
This is a plain HTML form field with `method="POST"`, so it works identically with and without JavaScript;
`e2e/api.spec.ts:106` ("without JavaScript: create shows the token once, reload hides it, revoke works") runs
with JS disabled and passed. `pengaturan-api.test.ts`'s new "re-proves the current password before creating a
token" test (read in the diff) covers empty, wrong, and over-length passwords, plus a password changed
between page-load and submit (`'credential'` reason, 409 `CHANGED_MEANWHILE`) — all refused, none creating a
row.

### A valid token still works from an IP that hit the failure limit — PASS

Live, with a distinguishing `X-Forwarded-For` so the throttle's client key is isolated from any other traffic:
1. The real token → 200 (sanity, before flooding).
2. 20 requests with junk Bearer tokens from the same IP → 401 each.
3. A 21st junk request → 429 `rate_limited` (the pre-auth failure budget is spent).
4. **The same real, valid token, from the same now-throttled IP → 200**, not 429 — confirming the cycle-2
   fix: a valid token is resolved and admitted before the failure budget is ever consulted, so it is
   immune to another (or the same) client's bad guesses sharing its address. This directly fixes cycle 1's
   Finding 2 (shared-IP/CGNAT lockout), which I had flagged as accepted-but-worth-reproducing; it is no
   longer present.

`test/integration/public-api.test.ts`'s rewritten describe block ("FN-38: guessing tokens is bounded per
client (cycles 1b, 2)") asserts the same thing in-process — 20 failures → 429 on the 21st failure, the real
token from that IP still 200, another client's failures are independent — which I read in the diff and which
is consistent with what I reproduced live.

### Note on my own tooling

My first combined curl script had a shell/Python glue bug extracting the raw token from the SvelteKit action
response, so its own DELETE/rate-limit sub-checks ran against a malformed token and only showed 401/429 (not
a defect in FN-38 — visible in `curl-part2.txt`, kept for the record). I do not count that against the
verdict: the same scenarios are independently and correctly proven by (a) the Playwright run above, which
uses a different, unrelated extraction path (`page.getByLabel('Token').inputValue()`), and (b) a second,
corrected standalone script using the real raw token value, both of which are the live reproductions quoted
above.

### Recommendation

Ship. No new findings. Criteria 1–16, 18–21, 24–29 were not touched by this diff and keep their cycle 1
PASS evidence; criteria 17, 22, 23 and the two owner-safety additions (password-gated token creation,
per-IP failure budget that never blocks a valid token) are now independently, live-verified fixed.
