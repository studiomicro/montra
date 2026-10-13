# FN-41 — Integrations: per-user AI keys (BYOK) and an admin status view

Risk tier: **Large** (new migration, new per-user secret material, server-side calls to a real external provider,
a new access-control gate). Full engineer → QA → red-team pipeline.

## Goal

The owner asked for "settings to add integrations." AI capture (FN-15/16/17/19/20) and the assistant (FN-22/23)
are on hold because the owner has not supplied an Anthropic key (`docs/TASKS.md:43,100-101`). Owner decision
2026-10-09: instead of the owner paying for everyone, **each user adds their own Anthropic API key** in Settings
and pays their own AI cost (BYOK) — this unblocks a user who wants AI features today without the owner's key, and
removes a shared-cost/rate-limit problem that scales with users. A user who adds a key can be the one who tests
FN-15/16/17/19/20/22/23 once those are built; a user with no key sees exactly why the feature is unavailable. The
owner also gets a minimal, read-only admin view (gated by e-mail, `ADMIN_EMAILS`) of which **app-wide** secrets are
configured, so support/ops can tell "is this missing on staging" without reading `wrangler secret list` output or
any value.

This PRD ships: the settings page to add/replace/remove/test a personal Anthropic key, its sealed storage, the
admin status view, and the lookup helper later AI features will call. **It does not call Claude for any user-facing
feature** — no AI capture, no assistant. The only real provider call in this pass is the user-initiated "Tes
koneksi" validation of their own key.

## Scope

### User-facing: `/pengaturan/integrasi`

- New Settings page, linked from `/pengaturan/+page.svelte`'s "Aplikasi" group (new `IconRow`, icon `key` or `plug`,
  title "Integrasi AI", hint "Kunci Anthropic milikmu sendiri"), placed after "Aplikasi terhubung"
  (`src/routes/(app)/pengaturan/aplikasi/+page.svelte`) and before "API" (`src/routes/(app)/pengaturan/api/+page.svelte`)
  so the three "bring something of mine" settings sit together.
- Account-scoped (like `/pengaturan/api`, not space-scoped — see **Architecture notes** for why), gated by
  `locals.user` the same way `/pengaturan/api/+page.server.ts:36-40` does (`redirect(303, '/masuk')` when signed out).
- One row today: **Anthropic**. A `provider` column and a one-row-per-provider table make a second provider (if
  ever) additive, but the UI, validation and messages this pass only know `anthropic`; no other provider is
  offered, named or planned here.
- States:
  - **No key stored:** empty state, "Belum ada kunci API" with a short explanation of what it is for (future AI
    reading of receipts, statements and the assistant) and an "Tambahkan kunci Anthropic" form (password input,
    label `sk-ant-…`, a link to Anthropic's own key page as plain text, no logo).
  - **Key stored:** one row showing provider name, masked value (`•••• ` + last 4 raw characters — never the
    prefix, which would narrow the guess space the least amount possible but is still not the thing to show),
    when added, when last tested and the last test's outcome ("Berhasil terhubung" / "Kunci tidak valid" /
      "Belum pernah dicoba"), three actions: **"Tes koneksi"**, **"Ganti kunci"** (same form as adding, replaces),
    **"Hapus kunci"** (confirm, then delete).
  - **Loading** (initial `load`), **saving** (form pending, button disabled with a spinner label "Menyimpan…"),
    **testing** ("Menguji koneksi…"), **error** (save failed, test failed — four distinct test outcomes below),
    **success** (toast/row update after the server confirms the write — never optimistic).
  - Works at 360 px; works with JavaScript off (progressive enhancement — every action is a `<form>` with a
    SvelteKit form action; the page re-renders the new state on submit without JS).
