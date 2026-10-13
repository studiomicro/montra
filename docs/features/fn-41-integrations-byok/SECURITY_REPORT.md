# FN-41 Security report — per-user AI keys (BYOK) and admin status view

Reviewed: `git diff main...HEAD` at 54690ff (review worktree `.claude/worktrees/fn-41-rt`), PRD threat model,
QA_REPORT.md, `docs/ENGINEERING_CHECKLIST.md`. Date: 2026-10-09.

## Verdict: PASS

No medium or high findings. Four low findings follow; they are recorded so they are tracked.

## Findings

### L1 (low): the admin gate trusts an e-mail address nobody has verified
`src/lib/server/admin.ts:18-32`, `src/routes/pengaturan/integrasi/admin/+page.server.ts:24`.
Sign-up (`src/routes/(auth)/daftar/+page.server.ts`) never checks that the person owns the address. There is no
verification flow, and no column to record that an address was verified. `isAdminEmail` admits whoever holds the
`users.email` row for a listed address. Exploit: suppose `ADMIN_EMAILS` names an address that has no account yet.
That could be an alias such as `ops@…`, a typo, or the owner's address on staging before the owner signs up there.
An attacker who registers that address first becomes admin. Case and Unicode tricks add nothing:
both sides go through the same `trim().toLowerCase()`. For example, `K` (the Kelvin sign) becomes `k`, so
`Kevin@` collides with `kevin@` on the unique index. What an admin can see today is limited: secret names and
booleans, `APP_ENV` and a count of users with a key. No values, and no data of any user. That is why this is low
severity now. It becomes high as soon as an admin page gains a write action or a per-user view.
Fix (before any admin write or drill-down): add verified-e-mail ownership (a `email_verified_at` column and a sign-up
confirmation link), and admit only verified accounts. Until then, the RUNBOOK should say: register the address first,
then list it.

### L2 (low): the "Tes koneksi" model id may go stale, and Anthropic's 404 `not_found_error` is reported as `network`
`src/lib/server/ai-keys/anthropic.ts:27` (`ANTHROPIC_TEST_MODEL = 'claude-haiku-4-5'`) and `:96-104`
(`classifyAnthropicResponse` has no case for 404 or `not_found_error`). This is QA finding 1; my severity is low.
It costs no confidentiality or integrity. Anthropic checks authentication before it resolves the model, so a revoked
key still gets 401 and is classified `invalid`. A `network` result also never overwrites the stored result (repo.ts).
The harm is availability and honesty. If the alias is retired, every valid key shows "Tidak bisa menghubungi
Anthropic sekarang" indefinitely, which falsely blames a transient network fault. I could not check offline whether
the model is retired; the owner's manual real-provider check decides. Fix: re-check the id against current Anthropic
docs, and map a 404 with `not_found_error` to its own server-side failure, logged as a configuration fault,
not shown to the user as "network".

### L3 (low): "Tes koneksi" does not opt out of AI Gateway caching or logging
`src/lib/server/ai-keys/anthropic.ts:118-131`. The request body is fixed (`ping`, `max_tokens: 1`), so it is
identical for every user, and only the `x-api-key` header differs. Exploit: suppose the owner turns on gateway response
caching. The cache key is built from the request, not the key header, so after one user's successful test, another
user's revoked key gets the cached 200 back. That stores `last_test_result = ok` for a key that does not work, which is
an integrity failure. Gateway logging is on by default, so each test is also kept in the owner's gateway logs. Those
entries hold only `ping`, and the gateway is not expected to show the key header, but this is unverified.
Fix: send `cf-aig-skip-cache: true` and `cf-aig-collect-log: false` on this call. Confirm both header names against
the current AI Gateway docs first.

### L4 (low, informational): one sealing secret opens every stored key
`src/lib/server/ai-keys/crypto.ts`. This is by design: the key has to open without the user present (PRD; RUNBOOK
says so). A leaked `AI_KEYS_ENCRYPTION_KEY` together with a D1 dump exposes every user's Anthropic key. Rotation
has no re-seal job either, so `_PREVIOUS` stays needed for as long as any old row exists. These are accepted
residual risks. Track them for when unattended AI jobs ship: a re-seal step, and keeping the secret out of any Worker
that does not need it (the RUNBOOK already holds it back from the jobs Worker until then).

## Checked and found sound

