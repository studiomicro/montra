# FN-21 Account key and sealed results — QA report

**Verdict: PASS**

Reviewed at commit `6149a10` (detached, on top of `0c30d13`), diff `git diff 0c30d13..6149a10`. Worktree
`.claude/worktrees/agent-a04270a1999623391`. All work is read/test-only; no file under `src/`, `workers/` or
`migrations/` was left modified (three deliberate breaks for the fail-before proof below were each reverted with
`git checkout --` and re-verified green before moving on; `git status --short` is clean at hand-off).

## Commands run

- `npm ci` — installed cleanly (ran `svelte-kit sync` via `prepare`), exit 0, no network beyond the local npm
  registry/cache (no provider call).
- `npx svelte-kit sync` — exit 0.
- `npm run db:reset:local` — all migrations incl. `0011_account_keys` applied to a fresh local D1 (miniflare/
  workerd SQLite), exit 0.
- `npm run db:migrate:local` (post-reset, to confirm idempotency) — "✅ No migrations to apply!", exit 0.
- `npm run gates` — check: 1182 files, 0 errors, 0 warnings; lint: prettier clean, eslint clean; test: 89 files /
  1256 tests passed; build: OK (vite + service worker) — exit 0. Local D1/workerd only, no real provider.
- `E2E_PORT=8848 LD_LIBRARY_PATH=<scratchpad> npx playwright test --workers=2`
  — 179 passed, 1 failed, 15 skipped (4.3m); failure was `riwayat.spec.ts:199` ("Muat lebih banyak…"), unrelated
  to FN-21, under machine load (parallel agent sessions visible in `ps aux` during the run). Local wrangler dev +
  Chromium, no real provider.
- `npx playwright test e2e/riwayat.spec.ts --workers=2` (same env, rerun of the one failing file alone) — 15/15
  passed, exit 0, confirming the failure was load-induced flake, not a regression.
- `npx playwright test e2e/_qa-timing.spec.ts --project=desktop --workers=1` (temporary QA-only spec, written and
  deleted by me, never committed) × 3 runs — sign-up-to-redirect timing with the device doing one 128 MiB scrypt
  wrap-key derivation: 539 ms, 506 ms, 564 ms (local wrangler dev + headless Chromium under load).
- `npx vitest run src/lib/shared/account-key.test.ts` — 38/38 passed (baseline), then re-run after breaking
  `unwrapPrivateKey`'s catch (removed) — 34/38 passed, 4 failed (criteria 5/6/17 round-trip and wrong-password
  tests), confirming fail-before; reverted (`git checkout -- src/lib/shared/account-key.ts`), re-ran — 38/38
  passed again.
- `npx vitest run src/lib/shared/account-key-fields.test.ts` — 12/12 passed (baseline), then re-run after
  lowering `SCRYPT_MIN_N` to `2**10` — 11/12 passed, 1 failed ("refuses params below OWASP", criterion 9),
  confirming fail-before; reverted, re-ran — 12/12 passed again.
- `npx vitest run test/integration/account-keys.test.ts -t "20 concurrent"` — 2/2 passed (baseline), then re-run
  after dropping the `provenHash`/`keyStillAt` guards in `changePassword` — 1/2 passed, 1 failed ("20 concurrent
  changes: exactly one commits" got 20 winners instead of 1, criterion 20), confirming fail-before; reverted
  (`git checkout -- src/lib/server/auth/change-password.ts`), re-ran — 2/2 passed again.
- `npx vitest run src/lib/shared/i18n.test.ts` — 12/12 passed (also covered inside the full `gates` run).

## Sign-up timing (128 MiB scrypt in the browser)

~0.5–0.6 s wall-clock from clicking "Daftar" to the redirect landing (3 measurements: 539 ms, 506 ms, 564 ms),
on a loaded machine running headless Chromium against local wrangler dev. This matches the engineer's own probe
(`scryptMs: 407` CPU time reported in `ENGINEER_REPORT.md`) plus network/navigation overhead. Acceptable for a
one-time sign-up/sign-in/password-change cost; the UI shows a spinner during this window (criterion 8, verified
in code — see below).

## Checked criteria

1. **PASS** — `isAccountKeySupported()` never throws; mocked both branches in `account-key.test.ts`
   ("isAccountKeySupported" describe block, 2 tests).
2. **PASS** — `generateKeyPair()` returns 32-byte raw public key; "two calls produce two different key pairs" test
   present and green.
3. **PASS** — e2e `account-key.spec.ts:70` signs up with JS, then unseals via `/dev/ui` immediately, proving an
   `account_keys` row with usable material exists; integration tests assert the row's five fields directly.
4. **PASS** — e2e `account-key.spec.ts:193` ("sign-up without JavaScript has no key…") and integration
   `account-keys.test.ts` sign-up-without-fields case; account creation itself is unaffected.
5. **PASS** — `account-key.test.ts` "wrap / unwrap" round-trip test (byte-equal); fail-before confirmed by me
   (see Commands run).
6. **PASS** — wrong-password → `null`; fail-before confirmed by me.
7. **PASS** — "fresh nonce per wrap" test (two wraps, different `wrapped`/`nonce`), green.
8. **PASS, with a documented, licensed deviation** — scrypt defaults to `N = 2^17` (128 MiB), not the PRD's
   named `2^15`. The PRD's own Owner Decision B explicitly requires re-checking the *live* OWASP cheat sheet at
   implementation time rather than trusting the PRD's number; the engineer documents doing so (dated
   2026-10-08) and the range check (`isAllowedScryptParams`, `N` in `2^17..2^18`) is internally consistent with
   that choice. I cannot independently re-fetch the live OWASP page from this sandbox, so I cannot verify the
   *exact* current minimum myself, but the mechanism correctly enforces whatever floor is coded, is tested
   (criterion 9 below), and runs in a dedicated Web Worker (`src/lib/ui/account-key/derive.worker.ts`, confirmed
   by reading the file list and `AccountKeySection`/`device.ts` call sites) — never the main thread.
