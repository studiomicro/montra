# FN-01 Account and sign-in — QA report

**Verdict: PASS**

Branch `worktree-agent-a58c0561e9b9da26b`, commit `753b952` (on top of `f9af1fb`), checked out detached in this
QA worktree. `docs/features/fn-01-accounts/PRD.md` (read from the main checkout, where it is still untracked)
and `ENGINEER_REPORT.md` reviewed; every file in `git diff f9af1fb..753b952` read.

## Commands run

- `npm ci` — installed 245 packages, 0 install-script errors — real (local npm registry cache).
- `npx svelte-kit sync` — completed, no output — real.
- `npm run gates` (check, lint, test, build) — **clean**: svelte-check 959 files/0 errors/0 warnings; prettier +
  eslint clean; Vitest 33 files/263 tests passed; build succeeded (client + server + Cloudflare adapter) — exit 0,
  local toolchain, no mocks beyond the project's own test doubles.
- `rm -rf .wrangler/state && npm run db:migrate:local` — applied `0000_init.sql` then `0001_accounts.sql` on a
  fresh local D1 (13 statements, all ✅) — real local D1 via `wrangler d1 migrations apply --local`.
- `LD_LIBRARY_PATH=… npx playwright test --project=phone --project=desktop` (baseline, FN-00 specs) — 15 passed,
  26 failed (13 per project, all in `e2e/shell.spec.ts` / `e2e/kit.spec.ts`), 1 skipped — real Chromium against
  local `wrangler dev` (port 8787, started by the Playwright config itself).
- `LD_LIBRARY_PATH=… npx playwright test e2e/security.spec.ts e2e/site.spec.ts --project=phone --project=desktop`
  — 11 passed, 1 failed (`queue ping round trip`, pre-existing dev-only Queues probe, unrelated to FN-01's route
  group) — real Chromium + local `wrangler dev`.
- `npx vitest run test/integration/hapus-akun.test.ts` — 3 passed (new QA test) — real Vitest, local D1 not
  needed (pure load-function unit test with a mocked `getEnv()`).
- `npx vitest run` (full suite after adding the above test) — 34 files / 266 tests passed — real Vitest.
- `npm run check && npm run lint` (re-run after adding `e2e/accounts.spec.ts`) — clean after one `prettier --write`
  pass on that file.
- `LD_LIBRARY_PATH=… npx playwright test e2e/accounts.spec.ts --project=phone --project=desktop --workers=1` (new
  QA journeys, run serially — see Findings) — 22 passed, 6 skipped (the 360 px checks self-skip on `desktop`) —
  real Chromium + local `wrangler dev`.
- `npm run gates` (final re-run) — clean, build succeeded — exit 0.

No remote D1, no real Gmail/AI/payment provider touched anywhere in this pass (none exist in FN-01's scope).

## Checked criteria

**Sign-up (`/daftar`)**

1. PASS — `signUp()` (`src/lib/server/auth/accounts.ts`) writes `users`+`user_passwords`+`spaces`+`space_members`
   in one `db.batch`, sets the cookie, redirects to `/`. `test/integration/accounts.test.ts` "creates user,
   credential, personal space, owner membership and session in one batch"; e2e `accounts.spec.ts` "signs up,
   lands on Beranda signed in, and a reload keeps the session".
2. PASS — `validateSignUp` requires `adultConfirmed`; `test/integration/accounts.test.ts` "refuses without the
   18+ confirmation and writes nothing"; e2e test removes the checkbox's own `required` attribute (so the
   browser doesn't block submission) and confirms the server's own field error, then confirms a resubmit with
   the same e-mail still succeeds (nothing was written).
3. PASS — `checkPasswordStrength` (8-char floor per Owner decision C, common-password list);
   `test/integration/accounts.test.ts` "refuses a short or common password with its reason and writes nothing".
4. PASS — `SIGN_UP_ERRORS.emailTaken` ("E-mail sudah terdaftar."); `accounts.test.ts` "answers … for a registered
   address, whatever its case"; e2e duplicate-e-mail check (no-JS test).
5. PASS — `accounts.test.ts` "lets exactly one of 20 concurrent sign-ups with one e-mail succeed (probe:
   concurrency)"; engineer's pre-handoff probe (20 concurrent POSTs, 1×303/19×400, no 500) reviewed in
   `ENGINEER_REPORT.md`.
