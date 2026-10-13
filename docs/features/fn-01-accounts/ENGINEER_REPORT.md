# FN-01 Account and sign-in — engineer report (cycle 1)

Branch `worktree-agent-a58c0561e9b9da26b`, rebased on `feat/fn-00-foundation` f9af1fb. Owner decisions applied:
8-character minimum (C), 30-day absolute session with no idle sign-out (A), no e-mail verification (E), public
`/hapus-akun` = explanation + mailto (B), self-attested 18+/guardian checkbox (D).

## What works

- **Migration `0001_accounts.sql`** (drizzle-kit generate): `users`, `user_passwords`, `sessions`, `auth_attempts`,
  `spaces`, `space_members` (unique `(space_id, user_id)`, CHECKs on enums, `space_members.space_id` ON DELETE
  CASCADE). Applied locally only (`db:migrate:local` into a scratch persist dir).
- **`src/lib/server/auth/`** ported from the earlier project, trimmed: `password.ts` (PBKDF2 100k, Workers cap guard,
  strength check, one guarded UPDATE for lockout 5/15 min), `session.ts` (opaque token, SHA-256 at rest,
  `__Host-` name on deployed hosts, guarded `last_seen_at` touch, `createPasswordSession` INSERT…SELECT guarded on
  the proven hash), `throttle.ts` (per-client budget 20/10 min, IPv6 /64, separate `sign-in` and `sign-up` scopes),
  `accounts.ts` (sign-up: user + credential + personal space + owner membership + first session in one
  `db.batch`), `delete-account.ts` (one batch, every statement guarded on the re-proven hash), `gate.ts` (route
  protection), `messages.ts`.
- **`src/hooks.server.ts`**: locale/theme/headers kept; adds `locals.db` (via `getEnv()`, ruling R10),
  `locals.user`, `locals.sessionToken`, `locals.secure`; http→https 308 on deployed hosts; signed-out GET of any
  `(app)` route → 303 `/masuk?next=…` (JSON redirect for data requests), other methods → 401; a dead cookie is
  cleared. Early responses are built (not thrown) so they carry the security headers. Signed-in responses get
  `Cache-Control: private, no-store`.
- **Routes**: `(auth)/masuk`, `(auth)/daftar`, `(auth)/akun-dihapus` (no tab bar), `(app)/pengaturan` (list with
  Akun), `(app)/pengaturan/akun` (name, e-mail, created-at in WIB; `signOut`, `deleteAccount`),
  `(site)/site/hapus-akun` (explanation, link to the app, mailto when `SUPPORT_EMAIL` is set, else
  "Alamat dukungan belum dikonfigurasi."). `masuk`, `daftar`, `pengaturan` removed from the stub matcher/`STUBS`;
  `hapus-akun` removed from the legal matcher.
- Shared helpers: `src/lib/server/forms.ts` (8 KiB cap, 10 s timeout, 415/400/408), `src/lib/server/return-to.ts`
  (`safeReturnTo`), `src/lib/shared/text.ts` (`cleanText`), `src/lib/shared/dates.ts` (`formatDateTimeWib`).
- UI reuses kit `Button`, `GroupList`, `GroupRow`, shell `ScreenTitle`/`EmptyState`. `src/lib/ui/auth/Field.svelte`
  exists because kit `TextInput` has no password type, error, hint or length props (kit is not ours to edit).
- `(app)/+error.svelte` now offers "Coba lagi" (link to the same URL, works without JS) for non-404 errors.

## Tests (Vitest, 263 total, all pass)

Unit: `return-to`, `forms`, `text`, `dates`, `auth/password`, `auth/throttle`, `auth/gate` (+ updated
`params.test.ts`, `nav.test.ts`). Integration (local D1 via `openLocalD1`, added to `test/helpers/d1.ts`):
`accounts`, `sign-in` (lockout, concurrent wrong passwords, throttle incl. 30 concurrent first attempts),
`sessions` (two devices, expiry, revoke, sign-in racing a delete), `delete-account` (shared space kept, wrong
proof, concurrent replays), `routes` (hook gate, actions of `/daftar`, `/masuk`, `/pengaturan/akun` called with a
fake event; `#lib/server/env` mocked).

