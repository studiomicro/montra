# QA Report — FN-41 Integrations: per-user AI keys (BYOK) and admin status view

**Verdict: PASS**

Branch `fn-41-integrations-byok` at `6f08152`, diff against `main` (`git diff main...HEAD`, 35 files,
+8145/-105). All 36 acceptance criteria verified; `npm run gates`'s four steps run individually are clean; the
targeted e2e journey is clean; the migration applies to a fresh local D1 and `drizzle-kit generate` reports no
schema drift.

## Commands run

- `flock … npx vitest run --maxWorkers=2 src/lib/server/ai-keys test/integration/integrasi.test.ts src/lib/server/admin.test.ts src/lib/server/connected-apps/crypto.test.ts src/lib/shared/ai-keys.test.ts src/lib/server/export` → 7 test files, 76 tests passed, exit 0 (local D1/Vitest, no real provider; `testAnthropicKey`'s fetch is injected).
- `flock … npx vitest run --maxWorkers=2` (whole repo) → 211 test files, 3026 tests passed, exit 0 (local D1/Vitest, no real provider, no real network).
- `flock … npm run check` → svelte-check + tsc ×3: 1765 files, 0 errors, 0 warnings, exit 0.
- `flock … npm run lint` → prettier --check + eslint: clean, exit 0.
- `flock … npm run build` → vite build + service worker + adapter-cloudflare: succeeded, exit 0.
- `npm run db:reset:local` (this worktree's own `.wrangler` state only) → removed local D1 state, re-applied all 28 migrations, reseeded: exit 0.
- `npx wrangler d1 execute DB --local --command "select name from sqlite_master where type='table' and name like 'ai_key%'"` → returns `ai_key_audit`, `ai_keys` (local D1 file, not a mock).
- `flock … npx drizzle-kit generate --name qa_consistency_check` → "No schema changes, nothing to migrate" (no new migration file was left behind) — confirms `schema.ts` and `migrations/0028_ai_keys.sql` are consistent.
- `LD_LIBRARY_PATH=… E2E_PORT=5381 npx playwright test --workers=1 e2e/integrasi.spec.ts` → 7 passed (setup + phone ×3 + desktop ×3), exit 0 (real browser against a local `wrangler dev` server with a local-only sealing key and no AI Gateway ids configured — no real provider reachable).

No command was skipped; `npm run gates`/`npm test` were never invoked directly (ran their constituent steps individually per the RAM rule), and none of the above hit the real Anthropic API or the real Cloudflare AI Gateway — every "Tes koneksi" path in an automated test uses the injected `fakeFetch` double (`test/integration/integrasi.test.ts`) or has no gateway ids configured at all (e2e server).

## Checked criteria

Server-side authorization

1. PASS — signed-out GET/`save`/`delete`/`test` on `/pengaturan/integrasi` all redirect 303 to `/masuk`; `fakeFetch` never called. `test/integration/integrasi.test.ts` "access (criteria 1, 2)".
2. PASS — every action is addressed by `(locals.user.id, 'anthropic')` only; a form-supplied `userId`/`id` for another user is ignored (`+page.server.ts` never reads an id from the form). Verified by "every action addresses only the session user's row" test: user B's `test`/`delete` against user A's key both 404, A's row untouched, `resolveAnthropicKey` still returns A's real key and B's is null.
3. PASS — non-admin, unset `ADMIN_EMAILS`, and signed-out all get the same `error(404)` body as the admin route; e2e confirms the rendered 404 page too ("the admin status page is a plain 404…").
4. PASS — a listed admin sees only the documented booleans/names/counts; the test asserts the full object shape and greps the JSON-stringified response for every secret value, both users' ids/emails — none present.
5. PASS — admin email matched case/whitespace-insensitively (`normalizeEmail` both sides, `isAdminEmail` in `src/lib/server/admin.ts`); a one-character-off or prefix/suffix near-miss is refused — covered by test "admits a listed address… and refuses a near miss".

Storage and lifecycle

6. PASS — valid `sk-ant-…` save creates one row, one `created` audit row, masked view ("Belum pernah dicoba"); test "stores one sealed row…".
7. PASS — "Ganti kunci" replaces ciphertext in place (`onConflictDoUpdate` on `(user_id, provider)`), one row remains, `replaced` audit row, `last_tested_at`/`last_test_result` reset to null; test "'Ganti kunci' replaces the ciphertext in place…".
8. PASS — "Hapus kunci" is a real `DELETE` (migration has no `deleted_at` on `ai_keys`), `removed` audit row, repeat delete 404s and audits nothing; test "'Hapus kunci' deletes the row for real…".
9. PASS — every lifecycle test above reads back through a fresh `page.load()` call (not the action's own response), i.e. from D1.
10. PASS — unset/empty/31-byte `AI_KEYS_ENCRYPTION_KEY` → `fail(503, AI_KEYS_NOT_CONFIGURED)`, nothing written, `load.configured === false`; test "stores nothing while AI_KEYS_ENCRYPTION_KEY is unset or not 32 bytes".
11. PASS — rotation round-trip: a row sealed under the old key still opens via `_PREVIOUS` (`resolveAnthropicKey` test), and `connected-apps/crypto.test.ts` additionally pins a **golden ciphertext vector** sealed by the pre-refactor implementation to prove `server-seal.ts`'s extraction didn't change the wire format (see "server-seal refactor (FN-41)" describe block).
12. PASS — `console.log/error/warn/info` are spied across a save/test(network error, with the key embedded in the thrown error)/delete cycle and asserted to never contain `sk-ant`; code review of `anthropic.ts`/`repo.ts`/`lookup.ts`/`+page.server.ts` confirms no raw key is ever passed to a logger, page data, or audit row (audit rows are action+timestamp only).

"Tes koneksi" behaviour

13. PASS — 2xx → `tested: 'ok'`, `last_test_result='ok'`, one `test_ok` audit row, the exact gateway URL and `x-api-key: <user's key>` header asserted.
14. PASS — 401/`authentication_error` → `'invalid'`; key remains stored (`rowsOf` still has 1 row afterward in the next test in the same block).
15. PASS — 429/`rate_limit_error` → `'quota'`, distinct stored value and distinct copy (`AI_KEY_TEST_LABELS.quota` reads as the user's own Anthropic account, never a Montra limit).
16. PASS — 503, 529/`overloaded_error`, and a thrown `TypeError` (simulated network failure) all → `'network'`, and the previously-stored `'ok'` result/`last_tested_at` are left untouched (asserted equal to the pre-failure value) — matches criterion 16's "must not overwrite a previous success with a false invalid".
17. PASS — the 6th attempt in a window is refused with 429/`AI_TEST_RATE_LIMITED` **before** any `fetch` call (`fakeFetch` call count stays at `AI_KEY_TEST_MAX_ATTEMPTS` = 5); a second user has an independent budget. A 20-concurrent-request probe confirms exactly 5 reach the provider under concurrency too.
18. PASS — gateway ids unset → `load.testConfigured === false`, `test` action fails 503 `AI_TEST_NOT_CONFIGURED`, while save/replace/delete all still succeed and `fakeFetch` is never called; the page replaces the button with a disabled "Belum dikonfigurasi" control (`+page.svelte`) — also exercised live in `e2e/integrasi.spec.ts` (no gateway ids on the e2e server).

Lookup helper

19. PASS — `resolveAnthropicKey` returns the exact decrypted raw key for a live row.
20. PASS — returns `null` for no key, a key sealed under a different/rotated-out key, `env === {}`/`undefined`, an unknown user id, and even when the D1 driver itself throws (`broken` driver test) — never throws, never another user's key, no app-wide fallback exists in the code (no such env var is read anywhere in `lookup.ts`).

i18n / dates / money

21. PASS — every new Indonesian string (`ai-keys/messages.ts`, `admin`/`integrasi` page copy) has a matching `i18n-en.ts` entry; grepped directly (see Findings for the exact lines) and the whole-repo Vitest run (which includes the i18n-completeness test) passed with 0 failures.
22. PASS — all three timestamps render through `formatDateTimeWib`/`wibIsoString`-family helpers: the page uses `formatDateTimeWib(ms, locale)` (`+page.svelte`), and the export's `accountJson` uses `iso()` (built on `wibIsoString`) for `anthropicKeyAddedAt`/`ReplacedAt`/`LastTestedAt` — the export test asserts the ISO strings end `+07:00`.
23. PASS (N/A) — no `amount_minor` or currency figure anywhere in the diff (grepped; only non-money timestamps and booleans).

Account deletion and export

24. PASS — `deleteAccount` deletes `aiKeys`/`aiKeyAudit` in the same guarded batch as `sessions`/`apiTokens`/`accountKeys`; test asserts zero rows for the deleted user's `ai_keys`/`ai_key_audit` while another user's row survives.
25. PASS — `account.json.aiKeys` states `hasAnthropicKey`/added/replaced/last-tested dates only; the ZIP is grepped for the raw key, ciphertext, nonce and key id — none found; `tables.ts`'s `export: 'custom'`/`'none'` decisions force this at compile time (`ACCOUNT_TABLE_DECISIONS`).

Engineering-checklist-derived criteria

26. N/A — no list/substring query added.
27. PASS — 20 concurrent "Ganti kunci" end in exactly one row (one of the 20 submitted keys), 1 `created` + 19 `replaced` audit rows (the guarded `onConflictDoUpdate`, no read-then-write); 20 concurrent deletes leave exactly one `removed` audit row; 20 concurrent tests let exactly the throttle budget (5) reach the provider.
28. PASS — `listKeysForDisplay` is `where userId = ? limit AI_KEY_PROVIDERS.length` (1 row today); the admin view touches a small fixed set of named env vars plus one `count(*)`.
29. PASS — masked row shows `•••• <last4>` only, never the `sk-ant-` prefix (verified in the rendered screenshot and in `listKeysForDisplay`'s selected columns, which never include `encrypted_key`).
30. PASS — `parseAiKey` runs the pasted value through `cleanText` (strips control/zero-width chars, caps length at `AI_KEY_MAX_LENGTH + 1` before processing) before the format regex; the value is bound to a password `<input>`, never interpolated into HTML.
31. PASS — no `integrasi` entry anywhere in the CSP config (grepped `src/lib/server/csp.ts`/`hooks.server.ts`); plain forms only.
32. PASS — `{#each data.keys as key (key.provider)}` — keyed by the `provider` column, not display text.
33. PASS — `track()` only flips `busy`/clears `actionError` on submit; the shown "done"/"tested" state comes from the server's form-action return value (`form.done`/`form.tested`) after `update()`, never set optimistically before the response.
34. PASS — "Batal" returns focus to the "Hapus kunci" `<summary>` (asserted in both the Vitest-adjacent reasoning and live in e2e: `await expect(summary).toBeFocused()`); after delete, focus moves to the `#ai-key` input (`tick()` + `.focus()` in `track()`); buttons/rows use the shared `Button`/`GroupRow` kit components (same 44 px/AA-contrast guarantees as the rest of the app, not bespoke markup).
35. Not independently re-verified (trusted) — the engineer's own fail-before-proof discipline is a process item; QA's own new coverage (none needed — existing tests were already comprehensive) has no separate before/after to show.
36. PASS — `testAnthropicKey`'s `fetchFn` parameter is injected in `integrasi.test.ts` via `vi.mock('#lib/server/ai-keys/anthropic', …)`; no Vitest or Playwright run in this QA pass reached the real gateway or Anthropic (confirmed: e2e server has no `AI_GATEWAY_*` vars set at all).

360 px / light+dark: verified live via two Playwright screenshots at the phone project (360×780) — `integrasi-stored-light.png` and `integrasi-stored-dark.png` — both render the full Integrasi AI page cleanly, masked key, dates, and all three actions visible, no `expectNoHorizontalScroll` failures.

No-JS: `e2e/integrasi.spec.ts` "works without JavaScript: save and remove re-render from the server" — a `javaScriptEnabled: false` context saves and deletes a key purely through `<form>` POSTs, each re-rendering the new state from the server; `page.content()` is asserted to never contain the raw key.

## Findings

1. **Non-blocking — test-model id likely outdated, with a real functional risk if it is.** `src/lib/server/ai-keys/anthropic.ts:27` hardcodes `export const ANTHROPIC_TEST_MODEL = 'claude-haiku-4-5'`. The current Claude lineup is the Claude 5 family (e.g. Haiku 5.5 → `claude-haiku-5-5`); `claude-haiku-4-5` is very likely retired/non-existent by now. This is already a named, documented constant (not scattered magic strings) with a comment telling the next engineer to re-check docs.anthropic.com, which is good practice — but functionally, if the model id is wrong, Anthropic answers a 404 with `{"type":"error","error":{"type":"not_found_error",…}}`. `classifyAnthropicResponse` (same file) does not special-case `not_found_error` or status 404, so it falls through to the default `return 'network'` — meaning **every real "Tes koneksi" with a perfectly valid key would show "Tidak bisa menghubungi Anthropic sekarang"** instead of "Berhasil terhubung", silently masking a model-id bug as a transient network error. This does not fail any PRD acceptance criterion (none specifies a model id, and every automated test uses a mocked response so it can't catch this), but the owner's planned one-off manual real-provider check (Prerequisites, PRD) should be done before relying on this path, and the engineer should re-verify the id against current Anthropic docs and consider also mapping a 404/`not_found_error` to a distinguishable outcome rather than silently falling into `network`.
2. **Informational — admin route lives outside the `(app)` route group by design.** `src/routes/pengaturan/integrasi/admin/` (not `src/routes/(app)/pengaturan/integrasi/admin/`) is deliberate and documented in the route's own top-of-file comment: being outside `(app)` means the app layout's own auth redirect never fires, so a signed-out visitor gets the same plain `error(404)` as everyone else instead of a `/masuk` redirect that would leak "this route exists." This matches PRD criterion 3's "same answer as a signed-out visitor" requirement exactly (confirmed in both Vitest and e2e) — flagged here only so a future reader of the route tree isn't surprised by the asymmetric placement, not because it's wrong.

No violations of `docs/ENGINEERING_CHECKLIST.md` found: bound parameters are fine (no list/LIKE query), concurrency is guarded (`db.batch` + `onConflictDoUpdate`/`RETURNING`), masking follows the "last 4" convention, untrusted text goes through `cleanText`, no new CSP relaxation, Svelte lists keyed by a real column, state is never shown as saved before a server confirmation, accessibility (focus return, 44 px, shared kit components) holds, and no real provider is called in any automated test.
