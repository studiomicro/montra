# FN-01 Account and sign-in — Security report (cycle 1)

Reviewed: `git diff f9af1fb..4c7dda2` (package-lock and generated `worker-configuration.d.ts` excluded), against
`docs/features/fn-01-accounts/PRD.md`, `ENGINEER_REPORT.md`, `QA_REPORT.md` and `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No high or medium findings. The low findings below are tracked; none blocks FN-01.

## What was checked and held

- **Password hashing** (`src/lib/server/auth/password.ts:14-58`): PBKDF2-HMAC-SHA256, 100,000 iterations (the
  workerd cap, pinned by test), 16-byte random salt per credential, 256-bit output, constant-time compare over
  equal-length base64. Iteration count read from the row is bounded before derive (no CPU amplification via a
  stored value).
- **Sign-in parity** (`password.ts:136-179`, `masuk/+page.server.ts:28-36`): an unknown, disabled, locked or
  wrong-password account each costs one derivation (random salt for a missing account) and one UPDATE, and all
  answer the same `E-mail atau kata sandi salah.` with status 400. Local probe: unknown 52.9–53.6 ms vs existing
  52.2–60.0 ms over the dev server (noise-level). Lockout is a single guarded UPDATE (no read-then-write race).
- **Sessions** (`session.ts`): 32-byte CSPRNG token, only its SHA-256 stored (unique index), 30-day absolute
  expiry enforced server-side, revoked/expired/disabled sessions refused, dead cookie cleared. Session creation
  is guarded on the hash just verified (no session after a concurrent delete). No fixation: the server always
  mints the token.
- **Cookie flags**: HttpOnly, SameSite=Lax, Path=/; on any non-loopback host `__Host-` + Secure. Host-spoof
  question: on Cloudflare the Host header selects the zone/route, so a request with `Host: localhost` (or
  `*.localhost`, `127.0.0.1`) never reaches the production Worker; production cannot be served a non-Secure
  cookie. Plain-http on a deployed host is 308'd before the cookie is read, and a `__Host-`/Secure cookie is
  never sent over http anyway. Local probe: `Host: app.example` → 308.
- **CSRF**: SvelteKit 3 origin check is active in production builds (it is skipped only under `vite dev`).
  Built Worker on wrangler dev :8794: `Origin: https://evil.test` → 403, no Origin → 403, sibling
  `site.localhost` → 403. `readFormBody` refuses `text/plain` (415) and JSON (415). SameSite=Lax additionally
  blocks cross-site cookie-bearing POSTs.
- **Form bodies** (`forms.ts`): 8 KiB cap by Content-Length and by streamed count (chunked bodies too), 10 s
  trickle timeout, 400/408/415 never 500, `form.get` by name only.
- **Open redirect** (`return-to.ts`): probed `//evil.test`, `/\evil.test`, `/%2F%2Fevil.test`,
  `/%252F%252F…`, `/.//evil.test`, `/a/../..//evil.test`, `/%09/evil.test`, `/%5Cevil.test`, `https:evil.test`
  → all `/`; survivors (`/;//evil`, `/x?//evil`, `/%E3%80%80/evil`) resolve on the app origin.
- **Route protection** (`gate.ts`, `hooks.server.ts`): every `(app)` route id, including `__data.json` data
  requests and non-GET methods, is answered before `resolve()` (303/JSON redirect or 401); `/dev/ui` sits in
  `(app)` and is also behind `DEV_ROUTES`; `/api/v1/dev/*` is behind `DEV_ROUTES`; the app host refuses `/site/*`;
  `//…` paths match no route (404). Signed-in responses get `cache-control: private, no-store`.
- **Account deletion** (`delete-account.ts`, `pengaturan/akun/+page.server.ts:28-45`): requires a session, the
  confirm box and a fresh password proof that counts toward lockout; one `db.batch`, every statement guarded on the
  proven hash; deletes sole-member spaces, the user's memberships, **all** sessions (every device), the
  credential and the user row. Sign-out revokes exactly the current session server-side.
- **Sign-up race**: `users.email` unique index + one batch; duplicate answers `E-mail sudah terdaftar` (QA ran 20
  concurrent same-address sign-ups: one account).
- **Throttle** (`throttle.ts`): counted before any derivation; keyed by `CF-Connecting-IP` (set by Cloudflare,
  not client-overridable), IPv6 by /64; stored as SHA-256, no raw address kept.
- **Secrets and output**: no password, token or hash in page data, logs or error copy; the only log line is the
  throttle DB error message. No `{@html}` in the diff. CSP unchanged (no `unsafe-inline`).
- **Tests**: `npx vitest run` → `Test Files 34 passed (34) / Tests 266 passed (266)`.

## Findings

