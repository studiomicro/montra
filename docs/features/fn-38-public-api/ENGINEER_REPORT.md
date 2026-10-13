# FN-38 Public API — engineer report (cycle 1)

Branch `fn-38-public-api` (from main a019757). Owner defaults applied: 90-day default expiry (30/90/365 offered, no
"never"), max 10 live tokens per user, no plan gating, 300 requests / 10 min per token, scopes `read` / `read_write`,
docs page behind sign-in, raw `openapi.json` public.

## What was built

- Migration `migrations/0026_api_tokens.sql` + `apiTokens` in `src/lib/server/db/schema.ts` (journal idx 24, tag
  `0026_api_tokens`, snapshot `migrations/meta/0026_snapshot.json`, prevId = 0023). **Re-chain at merge** (written in
  the SQL header): after 0024 (hardening-2) and 0025 (db-normalize) land, keep the SQL file unchanged, drop this
  branch's journal entry and snapshot, re-run `npx drizzle-kit generate --name api_tokens` on top of 0025 and rename
  the output to `0026_api_tokens.sql` (its SQL must equal this one).
- `src/lib/server/auth/api-tokens.ts`: create (one guarded INSERT…SELECT: active user, < 10 live, live membership of a
  restricted space), list (live only, never the hash), revoke, `resolveApiToken` (SHA-256 + one indexed lookup for
  every input, constant-time re-compare, one 401 for unknown/malformed/revoked/expired/disabled, `last_used_at`
  touched by a guarded UPDATE at most hourly).
- `src/lib/server/auth/throttle.ts`: scope `api-request` + `overTokenAttemptLimit` (per token id, fails closed).
- `src/lib/server/api/`: `schemas.ts` (zod request/response shapes), `endpoints.ts` (routes as data incl. D1
  budgets), `http.ts` (`apiRoute`: Bearer → throttle → scope → query → `requireSpaceAccess` → JSON body; fixed error
  shape; never reads `locals.user`/cookies), `transactions.ts` (Riwayat filter via `parseRiwayatQuery`/`viewFilter`;
  writes via `readTransactionForm` + `createTransactionOnce` / `updateTransaction` / `deleteTransaction`),
  `serialize.ts`, `openapi.ts` (OpenAPI 3.1 generated with `z.toJSONSchema` from the same schemas), `reference.ts`
  (docs page view of the same document), `messages.ts`.
- Routes: `GET /api/v1/spaces`, `/wallets`, `/categories`, `/transactions` (+ `POST`), `/transactions/{id}`
  (`GET`, `PATCH`, `DELETE`), `/budgets`, `/laporan/ringkasan`, `/openapi.json`. UI: `/pengaturan/api` (+ row in
  `/pengaturan`), `/pengaturan/api/dokumentasi`.
- Validation reuse: `parseTransactionForm`/`readTransactionForm` take an optional exact `amount_minor`
  (`exactAmountError`, now shared with `capturedTransactionInput`); every other rule and message is the compose form's.
- Account deletion deletes `api_tokens`; a restricted token cascades with its space; account export writes
  `api_tokens` without `token_hash`.

## Deviations from the PRD (deliberate, flag for QA)

1. Columns `last_four` and `restricted_space_id` instead of `token_last4` / `space_id`: the export invariants
   (`export/tables.test.ts`) treat any `space_id` column as space-owned data and forbid exported column names with
   `token`. The row is a user credential, so it stays an account table.
2. Schemas/OpenAPI live in `src/lib/server/api/` (not `src/lib/shared/api/`): they need server constants
   (`MAX_AMOUNT_MINOR`, `PAGE_SIZE`) and only server code reads them (no client JS added).
3. Added `GET /api/v1/transactions/{id}`: the list rows carry no `updated_at`/`note`, and `PATCH`/`DELETE` need
   `expected_updated_at`.
4. `space_id` is a query parameter on every space route, writes included (one access path). PATCH is a partial
   update (omitted fields keep their value). A balance-adjustment row answers 400 on PATCH/DELETE (app only, as FN-02).
5. API error messages are English machine text (like other `/api/v1` routes); validation messages are the form's
   own phrases translated with the `en` table.

## Acceptance criteria