- "Tes koneksi" action: rate-limited (new `ThrottleScope` `'ai-key-test'`, per user, reusing
  `overUserAttemptLimit` from `src/lib/server/auth/throttle.ts:181-193`, a stricter max than the default 20/10 min
  — propose 5 per 10 minutes, see **Owner decisions**), then one minimal real call to Anthropic's Messages API
  through the app's AI Gateway route (see **Architecture notes** for why the gateway, not a direct call). Outcomes
  shown to the user, each a distinct, truthful message (never conflated):
  - **success** → "Berhasil terhubung" (store `last_tested_at`, `last_test_result = 'ok'`);
  - **invalid key** (provider 401/403) → "Kunci tidak valid atau sudah dicabut" (`last_test_result = 'invalid'`);
  - **quota/billing** (provider 429 or a documented insufficient-credit/quota error code) → "Kuota Anthropic-mu
    habis atau tagihan bermasalah — periksa akun Anthropic-mu" (`last_test_result = 'quota'`); this is Anthropic's
    own account status, not Montra's — the message must not read as a Montra plan limit;
  - **network/timeout/5xx from the provider or the gateway** → "Tidak bisa menghubungi Anthropic sekarang, coba
    lagi" (`last_test_result = 'network'`), no change to the stored key;
  - **gateway not configured** (see Prerequisites) → the whole "Tes koneksi" control is replaced by "Belum
    dikonfigurasi" (disabled, with a short reason), matching the `isConnectedAppsConfigured` pattern
    (`src/lib/server/connected-apps/crypto.ts:56-58`) — the key can still be saved and replaced even when testing
    is unavailable, so a user is not blocked from entering it before the owner finishes the gateway prerequisite.
  - No raw key, no provider response body and no stack trace ever reaches the browser or a log line (engineering
    checklist "Untrusted text" and "No real providers in tests").
- Validation on save: trimmed; must start with `sk-ant-`; length between 20 and 300 characters (a loose bound —
  Anthropic's own format is not publicly specified to the byte, so this only rejects obviously-wrong pasted text,
  e.g. empty, a session cookie, a sentence; the real check is "Tes koneksi" or first real use); CSRF via the
  existing mechanism (`src/lib/server/csrf.ts` — this is a same-origin form POST, already covered, no new
  exemption needed, confirm it is **not** added to `BEARER_ROUTES`/`isBearerApiRoute`); form body size capped by
  the shared guard (`readFormBody`, per `docs/ENGINEERING_CHECKLIST.md` "Form bodies").
- i18n: every Indonesian string above through `tr()`/`trf()` (`src/lib/shared/i18n.ts`) with a matching English
  entry in `i18n-en.ts`; the existing test that fails on a missing English entry covers this file once new keys
  are added (see FN-29/FN-38 for the established pattern of one `messages.ts` per feature holding the `msg()` calls
  consumed by both the server and the page).

### Server modules

- `src/lib/server/ai-keys/crypto.ts` — sealing, mirroring `src/lib/server/connected-apps/crypto.ts` exactly
  (WebCrypto AES-256-GCM, fresh 96-bit nonce per seal, associated data binding key id + row id + user id +
  provider, `_PREVIOUS` rotation, fail-closed `null` on any malformed input): same algorithm, **different secret**
  (`AI_KEYS_ENCRYPTION_KEY` / `AI_KEYS_ENCRYPTION_KEY_PREVIOUS`, not `CONNECTED_APPS_ENCRYPTION_KEY`) — see
  **Owner decisions** for why a dedicated key. `isAiKeysConfigured(env)` export, same shape as
  `isConnectedAppsConfigured`.
- `src/lib/server/ai-keys/repo.ts` — `getStoredKey(db, userId, provider)` (for the lookup helper below, never
  returns the raw key to a loader — only to the one server function that is about to make a provider call),
  `saveKey(db, userId, provider, rawKey, env, now)` (insert-or-replace, one row per `(user_id, provider)`, writes
  one audit row), `deleteKey(db, userId, provider, now)` (writes one audit row), `recordTestResult(db, userId,
  provider, result, now)`, `listKeysForDisplay(db, userId)` (masked view only: provider, last four, created/updated,
  last test state — never the ciphertext to a loader that doesn't need it, matching the connected-apps pattern of
  never selecting token columns for a page, `src/lib/server/connected-apps/repo.ts:27-42`).