### L1 — Targeted lockout keeps a victim out indefinitely (low; accepted by PRD criterion 11)
`src/lib/server/auth/password.ts:26-27,162-173`. Anyone who knows an address sends 5 wrong passwords every
15 minutes (well inside the 20/10 min per-IP budget, and from any IP) and the owner's correct password is refused
for as long as the attacker keeps going. With no password reset and no "unlock by e-mail" yet, the victim cannot
sign in or delete the account in-app (the delete action uses the same proof). Repro: 5 × POST /masuk with a wrong
password for the victim's address, then the correct password → `E-mail atau kata sandi salah.`
Fix (later, with the e-mail provider): unlock link by e-mail, or a per-(account, client) failure counter so a
known device/IP is not locked by a stranger; until then keep it on the TASKS list.

### L2 — Account enumeration via sign-up (low; inherent to owner decision E, no e-mail verification)
`src/lib/server/auth/accounts.ts:96` answers `E-mail sudah terdaftar.` Repro: POST /daftar with any address →
the field error reveals whether it is registered (bounded to 20 per 10 min per IP). Sign-in itself has no oracle.
Fix (with the e-mail provider): answer sign-up uniformly and send "you already have an account" by e-mail.

### L3 — Address squatting without verification (low; owner decision E)
`accounts.ts:59-99`. Anyone can register `victim@…` first; the real owner then cannot sign up and cannot reset.
Fix: e-mail verification when the provider lands; at minimum an admin/support release path.

### L4 — E-mail accepts invisible format characters (low)
`password.ts:189-193` (`isPlausibleEmail` excludes `\s` and `\p{Cc}` but not `\p{Cf}`), so
`ana​@example.test` is a distinct account that renders identically to `ana@example.test`. Exploit is mostly
confusion in support/admin views and future invites (FN-03) ("invite ana@…" lookalike). Fix: reject
`\p{Cf}\p{Zl}\p{Zp}` in addresses (or NFC + strip before normalising) for sign-up, sign-in and future invites.

### L5 — Deleting a shared-space owner leaves an owner-less space (low; forward-looking, FN-03)
`src/lib/server/auth/delete-account.ts:33-34`. A space with another member survives and only the deleter's
membership row goes, so a shared space whose Pemilik deletes the account has no one allowed to manage members.
Also `otherMember` counts tombstoned (`deleted_at`) memberships, so a space whose other member was removed would
not be deleted. Not reachable in FN-01 (only personal spaces exist). Fix in FN-03: transfer ownership (or block
deletion) and filter `deleted_at is null`.

### L6 — Deletion completeness is not enforced for future user-data tables (low)
`delete-account.ts:32-54` lists tables by hand. Every later feature table keyed by user or sole-member space
(wallets, transactions, Gmail tokens, R2 keys) must be added, or deletion silently leaves data (or fails on an FK
with a 500). Fix: a test that walks the Drizzle schema and fails when a table with `user_id`/`space_id` is not
covered by `deleteAccount`.

### L7 — Signing in again does not revoke the session already in the browser (low)
`src/routes/(auth)/masuk/+page.server.ts:35-37`. A POST to /masuk while signed in mints a new session and
overwrites the cookie; the previous session row stays valid for its 30 days. Repro: sign in twice in one browser;
both token hashes resolve. Fix: revoke `locals.sessionToken` when replacing it.

### L8 — Throttle fails open on a D1 error (low)
`src/lib/server/auth/throttle.ts:117-129`. If only the `auth_attempts` writes fail (e.g. table missing after a
bad migration), derivations run unthrottled; account lockout still applies. Acceptable as documented; consider a
metric/alert on the log line.

### L9 — PBKDF2 iteration count below current OWASP guidance (low; platform cap)
`password.ts:14`. 100,000 × SHA-256 is about 1/6 of OWASP's 600,000 recommendation, forced by the workerd
`DEFAULT_MAX_PBKDF2_ITERATIONS`. The `algo`/`iterations` columns allow a rehash-on-login upgrade later; keep the
minimum length 8 + common-password list, and consider a larger blocklist.

## Engineering checklist

Redirects use `safeReturnTo` (pass); form bodies use the shared guard (pass); concurrent writes are guarded
single statements in `db.batch` (pass); untrusted name text goes through `cleanText` (pass; e-mail see L4); no
user copy leaks internals (pass); CSP has no `unsafe-inline` (pass); i18n entries covered by the existing gate test
(pass, per QA). Space-access helper and cross-space probes: no space data routes in FN-01 (n/a).

## Commands

- `npx vitest run` → Test Files 34 passed (34), Tests 266 passed (266).
- `npm run db:migrate:local` → 0000_init, 0001_accounts applied (local only).
- `npx vite build` → done; `npx wrangler dev --port 8794` (local, stopped after): CSRF 403 ×3, host spoof 308.
- `vite dev --port 8794` (stopped after): sign-in timing and response parity probes above.
