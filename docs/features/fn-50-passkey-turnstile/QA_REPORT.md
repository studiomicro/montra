# QA report — FN-50 passkeys and Turnstile (cycle 1, HEAD cef2bfc on main 3265fb6)

**Verdict: PASS** (with two non-blocking findings and a list of owner / real-device items not verified)

What was built (engineer hand-off lost; read from `git diff main...HEAD`): Part A Turnstile (`turnstile.ts`, `turnstile-action.ts`, widget `Turnstile.svelte`, per-route CSP in `hooks.server.ts`, admin row, privacy sentence, RUNBOOK). Part B passkeys with a **hand-rolled verifier** `src/lib/server/auth/webauthn-verify.ts` (WebCrypto, ES256/RS256, attestation `none`). `@simplewebauthn/server` is NOT a dependency (package.json unchanged): the header comment records the spike (14.0.3 worked on workerd but bundled to 323.84 KiB > the PRD's 300 KB bar; own verifier 8.52 KiB), which is the PRD's allowed fallback. Migration 0044 adds four tables (`passkeys`, `passkey_challenges`, `passkey_sessions`, `auth_events`); `passkey_sessions` is the engineer's choice for the AC 38 revoke (PRD allowed a sessions column or events). 0043_transfer_links.sql is byte-identical to the FN-48c worktree file (`cmp` clean).

## Commands run
- `npm run check` — 0 errors, 0 warnings (2278 files), exit 0; no provider.
- `npm run lint` — prettier clean, eslint clean, exit 0; no provider.
- `npm run build` — adapter-cloudflare done, exit 0; no provider.
- `npm run db:migrate:local` (fresh persist dir) — 0000 … 0044 all applied incl. 0043_transfer_links and 0044_passkeys, exit 0; local D1; rerun: "No migrations to apply!".
- `npx vitest run` one at a time: webauthn-verify.test.ts 18/18, turnstile.test.ts 8/8, passkey-flow.test.ts 5/5, test/admin-page.test.ts 5/5, test/auth-pages.test.ts 3/3, test/integration/passkeys.test.ts 41/41, test/integration/turnstile.test.ts 17/17; local D1, siteverify stubbed (fixture/mock, not a real provider).
- `npm run test` (once) — 351 files passed, 5741 tests passed, exit 0; local D1, mocks. No rerun needed.
- `PATH=shim E2E_PORT=5399 npx playwright test e2e/passkey.spec.ts e2e/accounts.spec.ts e2e/account-key.spec.ts --workers=1 --project=phone` — 27 passed, exit 0; wrangler dev local, Chromium CDP virtual authenticator (no real device).
- QA-added `e2e/turnstile.spec.ts` (untracked, skipped unless `QA_TS_MODE` set; needs `.dev.vars` test keys, which I created and deleted): `QA_TS_MODE=pass … E2E_PORT=5398 --project=phone --no-deps` — 3 passed, 1 skipped; `QA_TS_MODE=fail` (secret `2x…AA`) — 1 passed, 3 skipped. Real Cloudflare widget script and siteverify with Cloudflare's documented dummy keys (real provider, test keys). `npm run gates` was not run as one command; its four steps were run separately with the results above.
- `curl` siteverify with the three documented dummy secrets (real Cloudflare endpoint): 1x… → `success:true, hostname:"example.com"`, no `action`; 3x… → `timeout-or-duplicate`; 2x… → `invalid-input-response`.

## Checked criteria
- AC 1, 2 (unset / partial): PASS — integration `turnstile.test.ts` "unset or partial"; default e2e server (no keys) runs sign-up/sign-in unchanged (27 e2e passed); partial logs `turnstile: partial configuration` without a value.
- AC 3 (configured render, CSP): PASS — integration CSP tests (`/masuk`, `/daftar` gain the origin in `script-src` and `frame-src`; `/` and `/pengaturan/akun` byte-identical); browser: response CSP contains the origin, widget loads, 0 CSP violations.
- AC 4, 6, 7, 8, 9, 10 (missing/empty/2049 token, wrong action/host, duplicate, timeout/non-2xx/non-JSON, body fields, 429 before siteverify): PASS — `turnstile.test.ts` + integration "configured (AC 3–10)". Fails closed when configured.
- AC 5 (valid token signs in): PASS (stubbed siteverify, integration). Not possible with Cloudflare's dummy keys, see Finding 1.
- AC 11 (360 px, id/en): PASS for fit and language — widget 320 px wide at x=20 in a 360 px viewport, no horizontal scroll, widget requests `lang=id` and `lang=en`; screenshot shows Indonesian "Berhasil!". The submit-succeeds half is not verifiable with dummy keys (Finding 1).
- AC 12 (always-fail → message, widget reset, second attempt without reload): PASS — browser run with the failing secret; token changes after the refusal and the second submit shows the message again.
- AC 13 (no JS): PASS — `<noscript>` line visible (innerText), POST refused with the AC 4 message, still on `/masuk`.
- AC 14 (admin row ok / partial / missing): PASS — `test/admin-page.test.ts`. Partial row reads "Belum lengkap … Baru sebagian diisi" (PRD said "sebagian").
- AC 15: NOT VERIFIED (owner, real staging widget).
- AC 16: PASS — e2e empty state "Belum ada passkey"; unsupported-browser state not driven in a browser (code present).
- AC 17–24: PASS — integration "registration" (wrong password, options content, ES256+RS256 insert, replay, expiry, cap 10, 20-way cap probe, user B vs A's challenge, bad host). Origin/rpIdHash refusals also in `webauthn-verify.test.ts`.
- AC 25–26: PASS — e2e conditional autofill sign-in and button sign-in with the virtual authenticator; integration session/cookie/counter/event/old-cookie revoke/safe `next`.
- AC 27–33: PASS — integration replay, 20-way concurrent single winner, other key, counter rollback (5→5, 5→3; 0→0 accepted), removed vs unknown identical, disabled user, two users, throttles 61/21 and fail-closed; verifier unit tests for origin, rpIdHash, type, altered authData.
- AC 34, 35: PASS — e2e cancelled prompt shows "Dibatalkan…" with no server call; no-JS has no passkey button and the password form posts.
- AC 36, 37: PASS — e2e: passkey sign-in → "key not open" with link → wrong password refused, correct password opens key, page unseals; integration: key material, password change, deletion, API tokens still demand the password. Owner decision 8 matches.
- AC 38–42, 44: PASS — integration remove (tombstone, event, other passkey sessions revoked, current kept), other user's id = unknown id, wrong password, re-register, password change keeps passkeys, account delete removes rows, signed-out gate. Owner decisions 9 and 10 match.
- AC 43: PARTIAL — e2e (dark, 360 px): no horizontal scroll, controls ≥ 44 px, ellipsis, "Dibuat … WIB" shown; light theme and the exact "12 Okt 2026, 23.30" string were not asserted (code uses the shared WIB formatter).
- AC 45, 46, 48: PASS — hostile-input test (never 500), concurrency tests, message/log grep test.
- AC 47: PASS — full suite includes the i18n coverage test.
- AC 49: PASS for focus return and keyed each (e2e `toBeFocused`; code review); contrast test unchanged (no new colours).
- AC 50: gates' four steps clean. Fail-before proof for AC 20, 27, 29, 30 not re-run by QA.
- Owner decisions: 1 (both-or-none), 2 (Managed, visible, `size: 'flexible'`), 3 (`remoteip` sent), 4 (noscript), 8–10 verified above; 11 (90-day sweep in jobs Worker, tested), 12 (rollback refused, passkey stays usable) verified.
- Space authorization: passkeys are user-level (no `space_id`, like `api_tokens`); every statement is guarded on the session's `user_id`; second user gets the same 404-shaped answer. No space-scoped load added, so sync scoping is unaffected.
- Money/WIB/captured data: not touched by this feature.

## Findings (none blocking)
1. **PRD inconsistency, not a code defect:** AC 5/11 expect Cloudflare's always-pass test keys to complete a sign-in. Their siteverify answer carries `hostname:"example.com"` and no `action`, so the strict action and hostname checks (AC 6, correct for real keys) refuse every dummy token. A browser-level success path therefore exists only with the owner's real widget (AC 15). Do not loosen the check.
2. **Coverage gap closed by QA, not by the engineer:** the engineer wrote no browser test for Part A (AC 11–13). QA added `e2e/turnstile.spec.ts` (skipped unless `QA_TS_MODE` and test keys in `.dev.vars`; commit it or drop it at `/ship`).
3. Minor: `TURNSTILE_*` vars are cast (`getEnv() as Env & TurnstileEnv`); `worker-configuration.d.ts` was not regenerated (`npm run types:cf`) as the PRD listed. Only one recorded real-browser vector (Chromium virtual authenticator); no Safari/Chrome-real or Firefox vector, as the PRD asked for in the fallback branch.
4. ENGINEERING_CHECKLIST: no violated item found in the diff review (parameterised guarded statements, `readFormBody`, fail-closed throttles, loading/empty/error states, English entries).

## Not verified (owner / real device)
Real Turnstile widget on staging and replayed-token curl (AC 15); passkey on a real iPhone (Face ID) and Android; real Safari/Firefox WebAuthn; Turnstile "Pass level" behaviour and the Managed interactive challenge UI; the `<staging-app-host>` rpId in production.