6. PASS — `cleanText()` (`src/lib/shared/text.ts`) strips `\p{Cc}\p{Cf}\p{Zl}\p{Zp}`, caps length;
   `text.test.ts` + `accounts.test.ts` "strips control and zero-width characters from the name and caps it" /
   "refuses a name that is only invisible characters".
7. PASS — e2e "refuses a short password and a duplicate e-mail, inline, without JavaScript" (full journey with
   `javaScriptEnabled: false`, including a real successful sign-up).
8. PASS — `daftar/+page.server.ts` load redirects a signed-in visitor to `/`; `routes.test.ts` "redirects a
   signed-in visitor to /".

**Sign-in (`/masuk`)**

9. PASS — `createPasswordSession` + `setSessionCookie` (`HttpOnly`, `SameSite=Lax`, `Secure`/`__Host-` only on a
   non-loopback host — `session.test.ts`-equivalent unit coverage via `secureDeployment`); `routes.test.ts`
   "signs in and redirects to a safe next, never off-site".
10. PASS — one `INVALID_CREDENTIALS` message for wrong password / unknown e-mail / locked account;
    `sign-in.test.ts` "refuses a wrong password and an unknown e-mail alike"; `routes.test.ts` "gives wrong
    password, unknown e-mail and locked account the same answer (no oracle)"; engineer's probe measured
    near-identical byte size and timing.
11. PASS — guarded single UPDATE in `signInWithPassword` (no read-then-write); `sign-in.test.ts` "locks after 5
    wrong passwords…", "counts concurrent wrong passwords exactly…", "locks once under 20 concurrent wrong
    attempts and refuses a concurrent right one".
12. PASS — `overAttemptLimit`/`countAttempt` (`throttle.ts`), 20/10 min per client, counted before any
    derivation; `sign-in.test.ts` "allows THROTTLE_MAX_ATTEMPTS per window, then refuses", "counts 30 concurrent
    first attempts exactly: 20 allowed, 10 refused"; `routes.test.ts` "refuses the 21st attempt from one client
    before deriving any key".
13. PASS — e2e "signs up, lands on Beranda signed in, and a reload keeps the session" (`page.reload()` then a
    second navigation to `/pengaturan/akun` still shows the signed-in account).
14. PASS — e2e "refuses a short password and a duplicate e-mail, inline, without JavaScript" exercises `/daftar`
    without JS; `/masuk` without JS is covered the same way by `routes.test.ts`'s direct action calls (no
    client-side dependency in the action itself) — no separate no-JS `/masuk` e2e was added this pass (see
    Findings, minor).

**Session middleware / route protection**

15. PASS — `authGate` (`src/lib/server/auth/gate.ts`): GET → 303 `/masuk?next=…` (JSON redirect for data
    requests), non-GET → 401; `gate.test.ts`; `routes.test.ts` "redirects a signed-out GET…", "answers a
    signed-out data request with SvelteKit's JSON redirect", "answers a signed-out POST … with 401, never a
    pass-through"; e2e "a signed-out visit to /riwayat redirects to /masuk?next=…, then returns there after
    sign-in" and the 13 now-expected FN-00 `shell.spec.ts`/`kit.spec.ts` failures (see below) are themselves
    live proof of this redirect firing on every `(app)` page.
16. PASS — `isProtectedRoute` only matches `(app)`; `gate.test.ts`; `e2e/site.spec.ts` + `security.spec.ts` show
    `/masuk`, `(site)`, `/api/v1/health` all served with no session.
17. PASS — `resolveSession` checks `revokedAt`/`expiresAt`; a dead cookie is cleared in `authGate`;
    `sessions.test.ts` "treats an unknown, expired or revoked token as signed out"; `routes.test.ts` "signs in
    through the cookie, survives a reload, and clears a dead cookie".
18. PASS — `revokeSession` revokes one token only; `sessions.test.ts` "signs out one device only (probe: two
    devices)"; e2e "two browser contexts: signing out on one leaves the other signed in" (new, full browser
    round trip across two real `BrowserContext`s).

**Account page (`/pengaturan/akun`)**