- `src/lib/server/ai-keys/anthropic.ts` — `testAnthropicKey(env, rawKey)`: one minimal Messages API call through
  the AI Gateway route (see Architecture notes), a short timeout (reuse the engineering checklist's "every AI call
  … has a timeout"), mapped to the four outcomes above. This is the **only** place a provider is called in this
  PRD; later AI-capture PRDs add their own calls and reuse this module's error-mapping shape, not its test-specific
  prompt.
- `src/lib/server/ai-keys/lookup.ts` — `resolveAnthropicKey(db, userId, env)`: the helper a later AI feature calls
  first. Returns the user's own decrypted key, or `null`. **Never a fallback to an owner-wide key** — there is no
  app-wide Anthropic key in this design (see Architecture notes on BYOK vs app-level gateway). A later PRD's own
  action/load is responsible for showing "Tambahkan kunci Anthropic di Pengaturan › Integrasi AI" (a link to
  `/pengaturan/integrasi`) when this returns `null`; this PRD only ships the helper and documents the contract, not
  any caller.
- `src/lib/server/ai-keys/messages.ts` — the `msg()`-wrapped strings for this feature (mirrors
  `connected-apps/messages.ts`).
- Audit: a new small table `ai_key_audit` (see migration below) — `created`, `replaced`, `removed`, `test_ok`,
  `test_failed` rows, content-free beyond the action and timestamp (no key material, no test error detail).
  `connected_apps` audits into the existing space-scoped `audit_events` table because a connection belongs to a
  space; an AI key belongs to a user with no space, so it needs its own table rather than widening
  `audit_events.space_id` to nullable (a schema change with its own blast radius, out of scope here).

### Admin status view: `/pengaturan/integrasi/admin`

- Gated: signed-in (`locals.user`) **and** the user's e-mail (lowercased, trimmed) is in the `ADMIN_EMAILS` Worker
  secret (comma-separated list, mirroring how `SUPPORT_EMAIL` is read as a plain Worker var/secret per
  `docs/RUNBOOK.md`), compared with a constant-time comparison per candidate (reuse the shape of
  `constantTimeEqual` in `src/lib/server/auth/api-tokens.ts:153-158`, applied to a SHA-256 of the lowercased e-mail
  so the comparison cost does not leak which position in the list matched). Everyone else — signed out, signed in
  but not listed, or `ADMIN_EMAILS` unset — gets `error(404)`, the same "Not found" used for the dev-only gate in
  `src/routes/(app)/pengaturan/aplikasi/+page.server.ts:55-56`, so the route's existence is not an oracle either.
- Content, **names and booleans only, never a value, never a partial value, never a hash of a value**:
  - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — configured together or not (RUNBOOK's "all three
    or none" rule, so show one combined status: "Web Push: terkonfigurasi" / "belum lengkap").
  - `CONNECTED_APPS_ENCRYPTION_KEY` (and whether `_PREVIOUS` is also set, since that signals a rotation in
    progress someone should finish).
  - `AI_KEYS_ENCRYPTION_KEY` (and `_PREVIOUS`) — this feature's own key, so the owner can see it is set without
    asking Claude to check `wrangler secret list` for them.
  - `SUPPORT_EMAIL` — configured or not (never the address itself, even though it is not very secret, to keep the
    page's one rule simple: never a value).
  - `AI_GATEWAY_ACCOUNT_ID` / `AI_GATEWAY_ID` — configured or not (new to this PRD; see Prerequisites).
  - `BILLING_MOCK_ENABLED` / `MOCK_PAYMENT_WEBHOOK_SECRET` — configured or not, plus the `APP_ENV` value (not a
    secret) so the owner can confirm this never reads "configured" in production (RUNBOOK: "never in production").
  - Row count only (no identifying detail) of users with a live Anthropic key stored, so the owner can tell BYOK
    adoption without seeing who.
- No write actions on this page. No per-user drill-down (that would need its own access rule and audit trail this
  PRD does not build — see Out of scope). No edit-in-place for any secret; secrets are still only set with
  `wrangler secret put` per `docs/RUNBOOK.md`.
- i18n and 360 px same as the user page; no-JS (it is a pure `load`, no actions).

### Migration

New migration `0028_ai_keys.sql` (chained after `0027_ride_food_categories.sql`), two tables, no change to any
existing table:

```
ai_keys: id, user_id (FK users, cascade delete), provider (CHECK in ('anthropic')), encrypted_key, key_nonce,
  key_key_id, last_four, status (CHECK in ('active')), last_tested_at (nullable), last_test_result
  (CHECK in ('ok','invalid','quota','network') or null), created_at, updated_at.
  UNIQUE (user_id, provider). No space_id, deleted_at or seq — an account-level credential like api_tokens
  (replace-in-place on "Ganti kunci"; "Hapus kunci" is a real DELETE, not a tombstone, since there is nothing a
  sync pull needs to see removed — nothing here is ever synced to a device).
ai_key_audit: id, user_id (FK users, cascade delete), action (CHECK in ('created','replaced','removed','test_ok',
  'test_failed')), created_at. Write-only, like audit_events, no content beyond the action.
```

Add both to `ACCOUNT_TABLES`/`ACCOUNT_TABLE_DECISIONS` in `src/lib/server/export/tables.ts:100-135` (the compiler
forces a decision — this is why that file's test matters here): `ai_keys` → `export: 'custom'` ("account.json:
whether an Anthropic key exists, when it was added and last tested — never the key"; the export should say
`hasAnthropicKey: true/false` plus the non-secret timestamps, not a JSON dump that happens to omit three columns,
because a future column addition to `ai_keys` must not silently leak into an export file via the `omit`-list
pattern used for token tables); `ai_key_audit` → `export: 'none'` ("internal security log, not shown in the app",
same reasoning as `audit_events`).

Add `ai_keys` and `ai_key_audit` deletion to `src/lib/server/auth/delete-account.ts` (around its existing
`sessions`/`apiTokens`/`accountKeys` deletes at lines 92-97) so deleting the account deletes the key and its audit
trail — no exception for AI keys in CLAUDE.md's "deletion removes account, all server records."

## Out of scope

- Calling Claude for any user-facing feature (capture, assistant, agent) — FN-15/16/17/19/20/22/23 stay on hold;
  this PRD only makes the key available to whichever of those lands next, through `resolveAnthropicKey`.
- Any provider besides Anthropic (no OpenAI, no Google AI Studio, no Workers AI key management — Workers AI is
  already a binding, not a user secret, and is unrelated to this PRD).
- Cloudflare AI Gateway's own "Provider Keys" / BYOK dashboard feature (storing the key under Cloudflare's own
  Secrets Store, one key per gateway) — wrong shape for per-user keys; see Architecture notes.
- Per-user AI spend metering, credits, or billing for AI usage (the user pays Anthropic directly on their own
  Anthropic account; Montra does not see or bill for it). A future AI-capture PRD may still rate-limit *calls*
  per user to protect Montra's own infrastructure, but that is that PRD's decision, not this one's.
- An admin drill-down into a specific user's data, impersonation, or any admin write action.
- Key rotation reminders, expiry, or multiple keys per user per provider.
- Sharing a key across a shared space (decided per-user below, with reasoning).
- Changing `CONNECTED_APPS_ENCRYPTION_KEY`'s rotation tooling (FN-29's re-seal job still does not exist; this PRD
  does not add one for its own key either — the same "remove `_PREVIOUS` only after every row is re-sealed or
  reconnected" rule from `docs/RUNBOOK.md` applies to `AI_KEYS_ENCRYPTION_KEY`, stated there and here, not solved).

## Acceptance criteria

Server-side authorization

1. Given a signed-out visitor, when they request `/pengaturan/integrasi` (GET or any action), then they are
   redirected to `/masuk`, identically to `/pengaturan/api` (`src/routes/(app)/pengaturan/api/+page.server.ts:36-40`).
2. Given a signed-in user, when they submit `save`, `delete` or `test` on `/pengaturan/integrasi`, then the
   server reads and writes only `locals.user.id`'s own `ai_keys` row — no id from the form selects another
   user's row (there is nothing to select; the row is addressed by `(session user id, 'anthropic')` only, never a
   row id from the client).
3. Given a signed-in user who is **not** in `ADMIN_EMAILS` (including when `ADMIN_EMAILS` is unset), when they
   request `/pengaturan/integrasi/admin`, then the response is `404` with the standard "Not found" body — the same
   answer as a signed-out visitor requesting it, so the route's existence is not an oracle.
4. Given a signed-in user whose e-mail **is** in `ADMIN_EMAILS` (case-insensitive, trimmed), when they request
   `/pengaturan/integrasi/admin`, then they see the configured/not-configured booleans listed in Scope, and no
   secret value, partial value, or other user's e-mail/row anywhere in the response (view-source and Vitest both
   check this).
