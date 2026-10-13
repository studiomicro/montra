# FN-50 — Passkeys and bot check on sign-in

Owner request 2026-10-12: "add passkey and cloudflare bot checker sign in on login". Two parts, one build: **Part A**
Cloudflare Turnstile on `/masuk` and `/daftar`; **Part B** passkeys (WebAuthn) as a second way to sign in beside
e-mail + password (no Google sign-in, owner decision 2026-10-07). Risk tier: **Large** (new sign-in path, two new
tables, a third-party script inside the CSP, interaction with the FN-21 account key, adversarial replay/origin/counter
paths).

Fixed by earlier owner decisions and not re-opened here: e-mail + password stays the primary credential and every
account has one (`src/lib/server/auth/accounts.ts:77-121` requires a password at sign-up); sessions stay opaque,
hashed, 30-day (`src/lib/server/auth/session.ts:13`); the account key stays wrapped under a scrypt password key (FN-21).

## Goal

Sign-in is the gate to everything Montra holds about a person's money, and it is also the one page a bot can hammer
without an account. Today it is protected only by the per-client throttle (`src/lib/server/auth/throttle.ts:196-208`,
20 attempts per 10 minutes) and the per-account lockout. Turnstile stops credential-stuffing and sign-up floods before
they cost a PBKDF2 derivation or a D1 row, without a CAPTCHA puzzle. Passkeys give a returning user a one-touch sign-in
(Face ID, fingerprint, device PIN) that cannot be phished or reused across sites, which matters for a product that is
opened many times a day on a phone and whose password also unlocks the account key.

## Scope

### Part A — Turnstile