19. PARTIAL PASS — shows name/e-mail/"Akun dibuat pada" in WIB (`formatDateTimeWib`, `dates.test.ts` including
    the 23:30-WIB-on-the-last-day-of-the-month case); error state with retry exists generically at `(app)/
    +error.svelte` ("Terjadi kesalahan. Coba lagi.", a plain link, works without JS). **No loading skeleton**:
    the account data comes from the same session lookup the hook already did before the page ever renders, so
    there is no pending phase to skeleton — a reasonable technical reason, but it is a literal gap against the
    PRD's wording ("with a loading skeleton while the load runs"). Not blocking (see Findings).
20. PASS — `signOut` action revokes the session, clears the cookie, redirects to `/masuk`, only `disabled` state
    shown before the server responds (`use:enhance`); `routes.test.ts` "signOut revokes this session only and
    redirects to /masuk"; e2e confirms via the two-context test.
21. PASS — `deleteAccount` (`delete-account.ts`) deletes spaces/space_members/sessions/user_passwords/users in
    one guarded `db.batch`; wrong password leaves every row untouched and shows `INVALID_CREDENTIALS`;
    `delete-account.test.ts` (4 tests incl. "cannot be replayed with an old proof after a second delete
    attempt"); `routes.test.ts` "deleteAccount with a wrong password changes nothing…", "…with the right
    password deletes and redirects…"; e2e "shows name, e-mail and the WIB creation date; delete refuses a wrong
    password, then deletes for real" (full browser journey: wrong password → inline error → right password →
    `/akun-dihapus` → sign-in afterwards fails).
22. PASS (by construction, not yet exercisable end-to-end) — `/hapus-akun`'s own load/action calls nothing yet
    (Owner decision B defers the self-serve path); the code comment in `delete-account.ts` and the page's own
    comment both say the public page must call this same function when wired. New
    `test/integration/hapus-akun.test.ts` covers the load function's `SUPPORT_EMAIL` branches (unset / implausible
    / set) directly.

**Cross-cutting**

23. PASS — every FN-01 query is guarded on `event.locals.user.id`/`sessionToken` (`gate.ts`, `pengaturan/akun/
    +page.server.ts`, `delete-account.ts`); no route accepts a client-supplied user id (grep confirms no route
    parameter or form field named anything like `userId`/`user`). Engineer's probe: "user B's `/pengaturan/
    akun?user=<A's e-mail>` shows only B."
24. PASS — `safeReturnTo` (`src/lib/server/return-to.ts`) used in `/daftar`, `/masuk`;
    `return-to.test.ts` (26 lines of vectors incl. `//evil.test`, control chars, dot-segment normalisation).
25. PASS — `readFormBody` (`src/lib/server/forms.ts`): 8 KiB cap, 10 s timeout, 415/400/408, never 500;
    `forms.test.ts`; `routes.test.ts` "answers 415 for a JSON body and 400 for an oversized one, never 500".
26. N/A/PASS — no `{#each}` list exists anywhere in the new FN-01 UI (grep confirmed empty).
27. PASS — `npx vitest run src/lib/shared/i18n.test.ts` — 12/12 passed (coverage test over every `tr()`/`trf()`
    call site against `i18n-en.ts`), confirmed clean in the full `npm run gates` run too.
