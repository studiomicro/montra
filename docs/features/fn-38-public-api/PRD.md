# FN-38 — Public API

Risk tier: **Large** (new authentication surface + new external, pre-authentication input on every request;
CLAUDE.md requires the senior-software-engineer to treat this tier with the full review and the red-team pass
before `/ship`).

## Goal

MONTRA currently has no way for the owner's own scripts, or the future native app (FN-33), to read or write a
space's data without a browser session. This closes that gap with a small, versioned, token-authenticated REST
API: enough to script reports, feed a personal dashboard, or let a native app shell talk to the same ledger the
web app uses, without re-implementing any validation, money or space-access rule. It is deliberately narrow —
read-mostly, transactions-only for writes, no billing or account surface — so it cannot become a second,
inconsistent way to change the parts of the product that already have careful rules (sharing, deletion, billing,
AI).

## Scope (v1)

- **New D1 migration `migrations/0026_api_tokens.sql`** adding one table, `api_tokens`, modelled on `sessions`
  (`src/lib/server/db/schema.ts:86-100`) and `connected_apps` (`src/lib/server/db/schema.ts:1131-1151`):
  - `id`, `user_id` (→ `users.id`), `name` (user-given label, ≤ 60 chars), `token_hash` (SHA-256 hex, unique,
    looked up the same way `resolveSession` looks up a session: `src/lib/server/auth/session.ts:102-125`),
    `token_last4` (plaintext, for display only — the same "mask to last 4" convention CLAUDE.md already applies
    to account/card numbers), `scope` (`'read' | 'read_write'`), `space_id` (nullable → `spaces.id`; null means
    "every space this user is a live member of"), `expires_at` (not null — see Owner decisions), `revoked_at`,
    `last_used_at`, `created_at`, `updated_at`.
  - No `deleted_at`/sync `seq`: this is a user-level credential like `sessions`/`auth_attempts`, not space-synced
    financial data, so FN-02's sync conventions do not apply to it.
  - Index on `user_id` for the management list; partial index or `WHERE revoked_at IS NULL` check as needed for
    the "live tokens" queries.