5. Given `ADMIN_EMAILS` contains an e-mail with different casing or surrounding whitespace than the signed-in
   user's stored e-mail, when they request the admin page, then they are still admitted (comparison normalizes
   both sides the same way) — and given a near-miss e-mail (one character different, or a prefix/suffix of a
   listed address), then they are refused.

Storage and lifecycle

6. Given a user with no stored key, when they submit a value starting with `sk-ant-` of valid length, then one
   `ai_keys` row is created, sealed with `AI_KEYS_ENCRYPTION_KEY`, one `ai_key_audit` row `created` is written, and
   the page shows the masked row (provider, last four, "Belum pernah dicoba").
7. Given a user with a stored key, when they submit "Ganti kunci" with a new value, then the old ciphertext is
   replaced (not kept alongside), exactly one row still exists for `(user_id, 'anthropic')`, a `replaced` audit row
   is written, and `last_tested_at`/`last_test_result` reset to null (a replaced key has not been tested).
8. Given a user with a stored key, when they submit "Hapus kunci", then the row is deleted (a real DELETE, not a
   tombstone), a `removed` audit row is written, and the page returns to the empty state on reload.
9. Given any save, replace or delete, when the page reloads (full reload, not just the form response), then the
   new state persists — it was written to D1, not held in a loader-only variable.
