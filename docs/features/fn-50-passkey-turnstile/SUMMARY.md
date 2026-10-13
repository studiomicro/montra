# FN-50 Passkeys and bot check on sign-in — SUMMARY

Status: **complete** (2026-10-13).

Goal (PRD): let a user sign in with a passkey instead of typing the password, and stop scripted sign-in and sign-up
attempts with Cloudflare Turnstile, without weakening the account-key encryption.

- Files: `src/lib/server/auth/webauthn-verify.ts` (hand-rolled WebAuthn verifier on WebCrypto, ES256/RS256,
  attestation none; `@simplewebauthn/server` bundled to 324 KiB, over the PRD's 300 KB bar), `passkeys.ts`,
  `passkey-flow.ts`, `turnstile.ts`, `turnstile-action.ts`, `session.ts`, `throttle.ts`, `delete-account.ts`,
  `src/hooks.server.ts` (CSP on the two auth routes), `/masuk`, `/daftar`, `/pengaturan/akun/passkey`, account-key
  UI, the integrations admin status, `src/lib/shared/i18n-en.ts`, `docs/RUNBOOK.md`, `docs/FEATURES.md`.
- Owner decisions: defaults; managed visible Turnstile widget; after a passkey sign-in the password is asked once
  per page session to open the account key; passkeys stay on password change; removing a passkey revokes its
  sessions except the current one.
- Migration: `0044_passkeys.sql` (passkeys, passkey_challenges, passkey_sessions, auth_events).
- Tests: `webauthn-verify.test.ts`, `passkey-flow.test.ts`, `turnstile.test.ts` (unit and integration),
  `test/integration/passkeys.test.ts`, `e2e/passkey.spec.ts`, `e2e/turnstile.spec.ts` (runs only with
  `QA_TS_MODE`), auth and admin page tests.
- QA: PASS. Red team: PASS with lows L1–L5 (`SECURITY_REPORT.md`), logged in `docs/TASKS.md`.
- Not verified: real Turnstile keys on staging (Cloudflare's always-pass test secret reports hostname
  "example.com", which the strict check refuses by design), a real-device passkey on iPhone and Android, Safari and
  Firefox.