- **`src/lib/server/auth/api-tokens.ts`** (new): `createApiToken`, `listApiTokens`, `revokeApiToken`,
  `resolveApiToken(db, rawToken, now)` — the Bearer-auth equivalent of `resolveSession`
  (`src/lib/server/auth/session.ts:102-141`): hash the presented token, look up by `token_hash`, reject when
  revoked, expired, or the owning user's `status !== 'active'`; touch `last_used_at` at most once per an hour
  (mirrors `SESSION_TOUCH_MS`, `src/lib/server/auth/session.ts:15`), never on every request. One fixed-shape 401
  for "unknown token", "revoked token" and "expired token" alike (no oracle, same principle as
  `requireSpaceAccess`'s fixed 404/403 bodies, `src/lib/server/spaces/access.ts:29-30,69-71`).
- **Token management UI**: new settings page `src/routes/(app)/pengaturan/api/+page.server.ts` +
  `+page.svelte`, alongside the existing `src/routes/(app)/pengaturan/aplikasi/` and `.../akun/` pages. Lists
  live tokens (name, scope, space restriction, created, expires, last used, "Cabut"/Revoke); a create form
  (name, scope, optional space, expiry) whose success page shows the raw token **once**, with a copy button and
  an explicit "won't be shown again" notice (same pattern FN-21 already uses for one-time secrets); states:
  loading, empty ("Belum ada token"), saving, success, error, and the list after revoke. Reached from
  `/pengaturan` the same way `/pengaturan/aplikasi` is.
- **A docs page** `src/routes/(app)/pengaturan/api/dokumentasi/+page.svelte`: a plain, hand-built reference
  (endpoints, params, examples) rendered from the same data the OpenAPI document holds — no third-party
  Swagger/Redoc bundle (keeps the authenticated-shell JS budget and avoids a CSP exception). Links to the raw
  spec.
- **`GET /api/v1/openapi.json`** (new `+server.ts`, no auth required — the spec itself holds no secret):
  OpenAPI 3.1 document describing every route below.
- **New Bearer-authenticated routes, all under `src/routes/api/v1/`**, each a new `+server.ts` next to the
  existing `health`, `track`, `sync/push`, `billing/webhook`, `dev/ping` ones
  (`src/routes/api/v1/health/+server.ts:1`, `src/routes/api/v1/sync/push/+server.ts:1`):
  - `GET /api/v1/spaces` — the caller's live spaces (id, kind, name, role), same shape `resolveCurrentSpace`
    already computes (`src/lib/server/spaces/access.ts:79-101`).
  - `GET /api/v1/wallets?space_id=` — reuses `listWallets` (`src/lib/server/wallets/repo.ts:72-80`).
  - `GET /api/v1/categories?space_id=` — reuses `listCategories`/`ensurePresetCategories`
    (`src/lib/server/categories/repo.ts`).
  - `GET /api/v1/transactions?space_id=&cursor=&limit=&type=&category_id=&wallet_id=&from=&to=&q=` — reuses the
    existing keyset-cursor query (`src/lib/server/transactions/aggregate.ts:238,315-325`), the same cursor shape
    Riwayat's "Muat lebih banyak" already uses — no second pagination design.
  - `GET /api/v1/budgets?space_id=` — reuses `getActiveBudget` (`src/lib/server/budgets/repo.ts:24-35`).
  - `GET /api/v1/laporan/ringkasan?space_id=&bulan=YYYY-MM` — reuses `laporanReport`
    (`src/lib/server/reports/laporan.ts`, called today from `src/routes/(app)/laporan/+page.server.ts:15`) for
    one month's summary (totals in/out, per-category, comparison) — not the full Laporan payload, just the
    month-summary numbers the owner asked for.
  - `POST /api/v1/transactions` (`scope: read_write`) — body carries a `client_id` (the same role FN-02's
    `clientId` plays today) plus the compose-form fields; reuses `parseTransactionForm`'s validated shape via
    `resolveTransactionInput` and `createTransactionOnce`
    (`src/lib/server/transactions/client-id.ts:19-35`, `src/lib/server/transactions/validation.ts:246-273`) so a
    resend of the same `client_id` never double-writes, exactly like the web compose form and the FN-02 queue.
  - `PATCH /api/v1/transactions/:id` (`scope: read_write`) — body carries `expected_updated_at` (the row's
    `updatedAt` the caller last read) and reuses `updateTransaction`
    (`src/lib/server/transactions/repo.ts:318-361`); a mismatch answers 409, mirroring the `'stale'` result the
    edit form already handles.
  - `DELETE /api/v1/transactions/:id?expected_updated_at=` (`scope: read_write`) — reuses `deleteTransaction`
    (`src/lib/server/transactions/repo.ts:367-397`), same 409-on-stale rule.
- **i18n**: every new user-facing string (token list/empty/create/revoke/error states, the docs page's labels,
  the few API error messages that reach a human — not raw API JSON bodies, which are English/machine text by
  convention like every other `/api/v1/*` route today) gets a `tr()` entry in `src/lib/shared/i18n.ts` and an
  English one in `i18n-en.ts`.
- **Throttle**: a new scope added to `THROTTLE_SCOPES` (`src/lib/server/auth/throttle.ts:20-31`), e.g.
  `'api-request'`, counted per token id (a new `overTokenAttemptLimit` alongside `overUserAttemptLimit`,
  `src/lib/server/auth/throttle.ts:164-177`) so one leaked or misbehaving token cannot exhaust another token's
  budget.

## Out of scope

- No session-cookie acceptance anywhere under the new routes, and no Bearer-token acceptance on any `(app)`
  route or existing `/api/v1/*` route — see Architecture notes for exactly why this needs an explicit check.
- No billing, plan change, voucher, invite, space-create/delete, member-management, account-deletion, export,
  connected-app, Gmail, receipt/statement/spreadsheet, assistant, agent, net-worth, subscriptions, belongings or
  collectibles endpoints. Only spaces (read), wallets (read), categories (read), budgets (read), one Laporan
  summary (read), and transactions (read + create/edit/delete).
- No webhook or push delivery to third parties (no "API key calls out to your server" feature) — this is an
  inbound API only.
- No per-resource or per-field scopes beyond `read` / `read_write` in v1.
- No GraphQL, no batch/bulk write endpoint, no server-sent events or websockets.
- No interactive API explorer (Swagger UI/Redoc) — a static docs page and the raw `openapi.json` only.
- No change to how the existing internal `/api/v1/health`, `/api/v1/track`, `/api/v1/sync/push`,
  `/api/v1/billing/webhook` or `/api/v1/dev/*` routes authenticate; they keep using the session cookie, no auth,
  webhook signature, or the dev gate, exactly as today.

## Relationship to the existing `/api/v1/*` routes

`src/lib/server/auth/gate.ts:13-19` already documents that `/api/v1/*` lives outside the `(app)` route group, so
`isProtectedRoute` never gates it and `hooks.server.ts` never populates `event.locals.space` for it
(`src/hooks.server.ts:71-78`). But `authGate` **does** unconditionally resolve any session cookie present into
`event.locals.user` for every request, API routes included (`src/hooks.server.ts:65-67`,
`src/lib/server/auth/gate.ts:46-59`) — today's `sync/push` and `track` routes rely on exactly that
(`src/routes/api/v1/sync/push/+server.ts:29`, `src/routes/api/v1/track/+server.ts:25`).

This matters for FN-38: the owner's instruction is that these new routes must **never accept a session cookie**.
That means the new route handlers must not read `event.locals.user` at all (even though it may be populated from
a cookie) — they authenticate solely from the `Authorization: Bearer <token>` header via `resolveApiToken`.
Symmetrically, no existing `(app)` route or form action must accept an API token: they keep reading
`event.locals.user`/`event.locals.space` as today and never parse an `Authorization` header. The two auth
schemes stay fully disjoint by construction (different lookup table, different header vs. cookie, no shared
code path), not by a flag that could be flipped on the wrong route.

`billing/webhook` remains the model for "authenticated by something other than a session, and must say so in a
comment" (`src/routes/api/v1/billing/webhook/+server.ts:9-13`); the new routes follow the same documentation
discipline. `dev/ping` remains dev-only and gated by `devRoutesEnabled` (`src/routes/api/v1/dev/ping/+server.ts`)
and is unrelated to FN-38.

## Acceptance criteria

Numbering follows ENGINEERING_CHECKLIST.md categories so QA can cross them off directly.

**Auth and tokens**
1. Given a signed-in user on `/pengaturan/api`, when they create a token with a name, a scope and no space
   restriction, then the raw token is shown exactly once on that response, a `token_last4` and metadata row
   appears in the list on reload, and the raw value is never retrievable again from any UI or API response.
2. Given a token restricted to space A, when it is sent on a request naming space B, then the request is refused
   with the same fixed-shape 403/404 `requireSpaceAccess` already gives a non-member (`src/lib/server/spaces/access.ts:48-72`)
   — the token never sees whether space B exists.
3. Given a `read`-scope token, when it is sent to any `POST`/`PATCH`/`DELETE` route, then the request is refused
   (403) before any D1 write happens.
4. Given a revoked token, an expired token, and a token whose user is `status = 'disabled'`, when any is sent,
   then each gets the same fixed 401 body as an unknown token — no response distinguishes "revoked" from
   "expired" from "never existed" (no oracle, per the checklist's "Access and privacy" item).
5. Given a request with a valid session cookie and no `Authorization` header, when it hits any FN-38 route, then
   it is refused 401 exactly as an unauthenticated request would be — the cookie is never consulted.
6. Given a request with a valid Bearer token, when it hits any `(app)` page or form action, or any of the five
   pre-existing `/api/v1/*` routes, then the token is ignored and the request is treated as unauthenticated by
   those routes (they still only understand the session cookie / webhook signature / dev gate).
7. Given the user revokes a token in `/pengaturan/api`, when a request already in flight with that token's value
   reaches the server afterward, then it is refused 401.
8. Given a token nearing `max tokens per user` (Owner decision), when the user tries to create one more, then
   creation is refused with a clear message naming the limit, not a generic error.
9. `last_used_at` updates at most once per hour per token (verified by two rapid calls producing one write), and
   is visible in the management list.

**Space access and data correctness**
10. Every new route resolves the caller's space the same way every `(app)` load/action does: a `space_id` the
    request names is passed to `requireSpaceAccess(db, tokenUserId, spaceId, …)`
    (`src/lib/server/spaces/access.ts:48-72`) — never trusted, never substituted from a cookie (there is none).
11. Given two users in two different spaces, when user A's token requests user B's space's wallets, categories,
    transactions or budgets, then the response is the same 404 a non-member gets from the web app.
12. Given a removed member's token (the user left or was removed from a shared space after the token was
    created), when it is used against that space, then every call is refused exactly as a removed member's
    browser session already is.
13. `GET /api/v1/transactions` filters (type, category, wallet, date range, text) produce the same rows and
    totals as the equivalent Riwayat filter for the same space and period (totals reconcile, per the checklist).
14. Money in every response is an integer `amount_minor` plus an ISO 4217 `currency`; no endpoint ever returns or
    accepts a float amount.
15. `occurred_on` in every response is the WIB calendar date (never derived from the UTC instant); a transaction
    created through `POST /api/v1/transactions` with `occurred_on` = the WIB date of 23:30 WIB on the last day of
    a month lands in that month's Laporan summary and Riwayat list, not the next month's.
16. `POST /api/v1/transactions` with the same `client_id` sent twice (simulating a retried request) creates
    exactly one transaction, returns the same id both times, and never recreates a transaction whose id was
    since deleted (same rule as FN-02's `createTransactionOnce`,
    `src/lib/server/transactions/client-id.ts:19-35`).
17. `PATCH`/`DELETE /api/v1/transactions/:id` with a stale `expected_updated_at` is refused 409 and changes
    nothing (mirrors `TransactionWriteResult = 'stale'`, `src/lib/server/transactions/repo.ts:39`); with the
    current value it succeeds and the new `updated_at` is returned.
18. Every write validation error (bad amount, unknown wallet/category, wrong currency, transfer attempted
    through this surface's category rules, etc.) reuses the exact messages/codes `src/lib/server/transactions/validation.ts`
    already produces for the web form — no second, drifted validation.

**Pagination, rate limits, errors**
19. `GET /api/v1/transactions` pagination uses the same keyset cursor as `listTransactionsByDay`
    (`src/lib/server/transactions/aggregate.ts:238,315-325`): requesting with the `next_cursor` from a page never
    repeats or skips a row, including across a concurrent insert (checklist's "Concurrent writes"/"Two devices").
20. A caller exceeding the per-token rate limit (Owner decision default below) gets 429 with a `Retry-After`
    header, exactly as `sync/push` already answers over-budget (`src/routes/api/v1/sync/push/+server.ts:32-35`),
    and the throttle fails closed (the whole request is refused, never silently unthrottled) on a D1 failure, per
    `failClosed` (`src/lib/server/auth/throttle.ts:137-140`).
21. Every list endpoint is bounded (a `limit` capped the same way `PAGE_SIZE`/`MAX_WALLETS_PER_SPACE`/
    `MAX_CATEGORIES_PER_SPACE` already bound their lists) and uses no more than a small, fixed number of D1
    queries per request — documented per endpoint so the Cloudflare D1 Paid-plan 1,000-queries-per-invocation
    cap (https://developers.cloudflare.com/d1/platform/limits/) is never approached by one call.
22. Every error response (400/401/403/404/409/413/415/429) is JSON with a stable `{ "error": { "code", "message" } }`
    shape; no response body ever contains a file path, SQL text, or stack trace (checklist's "User copy" item).
23. `GET /api/v1/openapi.json` validates as OpenAPI 3.1 and documents every route, parameter, response shape and
    error code above; the docs page at `/pengaturan/api/dokumentasi` renders without any third-party JS bundle
    and stays inside the existing authenticated-shell JS budget.

**i18n and UI**
24. Every Indonesian string the token-management and docs pages show has an English counterpart in `i18n-en.ts`;
    the existing "a phrase without an English entry fails a test" check catches any miss.
25. `/pengaturan/api` shows loading, empty ("Belum ada token"), saving, success (token-shown-once) and error
    states, and only shows a token as created after the server confirms the write.
26. 360 px layout, 44 px touch targets, no horizontal scroll on `/pengaturan/api` and its create/detail views.

**Cross-cutting (ENGINEERING_CHECKLIST.md)**
27. 101+ space/wallet/category ids are never interpolated as individual bound parameters anywhere in the new
    code (the JSON `json_each` pattern already used by `insertTransactions`,
    `src/lib/server/transactions/repo.ts:230-251`, is reused wherever a list of ids is needed).
28. A fail-before regression test exists for each of criteria 2, 4, 5, 6, 16, 17 and 20 (shown failing on the
    pre-fix code, per the checklist's "Fail-before proof").
29. `npm run gates` is clean on the change.

## Architecture notes

- **Migration**: `migrations/0026_api_tokens.sql` — new `api_tokens` table only (see Scope). Re-runnable,
  `db:migrate:local` first; remote apply only through `wrangler d1 migrations apply` with a Time Travel bookmark
  taken first, per the existing convention noted for 0021–0023 in `docs/TASKS.md`.
- **Server modules** (new): `src/lib/server/auth/api-tokens.ts` (create/list/revoke/resolve, modelled on
  `src/lib/server/auth/session.ts`), `src/lib/server/auth/api-auth.ts` or similar (the `+server.ts` helper that
  reads the `Authorization` header, calls `resolveApiToken`, and enforces scope + optional space restriction
  before the route's own `requireSpaceAccess` call), `src/lib/shared/api/openapi.ts` (the OpenAPI document as
  data, consumed by both `/api/v1/openapi.json` and the docs page so they cannot drift apart).
- **Reused, unchanged, modules**: `src/lib/server/spaces/access.ts` (`requireSpaceAccess`, `isLiveMember`),
  `src/lib/server/transactions/{validation,repo,client-id,aggregate}.ts`, `src/lib/server/budgets/repo.ts`,
  `src/lib/server/categories/repo.ts`, `src/lib/server/wallets/repo.ts`, `src/lib/server/reports/laporan.ts`,
  `src/lib/server/auth/throttle.ts` (extended with one new scope, not redesigned), `src/lib/server/util.ts`
  (`sha256Hex`, `randomToken`, `newId`).
- **Routes** (new): `src/routes/api/v1/spaces/+server.ts`, `.../wallets/+server.ts`, `.../categories/+server.ts`,
  `.../transactions/+server.ts` + `.../transactions/[id]/+server.ts`, `.../budgets/+server.ts`,
  `.../laporan/ringkasan/+server.ts`, `.../openapi.json/+server.ts`; `src/routes/(app)/pengaturan/api/+page.server.ts`
  + `+page.svelte` + `dokumentasi/+page.svelte`.
- **Worker**: the app Worker only — CLAUDE.md already assigns "SSR, loaders, form actions and API routes" to it;
  no new Worker, Queue or Workflow.
- **i18n**: `src/lib/shared/i18n.ts` + `i18n-en.ts` for every new UI string.

## Prerequisites

None of the credentials in `.dev.vars.example` are needed to build or test this feature — it reuses D1 and the
existing session/throttle infrastructure only; no AI Gateway, Gmail, VAPID, connected-apps encryption key or
billing secret is read by any FN-38 code path. If the docs page or any error message needs a support contact, it
reuses the existing `SUPPORT_EMAIL` / "Belum dikonfigurasi" pattern (`.dev.vars.example:4`) rather than inventing
a new one.

## Owner decisions (defaults proposed; pick one or accept the default to proceed)

1. **Token lifetime.** Proposed: creation requires an expiry; offered choices 30/90/365 days; no "never expires"
   option in v1 (a token is always revocable before then, and can be recreated). Default if unspecified: 90 days.
2. **Max tokens per user.** Proposed default: 10 live tokens. A user who needs more revokes an old one first.
3. **Plan gating (FN-30).** Proposed default: available on every plan, including Gratis — this is the owner's
   own tooling and the future native app's login path, not a paid differentiator, and FN-30's Mirror description
   never lists an API as a paid feature to match. Revisit once FN-33 ships if abuse risk changes this.
4. **Per-token rate limit.** Proposed default: 300 requests / 10-minute window per token (reuses
   `THROTTLE_WINDOW_MS`), separate from and smaller than the per-user `sync-push` budget, since a script can
   legitimately poll more often than a human submits forms.
5. **Scope granularity.** Proposed default: exactly `read` / `read_write` for v1, no finer per-resource scopes
   (e.g. "transactions:write" vs "budgets:write") — the write surface is transactions-only anyway, so a finer
   split adds complexity without a real use case yet.
6. **Docs page audience.** Proposed default: `/pengaturan/api/dokumentasi` stays behind sign-in in v1 (consistent
   with every other Settings page); `/api/v1/openapi.json` itself is unauthenticated so external tooling (or a
   future public docs mirror) can still fetch the raw spec without a session.

## Tracker impact

- `docs/TASKS.md` has no existing line for this work (it was not previously in `docs/FEATURES.md`), so FN-38
  closes nothing there; add a new line under "Phases 3 – 5 and later" (or a new "Phase 5b" block) when
  `/build-feature` starts: **"Claude — FN-38 Public API (migration 0026)."**
- `docs/ACCEPTANCE.md` has no FN-38 row (it is organised by requirement, not by FN id). This PRD's acceptance
  criteria 2, 4–6, 10–12 extend the existing "Security and privacy" row "Space isolation on every load, action
  and sync push/pull"; criteria 14–15 extend "Money and dates" rows; once FN-38 ships, add one new row per
  section (e.g. "API Bearer-token auth never accepts a session cookie, and vice versa" under Security; "API
  transaction writes reuse FN-05 validation and FN-02 idempotency" under Money and dates) rather than moving an
  existing one, since none currently names this surface.
