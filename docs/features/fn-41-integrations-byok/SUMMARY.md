# FN-41 Integrations: per-user AI keys (BYOK) and an admin status view — summary

Status: **complete** (2026-10-09).

- `/pengaturan/integrasi`: each user adds their own Anthropic key, sealed at rest with the dedicated
  `AI_KEYS_ENCRYPTION_KEY` (AES-256-GCM via the shared `src/lib/server/server-seal.ts`, bound to row, user and
  provider; rotation with `_PREVIOUS`). Shown only as •••• + last 4; replace, delete, audit rows. "Tes koneksi" makes
  one minimal Messages call through the app's AI Gateway (`AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID`) with the user's
  key, `cf-aig-skip-cache` and `cf-aig-collect-log: false`, 10 s timeout, 5 per 10 minutes per user; outcomes ok,
  invalid, quota, network, model unavailable. `resolveAnthropicKey()` is ready for later AI features.
- `/pengaturan/integrasi/admin`: names and on/off of app-wide secrets, only for `ADMIN_EMAILS`; 404 for everyone else.
- Migration `0028_ai_keys.sql` (`ai_keys`, `ai_key_audit`, account-level). Account deletion and export covered (the
  export says only that a key exists).
- Tests: ai-keys, crypto, anthropic (injected fetch), admin unit tests; `test/integration/integrasi.test.ts`;
  `e2e/integrasi.spec.ts`. The connected-apps sealing refactor is pinned by a golden ciphertext vector.
- QA PASS; red team PASS. Cycle 2 fixed L2 (model id `claude-haiku-5-5`, 404 → model unavailable) and L3 (gateway
  cache/log headers). Open: L1 admin trusts an unverified e-mail (fine while admin is read-only; needs verification or
  account-id admin before any admin write), L4 one sealing secret for all stored keys (by design).
- Not verified: a real Anthropic call through a real AI Gateway; no secrets set on staging yet.