10. Given `AI_KEYS_ENCRYPTION_KEY` is unset or not exactly 32 bytes, when a user tries to save a key, then the
    action fails with a clear "Belum dikonfigurasi" error and nothing is written (mirrors
    `isConnectedAppsConfigured` gating `seedDemoConnectedApp`'s `not_configured` result).
11. Given `AI_KEYS_ENCRYPTION_KEY_PREVIOUS` is set and a row was sealed under it, when the server needs to read
    that key (e.g., a future AI feature calling `resolveAnthropicKey`), then it still opens (the rotation
    round-trip, same test shape as `src/lib/server/connected-apps/crypto.test.ts`).
12. Given the raw key is never written to `console.log`, `console.error`, an audit row, or a Workers Logs line
    (grep the diff, as the engineering checklist's "No upload persistence" grep instructs for files — the same
    discipline applies to this secret).

"Tes koneksi" behaviour

13. Given a stored key and `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` configured, when the user clicks "Tes koneksi"
    and the provider call succeeds, then the page shows "Berhasil terhubung", `last_test_result` becomes `'ok'`,
    and a `test_ok` audit row is written.
14. Given the same setup, when the provider answers 401/403 (simulated by a test double — see Prerequisites on
    never calling the real provider in automated tests), then the page shows "Kunci tidak valid atau sudah
    dicabut", `last_test_result` becomes `'invalid'`, and the stored key is **not** deleted (the user may want to
    fix a typo by replacing it, not be forced to start over).
15. Given a 429/quota-style provider answer, then the page shows the quota message distinctly from the invalid-key
    message (different copy, different stored result).
16. Given a network failure, timeout, or 5xx from the provider or the gateway, then the page shows the
    network-error message, and `last_test_result` is left as it already was (a transient failure must not
    overwrite a previously-successful test with a false "invalid").
17. Given 6 "Tes koneksi" attempts inside one throttle window for one user, then the 6th is refused with a
    rate-limit message before any provider call is attempted (the throttle check runs first; no provider call is
    billed to the user's Anthropic account for a refused attempt).
18. Given `AI_GATEWAY_ACCOUNT_ID` or `AI_GATEWAY_ID` is unset, when the user views the stored-key row, then "Tes
    koneksi" is replaced by a disabled "Belum dikonfigurasi" control, and saving/replacing/deleting the key still
    works normally (testing is the only action gated by the gateway).

Lookup helper (no caller shipped this pass, but the contract is tested)

19. Given a user with a live key, when `resolveAnthropicKey(db, userId, env)` is called, then it returns the
    decrypted raw key string.
20. Given a user with no key, or a key that fails to decrypt (wrong/missing encryption key), then
    `resolveAnthropicKey` returns `null` — never throws, never returns another user's key, never falls back to
    any app-wide key (there is none).

Money, dates, i18n (apply where relevant to this feature)

21. Given every new Indonesian string added for this feature (`messages.ts`, page copy, admin page copy), when the
    i18n English-completeness test runs, then every one has an English entry in `i18n-en.ts` (no new failure in
    that test).
22. Given `last_tested_at`/`created_at`/`updated_at` are shown to the user, when rendered, then they use the
    shared WIB timestamp formatter (no new ad hoc date formatting), consistent with
    `src/lib/shared/dates.ts:wibIsoString` used elsewhere (e.g. `export/tables.ts:3`).
23. There is no money arithmetic in this feature (no `amount_minor`), so the money criterion in the brief does not
    apply beyond: this PRD introduces no currency figure anywhere.

Account deletion and export

24. Given a user deletes their account, when `delete-account.ts` runs, then their `ai_keys` and `ai_key_audit` rows
    are deleted in the same guarded batch as `sessions`/`apiTokens`/`accountKeys` (no orphaned key survives account
    deletion; test by asserting a zero row count for that `user_id` after deletion, mirroring the existing
    `delete-account.test.ts` pattern for `apiTokens`).
25. Given a full-account export (FN-31), when a user with a stored key exports, then `account.json` states a key
    exists and when it was added/last tested, and the exported ZIP contains no ciphertext, nonce, key id or raw
    key anywhere (grep the fixture output in the test, mirroring the existing export-completeness test that forces
    a decision per table).

Engineering checklist items turned into criteria

26. (100-bound-parameters / LIKE patterns) N/A — no list or substring query is added by this feature.
27. (Concurrent writes) Given two concurrent "Ganti kunci" submissions for the same user, when both run, then the
    row ends in one consistent state (one guarded `UPDATE`/`INSERT … ON CONFLICT`, not a read-then-write race) and
    exactly one audit row per actually-applied change — test with a concurrent-write probe.
28. (Bounded work) `listKeysForDisplay` and the admin status view touch only this user's row (or a small fixed set
    of named secrets) — no unbounded scan.