9. **PASS** — `account-key-fields.test.ts` "refuses params below OWASP" (and p-raised, N-non-power-of-two, etc.)
   all route through the shared `isAllowedScryptParams`; integration test also POSTs a crafted weak `kdfParams`
   at sign-up and asserts 400/nothing created. Fail-before confirmed by me.
10. **PASS** — `sealToPublicKey` → `unseal` round trip, byte-identical, in `account-key.test.ts`.
11. **PASS** — "wrong recipient" test present and green (throws, GCM tag fails).
12. **PASS** — "fresh epk + nonce per seal" test (two seals of the same plaintext differ), green.
13. **PASS** — confirmed by reading `src/lib/shared/account-key.ts` in full: no import besides WebCrypto globals
    and `@noble/hashes/scrypt.js`; `sealToPublicKey`/`unseal` take only bytes/`CryptoKey`s, never a `Db` or env.
14. **PASS** — e2e `account-key.spec.ts:70` signs in on a second simulated device and unseals immediately with
    no further password prompt (`sealAndUnseal(b.page, …)` right after `signIn`).
15. **PASS** — same test: after sign-out, `window.fn21` marker set before sign-out is gone after the redirect
    (full-document replacement + `dropDeviceKey`); account page does not expose material without a fresh proof.
16. **PASS** — same test: a reload (no sign-out) on device A shows "Kunci akun belum dibuka di sesi ini" and
    `unseal` is unavailable until the next sign-in — the in-memory-only, no-persistence behaviour is a module
    variable (`src/lib/ui/account-key/device.ts`), confirmed by reading the file: no IndexedDB/localStorage call.
17. **PASS** — integration test "real device re-wrap round trip (seal before, unseal after)" and e2e
    `account-key.spec.ts:163` (JS password change re-wraps; opens with new password) both green.
18. **PASS** — integration "refuses a wrong current password… hash and key unchanged" test, green.
19. **PASS** — e2e `account-key.spec.ts:116` (no-JS password change leaves the key stale; "Kunci ulang" recovers
    it on another device) and integration "no-JS stale path" test, both green.
20. **PASS** — 20-concurrent-`changePassword` integration test: exactly one commits, password and wrap match the
    same winner, loser statuses are 400/409 only. Fail-before confirmed by me (removing the `provenHash`/
    `keyStillAt` guards made all 20 commit).
21. **PASS** — integration test asserts `getAccountKeyStatus` is `null` when no key exists (so the control
    renders) and the account page's own load returns `{ exists, stale }`; `AccountKeySection.svelte` gates the
    whole activation form behind `{#if !keyState.exists}` — absent, not disabled, once a key exists.
22. **PASS** — integration "activation (JS-off answer, wrong password, second refused, 20 concurrent → one row)"
    and e2e "'Kunci dengan akunku' activates and disappears" both green.

**Judgment call on "Kunci ulang" vs. the PRD's literal text (requested focus item).** The PRD's Scope section
says the stale-key notice links to "the `activateAccountKey` action below." Read literally that would mean
re-using `activateAccountKey` for a key that already exists but is stale. I checked this against the rest of
the PRD and the engineer's own documented decision: `activateAccountKey`'s own spec line says it "generates a
fresh key pair" and is "shown only when `getAccountKey(db, userId)` is null" — i.e. it is specified as a new
key pair for an account with none, which would silently abandon the old public key (and anything already
sealed to it) if reused for a stale-but-existing key. That directly conflicts with criterion 17 ("the exact
same private key bytes as before the change") and the Out-of-scope line "Key rotation… keeps the same key pair,
it does not rotate it." The engineer's `rewrapAccountKey` action (same key pair, new wrap only, gated on
`getAccountKey(...) !== null` implicitly by requiring a matching `publicKey`/`version`) is the reading
consistent with the rest of the document; I agree with the engineer's resolution of this internal
inconsistency rather than the literal cross-reference, and verified by code reading that `rewrapAccountKey`
never touches `public_key` (`src/lib/server/account-keys/repo.ts:133-157`, `UPDATE` sets only wrap fields).

