# FN-21 Account key — Security report (cycle 1)

Reviewed: `git diff 0c30d13..6149a10` (detached at 6149a10), PRD, ENGINEER_REPORT, `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: FAIL

One medium finding (M1). The cryptography itself is sound; the failure is in the new password-change path.

## Findings

### M1 (medium): changing the password leaves every other session signed in

- Where: `src/lib/server/auth/change-password.ts:220-230`, `src/routes/(app)/pengaturan/akun/+page.server.ts:76-104`.
  `changePassword` is new in this diff (FN-01 had no password change). It updates `user_passwords` and the key
  row but never touches `sessions`.
- Exploit: an attacker holding a stolen session cookie (shared device, malware, a leaked backup) keeps full access
  to every space's financial data after the victim changes the password, which is the usual response to a
  suspected compromise. Reproduced locally: sign in twice as A (sessions S1 and S2), change the password from S1,
  then `GET /pengaturan/akun/__data.json` with S2 → 200 with A's account data.
- Fix: in the same `db.batch`, after the guarded password UPDATE, delete the user's other sessions (all sessions
  of `userId` except the current session's hash), guarded on the new hash so it runs only when the change commits.
  Optionally re-issue the current session. Add an integration test with two sessions.

### L1 (low): re-wrap is accepted for a key that is not stale, and the server cannot tell whether the wrap opens

- Where: `src/routes/(app)/pengaturan/akun/+page.server.ts:129-147`, `src/lib/server/account-keys/repo.ts:262-287`.
- Scenario: anyone with the session and the current password can post `?/rewrapAccountKey` with the right public
  key and `keyVersion` (from `?/keyMaterial`) and 64 random bytes as `wrappedPrivateKey`. The row is overwritten;
  the private key is then lost for good and every sealed result becomes unreadable. Same holds for the re-wrap
  inside `changePassword`. Needs the password, so impact is destruction rather than disclosure.
- Fix: accept `rewrapAccountKey` only while the key is stale (`account_keys.updated_at < user_passwords.updated_at`
  in the guarded UPDATE). The opaque-wrap limit is inherent; document it.

### L2 (low): the opened private key outlives a session that ends elsewhere

- Where: `src/lib/ui/account-key/device.ts:33-60`.
- Scenario: the key is dropped on this tab's sign-out, account deletion and the next sign-in submission, but not
  when the session expires, is revoked from another device or is signed out in another tab. It stays usable for
  unseal in that open tab until reload. Memory only, non-extractable, so exposure is small.
- Fix: drop the key when a load returns no user (for example in the `(app)` layout when `data.user` is null) or on
  a 401 from any action.

### L3 (low): password-proving account actions have no per-client throttle

- Where: `src/routes/(app)/pengaturan/akun/+page.server.ts:49-56` (used by `keyMaterial`, `changePassword`,
  `activateAccountKey`, `rewrapAccountKey`).
- Scenario: wrong passwords count toward the account lockout. With the correct password, though, a session holder
  can call `?/keyMaterial` in a loop and every call runs PBKDF2 at the Workers CPU cap. `/masuk` and `/daftar`
  use `overAttemptLimit`; these actions do not.
- Fix: apply `overAttemptLimit` (per client and per user) before `signInWithPassword` in `proveCurrentPassword`.

### L4 (low, informational): the scrypt Web Worker script is served without its own CSP

- Where: build output `/_app/immutable/workers/derive.worker-*.js`, served by Workers Assets under `_headers`,
  which sets no `Content-Security-Policy` for `/_app/*`.
- Under CSP Level 3, a dedicated worker uses the policy delivered with its own script response, so this worker
  runs without one. It is first-party, makes no network calls and is instantiated same-origin (no blob/data URL),
  so the document CSP (`script-src 'self'` → `worker-src` fallback) allows it. There is no violation today.
- Fix (optional): add a `Content-Security-Policy: default-src 'none'` header for `/_app/immutable/workers/*` in
  `_headers`.

### Informational, no action this pass

- Sign-in sends the password to the server (FN-01 design). A malicious or compromised app Worker could capture it
  and derive the wrap key, so sealing protects against D1/R2 and backup exposure, not against a hostile app
  deploy. This is an accepted architectural limit; it should be stated on `/privasi`.
- HKDF uses an empty salt (`src/lib/shared/account-key.ts:254`). That is acceptable under RFC 5869 because `info`
  binds the label `financer/account-key/seal/v1`, the ephemeral key and the recipient key.

## Checked and passing

- Primitives (`src/lib/shared/account-key.ts`): WebCrypto X25519, HKDF-SHA256 and AES-256-GCM. Each wrap and seal
  gets a fresh 96-bit random nonce, and each seal a fresh ephemeral key pair. Header (version‖epk‖nonce) is the
  AAD for seals; label‖public key is the AAD for wraps. HKDF info binds the version label and both public keys.
  Version and length checks run in `decodeSealed`/`unseal`. A tag failure throws or returns null and never yields
  partial plaintext. PKCS#8 bytes and the derived key are zeroed after import. The held key is non-extractable.
- scrypt: N=2^17, r=8, p=1, dkLen=32 with a fresh 16-byte salt for each wrap. `isAllowedScryptParams` needs exactly
  5 keys, r=8, p=1, dkLen=32 and N a power of two in [2^17, 2^18]. The client checks this in `decodeAccountKey`
  before deriving (a tampered server cannot downgrade the cost or ask for more than 256 MiB). The server checks it
  too. Live: sign-up with N=1024 → 400 and N=2^30 → 400; nothing is stored. The server never runs scrypt (no
  server-side DoS).
- Wrapped key exposure: absent from `/pengaturan/akun` HTML and `__data.json`. It is returned only by `?/keyMaterial`
  after a password proof (wrong → 400 with no material, no session → 401, cross-origin → 403) and by the `/masuk`
  success with `withKey=1`. No secrets appear in the wrangler log (0 matches for the passwords or key fields).
- IDOR: the user id always comes from `locals.user`. User B's `?/keyMaterial` returns `material: null`, and B
  re-wrapping with A's public key → 409.
- Concurrency: activation uses `INSERT … SELECT` guarded on the proven hash with a unique `user_id`. The re-wrap
  and password change form one batch guarded on version, public key and hash.
- Account deletion removes `account_keys` before `users`.
- `@noble/hashes` is pinned at 2.4.0 and imported only for `scrypt` (one import site). The worker is emitted as a
  same-origin file.
- Test vectors assert concrete values: RFC 7748 §5.2/§6.1, RFC 5869 TC1/TC3, RFC 7914 §12. Tests also cover
  wrong password, tamper, fresh nonce and re-wrap round trip.
- ENGINEERING_CHECKLIST: Sealed results (vetted primitives, fresh nonce, round-trip and wrong-password tests): met.
  The other items are not touched by this diff.

## Commands

- `npx vitest run src/lib/shared/account-key.test.ts src/lib/shared/account-key-fields.test.ts src/lib/server/account-keys/validation.test.ts test/integration/account-keys.test.ts` → 4 files, 92 tests passed.
- `npm run build` → exit 0; worker emitted at `_app/immutable/workers/derive.worker-*.js`.
- `npm run db:reset:local` → exit 0; `wrangler dev --port 8827 --local` → live probe run as described above,
  server stopped afterwards.

## Cycle 2 re-check

Reviewed `git diff 1e533c5..8df4303` (cycle-2 commit 8df4303 on top of main 9c77de9 plus the cherry-picked reports).

### Overall: PASS

No medium or high findings remain. The new lows are listed below for tracking.

| Finding | Status | Evidence |
| --- | --- | --- |
| M1 other sessions survive a password change | FIXED | `change-password.ts`: other sessions are revoked and their push subscriptions tombstoned in the same batch, guarded on the new hash, and the current session is kept. Live test: sessions S2 and S3 had data before the change; afterwards both got a redirect to `/masuk`, S1 still got 200 with data, and the old password was refused (400). A change with a forged check gave 409 and revoked nothing. |
| L1 re-wrap of a key that is not stale, or of an opaque wrap | FIXED | `rewrapAccountKey` now uses `staleOnly` and requires `key_check`. Live test on a stale key: forged check → 409, the real check with a swapped public key → 409, no check → 400, real check → 200. Re-wrapping the same key again once it was no longer stale → 409. `?/keyMaterial` does not return `key_check`. |
| L2 opened key outlives a session ended elsewhere | FIXED | `device.ts` `announceSignOut`/`watchSessionEnd` (BroadcastChannel plus a session check on `visibilitychange`), the `(auth)` layout's `onMount(dropDeviceKey)`, and a 401 effect in both error pages. Covered by unit tests in `device.test.ts`. Not checked in a browser this cycle (no Playwright run). |
| L3 no per-client throttle on account-page password actions | FIXED | `proveCurrentPassword` counts per client and per user before PBKDF2 runs. Live test: wrong-password `?/keyMaterial` calls reach 429 within the 20-attempt budget. |
| L4 scrypt worker served without a CSP | FIXED | `_headers` → the built `.svelte-kit/cloudflare/_headers` has `/_app/immutable/workers/*` with `Content-Security-Policy: default-src 'none'; base-uri 'none'`. The worker is a single IIFE file with no imports or fetches, so the policy does not break it. |

**`key_check` analysis.** It is HKDF-SHA256(X25519(sk, own pk)), with info = `financer/account-key/check/v1`‖pk, giving 32 bytes.
- It does not depend on the password, so it gives no shortcut for offline password guessing. Testing a guess
  against a D1 dump still needs one scrypt N=2^17 per guess plus the GCM tag.
- It tells nothing about any seal key, because a seal key uses X25519(sk, ephemeral) and a different HKDF label.
- It can be forged only with the private key. Swapping the public key fails because both `public_key` and
  `key_check` must match the row, and neither column is ever overwritten.
- Replaying an old check works by design: the check is constant for the key pair. But only someone who once held
  the private key could have computed it.

### New findings (cycle-2 diff only)

- **N1 (low): the per-user budget also counts successful attempts and can be spent by any holder of the session.**
  Where: `src/routes/(app)/pengaturan/akun/+page.server.ts` `proveCurrentPassword` → `overUserAttemptLimit`.
  Scenario: an attacker with a stolen session sends 20 `?/keyMaterial` requests every 10 minutes. The real user
  then gets 429 on "Ubah kata sandi", which is the action that now evicts the attacker (M1).
  This adds no real capability: since FN-01, a session holder can already lock the account by entering wrong
  passwords (the account lockout). Fix (optional): count only failed proofs per user, or let a request from a
  different client exceed the per-user budget when the password is correct. A future "sign out all devices"
  should not depend on this budget.
- **N2 (low, hardening): `key_check` is stored in plain form.** Where: `account_keys.key_check` (`repo.ts`).
  Scenario: someone who reads a D1 backup and also holds a session and the current password could replay the
  check and overwrite a stale key with an unusable wrap (destruction only, no disclosure). Fix: store
  SHA-256(key_check) and compare the hash of the submitted value.
- Note: migration `0011_account_keys.sql` was edited in place to add `key_check`. This is fine only because 0011
  has never been applied to staging or production (FN-21 is unshipped). Check this before `/ship`.

### Cycle 2 commands

- `npm ci` → exit 0. `npx svelte-kit sync` → done.
- `npx vitest run --maxWorkers=2` on the 6 FN-21 test files (account-key, account-key-fields, validation, device,
  integration account-keys, static-headers) → 6 files, 116 tests passed.
- `npm run build` → exit 0; `_headers` rule for the worker present in the output.
- `npm run db:reset:local` → exit 0. `wrangler dev --port 8827 --local` was used for the live probe above. Its
  log had 0 matches for the passwords or key fields. The server was stopped afterwards.
