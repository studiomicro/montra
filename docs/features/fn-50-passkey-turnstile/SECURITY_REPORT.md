# FN-50 Security report — Passkeys and Turnstile

Reviewer: red-team-pentester, 2026-10-13. Scope: `git diff main...HEAD` on `feat/fn-50-passkey-turnstile`
(HEAD 90e9b53, based on main 19af7cc), checked against the PRD (owner decisions 1–15) and
`docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No high or medium findings. Five low findings are listed below for tracking.

## What was attacked, and what held

### WebAuthn verifier (`src/lib/server/auth/webauthn-verify.ts`)

- **Challenge binding.** The challenge is read from `clientDataJSON` with `atob` (`passkey-flow.ts:97`). It is then
  looked up in D1 (`passkey-flow.ts:81`) and compared again after `base64urlDecode` (`webauthn-verify.ts:362`), so a
  difference between the two decoders cannot swap challenges. The kind is checked: a `register` challenge cannot
  sign in, and a `sign_in` challenge cannot register (PoC). A register challenge is bound to the user
  (`passkey-flow.ts:205`, with `insertPasskey` guarding again on `user_id`).
- **Single use and expiry.** The guarded `UPDATE … used_at IS NULL AND expires_at > now` runs inside the batch that
  writes the session or passkey (`session.ts` `createPasskeySession`, `passkeys.ts:143`). `used_by` ties the consume
  to the row that was written. Replay and the 20-way race are covered by the existing tests. An expired `sign_in`
  challenge was refused (PoC).
- **Origin and rpId.** The origin is compared exactly with `url.origin`. The rpIdHash is compared in constant time
  with SHA-256(host). An rpId is refused on IP literals, `*.workers.dev` and non-loopback hosts without a dot
  (`passkey-flow.ts:47`). `frame-ancestors 'none'` makes the `crossOrigin` and `topOrigin` fields that are ignored
  irrelevant.
- **Flags.** UP is required. UV is not required (L1).
- **Counter.** Rollback is refused and recorded as `passkey_counter_rollback`. The forward move is re-checked inside
  the session batch (`passkeys.counter < new or 0 = 0`), so two concurrent assertions from a cloned authenticator
  cannot both win with the same counter.
- **CBOR, COSE and DER.** Only definite lengths are accepted. Depth is capped at 8 and items at 64. Tags,
  floats, indefinite lengths and 8-byte lengths throw. Every field is capped at 6000 characters (clientData at 4000)
  before decoding. ES256 requires kty 2, crv 1 and 32-byte x and y. A point that is not on the curve is refused
  (WebCrypto import fails; PoC). RS256 requires a 2048–4096-bit modulus and an exponent of at most 8 bytes. DER
  integers longer than 33 bytes are refused.
  PoC fuzz: 3,000 byte flips of a registration and 6,000 of an assertion (authData and signature). Result: 0 throws
  and 0 accepted assertions. Some mutated registrations were accepted, which is expected under attestation `none`:
  no signature covers them, and a changed credential id is caught by `id_mismatch`.
- **Credential collisions.** The partial unique index on `credential_id` (live rows) holds globally. When B
  registered A's live credential id with B's own key (attestation `none`), it was refused. A still signed in, and
  B's key over A's id was refused (PoC). The user handle is opaque (SHA-256 of a tag and the user id), and the
  server maps credential to user, so a returned `userHandle` is never trusted.
- **Account state.** A disabled user gets no session: the guard is inside the INSERT … SELECT. After account
  deletion the passkey rows are gone and an assertion is refused (PoC). The per-account password lockout does not
  block passkey sign-in, which is by design: an assertion cannot be guessed.
- **Session fixation.** A fresh token is issued for each sign-in. The session in the replaced cookie is revoked
  (`masuk/+page.server.ts:121`). The cookie writer is shared with password sign-in.
- **Decision 8.** A passkey session holds no key material. Key material is returned only by `keyMaterial` (behind
  `proveCurrentPassword`) and by the password sign-in action. The new inline unlock form sends the password only to
  `keyMaterial` and opens the key on the device. Password change, account deletion, API tokens and key material
  still demand the password (AC 37 test).
- **Decision 9.** The app has no password-reset flow (grep: none), so an attacker who controls only the mailbox
  cannot set a password and then add a passkey. Adding a passkey requires the current password through
  `proveCurrentPassword`, and the step is silent (L2).
- **Decision 10.** Removing a passkey revokes the sessions linked to it in `passkey_sessions`, in the same batch as
  the tombstone. A session of the removed passkey on another device stopped resolving immediately, and the remover's
  session stayed (PoC). A concurrent sign-in either commits first, so its session is linked and then revoked, or it
  sees the tombstone and is refused.
- **CSRF.** The new actions are form actions under the hook-level cross-site check (`hooks.server.ts:71`). Only
  Bearer API routes are exempt. This also covers login CSRF on `/masuk?/passkey`.
- **Enumeration and rate limits.** `passkeyOptions` takes no identifier and returns no credential list.
  `passkey-begin` allows 60 per client per window and `passkey-finish` 20. `passkey-manage` allows 20 per user,
  and `account-password` also applies to register and remove. All of these fail closed. An unknown credential and a
  removed one get the same status and body.
- **auth_events.** Rows hold only id, user, kind, passkey id and time: no IP, user agent or key material. The export
  omits `passkey_id`, and the export of `passkeys` omits the credential id, public key and counter. Rows are swept
  after 90 days and deleted with the account. Log lines carry reason labels only.

### Turnstile

- `requireBotCheck` runs after the throttle and before PBKDF2 in `?/password` (`masuk/+page.server.ts:56-65`) and in
  `/daftar` (`daftar/+page.server.ts:49-53`). The token is capped at 2048 characters before any fetch.
  `idempotency_key` is a fresh UUID for each call, so a reused token is refused as a duplicate. `action` and
  `hostname` are checked exactly. The timeout is 5 s, and timeouts, non-2xx answers, non-JSON answers and anything
  without `success: true` are refused (fail closed). With no keys, or with only one, there is no check and no
  widget, and the admin page shows `partial` or `missing`.
- **Bypass by route.** `signInWithPassword` has one signed-out caller, `?/password`; there is no `default` action
  left. Every other password proof (`proveCurrentPassword` and account deletion) requires a session. There is no
  password reset and no API sign-in (`/api/v1` is Bearer-only). The passkey path needs an unforgeable assertion
  rather than a password, so the PRD excludes it from Turnstile.
- **CSP.** The extra source is added only when `event.route.id` is `/(auth)/masuk` or `/(auth)/daftar` and the
  check is configured. Only `script-src` and `frame-src` are extended, and there is no `'unsafe-inline'`.
- **Secret.** `TURNSTILE_SECRET_KEY` is read only in `src/lib/server/auth/turnstile.ts`. Loaders return
  `{ siteKey }` or null, and the admin page returns a state label only.

## Findings

| # | Severity | Location | Issue and scenario |
|---|----------|----------|--------------------|
| L1 | low | `src/lib/server/auth/webauthn-verify.ts:438`, `src/lib/server/auth/passkey-flow.ts:150,163` | User verification is `preferred` and is never enforced at sign-in. The `userVerified` result is computed but neither stored nor checked. A roaming security key without a PIN (UP only) is enough on its own to sign in. PoC: an assertion with flags `0x01` returned `{ok:true,userVerified:false}`. Someone who steals such a key gets a session that can read every financial row (sensitive actions still need the password). This follows the PRD's `preferred` default; consider requiring UV for sign-in, or refusing UP-only assertions for passkeys registered with UV. |
| L2 | low | `src/routes/(app)/pengaturan/akun/passkey/+page.server.ts:75-100` | Adding a passkey sends no notification, e-mail or otherwise. Combined with Owner decision 9 (passkeys survive a password change), an attacker who once phished the password can add a passkey and keep signing in after the victim changes it. The only cue is the passkey list. Recommend an e-mail when a passkey is added, and a "review your passkeys" prompt on password change. |
| L3 | low | `src/routes/(auth)/masuk/+page.server.ts:88-96`, `src/lib/server/auth/passkeys.ts:277` | Unauthenticated `sign_in` challenge rows are capped at 60 per client per 10 minutes, but a botnet with many IPs can insert many rows. Turnstile does not cover this action, and expired rows are swept only when the next challenge is inserted. The cost is bounded D1 storage growth. Consider a global cap or a Cron sweep. |
| L4 | low | `src/lib/server/auth/passkey-flow.ts:268` | `passkey_refused` rows are written for anyone who posts a known credential id with a bad signature, without authentication. Someone who learns a victim's credential id can add up to 20 rows per IP per window to the victim's `auth_events`. This is harmless today because the rows are not shown. Rate-limit per passkey, or dedupe, before the planned "Aktivitas masuk" page shows them. |
| L5 | low | `src/lib/server/auth/webauthn-verify.ts` (whole file) | The checklist says "never invent a" primitive, and this parser and verifier are hand-rolled. The owner sanctioned the fallback (decision 13), and every signature check uses WebCrypto. Fuzzing found no throw and no forged accept. Keep the recorded Chromium fixture, and add a Safari/iOS fixture before relying on RS256 or other authenticators in production. |

## Checks run

- `npx vitest run src/lib/server/auth/webauthn-verify.test.ts`: 18 passed.
- `npx vitest run src/lib/server/auth/turnstile.test.ts`: 8 passed.
- `npx vitest run test/integration/passkeys.test.ts`: 41 passed.
- `npx vitest run test/integration/turnstile.test.ts`: 17 passed.
- Red-team PoC unit file (fuzzing, CBOR bombs, UV-only, ES256 point not on curve, challenge decode parity): 6 passed.
- Red-team PoC integration file (cross-account credential id, challenge kind swap, removal revokes another
  device's session, deleted account, expired challenge): 5 passed.
- Both PoC files were deleted afterwards.
- Not run: the full suite, Playwright, and a real Turnstile widget on staging (AC 15 is an owner check).