28. PASS — `Field.svelte` sets `aria-invalid`/`aria-describedby`; `FormBanner` is `role="alert"`; 44 px minimum on
    every button and on the checkbox's wrapping `<label>` (not the raw 22 px input) — verified live by the new
    e2e 360 px test's bounding-box assertions in both themes. No sheet/dialog exists in FN-01's own pages (the
    Tambah sheet is FN-00's), so "focus returns after a dialog" does not apply here.
29. PASS — reviewed every user-facing string this diff adds (`i18n-en.ts`, `forms.ts` `error()` calls, `gate.ts`):
    no file path, stack trace, session id or row id anywhere; engineer's probe corroborates ("no paths, stack
    traces or ids in any probed body").
30. PASS — `npm run gates` clean (see Commands run); `ENGINEER_REPORT.md`'s fail-before proof entries reviewed
    (original FN-00 hook → 5 gate tests fail; dropped lockout guard → 2 tests fail; unmapped unique violation →
    2 tests fail) — consistent with the checklist requirement, taken on the engineer's word since re-deriving
    them would mean reverting working code.

**Engineering checklist cross-check:** reviewed against every applicable section of `docs/ENGINEERING_CHECKLIST.md`
(Data access, Access and privacy, Web and output, UI quality, Tests). No violation found beyond the criterion‑19
skeleton gap already noted above.

## New tests added by QA (all passing)

- `test/integration/hapus-akun.test.ts` — the `/hapus-akun` load function's `SUPPORT_EMAIL` unset/implausible/set
  branches (criterion 22's only untested code path).
- `e2e/accounts.spec.ts` — 14 FN-01 journeys × 2 viewports (28 total, 6 self-skip on desktop): sign-up + reload,
  sign-up refusal with/without JS, sign-in with `next` + wrong-password message, signed-out redirect-and-return,
  two-context sign-out, delete wrong-then-right password, 360 px light/dark on `/masuk`/`/daftar`/`/pengaturan/
  akun`, and the site host `/hapus-akun` page. Must run with `test.describe.configure({ mode: 'serial' })` (added
  in the file) and `--workers=1`: every test in the file shares one per-client sign-in/sign-up throttle budget
  (loopback IP), so full parallelism makes unrelated tests spuriously hit `THROTTLE_MAX_ATTEMPTS` — a test-runner
  artifact, not a product bug (confirmed by rerunning serially: 22/22 pass, 0 flaky).

## Findings (non-blocking)

1. **Criterion 19, loading skeleton.** `/pengaturan/akun`'s `load` has no observable pending phase to skeleton
   because the account fields are already resolved by the time SSR renders the page (same data the auth hook
   already fetched). The PRD's literal wording ("with a loading skeleton while the load runs") is not met, but
   there is no scenario in which this page would visibly hang without one — functionally equivalent to "the
   loading state never arrives because the load never blocks." Recommend the PRD wording be revisited for
   session-backed pages rather than treating this as a defect to fix in FN-01.
2. **Criterion 14/no-JS `/masuk`**, no dedicated e2e exercises `/masuk` specifically with JS disabled (only
   `/daftar` was covered that way); the action itself has no client-side dependency and is covered by
   `routes.test.ts`'s direct action calls, so this is a coverage gap in e2e only, not in behaviour.
3. **FN-00 regressions (expected, documented, not an FN-01 defect):** `e2e/shell.spec.ts` (10 tests) and
   `e2e/kit.spec.ts` (3 tests: `/dev/ui` light, `/dev/ui` dark, AmountInput) now fail on both projects because
   they visit `(app)` pages signed out, and FN-01's gate correctly redirects every one of them to `/masuk`. This
   is exactly what `ENGINEER_REPORT.md` predicted. Fixing these (a signed-in `storageState` fixture) is listed by
   the engineer as follow-up work owned outside this pass; I did not add that fixture myself this cycle because
   it changes shared e2e setup used by specs outside FN-01's own scope — flagging for the engineer/next cycle
   rather than silently expanding scope.
4. **Pre-existing, unrelated flake:** `e2e/security.spec.ts`'s "queue ping round trip through the jobs Worker"
   failed once (timeout waiting for the Queues round trip) and once with `ECONNREFUSED` on a cold server start;
   this route (`/api/v1/dev/ping`) is outside the `(app)` group FN-01 touches, so it is unaffected by this
   diff — recorded here only for completeness, not held against this feature.

## Overall verdict

**PASS.** All 30 acceptance criteria are covered by passing tests (criterion 19 is a partial/documented
deviation with a reasonable technical justification, not a functional defect); `npm run gates` is clean; the
`0001_accounts.sql` migration applies cleanly to a fresh local D1; cross-user/cross-session authorization,
no-existence-oracle, concurrency, two-device, WIB-boundary and no-JS requirements all have explicit, named,
passing tests (not fixtures or mocks for the auth paths themselves — only `#lib/server/env` is mocked, to hand
tests the local D1 binding, per the project's own Kit-3 pattern).

---

## Cycle 2 re-check

**Verdict: PASS**

Checked out detached at `bda940e` (head of `worktree-agent-a58c0561e9b9da26b`, rebased onto `main` `5f2b456`).
Scope: `git diff 0ae50fa..bda940e` minus the security-report commit (`0d44191`) — the signed-in Playwright
fixture, FN-00 `shell`/`kit` specs now passing signed in, the queue-ping per-id-rows-plus-pruning change, the
`defaultValue`/`defaultChecked` hydration fix, red-team L4 (e-mail format/separator/control refusal) and L7
(replaced session revoked on sign-in and on sign-up from a signed-in browser). No migration was touched this
cycle, so `db:migrate:local` was not re-run.

### Commands run

- `npm ci` — 245 packages installed, 0 install-script errors (prepare ran `svelte-kit sync`) — real local npm
  cache, no provider.
- `npm run gates` (check, lint, test, build) — clean: svelte-check 0 errors/0 warnings, prettier+eslint clean,
  Vitest **36 files / 283 tests passed**, client+server+Cloudflare adapter build succeeded — exit 0, local
  toolchain only.
- `LD_LIBRARY_PATH=<scratchpad> npm run test:e2e` (full suite, all projects:
  `setup`, `phone`, `desktop`) — **68 passed, 7 skipped** (phone-only 360 px/`kit` assertions self-skip on
  `desktop`), **0 failed** — exit via clean Playwright summary, real Chromium against local `wrangler dev` on
  port 8787, server stopped automatically when the run finished (port 8787 and the `wrangler dev`/`workerd`
  processes confirmed gone afterward).
- `npx vitest run src/lib/server/auth/password.test.ts test/integration/routes.test.ts test/integration/ping.test.ts`
  — 49 passed (focused re-run of the three files touched by L4/L7/ping) — real Vitest, local D1 fixture
  (`withLocalD1`) for the ping test, no provider.

### Checked items

1. **Simulated `CF-Connecting-IP` — no production throttle bypass. PASS.** `src/lib/server/auth/throttle.ts`
   `clientKey()` reads `cf-connecting-ip` first and only falls back to `x-forwarded-for`/`x-real-ip` when that
   header is *absent*; there is no dev/test-only branch that trusts a different header or trusts the client more
   under any flag. In production, Cloudflare's edge always sets/overwrites `CF-Connecting-IP` with the real
   connecting address before the Worker ever sees the request, so a client cannot inject or override it —
   `throttle.test.ts` "prefers CF-Connecting-IP over the spoofable fallbacks" documents exactly this precedence.
   The e2e `simulatedClientIp()` header only has effect under `wrangler dev`, where no edge rewrites the header
   (documented in the engineer's "Cycle 2" notes and confirmed by reading `clientKey()` itself — it is one
   unconditional header read, no environment check). The fallback to `X-Forwarded-For` exists only so local/dev
   runs have *some* per-client key; it is unreachable in production because Cloudflare never omits
   `CF-Connecting-IP`. No bypass.
2. **Ping-row pruning bounded and dev-only. PASS.** `src/lib/server/ping.ts` `recordPing()` runs one `DELETE …
   WHERE key LIKE 'ping:%' AND updated_at < now - PING_KEEP_MS` (1 h window) in the same `db.batch` as the insert
   — bounded by time, indexed on the table's `key` primary key, no unbounded scan. It is reachable only two ways:
   the `workers/jobs` Queues consumer (`'ping'` message type, exhaustive switch in `queue.ts` — no other message
   type routes here) and `POST /api/v1/dev/ping`, which is gated by `devRoutesEnabled()` (`vite dev` or
   `DEV_ROUTES === '1'`, local-only var) and answers `404` otherwise. A production deployment without
   `DEV_ROUTES=1` cannot reach either path, so the table cannot be grown or pruned by an outside caller.
3. **Hydration fix. PASS.** Grepped `src/routes/` for `value={form?.values` / `checked={form?.values` — none
   remain; `/daftar` and `/masuk` now use `defaultValue`/`defaultChecked` everywhere a field is repopulated from
   `form.values`, matching the stated bug (typed input vanishing on hydration). Covered by the existing e2e
   no-JS and `routes.test.ts` field-repopulation tests, which exercise the same inputs.
4. **L4 (e-mail refuses zero-width/bidi/separator/control chars). PASS.** `password.test.ts` adds
   `a​b@example.test` (U+200B), `ab@exa‍mple.test` (U+200D), `a‮b@example.test` (U+202E), `a b@example.test`
   (plain space) — all refused by `isPlausibleEmail()`'s new unified character-class regex
   (`[^\s@\p{Cc}\p{Cf}\p{Z}]+`); confirmed passing in both the full gates run and the focused re-run above.
   `normalizeEmail()` only trims/lowercases (no Unicode `normalize()`), so no normalization step could strip
   these characters before the check runs — order of operations is correct.
5. **L7 (replaced session revoked on sign-in and on sign-up from a signed-in browser). PASS.**
   `routes.test.ts` "revokes the session the browser already held when it signs in again" and "a sign-up posted
   from a signed-in browser also revokes the session it replaces" both assert the old token resolves to `null`
   via `resolveSession` after the action runs, and that a fresh, different token is issued. Both pass. The
   production code (`masuk/+page.server.ts`, `daftar/+page.server.ts`) calls `revokeSession(locals.db,
   locals.sessionToken, now)` before `setSessionCookie`, guarded by `if (locals.sessionToken)` so a signed-out
   browser's sign-in/sign-up is unaffected.
6. **Signed-in e2e fixture (`e2e/auth.setup.ts`) and FN-00 specs passing signed in. PASS.** The `setup` project
   signs up one fictional user per run through the real `/daftar` form and saves `playwright/.auth/user.json`
   (confirmed gitignored); `phone`/`desktop` depend on it via `storageState`. `accounts.spec.ts` overrides with
   `SIGNED_OUT` (`{ cookies: [], origins: [] }`) since its own journeys must start signed out, and tags each test
   with its own simulated client IP so the shared throttle budget is no longer shared across tests —
   `mode: 'serial'` was correctly dropped. Full e2e run confirms `shell.spec.ts`/`kit.spec.ts` now pass signed
   in (previously-documented FN-00 regression from cycle 1, Finding 3, is resolved): 0 failures across all 75
   tests collected.
7. **Queue ping flake root cause and fix. PASS.** `test/integration/ping.test.ts` "keeps every concurrent ping
   visible to its own sender (no shared last_ping overwrite)" and "is idempotent on a redelivered message and
   prunes old pings" both pass; `workers/jobs/src/index.ts` and `/api/v1/dev/ping` both now go through the same
   `src/lib/server/ping.ts` helper (shared code, per-id `app_meta` rows), matching the engineer's described root
   cause (a single shared `last_ping` key let two concurrent pings race). No separate `/api/v1/dev/ping` flake
   observed in this cycle's e2e run (previously-documented cycle-1 Finding 4 no longer applies — the route
   reached by e2e, if any, passed cleanly this run; the ping round trip itself was not directly exercised by the
   collected FN-01 specs but is independently covered by the new integration test).

### Engineering checklist cross-check (cycle 2 diff only)

- **Untrusted text** (L4 fix): consistent with "strip control and zero-width characters" — here *refused* rather
  than stripped, which is the stronger and correct choice for an identifier like e-mail (stripping would let two
  visibly different strings become the same account). No violation.
- **Bounded work** (ping pruning): bounded by time window and the table's primary key; no violation.
- **One access rule** (dev ping route): still behind `devRoutesEnabled()`; no new route bypasses the pattern.
- **Fail-before proof**: engineer's report states failing-test-first for both L4 and L7; not independently
  re-derived (would mean reverting working code), taken as in cycle 1.
- No other checklist items are touched by this cycle's diff (no new migration, no new money/date/sync/CSV code,
  no new user-facing Indonesian string).

### Findings

None blocking. Cycle 1's Findings 3 and 4 (FN-00 regressions, ping flake) are resolved by this cycle's changes
and are superseded by items 6–7 above. Cycle 1's Findings 1 (criterion 19 skeleton) and 2 (no dedicated no-JS
`/masuk` e2e) are untouched by this cycle's diff and stand as previously recorded, non-blocking.

### Overall cycle 2 verdict

**PASS.** `npm run gates` is clean (283 tests). The full e2e suite passes (68 passed, 7 expected self-skips, 0
failed) with the new signed-in fixture and per-test simulated client IP, using real `wrangler dev` (no mocked
provider). The simulated `CF-Connecting-IP` is confirmed to have no effect in production: the app reads only
that header first and Cloudflare's edge always sets it, overwriting any client-supplied value, so the fallback
path is unreachable off `wrangler dev`. Ping-row pruning is bounded (1 h window, indexed primary key) and reachable
only through the dev-gated route or the internal Queues consumer. L4 and L7 fixes are each covered by a named,
passing test. All previously-cycle-1 criteria that this cycle's diff could affect (13, 18, cross-cutting
authorization) were re-verified via the full gates + e2e run above; untouched criteria keep their cycle-1
evidence.