- **Server module** `src/lib/server/auth/turnstile.ts`: `isTurnstileConfigured(env)` (true only when both
  `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are non-blank), `turnstileState(env)` (`ok` / `partial` / `missing`
  for the admin page, like `webPush` at `src/routes/pengaturan/integrasi/admin/+page.server.ts:46`), and
  `verifyTurnstile(env, token, expected: { action, hostname }, remoteip)` that POSTs to Cloudflare's siteverify
  endpoint with `secret`, `response`, `remoteip` (the `CF-Connecting-IP` value, see Owner decisions #3) and a fresh
  UUID `idempotency_key`, under an `AbortSignal.timeout` of 5 s, and returns `ok` only when the answer has
  `success: true`, `action` equal to the expected one (`sign-in` / `sign-up`) and `hostname` equal to the request host.
  Anything else (timeout, network error, non-JSON, `timeout-or-duplicate`, `invalid-input-response`) is `refused`
  with a reason label for the log line only. Token length capped (2048 characters) before any call.
- **Form actions** `src/routes/(auth)/masuk/+page.server.ts:22-53` and `src/routes/(auth)/daftar/+page.server.ts:25-67`:
  after the existing field check and the existing throttle count (so a flood still costs one row write, never a
  siteverify call), when configured, read `cf-turnstile-response`; missing or refused → `fail(400, { error:
  BOT_CHECK_FAILED })` before any password derivation. The check runs in both actions and in nothing else.
- **Loaders** of both pages return `turnstile: { siteKey } | null` (the site key is public; the secret is never
  serialised).
- **Widget** on both pages: Turnstile's script from `https://challenges.cloudflare.com/turnstile/v0/api.js` loaded
  only when `turnstile` is non-null, explicit render into a container inside the form, `action` `sign-in` / `sign-up`,
  `language` from the active locale (`id` / `en`), `theme` following `data-theme`, `size: 'flexible'` so it fits a
  360 px column, Managed mode (Owner decisions #2). After a failed submit the widget is reset (a token is single-use).
  A `<noscript>` line under the form explains that sign-in needs JavaScript while the bot check is on (Owner
  decisions #4).
- **CSP**: `src/lib/server/csp.ts:10-26` stays unchanged for every other route. For the `/(auth)/masuk` and
  `/(auth)/daftar` route ids only, and only when configured, `hooks.server.ts` appends `https://challenges.cloudflare.com`
  to `script-src` and `frame-src` of the response's `content-security-policy` header. A test asserts the header of `/`
  and `/pengaturan/akun` is byte-identical to today's.
- **Third-party statement** (CLAUDE.md "no third-party trackers"): Turnstile is Cloudflare infrastructure, the same
  provider that already terminates every request to `<staging-app-host>`; it sets no advertising identifier and Montra
  sends it nothing but the challenge token and the connecting IP Cloudflare already has. `docs/PRIVACY` draft and
  `/privasi` get one sentence saying so (Owner decisions #5).
- **Visibility when unset**: no widget, no check, nothing in the form; `/pengaturan/integrasi/admin` shows
  `Turnstile — Belum dikonfigurasi` (or `sebagian` when exactly one of the two values is set); RUNBOOK › Secrets gains
  the two names. A partial configuration also logs one `console.error('turnstile: partial configuration')` per
  request to the two auth actions. Never a silent fail-open that looks configured: the admin line is the truth.
- **i18n**: `BOT_CHECK_FAILED` = "Verifikasi keamanan gagal. Muat ulang halaman lalu coba lagi.", the `<noscript>`
  line, the widget's accessible label, the admin status label, all with `i18n-en.ts` entries.
- **Tests**: unit tests of `verifyTurnstile` against a stubbed `fetch` (success, wrong action, wrong hostname,
  duplicate, timeout, non-JSON); integration tests of both actions configured / unconfigured / partial; Playwright with
  Cloudflare's documented always-pass and always-block test keys in `.dev.vars` (Browser level; a real widget on
  staging is Pass level and an owner check).

### Part B — Passkeys

- **Library decision (verified 2026-10-12 against the JSR listing and the `simplewebauthn.dev` docs; not yet run on
  workerd in this repo)**: `@simplewebauthn/server` 13.x states it runs on Cloudflare Workers; its dependency tree is
  `@peculiar/asn1-*`, `@peculiar/x509`, `@hexagon/base64`, `@levischuck/tiny-cbor` (no Node-only API in the ESM build
  per the listing). Proposed: pin the newest 13.3.x release that is at least two weeks old on the build day
  (13.3.3 was published within days of writing; 13.3.1 otherwise) exactly in `dependencies`, following the
  deps-audit rules (`docs/features/deps-audit/REPORT.md`: exact pin, two-week age, `npm audit --omit=dev` 0,
  grep for `eval`/`new Function`, note the bundle size). **First task of the build is a spike**: `npm run build` plus
  one `wrangler dev` round-trip of `verifyRegistrationResponse` with attestation `none`. If the bundle fails on
  workerd or exceeds 300 KB minified for this feature, fall back to a minimal verifier in
  `src/lib/server/auth/webauthn-verify.ts` (CBOR decode of `attestationObject`, authData parse, COSE → WebCrypto
  import for ES256 and RS256 only, `clientDataJSON` type/challenge/origin checks, signature over
  `authData || SHA-256(clientDataJSON)`), with the test vectors from the W3C spec and from a real Chrome/Safari
  registration recorded as fixtures. Either way: attestation `none`, algorithms ES256 (-7) and RS256 (-257), user
  verification `preferred`, resident key `preferred` (discoverable), no attestation statement stored or parsed.
- **Migration `migrations/0044_passkeys.sql`** (the FN-48c branch in flight takes 0043 `transfer_links`; renumber to
  0043 if that branch has not merged first). Two tables and one audit table, no `space_id` (credentials belong to a
  user, like `api_tokens` and `ai_key_audit`, `src/lib/server/db/schema.ts:222-239`):
  - `passkeys`: `id`, `user_id` (FK users, no cascade — deleted in `deleteAccount`), `credential_id` (base64url),
    `public_key` (COSE, base64url), `algorithm` (-7 / -257), `counter` integer, `transports` (JSON array text),
    `aaguid` (36-char text, may be the zero UUID), `name` (≤ 40 chars, cleaned with `cleanText`), `rp_id`,
    `backed_up` integer 0/1, `created_at`, `last_used_at`, `updated_at`, `deleted_at`. Partial unique index on
    `credential_id` where `deleted_at is null`; index `(user_id, created_at)`.
  - `passkey_challenges`: `id`, `challenge` (base64url, unique), `kind` CHECK in (`register`, `sign_in`), `user_id`
    (set for `register`, null for a discoverable `sign_in`), `created_at`, `expires_at` (created + 5 minutes),
    `used_at`. Consumed by one guarded `UPDATE … SET used_at = ? WHERE challenge = ? AND used_at IS NULL AND
    expires_at > ? RETURNING` inside the verify path; expired rows older than 1 hour deleted on the next insert, like
    `countAttempt`'s sweep (`throttle.ts:149-151`).
  - `auth_events`: `id`, `user_id` (FK users, cascade), `kind` CHECK in (`passkey_added`, `passkey_removed`,
    `passkey_sign_in`, `passkey_refused`, `passkey_counter_rollback`), `passkey_id` nullable, `created_at`. No IP, no
    user agent, no credential material. Kept 90 days, swept by the jobs Worker's existing retention sweep (Owner
    decisions #11).
- **Server modules**: `src/lib/server/auth/passkeys.ts` (repo: list for a user, insert guarded on a consumed
  `register` challenge and the per-user cap, soft-delete guarded on `user_id`, `touchUsed(counter, now)` guarded on
  `counter < new` or new = 0), `src/lib/server/auth/passkey-flow.ts` (`registrationOptions`, `verifyRegistration`,
  `signInOptions`, `verifySignIn`: challenge issue/consume, `rpId` and expected origin from the request, see Owner
  decisions #7), `createPasskeySession(db, userId, passkeyId, now)` in `session.ts` next to `createPasswordSession`
  (`session.ts:65-96`): an `INSERT … SELECT` guarded on the passkey row still live and the user `active`, same
  `last_login_at` update. Throttle scopes added to `THROTTLE_SCOPES` (`throttle.ts:22-61`): `passkey-begin` (per
  client, 60 per window: conditional UI issues one challenge per `/masuk` load), `passkey-finish` (per client, 20),
  `passkey-manage` (per user, 20). All fail closed like the rest (`throttle.ts:187-190`).
- **Sign-in UI** `src/routes/(auth)/masuk`: actions `passkeyOptions` (returns the options JSON after a `passkey-begin`
  count and a challenge insert) and `passkey` (receives the assertion fields, counts `passkey-finish`, verifies,
  creates the session, revokes the replaced cookie's session exactly as `masuk/+page.server.ts:41`, tracks
  `sign_in` with `method: 'passkey'`, redirects through `safeReturnTo`). With JavaScript and
  `PublicKeyCredential.isConditionalMediationAvailable()` true, the e-mail field gets `autocomplete="username webauthn"`
  and a conditional `navigator.credentials.get` starts on mount; a "Masuk dengan passkey" button under the form is
  the fallback and is hidden when `window.PublicKeyCredential` is undefined. Without JavaScript neither appears and
  the password form works as today. Pending / cancelled / refused states with copy.
- **Management UI** new page `src/routes/(app)/pengaturan/akun/passkey/+page.server.ts` + `+page.svelte`, linked from
  `/pengaturan/akun` ("Passkey" row) and listed under Akun in `src/routes/(app)/pengaturan/+page.svelte:28-56`. Load
  returns the user's live passkeys (name, created, last used, `backed_up`, transports; never the public key).
  Actions: `registerOptions` (password re-proven through `proveCurrentPassword`,
  `src/lib/server/auth/prove-password.ts:16-32`, then options), `register` (verifies, inserts, writes
  `passkey_added`), `remove` (password re-proven, soft-deletes, writes `passkey_removed`, and revokes every session
  created by that passkey other than the current one — see Owner decisions #10). Empty state ("Belum ada passkey"),
  unsupported-browser state, cap-reached state, saving and success states. Name defaults to the authenticator
  description when the browser gives one, else "Passkey <WIB date>", editable in the register sheet only.
- **Account key interaction (FN-21)**: Owner decisions #8, recommended Option 1. A passkey session holds no account
  key. The existing "key not held" state in `src/lib/ui/account-key/AccountKeySection.svelte:171` ("Keluar lalu masuk
  lagi …") becomes an inline "Buka kunci dengan kata sandi" form that calls the existing `keyMaterial` action
  (`pengaturan/akun/+page.server.ts:57-63`) through `fetchKeyMaterial` (`device.ts:122-138`), opens the key on the
  device with `openAccountKey` (`device.ts:225-239`) and `holdDeviceKey`. Every feature that needs the key already
  reads `deviceKey()` and shows its own "key not open" copy; those copies link to the account page instead of saying
  "sign out". No change to `account_keys`, no second wrap.
- **Account deletion**: `deleteAccount` (`src/lib/server/auth/delete-account.ts:97-179`) gains guarded deletes of
  `passkeys`, `passkey_challenges` (by `user_id`) and `auth_events` before the credential delete. Deletion still
  requires the password (`pengaturan/akun/+page.server.ts:165-190`): a passkey never proves identity for deletion.
- **Password change**: `changePassword` (`src/lib/server/auth/change-password.ts:33-88`) leaves passkeys as they are
  (Owner decisions #9); other sessions are already revoked there, passkey-created ones included.
- **i18n**: every new phrase in `i18n.ts` with an `i18n-en.ts` entry; server messages via `msg()` like
  `auth/messages.ts`.
- **Docs**: RUNBOOK › Secrets (two Turnstile names, "none for passkeys"), RUNBOOK a "Passkeys" section (rpId per
  host, what a host change means), `docs/FEATURES.md` FN-50 (added with this PRD), `docs/PRD.md` one line under
  FN-01.

## Out of scope

- Passkey-only accounts (no password), password reset by passkey, account recovery codes.
- WebAuthn PRF or a second wrapped copy of the account key (Owner decisions #8 option 2) — deferred.
- Renaming a passkey after registration; passkey sign-in for the public API (FN-38) or the offline queue.
- Attestation verification, AAGUID → authenticator-name lookup table, MDS metadata.
- Turnstile anywhere else (invite acceptance, `/hapus-akun`, API); Turnstile Enterprise features (pre-clearance,
  Any Hostname); Cloudflare WAF / Bot Management rules (dashboard, owner).
- Showing the `auth_events` list to the user (stored this pass; "Aktivitas masuk" page later).
- Step-up: a passkey proving identity instead of the password for key material, password change, API tokens or
  deletion.
- Changes to session lifetime, idle sign-out, or cookie names.

## Acceptance criteria

QA tests these verbatim. Levels: **Automated** (Vitest, local D1), **Browser** (Playwright on `wrangler dev` with
Chromium's virtual authenticator for WebAuthn and Cloudflare's test keys for Turnstile), **Pass** (real widget on
staging; owner).

### Part A — Turnstile

1. Given `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are both unset, when `/masuk` and `/daftar` render, then no
   Turnstile script, container or `<noscript>` line is in the HTML, the CSP header equals today's, and sign-in and
   sign-up behave exactly as before. Automated.
2. Given exactly one of the two is set, when the pages render and the actions run, then behaviour equals AC 1, the
   admin page shows the Turnstile row as `sebagian`, and one `console.error` line without any value is logged per
   auth action call. Automated.
3. Given both are set, when `/masuk` renders, then the HTML contains the widget container with `data-action="sign-in"`
   and the script tag for `https://challenges.cloudflare.com/turnstile/v0/api.js`, the response CSP's `script-src` and
   `frame-src` include `https://challenges.cloudflare.com`, and the CSP of `/` and `/pengaturan/akun` is unchanged.
   Automated.
4. Given both are set, when the sign-in form is posted without `cf-turnstile-response`, with an empty one, or with a
   2049-character one, then the action answers 400 with "Verifikasi keamanan gagal. Muat ulang halaman lalu coba
   lagi." (English: its `i18n-en.ts` entry), no password derivation runs (the stub `signInWithPassword` is not
   called) and no siteverify request is made for the over-length token. Automated.
5. Given a stubbed siteverify answering `success: true` with the expected `action` and `hostname`, when valid
   credentials are posted with a token, then the sign-in succeeds exactly as today (cookie, `last_login_at`, redirect
   through `safeReturnTo`). Automated.
6. Given a stubbed siteverify answering `success: true` but `action: "sign-up"` on the sign-in action, or a `hostname`
   that is not the request host, then the action answers 400 with the AC 4 message. Automated.
7. Given siteverify answers `success: false` with `error-codes: ["timeout-or-duplicate"]` (the same token posted a
   second time), when the form is posted, then 400 with the AC 4 message: a token is accepted once. Automated;
   Browser with Cloudflare's "token already spent" test secret.
8. Given siteverify does not answer within 5 s, answers a non-2xx status, or answers non-JSON, when the form is
   posted, then the action answers 400 with the AC 4 message within 6 s and logs one line with a reason label and no
   token. Automated.
9. Given the siteverify request body, when inspected in the stub, then it carries `secret`, `response`, `remoteip`
   equal to the request's `CF-Connecting-IP`, and a UUID `idempotency_key`; never the e-mail, name or password.
   Automated.
10. Given the throttle (`sign-in` scope) is already over its limit, when a form with a token is posted, then the
    action answers 429 as today and siteverify is not called. Automated.
11. Given Cloudflare's always-pass test keys in `.dev.vars`, when a Playwright user signs in at 360 px, then the widget
    fits the column without horizontal scroll, the submit succeeds, and the widget shows the Indonesian UI; with
    `lang=en` the English one. Browser.
12. Given Cloudflare's always-block test site key, when the user submits, then the form shows the AC 4 message, the
    widget resets, and a second attempt is possible without reload. Browser.
13. Given JavaScript disabled and Turnstile configured, when `/masuk` renders, then the `<noscript>` line
    "Verifikasi keamanan membutuhkan JavaScript. Aktifkan JavaScript lalu muat ulang." is visible and a posted form
    is refused with the AC 4 message (never silently signed in). Browser.
14. Given the admin account opens `/pengaturan/integrasi/admin`, when Turnstile is configured / partial / missing, then
    the row shows `ok` / `sebagian` / `Belum dikonfigurasi` as names and booleans only. Automated.
15. Given the real widget on staging with the owner's keys, when the owner signs in once, then it succeeds and a
    replayed POST of the same token (curl) is refused. Pass (owner).

### Part B — Passkeys: registration

16. Given a signed-in user on `/pengaturan/akun/passkey` with no passkeys, when the page loads, then it shows the
    empty state "Belum ada passkey" and a "Tambah passkey" button; when `window.PublicKeyCredential` is undefined, the
    button is replaced by "Browser ini belum mendukung passkey". Browser.
17. Given a wrong current password in the register sheet, when `registerOptions` is posted, then 400 with "E-mail atau
    kata sandi salah.", the attempt counts toward `account-password` (`prove-password.ts:24-26`), and no challenge row
    is written. Automated.
18. Given a correct password, when `registerOptions` is posted, then one `passkey_challenges` row (`kind='register'`,
    `user_id` set, `expires_at` = created + 5 min) exists and the options carry `rp.id` equal to the request host,
    `user.id` as an opaque 32-byte handle (never the e-mail or `users.id` in clear), `attestation: 'none'`,
    `pubKeyCredParams` exactly ES256 and RS256, and `excludeCredentials` listing the user's live passkeys. Automated.
19. Given a valid registration response from the virtual authenticator, when `register` is posted, then one `passkeys`
    row exists with `counter`, `aaguid`, `transports`, `rp_id`, `backed_up`, the cleaned `name` (≤ 40 chars, control and
    zero-width characters stripped), the challenge row has `used_at` set, one `auth_events` row `passkey_added` exists,
    and the page lists the passkey after reload. Browser + Automated.
20. Given the same registration response posted twice, when the second arrives, then it is refused (challenge already
    used) and exactly one `passkeys` row exists. Automated.
21. Given a registration response whose `clientDataJSON.origin` is `https://evil.example` or whose `rpIdHash` is of
    another host, when posted, then 400 with "Pendaftaran passkey gagal. Coba lagi." and no row is written. Automated.
22. Given a challenge row older than 5 minutes, when its response is posted, then it is refused with the AC 21 message
    and the row is not consumed. Automated.
23. Given the user already has 10 live passkeys (Owner decisions #6), when `registerOptions` is posted, then 400 with
    "Batas 10 passkey tercapai. Hapus satu dulu." and no challenge is written; the cap is held under 20 concurrent
    registrations (pre-handoff concurrency probe). Automated.
24. Given user B's session, when B posts a `register` response for a challenge issued to user A, then it is refused and
    nothing is written for either user. Automated.

### Part B — Passkeys: sign-in

25. Given a signed-out visitor at `/masuk` with JavaScript and conditional mediation available, when the page mounts,
    then one `passkeyOptions` call issues a `sign_in` challenge (`user_id` null, `allowCredentials` empty) and the
    e-mail input has `autocomplete="username webauthn"`; the "Masuk dengan passkey" button is also present. Browser.
26. Given a registered passkey on the virtual authenticator, when the user picks it (conditional UI or button), then
    `passkey` creates a session (cookie flags identical to a password session, `last_login_at` updated), the challenge
    is consumed, `passkeys.last_used_at` and `counter` are updated, one `auth_events` row `passkey_sign_in` exists,
    the previous cookie's session (if any) is revoked, and the user lands on `safeReturnTo(next)`. Browser + Automated.
27. Given the same assertion posted a second time, then it is refused ("Masuk dengan passkey gagal. Coba lagi.") and
    no second session exists. Automated.
28. Given an assertion with a wrong origin, a wrong `rpIdHash`, a `clientDataJSON.type` other than `webauthn.get`, a
    signature over altered `authData`, or a signature by another key, then each is refused with the AC 27 message,
    nothing is written except an `auth_events` `passkey_refused` row when the credential id is known. Automated.
29. Given a stored counter of 5 and an assertion with counter 5 or 3, then it is refused, an `auth_events`
    `passkey_counter_rollback` row is written, the passkey stays usable with a higher counter (Owner decisions #12);
    given stored 0 and new 0 (authenticators that never count), then it is accepted. Automated.
30. Given a passkey soft-deleted (`deleted_at` set), when its assertion is posted, then it is refused with the AC 27
    message, as is one for an unknown credential id, with the same status and body (no oracle). Automated.
31. Given the user's `status` is `disabled`, when a valid assertion is posted, then no session is created. Automated.
32. Given two users each with a passkey, when A's assertion is posted, then the session belongs to A and reads nothing
    of B; B's credential id in A's `allowCredentials` is never listed (discoverable flow lists none). Automated.
33. Given 61 `passkeyOptions` calls from one client in 10 minutes, when the 61st arrives, then 429 and no challenge
    row; given 21 `passkey` posts from one client, then 429. Both fail closed when D1 is unavailable. Automated.
34. Given the user cancels the browser's passkey prompt, when the promise rejects, then the form shows "Dibatalkan.
    Masuk dengan kata sandi atau coba lagi." and the password form stays usable; no server call is made for the cancel.
    Browser.
35. Given JavaScript disabled, when `/masuk` renders, then no passkey button or script is present and the password
    form posts as today. Browser.
36. Given a passkey sign-in, when the user opens a page that needs the account key, then that page shows the "key not
    open" state with a link to `/pengaturan/akun`, where "Buka kunci dengan kata sandi" re-proves the password via
    `keyMaterial`, opens the key on the device and the page then unseals as after a password sign-in; a wrong password
    there counts toward `account-password` and shows "E-mail atau kata sandi salah.". Browser.
37. Given a passkey sign-in, when the user tries to change the password, delete the account, create an API token or
    fetch key material, then each still demands the current password exactly as today (no passkey step-up). Automated.

### Part B — Passkeys: management and lifecycle

38. Given two live passkeys, when `remove` is posted for one with the correct password, then that row gets
    `deleted_at`, an `auth_events` `passkey_removed` row exists, every session created by that passkey except the
    current one is revoked (Owner decisions #10), and the list shows one passkey after reload. Automated + Browser.
39. Given user B posts `remove` with user A's passkey id, then 404-shaped refusal identical to an unknown id and A's
    row is untouched. Automated.
40. Given a removed passkey's authenticator registers again, when `register` is posted, then a new row is written (the
    partial unique index ignores the tombstone). Automated.
41. Given a password change with a re-wrap, when it commits, then the user's passkeys are unchanged and still sign in;
    sessions created by passkeys on other devices are revoked like every other session (`change-password.ts:63-73`).
    Automated.
42. Given account deletion with the correct password, when it commits, then `passkeys`, `passkey_challenges` and
    `auth_events` rows of the user are gone in the same batch; the account's shared-space rows behave as before.
    Automated.
43. Given `/pengaturan/akun/passkey` at 360 px in both themes, when listed with three passkeys with 40-character names,
    then no horizontal scroll, every control ≥ 44 px, names truncate with an ellipsis, dates show in WIB
    (`created_at` 2026-10-12T16:30Z shows "12 Okt 2026, 23.30"). Browser.
44. Given a signed-out request to `/pengaturan/akun/passkey` or its actions, then the auth gate answers as for every
    `(app)` route (303 to `/masuk?next=…` on GET, 401 otherwise). Automated.

### Cross-cutting (ENGINEERING_CHECKLIST)

45. Every new form body is read through `readFormBody` (size cap, 400/415, prototype-safe); assertion and attestation
    JSON fields are individually length-capped before decoding; malformed base64url or CBOR answers 400, never 500.
    Automated.
46. Every challenge consume and counter update is one guarded statement (`UPDATE … WHERE … RETURNING`) inside the
    `db.batch` that writes the session or passkey row; proven with a 20-way concurrent test on one challenge (exactly
    one winner). Automated.
47. Every Indonesian phrase added (pages, server messages, `<noscript>`, admin row) has an `i18n-en.ts` entry; the
    existing i18n test passes. Automated.
48. User-facing copy never contains a credential id, AAGUID, challenge, token, file path or stack; log lines never
    contain a token, challenge, public key or e-mail. Automated (grep in tests of the messages module and the log stub).
49. `{#each}` of passkeys is keyed by `passkeys.id`. Focus returns to the "Tambah passkey" button after the register
    sheet closes. AA contrast in both themes (`test/contrast.test.ts` extended if new colours appear — none expected).
    Browser.
50. `npm run gates` clean; every regression test shown failing on the unfixed code once (fail-before proof) where it
    guards a refusal path (AC 20, 27, 29, 30). Automated.

## Architecture notes

- **Touched**: `src/lib/server/auth/{turnstile.ts (new), passkeys.ts (new), passkey-flow.ts (new),
  webauthn-verify.ts (only if the library fallback is taken), session.ts, throttle.ts, messages.ts, delete-account.ts}`;
  `src/lib/server/db/schema.ts` (three tables); `src/lib/server/admin.ts` untouched, admin page loader
  `src/routes/pengaturan/integrasi/admin/+page.server.ts:44-69` and its `+page.svelte` (one row);
  `src/hooks.server.ts:23-31` (per-route CSP addition); `src/routes/(auth)/masuk/*`, `src/routes/(auth)/daftar/*`;
  `src/routes/(app)/pengaturan/akun/passkey/*` (new), `src/routes/(app)/pengaturan/akun/+page.svelte` (link),
  `src/routes/(app)/pengaturan/+page.svelte:28-56` (row); `src/lib/ui/account-key/AccountKeySection.svelte:171`
  (inline unlock) and the callers of `deviceKey()` (`SealDemo.svelte`, any FN-15/16 unseal view) for the link copy;
  `src/lib/ui/auth/*` for a `PasskeyButton.svelte`; `src/lib/shared/i18n.ts` + `i18n-en.ts`;
  `migrations/0044_passkeys.sql`; `src/worker-configuration.d.ts` via `npm run types:cf` after adding the vars;
  `wrangler.jsonc` staging `vars` gets `TURNSTILE_SITE_KEY` only when the owner sets it (the secret via
  `wrangler secret put`); `.dev.vars.example`; `docs/RUNBOOK.md`; `workers/jobs` retention sweep (one `auth_events`
  step, 90 days). No Queue, Workflow, R2 or AI involvement.
- **Reuse, do not rewrite**: `overAttemptLimit` / `overUserAttemptLimit` (`throttle.ts:196-228`),
  `proveCurrentPassword` (`prove-password.ts`), `newSession` / `createPasswordSession` shape (`session.ts:46-96`),
  `revokeSession` (`session.ts:148-159`), `setSessionCookie` (`session.ts:168-178`), `safeReturnTo`,
  `readFormBody` / `textField`, `trackEvent` (`masuk/+page.server.ts:44`), `cleanText`, `newId` / `randomToken` /
  `sha256Hex` (`util.ts`), `isAdminAccount`, `hostCookieName`, the `fetchKeyMaterial` / `openAccountKey` /
  `holdDeviceKey` trio (`device.ts`).
- **Origin and rpId**: expected origin is `event.url.origin`; `rpId` is `event.url.hostname` when
  `secureDeployment(hostname)` (`session.ts:39-41`) or the hostname is `localhost`; any other hostname (an IP, a
  `*.workers.dev` preview) refuses passkey actions with "Passkey tidak tersedia di alamat ini." so a credential is
  never bound to a throwaway host. Staging and production both answer on `<staging-app-host>` today
  (`wrangler.jsonc` staging `routes`), so one rpId covers both; a future production host means users register again
  (RUNBOOK notes it). The stored `rp_id` lets the list say which host a passkey belongs to.
- **CSRF**: both new action groups are form actions, so the existing cross-site check (`src/lib/server/csrf.ts:34-42`,
  applied in `hooks.server.ts:66-67`) covers them; Turnstile's token travels in the same form body.
- **Analytics (FN-31)**: `sign_in` events gain `method: 'password' | 'passkey'`, no other field.
- **No sessions column change**: which passkey created a session is derived from `auth_events`
  (`passkey_sign_in` rows carry `passkey_id`) only for the AC 38 revoke; if that proves awkward, add a nullable
  `sessions.passkey_id` in the same migration (engineer's call, state it in the hand-off).

## Prerequisites

- **Part A (owner)**: create a Turnstile widget in the Cloudflare dashboard for hostname `<staging-app-host>` (Managed
  mode), then on staging `npx wrangler secret put TURNSTILE_SECRET_KEY --env staging` and add `TURNSTILE_SITE_KEY` to
  the staging `vars`. Locally: both in `.dev.vars` (Cloudflare's documented test keys are enough for Browser level).
  Unset → no widget, no check, admin row "Belum dikonfigurasi" (AC 1, 14). Staging today has neither: the
  feature ships dark until the owner sets them.
- **Part B**: no credential. Needs HTTPS or `localhost` (WebAuthn refuses elsewhere); Playwright's CDP
  `WebAuthn.addVirtualAuthenticator` in Chromium for Browser level.

## Tracker impact

- Closes no existing `docs/TASKS.md` item (none mentions passkeys or a bot check). Adds under "Phases 3 – 5 and
  later": "**You** — FN-50: create the Turnstile widget for `<staging-app-host>`, set `TURNSTILE_SECRET_KEY` (secret) and
  `TURNSTILE_SITE_KEY` (var) on staging (RUNBOOK › Secrets); then AC 15 once." and "**You** — FN-50: register a
  passkey on a real iPhone (Face ID) and an Android phone, sign in with it, remove it." Adds the library spike result
  to HISTORY.
- `docs/ACCEPTANCE.md` › Security and privacy: row "Session hashing, cookie flags, CSRF/origin check, sign-out
  revocation" can move from Not run to **Automated + Browser** on the strength of AC 26–28, 38 and the existing
  session tests if the engineer cites them; add two rows: "Passkey sign-in: replay, wrong origin, expired challenge,
  counter rollback, deleted passkey refused" (Automated) and "Turnstile token required when configured, single use,
  hostname/action checked" (Automated; Pass after AC 15).
- `docs/FEATURES.md` gains FN-50 (added with this PRD); `docs/PRD.md` gets one line under FN-01.

## Owner decisions

Answer once before the build; the proposed default applies if unanswered.

1. **Both-or-none configuration.** The request says "refuse without a token only when the secret is set". With the
   secret set and the site key missing no widget renders, so every sign-in would be refused. Default: the check is on
   only when **both** values are set; a half configuration behaves as unset, is shown as `sebagian` on the admin page
   and logged. Alternative: refuse on secret alone (locks everyone out until the var is added).
2. **Widget mode.** Default: Managed (Cloudflare decides when to show an interaction), `size: 'flexible'`, visible
   widget. Alternative: Invisible (no visible box; Cloudflare may still interrupt).
3. **`remoteip`.** Default: send the `CF-Connecting-IP` value (Cloudflare already has it; improves accuracy; no new
   party). Alternative: omit it.
4. **No-JS sign-in while Turnstile is on.** Default: unavailable, explained by the `<noscript>` line (a token needs the
   widget; skipping the check without a token would be fail-open). Alternative: none that is not fail-open.
5. **Privacy copy.** Default: one sentence in `/privasi` and the draft policy: "Halaman masuk memakai pemeriksaan bot
   Cloudflare Turnstile (infrastruktur Cloudflare yang sudah melayani Montra); tidak ada pelacak pihak ketiga." (legal
   review pending like the rest of the draft).
6. **Passkeys per account.** Default: 10 live passkeys. Name ≤ 40 characters.
7. **rpId policy.** Default: the request host when it is a secure deployment or `localhost`; refused on any other
   host. Staging and production share `<staging-app-host>` today, so one rpId. A later production host change means every
   user registers passkeys again (RUNBOOK). Alternative: a `PASSKEY_RP_ID` var per environment (more config, same
   outcome).
8. **Account key with passkey sign-in (critical).** The account key's private key is wrapped under a scrypt key derived
   from the password (`migrations/0011_account_keys.sql`, `device.ts:225-239`); a passkey sign-in has no password, so
   sealed results cannot be opened by it. Options: **(1) recommended default** — a passkey sign-in gives a normal
   session; the first feature that needs the key asks for the password once per page session through the existing
   `keyMaterial` action and holds the opened key in memory exactly as after a password sign-in (`holdDeviceKey`);
   smallest change, no new crypto, same security as today. **(2)** WebAuthn PRF extension: derive a second wrapping key
   per passkey and store a second wrapped copy (new columns, a second wrap path, browser support uneven and to be
   re-checked at build time), falling back to (1) where PRF is absent — deferred to a later FN. **(3)** block passkey
   sign-in on accounts that have an account key — rejected: it would make the safest accounts the least convenient.
9. **Password change and passkeys.** Default: passkeys stay registered (they are independent of the password); other
   sessions are revoked as today. Alternative: also remove all passkeys on a password change (safer after a suspected
   compromise, more friction).
10. **Removing a passkey.** Default: soft-delete and revoke every session created by that passkey except the current
    one. Alternative: revoke nothing (a stolen device stays signed in for up to 30 days).
11. **`auth_events` retention.** Default: 90 days, swept by the jobs Worker; no IP or user agent stored; not shown to
    the user this pass.
12. **Counter rollback.** Default: refuse the attempt and record `passkey_counter_rollback`; the passkey stays usable
    with a higher counter. Alternative: disable the passkey until the user removes and re-adds it (stricter; false
    positives with some authenticators that report inconsistent counters).
13. **Library.** Default: `@simplewebauthn/server` 13.3.x pinned exactly (newest release ≥ 2 weeks old on build day),
    subject to the workerd spike in Scope; fallback a minimal `none`-attestation verifier with recorded vectors.
14. **Conditional UI challenge cost.** Default: one `sign_in` challenge per `/masuk` load with JavaScript, throttled at
    60 per client per 10 minutes. Alternative: issue the challenge only when the user focuses the e-mail field or taps
    the button (fewer rows, autofill appears a beat later).
15. **Analytics.** Default: `sign_in` gains `method` only. No new event kinds.

## Owner decisions — answered 2026-10-12

Owner picked the proposed default for every item, with these four confirmed explicitly:

- **8 Account key:** option (1) — a passkey sign-in gives a normal session; the first feature that needs the account
  key asks for the password once per page session (existing `keyMaterial` action, `holdDeviceKey`). PRF deferred.
- **9 Password change:** passkeys stay registered; other sessions revoked as today.
- **10 Removing a passkey:** soft-delete and revoke every session created by that passkey except the current one.
- **2 Widget mode:** Managed, visible, `size: 'flexible'`.

All other items (1, 3–7, 11–15) apply as proposed.