| # | Status | Evidence |
|---|--------|----------|
| 1 | met | `pengaturan-api.test.ts` "shows the raw token once"; e2e reload check |
| 2 | met | `public-api.test.ts` "restricted to one space" (byte-identical 404 to a stranger space) |
| 3 | met | "refuses a read token on every write route" (403, rows and space seq unchanged) |
| 4 | met | "same 401" across unknown/malformed/oversized/Basic/revoked/expired/disabled |
| 5 | met | "never accepts a session cookie" — all 10 handlers with `locals.user` + cookie → 401 |
| 6 | met | hook test: Bearer-only on `/(app)/riwayat` → 303 `/masuk`; `sync/push` → 401 `session` |
| 7 | met | "refuses a token revoked after it was used"; settings revoke test |
| 8 | met | 11th create → 409 `TOKEN_LIMIT` ("{n}" = 10); 20 concurrent creates → exactly 10 |
| 9 | met | statement counter: first call 2 statements, second 1 (no write), after 1 h 2 again |
| 10–12 | met | every route through `admitSpace` → `requireSpaceAccess`; two users, restricted, removed member tests |
| 13 | met | API rows/totals equal `listTransactionsByDay`/`periodTotals` for 5 filters; listed rows sum to the total |
| 14 | met | integer `amount_minor` + ISO currency everywhere; float/string amounts refused |
| 15 | met | 23:30 WIB on a month's last day → `occurred_at` 16:30Z same date, in that month's summary and list only |
| 16 | met | same `client_id` twice → same id, 1 row; 20 concurrent → 1 row; deleted id → 409 `gone`, not recreated |
| 17 | met | stale PATCH/DELETE → 409 `stale`, row byte-identical; current → 200 + newer `updated_at` |
| 18 | met | wallet/amount/too-large/transfer-currency/type cases answer the form's own messages |
| 19 | met | pages of 3 across an insert: 7 unique ids, no repeat/skip; bad cursor/limit/period → 400 |
| 20 | met | 300th request 200, 301st 429 + Retry-After; other token unaffected; injected D1 failure → 429 |
| 21 | met | statement counter per route ≤ `maxD1Queries` (8–16 incl. 2 for the hook's session lookup) |
| 22 | met | 400/401/403/404/409/413/415/429/500 all `{error:{code,message,fields?}}`; injected D1 error → generic 500 |
| 23 | partly | `openapi.test.ts` structural checks (3.1.0, every route both ways, $refs resolve, English); **not run through an official OpenAPI validator** (none installed). Docs page loads no third-party script (e2e) |
| 24 | met | `test/i18n-coverage.test.ts` passes with 117 new English entries |
| 25 | met | loading (Skeleton on retry), empty "Belum ada token", saving "Memproses…", success (token once), error (ErrorState / banner) |
| 26 | met | e2e: no horizontal scroll at 360 px in light and dark; buttons and links ≥ 44 px |
| 27 | met | no id lists bound per item (only `json_each` reuse inside existing repos) |
| 28 | met | fail-before mutation runs below |
| 29 | partly | gates run step by step (owner RAM rule), not as `npm run gates` |

## Fail-before proof (mutations, each restored afterwards)

```
criterion 2 restriction: mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 4 revoked/expired: mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 5 cookie (locals.user accepted): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 6 token on app route (gate reads Bearer): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 16 idempotent (createTransaction instead of Once): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 17 stale (current.updatedAt passed): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 20 fail closed (failClosed returns false): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
criterion 20 limit (throttle skipped): mutated -> exit 1 :: Tests 1 failed | 25 skipped (26)
```

## Pre-handoff probes

- Concurrency: 20 concurrent token creates → exactly 10 live (cap holds); 20 concurrent POSTs of one `client_id` → 1 row.
- Two tabs / stale: PATCH/DELETE with an old `expected_updated_at` → 409, nothing changed.
- Cross-space: every new route crawled with another user's token, a restricted token and a removed member's tokens → identical 404, 0 rows written; `/spaces` hides the space.
- Revoked / expired / disabled user: identical 401 body and status to an unknown token.
- Scope: read token on POST/PATCH/DELETE → 403 before any read or write.
- Cookie-only: all 10 handlers → 401. Token on app route: 303 `/masuk`; on `sync/push`: 401.
- Idempotent replay: same id both times; deleted row never recreated; another space's id → 409 `gone`.
- Pagination under inserts: no repeat, no skip.
- Rate limit: 301st request in the window → 429 + Retry-After; fails closed on a D1 error.
- Malformed/huge bodies: form type 415, broken JSON 400 `invalid_json`, array 400, 9 KB 413, `__proto__` body 400 with no prototype change.
- Timing of token compare: every presented value costs one SHA-256 and exactly 1 D1 statement (measured); stored hash re-compared in constant time. Wall-clock timing not asserted.
- Month boundaries: 23:30 WIB on the last day stays in its month (list and Laporan summary).
- Money vectors: n/a (the API takes integer `amount_minor`, no text parsing).
- 360 px: e2e `e2e/api.spec.ts` (phone project 360×780) — see gate lines.
- No-JS forms: create/revoke are plain `method="POST"` actions; not run without JavaScript.
- User copy: no error body contains a path, SQL text or stack (asserted).

## Gate lines (run separately, `flock /tmp/montra-heavy.lock`)

- `npm run check`: `COMPLETED 1581 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS` (tsc service worker / jobs / inbound clean).
- `npm run lint`: `All matched files use Prettier code style!`, eslint no output (clean).
- `npx vitest run --maxWorkers=2`: `Test Files 184 passed (184)`, `Tests 2604 passed (2604)`.
- `npm run build`: exit 0 (`✔ done`).
- `npm run db:migrate:local` on a fresh persist dir: 0000–0023 and `0026_api_tokens.sql` ✅, exit 0.
- Playwright `e2e/api.spec.ts --workers=1`: `5 passed (15.6s)` (setup + phone 360×780 + desktop; light and dark screenshots under `test-results/port-8838/`)

## Not verified / open

- No official OpenAPI 3.1 validator run (structural test only).
- Changing the password does not revoke API tokens (sessions are revoked). Owner decision whether it should.
- Unauthenticated requests are not throttled per client (each costs one hash + one indexed read); CORS is not enabled.
- No real native-app or third-party client exercised; remote D1 untouched.

## Cycle 1b (before QA)

- **Rebased** onto main 07ea016. The journal and snapshot were regenerated after 0025: `0026_api_tokens` is journal idx 26 and its snapshot `prevId` is 0025's id. The SQL is identical to cycle 1 (only the header comment changed). A second `drizzle-kit generate` reports "No schema changes". Resolved `throttle.ts`: kept both `transaction-create` and `api-request`. i18n, export and delete-account merged without conflicts.
- **Password change revokes every API token** of the user. This happens in the same guarded `db.batch` as the other-session revocation (`auth/change-password.ts`, only if the change commits). The app has no "sign out everywhere" action. The token page and the docs limits text say so. Tests in `pengaturan-api.test.ts`: all of the user's tokens are revoked, other users' tokens keep working, and a refused change revokes nothing.
- **Per-client budget for requests without a valid token:** 20 per 10 minutes, scope `api-auth`, keyed by IP (IPv6 by /64) through the existing throttle helper.
  - A new read-only `attemptLimitReached` runs before any token lookup, at a cost of one indexed read. Each 401 then counts one failure through `overAttemptLimit`.
  - On a D1 error it fails closed. `BASE` in the D1 budget is now 9.
  - Tests: after 20 failures, the 21st request gets 429 with Retry-After, even with a valid token, and runs exactly 1 statement (no lookup). Another client is unaffected, and 25 valid requests from one client are never limited.
- **OpenAPI 3.1 validation:** added `@seriousme/openapi-schema-validator` **2.11.0** (exact pin, devDependency only; last published 2026-09-25). `npm audit`: no advisory for it or its dependencies (ajv 8.20.0, ajv-formats 3.0.1, ajv-draft-04 1.0.0, yaml 2.9.1). The 8 existing advisories are all in the wrangler/esbuild/drizzle-kit/sharp chain. `openapi.test.ts`: our document validates as 3.1 with no errors, and a document without `info` is rejected.
- **JavaScript off** (`e2e/api.spec.ts`, phone and desktop): creating a token shows it once and it works as Bearer. After a reload it is gone from the page and the row shows only `…last4`. Revoking shows "Token dicabut", and the token then gets 401.

### Gate lines (cycle 1b, each step separately under the lock)

- `npm run check`: `COMPLETED 1634 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0
- `npm run lint`: `All matched files use Prettier code style!`, eslint clean, exit 0
- `npx vitest run --maxWorkers=2`: `Test Files 189 passed (189)`, `Tests 2638 passed (2638)`
- `npm run build`: exit 0
- `npm run db:migrate:local` (fresh persist dir): 0000–0026 ✅, exit 0
- Playwright `e2e/api.spec.ts e2e/accounts.spec.ts --workers=1`: `31 passed, 6 skipped` (the existing phone-only cases on desktop)
- `npm run clean:tmp` done; no servers left running.

## Cycle 2 (QA FAIL + red team lows)

- **QA blocker, real `DELETE` refused by SvelteKit's CSRF check.** SvelteKit 3 has a single CSRF option, `csrf.trustedOrigins` (https://svelte.dev/docs/kit/configuration#csrf). `checkOrigin` was removed in 3.0, and `['*']` is the documented way to switch the check off. It has no per-route exemption (verified in `@sveltejs/kit` 3.0.1 `runtime/server/csrf.js` and `respond.js`). The check runs before any hook and answers in plain text, so neither of the other two options could guarantee the fixed JSON error shape on our routes. Fix:
  - `vite.config.ts` sets `csrf.trustedOrigins: ['*']`.
  - The new `src/lib/server/csrf.ts` applies SvelteKit's exact rule (POST/PUT/PATCH/DELETE; no Content-Type or a form type including `application/x-sveltekit-formdata`; Origin ≠ self) and returns SvelteKit's exact 403 body.
  - `hooks.server.ts` runs it first, for every route except the 10 FN-38 Bearer-only routes (route ids taken from `ENDPOINTS`).
  - SvelteKit's separate remote-function guard is untouched.
  - Tests:
    - `csrf.test.ts`: method × type × origin vectors, the exempt route list, SvelteKit's body.
    - Hook integration in `public-api.test.ts`: a cross-site form POST, a multipart POST without Origin and a POST with no Origin and no Content-Type to `/(app)/pengaturan/api` → 403, never reaching the action. `/api/v1/sync/push` is still guarded. A bodyless, Origin-less DELETE reaches the Bearer route.
    - e2e over real HTTP: a cookie-less Playwright `request` context sends POST 201, PATCH 200, a bodyless DELETE with a stale `expected_updated_at` → 409 JSON, then the real DELETE 200, and an unauthenticated DELETE → 401 JSON. A cross-site form POST with the session cookie to `?/create` and an Origin-less POST to `?/revoke` → 403 "Cross-site POST form submissions are forbidden", and no token is created.
  - Three existing in-process hook tests (`routes`, `privacy`, `push`) sent Origin-less POSTs. They now send the same-origin `Origin` a browser sends; in production those requests were already stopped by SvelteKit's check before the gate.
  - Fail-before for the blocker: QA's curl repro (QA_REPORT Finding 1).
- **Red team L1:**
  - The token is now looked up first (constant work).
  - Only failed requests count against the client (`api-auth`, 20 per 10 min, IP or IPv6 /64).
  - Only a failing request is refused (429) once the client is over the limit. A valid token keeps working from that address (tested).
  - Tokens are 256 random bits (`fin_` + 32 bytes base64url), so guessing is infeasible anyway; the budget only bounds lookup load.
  - The read-only `attemptLimitReached` helper from cycle 1b was removed. `overAttemptLimit` gained an optional `max`.
- **Red team L2:** creating a token needs the current password.
  - `proveCurrentPassword` was moved from the akun page to `src/lib/server/auth/prove-password.ts` and is shared. It keeps the per-client and per-user budgets and the lockout.
  - `createApiToken` takes the proven hash and joins `user_passwords` on it, so a password changed in between writes nothing (`credential`).
  - Tests: empty, wrong and over-long passwords → 400 `INVALID_CREDENTIALS` and no token; a stale hash → `credential`. Both e2e create flows (with and without JavaScript) fill the password field.
- **Red team L3:** `x-financer-max-d1-queries` and `maxD1Queries` are gone from `ENDPOINTS`, `openapi.json` and the docs page. The budgets now live in a test-only `D1_BUDGET` map in `public-api.test.ts`, still asserted per route. `openapi.test.ts` asserts no D1 or budget key is in the public document.

### Gate lines (cycle 2, each step separately under the lock)

- `npm run check`: `COMPLETED 1637 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`, exit 0
- `npm run lint`: exit 0 (Prettier clean, eslint clean)
- `npx vitest run --maxWorkers=2`: `Test Files 190 passed (190)`, `Tests 2646 passed (2646)`
- `npm run build`: exit 0
- `npm run db:migrate:local` (fresh persist dir): 0000–0026 ✅, exit 0
- Playwright `--workers=1` for api, accounts, security, riwayat, ruang, offline-queue and account-key: `98 passed, 3 failed, 8 skipped`. All 3 failures were in `api.spec.ts` on desktop: `getByLabel('Nama')` also matched the space `<select>` once the ruang spec had created a space. Switched to role locators, then reran `ruang.spec.ts` + `api.spec.ts`: `23 passed, 2 skipped`. Skips are the existing phone-only cases.
- `npm run clean:tmp` done; no servers left running.
