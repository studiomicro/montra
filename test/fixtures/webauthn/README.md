# WebAuthn vectors (FN-50)

`chromium-virtual-es256.json`: one registration (`attestation: 'none'`, ES256) and one discoverable assertion made by
Chromium 153's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`: ctap2, internal, resident key, user
verification) on a blank page at `http://localhost:47811`, rp id `localhost`, with fixed challenges (bytes 0x00–0x1f
and 0x20–0x3f). Recorded 2026-10-12 with a Playwright script that calls `navigator.credentials.create` and then
`navigator.credentials.get` and base64url-encodes the response fields exactly as `src/lib/ui/auth/webauthn.ts` does.
No real account or person: the user handle is 32 bytes of 0x07 and the user name `demo@example.test`.
