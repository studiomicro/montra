# FN-21 Account key and sealed results — summary

**Status: complete** (2026-10-08). PRD: `PRD.md` (defaults auto-accepted). No producer yet: FN-15/16 (on hold with the
Anthropic key) will be the first to seal results.

- **Built:** migration `0011_account_keys.sql`; X25519 key pair generated on the device (WebCrypto) at sign-up / first
  sign-in; private key (PKCS#8) wrapped with AES-256-GCM under a scrypt key (N=2^17, r=8, p=1 — OWASP's current
  figure, verified 2026-10-08; `@noble/hashes` 2.4.0 for scrypt only) derived in a Web Worker with a 30 s timeout;
  server stores only the public key, the wrapped key and SHA-256 of a key check; sealing = ephemeral X25519 + HKDF-SHA256
  (both public keys bound) + AES-256-GCM, versioned envelope, fresh nonce; shared code in `src/lib/shared` for device
  and Worker; "Kunci ulang" re-wraps the same key after a password change; password change signs out every other
  session and removes their push subscriptions; opened key dropped on sign-out in any tab, ended sessions and 401;
  throttled password-checking actions; worker CSP via `_headers`; RFC 7748 / RFC 5869 / scrypt vectors; e2e
  `account-key.spec.ts`. Sign-up adds ≈0.5 s.
- **QA:** PASS 30/30 (fail-before done by QA). **Red team:** FAIL (M1 other sessions stayed signed in) → fixed;
  re-check PASS; N2 (hash the key check) fixed; N1 (throttle counts correct passwords) accepted.
- **Inherent limit:** the password still reaches the server at sign-in (FN-01), so a malicious server could unwrap the
  key; the derived key and plaintext private key never leave the device.