29. (Masking) The displayed value is prefix-free (no `sk-ant-` shown) and shows only the last four raw characters,
    consistent with `apiTokens.lastFour`'s "last four" convention — not the CLAUDE.md "account/card number last 4"
    rule verbatim (this is not an account number), but the same masking discipline.
30. (Untrusted text) The pasted key value is never rendered as HTML, is length-capped before any processing, and
    control/zero-width characters are stripped before the format check (reuse `cleanText` from
    `src/lib/shared/text.ts` the way `pengaturan/api/+page.server.ts:73` does for a token name).
31. (CSP) No new `'unsafe-inline'`; no new per-route CSP relaxation needed (plain forms, no embedded widget).
32. (Svelte keyed lists) The one-row list (today, provider = anthropic only) is still keyed by `provider`, not by
    display text, so a second provider added later does not break the key.
33. (Truthful state) The masked row only ever reflects a confirmed server write; no optimistic update renders
    "saved" before the response returns.
34. (Accessibility) Focus returns to the triggering control after "Hapus kunci"'s confirm step closes; the three
    action buttons and the admin page's status rows meet the 44 px touch target and AA contrast in both themes
    (reuse the shared `GroupList`/`IconRow`/kit components already in the design system, not new bespoke markup).
35. (Fail-before proof) Each new Vitest test in this feature's QA pass is shown failing against the pre-feature
    code before the feature exists, per the usual regression discipline.
36. (No real providers in tests) `npm test`'s Anthropic call is a stub (`testAnthropicKey`'s HTTP call is injected/
    mockable); no Vitest run makes a real call to Anthropic or to the real AI Gateway. A real-provider check (if
    the owner wants one before shipping) is recorded separately, never reported as part of `npm run gates`.

## Architecture notes