- **Sealing (`server-seal.ts`)**
  - Uses AES-256-GCM through WebCrypto, with a fresh `getRandomValues` 96-bit nonce on every seal.
  - Opening checks that the nonce is exactly 12 bytes.
  - The associated data is a JSON array: `[label, keyId, rowId, userId, provider]`. Moving a ciphertext to
    another user, row or provider fails to open (tested).
  - The key id is a SHA-256 over a label and the key, truncated to 8 bytes. Labels differ per feature.
  - Opening fails closed: it returns `null` and never a wrong plaintext, and strict UTF-8 decoding is used.
  - A missing or malformed current key (not exactly 32 bytes) is reported as not configured. It never falls back
    to a default key.
  - With only `_PREVIOUS` set, old rows still open and nothing new is sealed.
- **Connected-apps refactor:** the labels are unchanged, and the order of the associated data matches the old code
  exactly: `[label, keyId, rowId, spaceId, provider]`. The golden ciphertext vector test pins this. There is no
  downgrade path.
- **Leak paths:**
  - `listKeysForDisplay` selects only the provider, the last four characters, dates and the last test result.
  - Actions return `{done}` / `{tested}` / `{error}`; `fail()` never echoes the key.
  - Logs carry only `errorLabel(e)`, which is just the error name and code, so Drizzle "Failed query … params"
    text never reaches a log.
  - Audit rows record only the action and a timestamp.
  - The export writes `account.json` field by field with no key material, and `ai_key_audit` is not exported.
  - No Analytics Engine event and no `{@html}` was added.
  - The input is `type=password autocomplete=off`, and the form is reset on success.
- **Outbound call:**
  - The URL is built only from the env ids, each checked against `^[A-Za-z0-9_-]{1,64}$`, so the request cannot be
    redirected elsewhere (no SSRF).
  - Redirects are not followed (`redirect: 'manual'`).
  - The key must be printable ASCII with no spaces or CR/LF (`parseAiKey`), so it cannot inject headers.
  - The timeout is 10 s through `AbortSignal`.
  - Hostile response bodies are capped at about 4 KB and parsed defensively; the body is never sent to the caller.
  - Every exception becomes `network` and is not logged.
- **Throttle:** a per-user limit (`ai-key-test`, 5 attempts per window) is counted before the key is opened or the
  provider is called. It fails closed.
- **Authorization:** every action uses `locals.user.id` and the fixed provider `'anthropic'`; no id is read from the
  form. Cross-user `test` and `delete` attempts get 404 (QA test). `recordTestResult` is bound to the row id that was
  tested.
- **CSRF:** the global hook (`hooks.server.ts` with `csrf.ts`) refuses cross-site form POSTs. `readFormBody` accepts
  only form content types, so a JSON or other body cannot get around the check.
- **Admin gate:**
  - Signed out, not listed and `ADMIN_EMAILS` unset all get the same root 404, which avoids an existence oracle.
  - Each listed address is compared by SHA-256 in constant time without stopping at a match, with at most 20
    entries.
  - The page is read-only, only booleans are shown, and it is served `no-store`.
- **Migration 0028:**
  - Both tables cascade on user deletion.
  - (user, provider) is unique.
  - CHECK constraints cover the provider, status, test result and audit action.
  - The content check fixes the nonce at 16 characters and the key id at 11 (base64url of 12 and 8 bytes), keeps the
    last four at 4, and caps the ciphertext at 1000 characters.
  - No existing table changes.
- **Account deletion:** `ai_keys` and `ai_key_audit` are deleted inside the proof-guarded batch, and the foreign-key
  cascade backs this up.
- **Engineering checklist:**
  - Queries are parameterised (the Drizzle `sql` template binds values) and bounded.
  - Writes and their audit rows go in one `db.batch`.
  - Only the last 4 characters are kept.
  - The AI call goes through AI Gateway with a timeout. Credit metering does not apply, because this is BYOK and
    the user pays.
  - The test fixture key exists only in `playwright.config.ts`, is local-only and is not a secret.

## Commands

- `flock … npx vitest run --maxWorkers=2 src/lib/server/admin.test.ts src/lib/server/ai-keys src/lib/server/connected-apps/crypto.test.ts src/lib/shared/ai-keys.test.ts`
  → 5 files, 45 tests passed.
- The integration and e2e suites were not re-run (QA ran them). No real Anthropic or gateway call was made.