Fail-before proof (mutations, then restored): original FN-00 `hooks.server.ts` → 5 gate tests fail; dropping the
`unlocked` guard → 2 lockout tests fail; not mapping the unique violation → 2 sign-up tests fail.

## Pre-handoff probes (wrangler dev :8790, curl with `Accept: text/html`, no JS)

- Concurrency: 20 concurrent POST /daftar, same e-mail → `1×303, 19×400` (duplicate message), no 500.
- No existence oracle: wrong password vs unknown e-mail → both 400, identical 4179-byte body (e-mail echo removed),
  14.6 ms vs 12.9 ms single sample (residual: a wrong password writes the lockout counter, an unknown e-mail
  updates no row; same residual the earlier project documented).
- Gate: `GET /` → 303 `/masuk`; `GET /riwayat?bulan=1` → 303 `/masuk?next=%2Friwayat%3Fbulan%3D1`; signed-out
  POST `?/signOut` → 401; `/masuk`, `/daftar`, `/api/v1/health` → 200.
- No-JS forms: missing 18+ → 400 with message; short password → 400 with reason; valid → 303 `/` with
  `HttpOnly; SameSite=Lax` cookie (`Secure`/`__Host-` only on non-loopback hosts, unit-tested).
- Cross-origin POST to `/masuk`, `/daftar`, `?/deleteAccount` → 403 (SvelteKit CSRF check); JSON body → 415;
  20 KB body → 400.