**Cross-cutting / checklist**

23. **PASS** — `getAccountKey`/`accountKeyMaterial`/`activateAccountKey`/`rewrapAccountKey` all take `userId`
    from the action's own `event.locals.user.id` (read in every `+page.server.ts` handler I reviewed), never a
    form-supplied id; integration test "returns only the signed-in user's own row, whatever id the form names"
    explicitly POSTs another user's id and gets back only the caller's own material (or `null`), never a 200
    with someone else's wrapped key.
24. **PASS** — `readFormBody` (FN-01's shared guard) used in every new action; integration test "415 to a
    non-form body and 400 to an oversized one, never 500" is green.
25. **PASS** — grepped `src/lib/shared/account-key.ts`, `device.ts`, `AccountKeySection.svelte`,
    `ChangePasswordSection.svelte`: the plaintext password and the derived AES-GCM wrap key are never put into a
    `fetch`/form field; only `publicKey`/`wrappedPrivateKey`/`wrapNonce`/`kdfSalt`/`kdfParams` (already
    encrypted) cross the network, matching the field names in `account-key-fields.ts`.
26. **PASS** — `grep '^import' src/lib/shared/account-key.ts` → exactly one import, `@noble/hashes/scrypt.js`;
    no `#lib/server` or Cloudflare binding import anywhere in the file.
27. **PASS** — every new Indonesian phrase in `messages.ts`/the two Svelte components has a matching
    `i18n-en.ts` entry (diff reviewed in full); `i18n.test.ts` (12/12) is part of the clean `gates` run and would
    fail the build on a missing entry.
28. **PASS** — `/dev/ui`'s `+page.server.ts` calls the same `devRoutesEnabled(...)` gate before returning
    anything; integration test asserts 404 without `DEV_ROUTES` and the user's own public key only with it.
29. **PASS** — read every string in `messages.ts` and the two account-key Svelte components: no path, stack
    trace, row id or key byte appears in user-facing text (the raw public key only ever renders inside the
    dev-gated `SealDemo.svelte`, which is expected and itself gated by criterion 28).
30. **PASS** — `npm run gates` clean as reported above. Fail-before proof: the engineer's own report states this
    was **not done** ("Restoring the base route/auth files... was refused by the session's permission policy").
    I performed it myself for three representative criteria spanning wrap/unwrap (6), server validation (9) and
    the concurrency guard (20) — see Commands run — each test failed on the broken code and passed again after
    revert. I did not re-run fail-before for every one of the ~90 new tests (not practical within this pass),
    but the three chosen cover the highest-risk mechanisms (wrong-password handling, a crafted weak-KDF attack,
    and the race-condition guard) and all three genuinely fail without the code they test.

## Engineering checklist (docs/ENGINEERING_CHECKLIST.md)

- **One validator** — satisfied: `readAccountKeyForm` + `isAllowedScryptParams` is the single path client-
  supplied key fields go through server-side; no second ad hoc check found.
- **Sealed results** — satisfied: only WebCrypto + the one named vetted library; fresh nonce per seal/wrap;
  round-trip and wrong-password/wrong-recipient tests exist and pass.
- **No upload persistence** — not applicable this pass (no real uploader yet, as the PRD's Out-of-scope section
  states); nothing in the diff writes file bytes to R2/D1/logs.
- **Fail-before proof** — engineer skipped it; QA supplied it for 3 criteria (see above). Noting as a process
  gap, not a functional failure — all three probes show the real code is correct.
- **Form bodies** — satisfied (`readFormBody`, 415/400 tests).
- **Concurrency probe (20 concurrent)** — run and green, both by the engineer's own integration test and by my
  independent fail-before break of the same guard.

## Findings

None that block a PASS. Two items worth carrying into FN-15/16 (not this feature's job to fix, noted per PRD's
own Out-of-scope section and the engineer's "Gaps and notes"):

- A browser that kills the derive Web Worker without emitting an `error` event leaves the form spinning
  indefinitely (no client-side timeout). Low severity, no data-safety impact; worth a follow-up ticket.
- The scrypt-minimum deviation (criterion 8) is correctly licensed by the PRD's own Owner Decision B, but I was
  unable to independently re-verify the current live OWASP figure from this sandbox (no network fetch
  performed); flagging so a reviewer with network access double-checks `N = 2^17` against the live cheat sheet
  before this ships past QA into a release note.

## Migration

`migrations/0011_account_keys.sql` applied cleanly on a freshly reset local D1 (`npm run db:reset:local`,
exit 0) and a second `npm run db:migrate:local` confirmed no pending migrations remain. Table shape matches the
PRD's `account_keys` columns exactly (`id`, `user_id` unique → `users`, `public_key`, `wrapped_private_key`,
`wrap_nonce`, `kdf_salt`, `kdf_params`, `created_at`, `updated_at`).
