# FN-01 Account and sign-in — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (owner answers: password minimum 8, 30-day absolute session, no
e-mail verification, `/hapus-akun` explanation + mailto, self-attested 18+).

- **Built:** migration `0001_accounts.sql` (users, user_passwords, sessions, auth_attempts, spaces, space_members);
  `src/lib/server/auth/*` ported from the earlier project (PBKDF2 100k, hashed opaque sessions, per-client throttle + lockout,
  `__Host-` Secure cookie off localhost); session middleware in `src/hooks.server.ts` protecting every `(app)` route;
  `/daftar`, `/masuk`, `/pengaturan`, `/pengaturan/akun` (sign-out, delete with password), `/akun-dihapus`, site
  `/hapus-akun`; personal space created at sign-up; e2e signed-in fixture; per-id queue ping rows (flake fix).
- **QA:** PASS (cycle 1: 29/30 criteria, criterion 19 partial — no skeleton needed; cycle 2 re-check PASS).
- **Red team:** PASS, no critical/high/medium; L4 (zero-width e-mail) and L7 (revoke replaced session) fixed in cycle 2;
  L1–L3, L6, L8, L9 documented Lows; L5 handed to FN-03.
- **Not verified:** real Cloudflare edge behaviour of `CF-Connecting-IP` (staging deploy pending); `SUPPORT_EMAIL`
  not supplied (no-mailto branch shown).