- Two devices: device 1 sign-out → its next GET 303 `/masuk`; device 2 still 200.
- Cross-user: user B's `/pengaturan/akun?user=<A's e-mail>` shows only B. No FN-01 route accepts a user id.
  (Space-scoped data does not exist yet; the space-access helper is FN-03.)
- Delete: wrong password → 400 with sign-in message, rows kept; right → 303 `/akun-dihapus`; old cookie → 303
  `/masuk` with cookie cleared; sign-in afterwards → 400.
- User copy: no paths, stack traces or ids in any probed body.
- 360 px: **not run** — Chromium/Firefox cannot start here (missing system libs `libnspr4`, `libasound2t64`; needs
  `sudo npx playwright install-deps`). Layout uses 44 px+ targets and token colours only.

## Checklist items applied

Concurrent writes (guarded UPDATE/INSERT…SELECT, batch, concurrency tests); bounded work (single-row lookups,
throttle cleanup per window); migrations (new 0001, none edited); one access rule / no oracle (generic message,
same work, locked = invalid); untrusted text (`cleanText` on name); redirects (`safeReturnTo`); form bodies
(`readFormBody`, 400/415, prototype-safe `form.get`); CSP (no inline styles, nothing added); i18n (every phrase in
`i18n-en.ts`; `Keluar` already meant "Out" in the kit, so sign-out uses "Keluar dari akun"); truthful state
(redirect only after the server write; buttons disabled with "Memproses…" while pending); accessibility (labels,
`aria-invalid`/`aria-describedby`, `role="alert"` banner, 44 px targets); gates; fail-before proof.

## Deviations and concerns

- **Criterion 19 loading skeleton (kept as is, controller ruling cycle 2)**: `/pengaturan/akun` reads name,
  e-mail and created-at from `locals.user`, which the hook already loaded with the session; the page load issues
  no query of its own, so there is no pending phase for a skeleton. A streamed promise would show a skeleton that
  never resolves without JavaScript. The failure state with retry is the `(app)` error page ("Coba lagi" link to
  the same URL, works without JS).
- **E2E (fixed in cycle 2)**: see "Cycle 2" below.
- `secureDeployment` is decided by host name (loopback = local) because Kit 3 passes no platform; add any
  non-HTTPS deployed host there if one ever exists.
- Guest mode is not available: every `(app)` page now requires an account (PRD scope, server-first decision).
- `/hapus-akun` request path needs `SUPPORT_EMAIL` (owner to supply); the handling is a manual process until an
  e-mail provider exists.

## E2E journeys FN-01 needs (to add after merge)

1. Sign up (JS) → lands on Beranda signed in; reload keeps the session.
2. Sign-up refusals: no 18+ box, short password, duplicate e-mail — inline messages; same with JS disabled.
3. Sign in with `next` → lands on the requested page; wrong password shows the generic message.
4. Signed-out visit to `/riwayat` → `/masuk?next=/riwayat` → after sign-in back on `/riwayat`.
5. Two browser contexts: sign out on one, the other stays signed in.
6. Pengaturan › Akun shows name, e-mail, WIB date; delete with wrong password (error), then right password →
   `/akun-dihapus`; signing in again fails.
7. 360 px, light and dark: `/masuk`, `/daftar`, `/pengaturan/akun` without horizontal scroll, 44 px targets.
8. Site host `/hapus-akun` renders (with and without `SUPPORT_EMAIL`).

(All of these now exist in QA's `e2e/accounts.spec.ts`.)

## Cycle 2

Rebased on `main` 5f2b456, with QA commit 4c7dda2 and the red-team report cd37752 cherry-picked.

- **Signed-in e2e fixture**: a `setup` project (`e2e/auth.setup.ts`) signs up one fictional user per run
  (`e2e-<run id>@example.test`) through the real `/daftar` form and saves `playwright/.auth/user.json` (ignored
  by version control). The `phone` and `desktop` projects depend on it with `storageState`. Contexts that
  shell/kit specs open themselves pass `STORAGE_STATE`. `accounts.spec.ts` uses `SIGNED_OUT`.
- **Throttle budget in e2e**: under `wrangler dev` every request comes from loopback, so the whole run shared one
  per-client budget (20 per 10 min). Wrangler passes a client-sent `CF-Connecting-IP` through, while Cloudflare
  overwrites it in production. So each test, and each extra context, sends its own simulated address
  (`simulatedClientIp`, 198.18.0.0/15, from the test id): each test gets its own budget, as separate real users
  would, with no test-only switch in the app. `mode: 'serial'` was removed; `--workers=1` is not needed.
- **Queue ping flake, real cause**: the consumer stored every ping under one `app_meta` key, `last_ping`. The
  phone and desktop projects ping at the same time, both messages arrive in one batch, and the later write
  overwrote the earlier id, so that test polled forever. Reproduced with curl: of two pings, the first stayed
  `received:false` for 12 s while the second was `true`. Fix: `src/lib/server/ping.ts` stores `ping:<id>` per
  message (idempotent on redelivery; rows older than 1 h are pruned in the same batch), used by the jobs Worker
  and `/api/v1/dev/ping`, covered by `test/integration/ping.test.ts`. Timeouts were not changed.
- **Real bug found by e2e**: inputs rendered with `value={…}` were reset during hydration, so an e-mail typed
  before JS loaded vanished (QA's next-flow test failed this way). They now use `defaultValue`/`defaultChecked`.
  The `signUp` helper in `accounts.spec.ts` now waits for the redirect, because an earlier `goto` aborted the
  sign-up.
- **Red team L4 (fixed)**: `isPlausibleEmail` refuses `\p{Cf}` (zero-width, bidi), `\p{Z}` and controls, so a
  look-alike address cannot become a second account (refuse, not strip). Failing test first in
  `password.test.ts`.
- **Red team L7 (fixed)**: a successful sign-in, and a sign-up posted from a signed-in browser, revoke the session
  of the cookie being replaced. Failing tests first in `routes.test.ts` (sign-in, and sign-up: removing the
  revoke line makes it fail).
- **Red team L1–L3, L5, L6, L8, L9**: left as documented Lows, per the controller. L5 (shared space without an
  owner after its Pemilik deletes the account) belongs to FN-03.
- `SUPPORT_EMAIL` is omitted from `env.staging.vars` (comment in `wrangler.jsonc`), so staging shows the no-mailto
  branch until the owner supplies the address.