- **Why per-user BYOK, not an app-level Anthropic key passed through the gateway:** CLAUDE.md names "AI through
  Cloudflare AI Gateway" as the architecture, and the owner's 2026-10-09 decision is BYOK specifically so each
  user pays their own AI cost. Cloudflare AI Gateway supports both an app-level "Provider Keys" store (one key per
  gateway, managed in the Cloudflare dashboard or Secrets Store) and passing a provider credential **per request**
  in the call's own `Authorization` header, which the gateway forwards to the provider unchanged without
  consulting any stored key — this is documented as the precedence order (a key present on the request is used
  as-is; a stored key is only consulted when the request carries none). Per-user BYOK fits the second mode: the
  app Worker still calls the gateway's Anthropic route (so the owner's gateway logs, caches by default, and can
  set spend alerts the way CLAUDE.md's architecture intends), but the credential forwarded on each call is the
  calling user's own decrypted key, never a key stored in Cloudflare's own Provider Keys feature (which would mean
  one Cloudflare dashboard entry per user — the wrong shape for a per-user, user-editable secret). This is why
  the AI Gateway is described as **app-level** (one gateway, identified by `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID`,
  owned by Montra) while the **provider key is per-user** — re-confirm the exact current header name and
  precedence rule against `developers.cloudflare.com/ai-gateway` at implementation time; this PRD's acceptance
  criteria do not depend on the exact header name, only on the behaviour (the user's own key is what is billed by
  Anthropic, never a key of the owner's).
- Reuses, unchanged: `src/lib/server/auth/throttle.ts` (new scope `'ai-key-test'` added to `THROTTLE_SCOPES`),
  `src/lib/server/csrf.ts` (no change — same-origin form, not a Bearer route), `src/lib/shared/text.ts#cleanText`,
  `src/lib/shared/dates.ts#wibIsoString`, the `GroupList`/`IconRow`/`ScreenTitle` kit components, the
  `devRoutesEnabled`/`error(404)` gate pattern from `pengaturan/aplikasi/+page.server.ts:33,55-56` (adapted to
  `ADMIN_EMAILS` instead of `DEV_ROUTES`).
- New: `src/lib/server/ai-keys/{crypto,repo,anthropic,lookup,messages}.ts`, `src/lib/shared/ai-keys.ts` (constants:
  `AI_KEY_PROVIDERS = ['anthropic']`, prefix/length validation, mirroring
  `src/lib/shared/api-tokens.ts`'s shape), `src/routes/(app)/pengaturan/integrasi/{+page.server.ts,+page.svelte}`,
  `src/routes/(app)/pengaturan/integrasi/admin/{+page.server.ts,+page.svelte}`.
- Schema: add `aiKeys` and `aiKeyAudit` to `src/lib/server/db/schema.ts` (table shapes as in Scope/migration above,
  styled like `apiTokens` at `schema.ts:111-140` — no `space_id`, no `deleted_at`, no `seq`). New migration
  `migrations/0028_ai_keys.sql`, generated with `npm run db:generate -- --name ai_keys` and applied locally with
  `npm run db:migrate:local`; never hand-written to match an existing applied migration's exact Drizzle-generated
  SQL shape.
- `getEnv()` (`src/lib/server/env.ts`) is the only accessor for the new Worker vars/secrets below — never
  `event.platform`.
- Admin gate implementation: add `ADMIN_EMAILS` to the `Env` surface the same way `SUPPORT_EMAIL` already is (a
  plain var/secret read through `getEnv()`), split on comma, trim, lowercase; compare via SHA-256 + constant-time
  equality (reuse `sha256Hex`/`constantTimeEqual` from `src/lib/server/util.ts` / `auth/api-tokens.ts`) so the
  comparison does not short-circuit on the first differing character of a plain string compare.
- Worker: app Worker only. No `workers/jobs` change in this PRD (no cron, no queue — "Tes koneksi" is a direct
  user-initiated request/response). A later AI-capture PRD that runs unattended (e.g. FN-19's hourly Gmail check)
  is the first caller that needs `workers/jobs` to also read `AI_KEYS_ENCRYPTION_KEY` to open a user's key without
  the user present — exactly the trust model note already written for `CONNECTED_APPS_ENCRYPTION_KEY` in
  `docs/RUNBOOK.md`, and the reason this PRD seals with a server-held key (openable without the password) rather
  than FN-21's account key (openable only with the user's password present).

## Prerequisites

- **You — `ADMIN_EMAILS`** (new Worker secret, comma-separated e-mail list, e.g.
  `wrangler secret put ADMIN_EMAILS --env staging` with value `owner@example.com` — the owner's own address;
  `owner@example.com` is one reasonable value, but the owner should pick which address(es) belong in it).
  Locally: add to `.dev.vars` (documented, not committed, matching the existing "names only" convention in
  `.dev.vars.example`). Unset → the admin route is `404` for everyone, same as not shipped.
- **You — `AI_KEYS_ENCRYPTION_KEY`** (new Worker secret, 32 random bytes base64url, generated exactly like
  `CONNECTED_APPS_ENCRYPTION_KEY`: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`). Unset →
  `/pengaturan/integrasi` shows "Belum dikonfigurasi" and stores nothing (criterion 10). Local: add to `.dev.vars`.
  Staging: `wrangler secret put AI_KEYS_ENCRYPTION_KEY --env staging`.
- **You — `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`** (new, app-level — identify the Cloudflare AI Gateway
  "Tes koneksi" calls through; **no Anthropic key of the owner's is needed for this**, since the credential
  forwarded per-request is the user's own). Create a gateway in the Cloudflare dashboard (the project owner
  account, `<your-account-id>`, already on Workers Paid per `docs/TASKS.md`) under AI Gateway →
  Create Gateway, then: `wrangler secret put AI_GATEWAY_ACCOUNT_ID --env staging` (the account id above) and
  `wrangler secret put AI_GATEWAY_ID --env staging` (the gateway's name/id). Locally, add the same two to
  `.dev.vars` for a staging/local gateway, or leave unset to exercise the "Belum dikonfigurasi" path (criterion
  18) — "Tes koneksi" is the only thing gated by these; saving a key is not. This is a smaller ask than the
  bundled "Anthropic API key and an AI Gateway" item in `docs/TASKS.md:43/100-101`: creating a gateway needs no
  payment and no Anthropic account, so the owner can unblock this PRD without deciding the still-open Gmail/AI
  capture question. **This PRD does not require or request the owner's personal Anthropic key at any point.**
- **You** (optional, recommended before marking FN-15/16/17/19/20/22/23 unblocked later): once this PRD ships, add
  your own `sk-ant-…` key through `/pengaturan/integrasi` on your own account to exercise "Tes koneksi" against
  the real provider as a one-off, manual, owner-run check — never part of `npm run gates` or CI (engineering
  checklist "No real providers in tests").

## Owner decisions

Proposed defaults below; proceeding on these unless corrected (per the house auto-accept-defaults policy — still
asking because `ADMIN_EMAILS`/gateway ids are credentials, per that same policy).

1. **Per-user key, not per-space.** Default: **per-user.** A shared space's members each bring their own key (or
   none); a future AI-capture feature run inside a shared space uses the key of whichever member's action
   triggered it (e.g., the member who asked the assistant a question, or — for an unattended job like Gmail
   look-back — the member whose connected Gmail triggered the read). Reasoning: Anthropic bills the key's owner,
   and a space can hold up to 5 people (FN-03) who should not silently spend each other's Anthropic credits; a
   member who leaves a shared space takes their key with them (it was never there) unlike FN-29's
   `autoDisconnectItems`, which has nothing to do here.
2. **Dedicated encryption key, not reused `CONNECTED_APPS_ENCRYPTION_KEY`.** Default: **dedicated
   `AI_KEYS_ENCRYPTION_KEY`.** Reasoning: a leaked key exposes everything it seals at once (per the existing
   `connected-apps/crypto.ts` comment); keeping AI keys and connected-app tokens under separate secrets limits one
   leak's blast radius and lets the two be rotated independently.
3. **"Tes koneksi" rate limit: 5 attempts per 10-minute window per user** (stricter than the general
   `THROTTLE_MAX_ATTEMPTS = 20`, since each attempt is a real external call the user's own Anthropic account pays
   for — generous enough for "I fixed a typo, try again" a couple of times, strict enough that a scripted loop
   cannot turn this page into a free Anthropic-key validator for someone else's stolen key). Alternative: reuse 20;
   rejected because this one burns the *user's own* money per attempt, unlike every other throttled scope.
4. **Delete-on-replace, not keep-history.** Default: replacing a key overwrites the row; no history of previous
   (now-revoked) keys is kept beyond the content-free audit log's `replaced` timestamp. Reasoning: there is no
   use for an old, presumably-revoked key, and keeping ciphertext around after the user chose to remove it works
   against the point of "Hapus kunci."
5. **Admin page path and scope.** Default: `/pengaturan/integrasi/admin`, read-only, the exact secret list in
   Scope — no per-user drill-down, no edit action, no e-mail of any non-admin user shown. Alternative considered:
   a top-level `/admin` area; rejected for this pass as a bigger surface than "which secrets are configured"
   needs, and nothing else lives there yet.
6. **`ADMIN_EMAILS` format.** Default: a single comma-separated Worker secret (not a D1 table of admin users).
   Reasoning: matches CLAUDE.md's instruction to use exactly this mechanism ("admin = emails listed in a Worker
   secret `ADMIN_EMAILS`"); a D1-backed admin role is a bigger, unrequested feature (its own invite/revoke flow,
   audit, etc.).
7. **Validation strictness of the pasted key.** Default: loose format check (`sk-ant-` prefix + length bounds)
   client- and server-side, real validity decided only by "Tes koneksi" or first real use. Alternative: hard-code
   a stricter pattern (e.g., `sk-ant-api03-`); rejected because Anthropic's exact format is not confirmed in
   official docs at the time of writing and a wrong hard-coded pattern would reject a real, working key the day
   Anthropic changes it.

## Tracker impact

- Closes the "settings to add integrations" owner request (2026-10-09) — not itself a `docs/TASKS.md` line yet;
  add one line when this PRD is accepted: `- [ ] **Claude** — FN-41 integrations (BYOK Anthropic keys, admin
  status view), migration 0028.`
- Does **not** close `docs/TASKS.md`'s "Anthropic API key and an AI Gateway" owner item
  (`docs/TASKS.md:43,100-101`) or unblock FN-15/16/17/19/20/22/23 by itself — those still need
  `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` (a smaller ask, listed under Prerequisites here) plus their own PRDs to
  actually call Claude. Once this PRD ships, update that TASKS.md line to note the Anthropic-key half is now
  optional for the owner (BYOK), while the AI Gateway id half is a prerequisite shared with this PRD.
- `docs/ACCEPTANCE.md` has no existing row for this feature (it predates FN-41); add one under a new "Settings and
  integrations" group once QA runs, rather than overloading an unrelated existing row.
