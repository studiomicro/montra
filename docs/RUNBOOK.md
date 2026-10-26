# MONTRA — Runbook

Commands marked "not run" were never executed (they touch a remote Cloudflare resource, which nothing in FN-00 does).
Everything else was run during FN-00 (see `docs/HISTORY.md`).

## Local setup

1. Node >= 22 (`.npmrc` has `engine-strict=true`; local Node is 24, so `node script.ts` runs TypeScript directly).
2. `npm ci` (the `prepare` script runs `svelte-kit sync`).
3. `cp .dev.vars.example .dev.vars` (names only; `DEV_ROUTES=1` enables `/dev/ui` and `/api/v1/dev/*`, local only).
4. `npm run db:reset:local` (wipes `.wrangler/state`, then applies all migrations).
5. `npm run dev` serves the UI on `http://localhost:5173` (app host) and `http://site.localhost:5173` (public site
   host). Under `vite dev`, adapter-cloudflare 8 resolves `cloudflare:workers` to a platform-proxy stub, so D1/KV/R2
   bindings work locally and share `.wrangler/state` once `npm run db:reset:local` has run. `npm run dev:workers`
   (built app + jobs + inbound) is needed only for the queue/cron round trip.

Conventions worth knowing:

- SvelteKit 3: config lives in `sveltekit({...})` inside `vite.config.ts`; there is no `svelte.config.js`.
- Shared code is imported as `#lib/*`. The alias exists twice: `package.json` `imports` and `tsconfig.json` `paths`.
  Keep both in sync.
- Cloudflare bindings come from `getEnv()` in `src/lib/server/env.ts` (wraps `cloudflare:workers`). The adapter never
  populates `event.platform`; `test/no-platform.test.ts` fails if server code reads it.

## Three Workers locally

```
npm run build && npm run dev:workers
```

Starts the app Worker (port 8787), `workers/jobs` and `workers/inbound` in one `wrangler dev` session sharing
`.wrangler/state`. Cron (not run): add `--test-scheduled` and call `/cdn-cgi/handler/scheduled` on the dev server. Local bindings only (`remoteBindings: false`); never pass `--remote`.

## Migrations

- Generate: `npm run db:generate -- --name <name>` (writes SQL to `migrations/`).
- Apply locally: `npm run db:migrate:local`.
- Never edit a migration that has been applied anywhere; add a new one.
- Remote apply is a separate, manual step and only on the owner's instruction (not run): first record a D1 Time
  Travel bookmark with `wrangler d1 time-travel info montra`, then `wrangler d1 migrations apply montra --remote`.

## Seed and reset

`npm run db:seed:local` and `npm run db:reset:local` touch the local database only. `scripts/local-guard.ts` refuses
`--remote`, `--preview`, `--env` and `-e` (also in `=value` form) before wrangler is started.

## Tests

- `npm run gates` = `check` (svelte-check + both worker tsconfigs) && `lint` (prettier + eslint) && `test`
  (Vitest) && `build`.
- `npm run test:e2e` builds, migrates `.wrangler/e2e-state-<port>`, starts all three Workers on port 8787 (or `E2E_PORT`) and runs the
  Playwright journeys (phone 360 px and desktop projects). For parallel runs by several agents give each its own
  port: `E2E_PORT=8811 npm run test:e2e` (own server, own persist dir, specs read the origin via `APP_ORIGIN` /
  `SITE_ORIGIN` in `e2e/helpers.ts`; `scripts/e2e-build.sh` serialises the build and skips it when current).
- Playwright needs Chromium system libraries (libnspr4, libnss3, libnssutil3, libasound2). On a fresh machine run
  `sudo npx playwright install-deps chromium` once (owner prerequisite). On this machine the libraries are unpacked
  under `<scratchpad>`; run `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=<port> npm run test:e2e`.
- Temp directories: miniflare (integration tests' `getPlatformProxy`, e2e `wrangler dev`) leaves `miniflare-*`
  directories in the temp directory (`/tmp`); on 2026-10-08 they filled `/tmp` and caused flaky workerd /
  `SQLITE_FULL` failures. `npm test` runs `posttest` (`scripts/clean-miniflare-tmp.ts`), which removes this
  user's `miniflare-*` directories older than 1 h (never another user's, never a younger one, so a run in
  progress keeps its own). After running `npx vitest` or Playwright directly, run `npm run clean:tmp`.
- Run status of the helper scripts: `db:reset:local` ran 2026-10-08 (exit 0, migrations applied); `types:cf` and
  `dev:workers` were not run by hand (the e2e web server starts the same three-Worker `wrangler dev` session).
- CSP: strict, with `style-src-attr 'unsafe-hashes' 'sha256-...'` for SvelteKit's announcer. The hash can change on a
  Kit upgrade; the e2e CSP-violation check fails and shows the new hash.

## On-device OCR assets (FN-16g)

- `npm run ocr:assets` runs automatically before `npm run build` and `npm run dev`. It fills the git-ignored
  `static/_ocr/<version>/` folder:
  - It copies the pinned tesseract.js 7.0.0, tesseract.js-core 7.0.0 and pdfjs-dist 6.4.299 files from `node_modules`.
  - It downloads tessdata_fast `ind`/`eng` at commit `87416418657359cb625c412a48b6e1d6d41c29bd` from
    raw.githubusercontent.com and caches them in `.ocr-cache/`.
  - It checks every file against its pinned size and SHA-256, including when the "already built" shortcut applies.
    Any mismatch fails the build.
- A clean build with GitHub unreachable fails with "download failed". Keep `.ocr-cache/` between CI builds, with the
  cache key `TESSDATA_FAST_COMMIT`.
- In CI and deploy, install with `npm ci --ignore-scripts`. The install script of `tesseract.js` is not needed (red team L2).
- CSP: the root `_headers` rule `/_ocr/*` gives these static files their own policy:
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; base-uri 'none'`,
  with an immutable cache. App pages get only `worker-src 'self'`; they never get `'wasm-unsafe-eval'` or `blob:`.
  Never put HTML or SVG under `static/_ocr/`.
- Bumping a version:
  1. Re-run `npm view <pkg> version license dist.unpackedSize`.
  2. Update the pins in `package.json`.
  3. In `src/lib/shared/ocr/assets.ts`, update every size and SHA-256, and `OCR_ASSET_VERSION`. The version needs a
     new folder name because the old one is cached as immutable.
  4. Run `npm run ocr:assets -- --force`.
  5. Run `npm run compat:ocr` on the owner's samples and `e2e/impor-ocr.spec.ts`.
- If the OCR block says "Mesin baca belum terpasang di server ini.", the build ran without `ocr:assets`.

## Secrets

Names only; values live in `.dev.vars` locally and `wrangler secret put` remotely (not run).

- `DEV_ROUTES` — local and e2e only; never set in staging or production.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — Web Push (FN-13). All three or none; unset or
  malformed → `/pengaturan/notifikasi` shows "Belum dikonfigurasi" and never asks for notification permission.

- `CONNECTED_APPS_ENCRYPTION_KEY` (and `CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS` during a rotation) — FN-29
  connected-app tokens at rest. Unset or not exactly 32 bytes → `/pengaturan/aplikasi` shows every app as
  "Belum dikonfigurasi" and stores nothing. See "Connected apps" below.
- `BILLING_MOCK_ENABLED`, `MOCK_PAYMENT_WEBHOOK_SECRET` — FN-30 mock payments ("mode uji"), local, e2e and
  owner-flagged demo/staging only; **never in production**. The upgrade button, the `?/checkout` action and
  `/pengaturan/paket/uji/*` exist only when the flag is exactly `1` and the secret has ≥ 32 characters
  (`openssl rand -hex 32`); otherwise they are absent (404) and `/api/v1/billing/webhook` answers 401 to every
  delivery. No real charge is possible: no real provider is implemented. Local voucher codes from
  `npm run db:seed:local`: `COBA-KREDIT-100` (100 credits) and `COBA-PRO-7-HARI` (Pro for 7 days).
- `AI_KEYS_ENCRYPTION_KEY` (and `AI_KEYS_ENCRYPTION_KEY_PREVIOUS` during a rotation) — FN-41 users' own Anthropic
  keys at rest. Unset or not exactly 32 bytes → `/pengaturan/integrasi` shows "Belum dikonfigurasi" and stores
  nothing. See "AI keys" below.
- `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` — FN-41 the app's Cloudflare AI Gateway that "Tes koneksi" calls
  through (no Anthropic key of the owner's: each request carries the user's own key). Either unset → "Tes koneksi"
  shows "Belum dikonfigurasi"; saving a key still works.
- `ADMIN_ACCOUNT_IDS` — FN-41 (gate by account id since the FN-30 hardening) comma-separated `users.id` list
  (case and spaces ignored, non-UUID entries dropped, first 20 read) admitted to `/pengaturan/integrasi/admin`, the
  read-only status of the secrets above (names and booleans, never a value) and the pending refund list. Unset →
  the page answers 404 to everyone. It replaces `ADMIN_EMAILS`, which is no longer read (sign-up does not verify an
  address). Find an id with a read-only query, e.g. staging:
  `npx wrangler d1 execute montra-staging --env staging --remote --command "SELECT id FROM users WHERE email = '<address>'"`,
  then `npx wrangler secret put ADMIN_ACCOUNT_IDS --env staging`; if `ADMIN_EMAILS` was ever set there,
  `npx wrangler secret delete ADMIN_EMAILS --env staging`.
- `CLAIM_HASH_KEY` (and `CLAIM_HASH_KEY_PREVIOUS` during a rotation) — FN-30 re-claim markers: the HMAC key of the
  fingerprint kept of a deleted account's canonical address, so the 300 starter credits and per-person vouchers
  cannot be claimed again by deleting and signing up anew (`src/lib/server/billing/claims.ts`). 32 random bytes,
  base64url: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. Unset or malformed → no markers are written or
  checked (credits granted as before) and the admin page shows "Belum dikonfigurasi". **Set it on staging and
  production before a real payment provider goes live.** Rotation: the new key in `CLAIM_HASH_KEY`, the old one in
  `CLAIM_HASH_KEY_PREVIOUS`; markers are kept 730 days (swept by the jobs Worker, which needs no key), so keep
  `_PREVIOUS` for 730 days or accept that earlier markers stop matching. The app Worker only; never commit it.

- `TURNSTILE_SITE_KEY` (a var: public, rendered into the page) and `TURNSTILE_SECRET_KEY` (a secret) — FN-50
  Cloudflare Turnstile on `/masuk` and `/daftar`. The check is on only when **both** are set; one alone behaves as
  unset, logs `turnstile: partial configuration` once per sign-in/sign-up call and the admin page shows
  "Belum lengkap … Baru sebagian diisi". Both unset → no widget, no check, admin row "Belum dikonfigurasi". Create
  the widget in the Cloudflare dashboard (Turnstile › Add widget, hostname `<staging-app-host>`, Managed mode), then
  `npx wrangler secret put TURNSTILE_SECRET_KEY --env staging` (with the generated config, see Staging) and set
  `STAGING_TURNSTILE_SITE_KEY` (in `.staging.env`, and as the `staging` environment variable on GitHub):
  `deploy:staging` writes it into the staging `vars`, which commit only an empty `TURNSTILE_SITE_KEY`. Locally, Cloudflare's documented test keys in `.dev.vars` are enough (re-check them on
  Cloudflare's "Turnstile › Testing" page before use, not verified here: always passes, site
  `1x00000000000000000000AA` with secret `1x0000000000000000000000000000000AA`; always blocks, site
  `2x00000000000000000000AB`; secret answering "token already spent", `3x0000000000000000000000000000000AA`).
  The widget script loads from Cloudflare, so even the test keys need network access. While on, sign-in
  and sign-up need JavaScript (a `<noscript>` line says so); the CSP of those two pages only admits
  `https://challenges.cloudflare.com`.
- Passkeys (FN-50) need no secret. See "Passkeys" below.

Later FNs add theirs here (session pepper, Gmail, the real payment provider's keys).

### Passkeys (FN-50)

- The relying-party id (`rpId`) is the request host: `<staging-app-host>` on staging and production today (both answer
  there), `localhost` in local dev. Any other host — an IP address, a `*.workers.dev` preview, a `*.localhost` name —
  refuses every passkey action with "Passkey tidak tersedia di alamat ini." so no credential is bound to a throwaway
  address. WebAuthn itself needs HTTPS or `localhost`.
- A passkey is bound to its host for good. **Moving the app to another host means every user registers their
  passkeys again** (their passwords keep working); the stored `rp_id` shows which host each passkey belongs to.
- Attestation `none`, ES256 and RS256 only, verified by `src/lib/server/auth/webauthn-verify.ts` on WebCrypto (no
  library: `@simplewebauthn/server` 14.0.3 worked on workerd but bundled to 324 KiB minified). Up to 10 live passkeys
  per account; challenges live 5 minutes and are swept an hour after expiry; `auth_events` (no IP, user agent or key
  material) are swept after 90 days by the jobs Worker's cron.
- A passkey sign-in holds no account key: features that need it ask for the password once per page session
  (Pengaturan › Akun › "Buka kunci dengan kata sandi"). Password change, account deletion, API tokens and key
  material still demand the password. Removing a passkey signs out every session it created except the current
  one; a password change keeps passkeys and signs out every other session as before.

### Web Push (VAPID) keys

- **Local:** `npx web-push generate-vapid-keys` (the `web-push` npm package's generator; a one-off CLI run, not a
  project dependency, nothing of it is imported by the Worker). Copy the printed public and private key into
  `.dev.vars` as `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` and add `VAPID_SUBJECT=mailto:dev@montra.local`.
  With `DEV_ROUTES=1`, `/pengaturan/notifikasi` shows "Kirim notifikasi uji", which sends one notification to the
  signed-in user's own subscribed devices (needs a real browser with network access to its push service).
- **Staging/production (owner item, not done):** generate a separate pair the same way on a trusted machine and
  set all three with `wrangler secret put <NAME> --env staging` (and the production equivalent). Never reuse the
  local pair; never commit either. Rotating the pair invalidates every stored subscription: browsers re-subscribe
  when the person turns notifications on again.
- **Jobs Worker (FN-24):** reminders are pushed by `workers/jobs`, so the same three secrets must also be set on
  `montra-jobs` (`wrangler secret put <NAME> -c workers/jobs/wrangler.jsonc --env staging`). Without them the
  jobs Worker still creates in-app notifications and sends no push. Locally, a `workers/jobs/.dev.vars` with the
  same values does the same. Manual cron tick: put the jobs config first,
  `npx wrangler dev -c workers/jobs/wrangler.jsonc -c wrangler.jsonc -c workers/inbound/wrangler.jsonc --test-scheduled`,
  then `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+23,0-16+*+*+*&time=<epoch ms>"` (`time` in
  milliseconds; `/cdn-cgi/handler/scheduled` takes it too). The `/__scheduled` alias ignores `time` and always
  uses the wall clock, so it cannot pick the WIB hour. A tick in 00:00–05:59 WIB does nothing by design. Each
  tick also runs the retention sweep (90 days; removed members' rows emptied) and stores its walk positions in
  `app_meta` (`cron:budget_check`, `cron:daily_nudge`, `cron:weekly_summary`); delete those keys to restart a
  pass locally.
- **Sending** is RFC 8291 encryption + RFC 8292 VAPID on WebCrypto (`src/lib/server/push/`), verified against the
  RFC 8291 Appendix A vector; only known push-service hosts (FCM, Mozilla, WNS, Apple) are ever contacted.

### Connected apps (FN-29) encryption key

- **What it is:** a server-held AES-256-GCM key that seals connected-app OAuth tokens in `connected_apps`
  (`src/lib/server/connected-apps/crypto.ts`). A different trust model from FN-21's account key on purpose:
  unattended jobs must use these tokens without anyone's password, so the server can open them. A leaked key
  exposes every stored token at once; treat it like any other production credential.
- **Local:** `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` and put the result in `.dev.vars` as
  `CONNECTED_APPS_ENCRYPTION_KEY`. With `DEV_ROUTES=1`, `/pengaturan/aplikasi` then offers "Tambah sambungan
  contoh" (a fictional, `Data demo` connection with a synthetic token) and "Putuskan". No provider app (Google,
  Notion, Slack) is registered, so "Hubungkan" stays "Belum dikonfigurasi" whatever the key.
- **Staging/production (owner item, not done):** only once a real provider connection ships. Generate on a trusted
  machine, `wrangler secret put CONNECTED_APPS_ENCRYPTION_KEY --env staging`. Since FN-19 Gmail a background job
  does decrypt a token (the hourly Gmail check refreshes access tokens), so the jobs Worker needs the same secret:
  `wrangler secret put CONNECTED_APPS_ENCRYPTION_KEY -c workers/jobs/wrangler.jsonc --env staging` (and
  `_PREVIOUS` on both Workers during a rotation). Never commit it.
- **Rotation:** set the new key as `CONNECTED_APPS_ENCRYPTION_KEY` and the old one as
  `CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS`. Each row stores `token_key_id` (a hash prefix of the key that sealed
  it), so old rows still open while new seals use the new key. Gmail refresh tokens are re-sealed with the new key
  by the jobs Worker: on each refresh, and by an hourly sweep (`resealGmailTokens`, up to 100 rows per tick, no
  Google call) that also covers paused, needs-reconnect and checks-off connections. Remove `_PREVIOUS` (on both
  Workers) only when `select count(*) from gmail_connections where token_key_id <> '<new key id>'` is 0 (the new key
  id is the `token_key_id` of any connection made or refreshed after the rotation), and at least 7 days after the
  rotation, so queued revocations (`gmail_revocations`, sealed under the old key, dropped after 7 days) still open.
  Other connected-app rows (FN-29) have no re-seal job (nothing real is stored); remove the previous key only after
  every such row was re-sealed or disconnected — a row whose key is gone no longer opens and must be reconnected.

### AI keys (FN-41) encryption key, AI Gateway and admin list

- **What it is:** a server-held AES-256-GCM key, separate from `CONNECTED_APPS_ENCRYPTION_KEY` (owner decision:
  one leak never opens both), that seals each user's own Anthropic key in `ai_keys`
  (`src/lib/server/ai-keys/crypto.ts`, on `src/lib/server/server-seal.ts`). Server-openable on purpose: a later
  unattended AI job uses the key without the user present. A leaked key exposes every stored AI key at once.
- **Local:** `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` into `.dev.vars` as `AI_KEYS_ENCRYPTION_KEY`.
  For "Tes koneksi" add `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID` of a gateway (or leave them unset to see the
  "Belum dikonfigurasi" path). For the admin page add `ADMIN_ACCOUNT_IDS=<your local account's id>`.
- **Staging/production (owner item, not done):** `wrangler secret put AI_KEYS_ENCRYPTION_KEY --env staging`
  (generated as above on a trusted machine); create a gateway in the Cloudflare dashboard (AI Gateway → Create
  Gateway; no payment and no Anthropic account needed) and `wrangler secret put AI_GATEWAY_ACCOUNT_ID` /
  `AI_GATEWAY_ID --env staging`; `wrangler secret put ADMIN_ACCOUNT_IDS --env staging`. Since FN-19 the jobs Worker
  runs an unattended AI job (the read of a forwarded mail, `inbound_read`), so it needs the same
  `AI_KEYS_ENCRYPTION_KEY` (and `_PREVIOUS` during a rotation), `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`:
  `wrangler secret put … -c workers/jobs/wrangler.jsonc --env staging`. Without them a queued mail ends
  `unreadable` with its reason and its text deleted. Never commit any of them.
- **Rotation:** as for connected apps: the new key in `AI_KEYS_ENCRYPTION_KEY`, the old one in
  `AI_KEYS_ENCRYPTION_KEY_PREVIOUS`; rows store `key_key_id`, so old rows still open. There is no re-seal job;
  remove the previous key only after every row was re-sealed or replaced by its user — a row whose key is gone no
  longer opens ("Kunci tersimpan tidak bisa dibuka lagi"), and its user must enter the key again.
- **Real-provider check (manual, owner-run, never part of `npm run gates`):** save your own `sk-ant-…` key on
  `/pengaturan/integrasi` and press "Tes koneksi" once; record the outcome separately.

### E-mail forwarding (FN-19)

- **What it is:** each user can create one secret address `m-<26 characters>@<INBOUND_EMAIL_DOMAIN>` on
  `/pengaturan/aplikasi/email`. Mail to it goes through Cloudflare Email Routing to the `montra-inbound` Worker
  (`workers/inbound`), which turns payment notifications into **drafts** in Kotak masuk (never saved
  transactions). Unparsed payment mail is read with the user's own Anthropic key by the jobs Worker
  (`inbound_read` on `montra-jobs`; only the row id travels, the text stays in D1 for at most 24 h).
- **Vars (per environment, plain vars or secrets):**
  - `INBOUND_EMAIL_DOMAIN` on the **app** Worker (`wrangler.jsonc`) and the **inbound** Worker
    (`workers/inbound/wrangler.jsonc`): the forwarding domain, e.g. `in.example.id`. Unset or malformed → the
    settings page shows "Belum dikonfigurasi", Tambah › Otomatis is disabled with the reason, and the inbound
    Worker refuses every mail ("Unknown recipient").
  - `INBOUND_AUTHSERV_ID` on the **inbound** Worker: the authserv-id of the `Authentication-Results` header that
    Cloudflare Email Routing adds. **Not verified from Cloudflare's docs** (they say SPF/DKIM/DMARC are checked but
    not the header's exact shape): read it from a real mail before setting it (below). Unset → every mail is
    `unverified` (still a draft, flagged "Perlu ditinjau"). Only the topmost header is read.
  - `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` on the **inbound** Worker too (it decides whether a mail can be
    queued for the AI read at all; unset → `unreadable/ai_unconfigured`, text not kept), and on the jobs Worker
    (see AI keys above).
- **Local:** `INBOUND_EMAIL_DOMAIN=in.montra.local` in `.dev.vars` shows the address flow on
  `/pengaturan/aplikasi/email`. `npm run dev:workers` runs all three Workers; wrangler's local email handler can
  be driven with `curl -X POST 'http://localhost:8787/cdn-cgi/handler/email?from=a@b.example&to=<address>'
  --data-binary @<file>.eml` (re-check the current wrangler docs for this endpoint). Tests never need it.
- **Domain setup (owner item, not done by any agent; staging and production separately):**
  1. Choose the forwarding domain (a subdomain such as `in.<app domain>` keeps it apart from people's mail) and
     add it to Cloudflare (DNS on Cloudflare).
  2. Dashboard → the zone → Email → Email Routing → Enable; accept the MX and SPF records it adds.
  3. Deploy the inbound Worker (`montra-inbound-staging` for staging) with its queue producer, then Email Routing →
     Routing rules → Catch-all address → Action "Send to a Worker" → the inbound Worker. Do not route `m-*` to a
     mailbox.
  4. Set `INBOUND_EMAIL_DOMAIN` on the app and inbound Workers (`--env staging`), deploy.
  5. Find the authserv-id **on the Worker route** (the only route production uses; a "Send to an email" rule may
     add headers differently). Leave `INBOUND_AUTHSERV_ID` unset until this is done (fail closed: every mail is
     then `unverified`). Deploy a temporary debug Worker (not part of the repo) and point a temporary
     custom-address rule (e.g. `header-check@<domain>`, action "Send to a Worker") at it. Its whole handler:
     `async email(m) { const raw = await new Response(m.raw).text(); const head = raw.split(/\r?\n\r?\n/)[0];
     console.log([...head.matchAll(/^Authentication-Results:\s*([^;\s]+)/gim)].map((x) => x[1])); }` — it logs
     only the authserv-ids, in header order, never values or addresses. Watch it with
     `npx wrangler tail <debug worker>` and send it:
     - one ordinary mail from a mailbox with DKIM (e.g. Gmail): the **first** id logged is the one Cloudflare adds
       (believed to be `mx.cloudflare.net`; unverified);
     - one mail whose raw source starts with a forged `Authentication-Results: <that id>; dkim=pass
       header.d=<sender domain>; dmarc=pass` line (sent with an SMTP client such as `swaks --header`): Cloudflare's
       own header must still be logged **first**, above the forged one.
     Only if both hold, set that id as `INBOUND_AUTHSERV_ID` on the inbound Worker and redeploy. If Cloudflare's
     header is not first, or absent, leave it unset (all mail stays a flagged draft) and record why. Delete the
     debug Worker and the temporary rule afterwards.
  6. Record the real-mail test separately (mocked mail never counts): one forwarded bank mail ends as a draft, and
     one spoofed mail with a forged top `Authentication-Results` header is listed on the settings page as
     "Pengirim belum terverifikasi" (its draft flagged "Perlu ditinjau").
- **Rotate / revoke:** each user rotates ("Putar ulang alamat": the old address is refused at once) or turns it off
  ("Matikan") on the settings page. Revoked local parts are never issued again. There is no admin override; to
  stop all forwarding, unset `INBOUND_EMAIL_DOMAIN` on the inbound Worker (every mail is refused) or disable the
  Email Routing rule.
- **Logs:** `npx wrangler tail montra-inbound-staging` / `montra-jobs-staging`. Log lines carry an outcome code and
  counts only. **Never log an address, a sender, a subject, an amount or mail text**, and never paste one into
  an issue: the address is a bearer secret.
- **Retention:** the jobs Worker's hourly tick deletes pending mail text after 24 h, clears Gmail confirmation codes
  after 24 h and deletes ledger rows after 90 days (bounded batches).

### Gmail (FN-19)

Nothing in this section was performed by an agent: no Google Cloud project, consent screen, client, test user or
secret exists until the owner creates it. Google's console moved to "Google Auth Platform" and its labels change:
**check every console label below against Google's current help page** before following it.

- **What it is:** a signed-in user presses Hubungkan on `/pengaturan/aplikasi/gmail`, grants Montra's own OAuth app
  the read-only scope `https://www.googleapis.com/auth/gmail.readonly` (Restricted), and the jobs Worker checks the
  mailbox hourly 06:00–23:00 WIB (the existing cron) plus on demand ("Periksa sekarang", "Lihat ke belakang").
  Payment mail becomes **drafts** in Kotak masuk through the forwarding pipeline (same parsers, dedupe keys,
  masking, AI read with the user's own Anthropic key). No mail text is stored; the refresh token is sealed with
  `CONNECTED_APPS_ENCRYPTION_KEY` (Gmail's own labels); access tokens live in memory only.
- **Names (app = `wrangler.jsonc`, jobs = `workers/jobs/wrangler.jsonc`):**
  - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`: secrets on **app and jobs**.
  - `GOOGLE_OAUTH_REDIRECT_ORIGIN`: plain var on **app**; one exact origin, no path or trailing slash
    (`http://localhost:8787` locally, `https://<staging-app-host>` on staging, filled into `env.staging.vars` from `STAGING_APP_HOST` by
    `deploy:staging`). The
    redirect URI is that origin + `/pengaturan/aplikasi/gmail/callback`, never taken from the request.
  - `CONNECTED_APPS_ENCRYPTION_KEY` (+ `_PREVIOUS` during a rotation): secret on **app and jobs** (see Connected
    apps above for generation and rotation: Gmail tokens are re-sealed by the jobs Worker, so remove `_PREVIOUS`
    only when no `gmail_connections` row has the old `token_key_id`, else it becomes "Perlu dihubungkan ulang").
  - Every Gmail capture is `unverified` (a draft flagged "Perlu ditinjau"), whatever its headers say (owner decision
    2026-10-13, red team L5); there is no `GMAIL_AUTHSERV_ID` any more. Remove it if an environment still has it.
  - `GOOGLE_OAUTH_TESTING`: optional plain var on **app**; set `0` only after Google publishes the app to
    production (hides the 7-day notice).
  - `AI_KEYS_ENCRYPTION_KEY`, `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` on **jobs** (already needed by forwarding):
    without them deterministic parsers still work and other payment mail ends `unreadable` with its reason.
  - Missing client id/secret, redirect origin or sealing key → the page says "Belum dikonfigurasi" and names what is
    missing in words; the jobs Worker enqueues no Gmail check without the client and key.
- **Google Cloud setup (You; staging first):**
  1. Sign in to https://console.cloud.google.com with the owner's Google account and **create a project** (e.g.
     "Montra").
  2. APIs & Services › Library › **Gmail API** › Enable.
  3. **OAuth consent screen** (Google Auth Platform › Branding / Audience / Data access): user type **External**;
     app name, user support email, developer contact email; the app domain links (home page, privacy policy
     `/privasi`, terms `/ketentuan`) may be added now. **Publishing status: Testing.**
  4. **Audience › Test users:** add each Gmail address that will test, **at most 100**. Anyone else is refused by
     Google. In Testing, "test user authorizations expire seven days after consent, and any refresh token issued
     with them expires too": every test connection must be reconnected weekly (the page says so; the jobs Worker
     marks it "Perlu dihubungkan ulang" on `invalid_grant`).
  5. **Data access › Add scope:** `https://www.googleapis.com/auth/gmail.readonly` (shown as Restricted). Nothing
     else (no `openid`, `email`, `profile`: there is no Google sign-in).
  6. **Clients › Create client › Web application.** Authorized redirect URIs, exact (scheme, case, no trailing
     slash): `http://localhost:8787/pengaturan/aplikasi/gmail/callback` (`npm run dev:workers`),
     `http://localhost:5173/pengaturan/aplikasi/gmail/callback` (`vite dev`, only if used; then set the local
     origin to `http://localhost:5173`), `https://<staging-app-host>/pengaturan/aplikasi/gmail/callback` (staging). No
     JavaScript origins. Copy the client ID and secret once.
  7. **Secrets.** Staging app Worker: `npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID --env staging` and
     `npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env staging`. Staging jobs Worker: the same two with
     `-c workers/jobs/wrangler.jsonc --env staging`, plus `CONNECTED_APPS_ENCRYPTION_KEY` (the app Worker's value)
     if not yet there. `GOOGLE_OAUTH_REDIRECT_ORIGIN` is
     already a plain var in `wrangler.jsonc` `env.staging.vars`. Local: `.dev.vars` gets
     `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_ORIGIN=http://localhost:8787`
     and the existing `CONNECTED_APPS_ENCRYPTION_KEY` / `AI_*`; for the jobs Worker in `npm run dev:workers` put
     the client id, secret, `CONNECTED_APPS_ENCRYPTION_KEY` (and `AI_*`) in `workers/jobs/.dev.vars`, as for the
     VAPID and AI keys above (each config reads the `.dev.vars` beside it; re-check against the current wrangler
     docs). `.dev.vars.example` lists names only. Never commit a value.
  8. **Verify (record separately, never from fakes):** connect with a listed test user; expect Google's "unverified
     app" warning; a real bank/QRIS mail of the last 7 days appears as a draft within one hourly check (or
     "Periksa sekarang"); a Promotions-tab mail does not; "Putuskan Gmail" removes the data and the app disappears
     from myaccount.google.com/permissions. Also confirm there: PKCE accepted at the token endpoint together with
     the client secret, `users.getProfile` under `gmail.readonly`, the real authserv-id, and "Hubungkan ulang"
     after 7 days.
  9. **Before public launch (You):** submit OAuth verification for the restricted scope, complete the CASA security
     assessment (annual; tier and cost to be confirmed with Google and the assessor), publish the privacy policy
     with the Google API Services User Data Policy (Limited Use) disclosure, then switch Publishing status to In
     production and set `GOOGLE_OAUTH_TESTING=0`. Until then the 100-test-user cap and the 7-day expiry apply.
- **Migration:** `0033_gmail_connection.sql` adds four tables (no change to existing ones). Before a remote apply
  take a D1 Time Travel bookmark (Migrations above); apply locally with `npm run db:migrate:local`.
  `0035_gmail_lows.sql` (red team L2–L4) adds `gmail_revocations` and the nullable column `inbound_mail.draft_id`.
  Its ALTER cannot be repeated, so apply it once through `wrangler d1 migrations apply`.
- **Revocation queue:** a space purge, an account deletion or a second authorization for another Google account
  queues the replaced sealed token in `gmail_revocations`. Each jobs tick revokes up to 20 of them at Google. A
  failed call is retried for up to 48 ticks, then dropped. Any row older than 7 days is dropped, even without the key. A grant the user's current connection may share (same
  address, or an address unknown) is dropped without a call. The tick log line has `gmailRevocations` counts.
- **Local cron:** as for Web Push above (`--test-scheduled`, a `time` between 23:00 and 16:59 UTC); the walk position
  is `app_meta` key `cron:gmail_check` (one round per WIB hour).
- **Logs:** `npx wrangler tail montra-jobs-staging`. Lines carry counts and status codes only. **Never log or paste
  a token, the client secret, an authorization code, a state, a Gmail id, an address, a subject or mail text.**
- **Retention:** the hourly tick re-sends listed reads after 15 min, expires them after 48 h, fails scans running
  over 6 h, deletes ledger rows after 90 days and expired authorizations (10 minutes).

### Service worker and sign-out

- `src/service-worker/` caches only the build's files and `static/` (offline page included); pages, `__data.json`
  and `/api/*` are never stored. A deploy changes the cache name, and the old cache is deleted on activation.
- Sign-out and account deletion answer with `Clear-Site-Data: "cache", "storage"`: the browser drops the cache,
  the service worker and its push subscription; the server tombstones the session's push subscriptions.
- Manifest icons in `static/icons/` are rendered from Koko's pixels by `scripts/generate-mascot-icons.ts`; when the
  brand mark is decided, change the mark there and rerun it.
- The worker never precaches `/splash/` or `/screenshots/` (`shellPaths` in `src/lib/shared/sw-policy.ts`): iOS and
  Chrome fetch those from the network.

### PWA images (FN-13b)

Three scripts make every committed image. Run each by hand (never in `gates`, `build` or CI), then commit the output.
Each needs Playwright's Chromium (the existing devDependency).

| Script                                  | Writes                                                                                                    | Rerun when                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `scripts/generate-mascot-icons.ts`      | `static/favicon.svg`, `static/icons/*` (any, maskable 192 and 512, monochrome, apple-touch, 4 shortcuts) | Koko or the brand mark changes                               |
| `scripts/generate-splash-screens.ts`    | `static/splash/*` (18 portrait sizes, light and dark) and `src/lib/shared/splash-screens.ts`              | Koko changes, or Apple ships a screen size (add a row)       |
| `scripts/capture-store-screenshots.ts`  | `static/screenshots/*` (2 narrow, 1 wide, with a "Data demo" ribbon)                                      | The Riwayat screen or the Tambah sheet changes visibly       |

- Budgets, checked by `test/manifest.test.ts`: `static/splash/` at most 1.5 MB, `static/screenshots/` at most 1 MB.
  The splash and icon scripts give the same bytes on the same Chromium; the screenshots follow the demo rows' dates.
- Splash sizes come from Apple's HIG "Layout" page, which renders client-side; every row was cross-checked against
  iosref.com/res on 2026-10-10. Recheck against the HIG when adding a device.
- Screenshots: run a local app on its own persist directory, then `FIN_PERSIST_TO=<dir> node
  scripts/capture-store-screenshots.ts http://localhost:<port>`. The script refuses any address that is not this
  machine, signs up `demo-screens@montra.local`, adds a wallet and runs the local demo seed.

### Replacing the app icon (FN-54 A6)

The home-screen, favicon and splash images are Koko today; a new logo (owner request 2026-10-11) waits for the owner's
image file and the decision whether it replaces Koko as the icon (`docs/TASKS.md`). Nothing is drawn as a placeholder.
When the file arrives, the swap is one path:

1. Put the source mark into `scripts/generate-mascot-icons.ts` (today it draws Koko's idle frame from
   `src/lib/ui/kit/mascot/poses.ts` in the light theme's colours, and the Pro crown for `PRO_ICONS`). A raster or SVG
   mark replaces the pose drawing there; keep the artwork inside the centre 80 % circle for the maskable icons.
2. Run `node scripts/generate-mascot-icons.ts`: it rewrites `static/favicon.svg` and `static/icons/*` (any, maskable 192
   and 512, monochrome, apple-touch, the four shortcut icons and the three Pro variants).
3. Run `node scripts/generate-splash-screens.ts` for `static/splash/*` (iOS launch images).
4. `npm test`: `test/icons.test.ts` checks every maskable icon keeps the artwork inside the safe zone, the monochrome
   icon is alpha-only, the Pro twins exist and the favicon is inline; `test/manifest.test.ts` checks the manifest still
   lists every icon at its size.
5. An installed app never updates its icon live (FN-46): only then does the release note say "reinstall to see the new
   icon".

## Release notes

Users read release notes in the app (Pengaturan › Tentang › "Apa yang baru", the full list on
`/pengaturan/tentang/catatan-rilis`, and the one-time "Baru di Montra" notice after an update; FN-42, FN-42b).

- Every user-visible release adds `src/lib/content/release-notes/<version>.id.md` and `<version>.en.md` in the same
  commit that bumps `package.json` (and `APP_VERSION`) and writes the `CHANGELOG.md` section.
- Front matter: `version` (must match the file name) and `date` (`YYYY-MM-DD`, the UTC day of the `CHANGELOG.md`
  heading).
- Body: plain-language bullets for users. No "Behind the scenes" line, no file names or migrations, no open security
  findings.
- `npm test` fails when the newest `## vX.Y.Z` heading in `CHANGELOG.md` has no note pair or a pair with another date
  (`src/lib/server/content/release-notes.test.ts`). A note in one language only fails the build.
- Known gap (owner decision D7): `/ship` writes `CHANGELOG.md` and does not know about the notes. Whoever prepares the
  release commit (engineer or orchestrator) adds the pair in that same commit; the test is the backstop.

## Staging

The repository is public: no real account id, resource id, staging hostname or workers.dev subdomain is committed.
The owner's Cloudflare account (`CLOUDFLARE_ACCOUNT_ID`, a 32-hex id) holds the staging resources. App:
`https://<staging-app-host>` (custom domain since 2026-10-09; fallback
`https://montra-app-staging.<your-subdomain>.workers.dev`). Renamed from `financer-*` on 2026-10-09: the `montra-*`
resources below are new (fresh D1, empty KV and R2); the old `financer-*` staging resources stay on the account until
the owner deletes them, and Worker secrets must be set again on the new Workers.
Each `wrangler.jsonc` has an `env.staging` block that repeats every binding (bindings are not inherited); the
top-level block keeps placeholders for local dev and tests, and `env.staging` keeps placeholders too:
`account_id` all zeros, D1 `00000000-0000-4000-8000-000000000000`, KV all zeros, host `staging.example.invalid`.

**Real values.** `npm run deploy:staging` reads them from the environment or, for any unset there, from the
gitignored `.staging.env` (copy `.staging.env.example`): `CLOUDFLARE_ACCOUNT_ID`, `STAGING_D1_DATABASE_ID`,
`STAGING_KV_CACHE_ID`, `STAGING_APP_HOST` (hostname only), and optionally `STAGING_TURNSTILE_SITE_KEY` (FN-50;
unset keeps the committed empty `TURNSTILE_SITE_KEY`, so Turnstile stays off). It writes them into temporary, gitignored
`wrangler.staging.generated.jsonc` files next to each config, runs every wrangler call with `-c` on those and removes
them at the end; a missing or malformed value, or a placeholder left in any `env.staging` block, stops it before any
wrangler call. **Hand-run staging commands** in this file (`--env staging`: `secret put`, `d1 execute`, Time Travel
restore, `rollback`) need the real ids too: run `npm run deploy:staging -- --write-config` (writes the three
generated configs and keeps them, no wrangler call), add `-c wrangler.staging.generated.jsonc` (or
`-c workers/jobs/wrangler.staging.generated.jsonc` / `-c workers/inbound/wrangler.staging.generated.jsonc` where the
command names that Worker's config), and delete the generated files afterwards. The generated files are also
removed when the deploy is interrupted (SIGINT/SIGTERM, exit 130/143) and, if an earlier run was killed outright,
at the start of the next deploy.

| Resource  | Name / id                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------- |
| Workers   | `montra-app-staging`, `montra-jobs-staging`, `montra-inbound-staging` (`workers_dev: true`)   |
| D1        | `montra-staging`, id in `STAGING_D1_DATABASE_ID` (binding `DB`, migrations in `migrations/`) |
| KV        | `montra-cache-staging`, id in `STAGING_KV_CACHE_ID` (binding `CACHE` in app and jobs; FN-25 price cache) |
| R2        | `montra-files-staging` (binding `FILES`)                                                          |
| Queue     | `montra-jobs-staging` (producer `JOBS_QUEUE` in app; consumer in jobs, max_retries 3), DLQ `montra-jobs-dlq-staging` |
| Analytics | dataset `montra_stats_staging` (binding `STATS`)                                                  |
| Workflow  | `montra-statement-staging` (binding `WORKFLOW_STATEMENT`, class `StatementWorkflow`)              |

Vars: `APP_VERSION`, `APP_ENV=staging`. Secrets are set by the owner with `wrangler secret put ... --env staging`
(none needed yet).

**Deploy:** `npm run deploy:staging` (locally, or the `Deploy staging` workflow on a `v*` tag; see CI/CD). It
refuses without the real values above, then runs in order: D1 Time Travel bookmark (`time-travel info --json`, printed
as `deploy:staging: Time Travel bookmark <bookmark>`; no bookmark, no migration),
`d1 migrations apply montra-staging --remote --env staging`, `vite build`,
`wrangler deploy --env staging` for jobs, inbound, app. Jobs go first because it owns the queue consumer and Workflow
that the app produces to. `npm run deploy:staging -- --dry-run` skips the remote steps and passes `--dry-run` to the
deploys (needs no upload). `--skip-build` leaves out `vite build` and deploys the existing `.svelte-kit/cloudflare`
output (refuses when there is none); CI uses it so the build never runs with the Cloudflare token. Staging deploys
only on the 10th push or on owner request (`/ship`).

**Rollback:** note the bookmark printed by step 1. Data: `wrangler d1 time-travel restore montra-staging --bookmark
<bookmark> --env staging` (restore returns the whole DB to that moment). Migrations are not always additive:
SQLite cannot change a CHECK in place, so a migration may rebuild a table (copy, drop, rename; `0013_subscriptions`
rebuilds `notification_prefs` and `space_notifications`). Never hand-edit or partly re-run a rebuild; the rollback
is the Time Travel restore. Before any remote apply, keep the bookmark `deploy:staging` prints and record row counts
of the tables the migration touches (`wrangler d1 execute montra-staging --remote --env staging --command "select
count(*) from <table>"`), then compare them after the apply. Code:
`wrangler rollback --env staging -c <config>` per Worker (app, jobs, inbound), choosing the previous version id from
`wrangler deployments list`.

`0032_tanya_messages` (FN-22) only adds the table `tanya_messages` (no rebuild, no existing row touched). Keep the
Time Travel bookmark `deploy:staging` prints before applying it remotely like any other migration; its rollback is
the same restore. Tanya needs no new secret: it uses `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` and each user's own key.

`0034_merchant_rules` (FN-20) only adds the tables `merchant_rules` and `merchant_cache` (`IF NOT EXISTS`, no rebuild,
no existing row touched). Built as 0035, renumbered to 0034 at merge (after 0033 Gmail; OCR needed none). Keep the Time Travel
bookmark `deploy:staging` prints before applying it remotely; its rollback is the same restore. No new secret: the AI
step uses `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` and each user's own key; without them every non-AI layer still works.

`0036_agent_runs` (FN-23 Agen) only adds the table `agent_runs` (no rebuild, no existing row touched). Numbered 0036
with journal idx 36 because 0035 is reserved for another branch: whoever merges second re-chains the snapshot
`prevId` and the journal idx (as for 0030/0032/0034); `wrangler d1 migrations apply` orders by file name, so the gap
is harmless. Keep the Time Travel bookmark `deploy:staging` prints before applying it remotely; its rollback is the
same restore (report rows are derived and expire anyway; R2 files of a restored-away row are left in `FILES` until
removed by hand, so prefer rolling back only when no report was created since). No new binding or secret: reports
run on the existing `JOBS_QUEUE` steps in the jobs Worker (no Workflow, owner decision 1) and are written to `FILES`;
the optional narrative uses `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_ID` and `AI_KEYS_ENCRYPTION_KEY` on the jobs Worker
and each user's own key. Without them every report still completes, without its AI narrative. The hourly cron sweeps
expired reports (30 days after ready, 7 days for unfinished or failed runs) before the file sweep. Locally a run only
leaves "Antre" while the jobs Worker runs (`npm run dev:workers`). Real-provider check of the narrative
(owner-run, never part of `npm run gates`): `npm run compat:agent` with `COMPAT_AGENT_ANTHROPIC_KEY` (or the
receipts key) and the gateway ids in `.dev.vars`; record the line it prints separately.

`0037_fn48_categories` (FN-48 Part A) rebuilds `categories` and ends with two `ALTER TABLE … ADD category_source`
statements that cannot run twice. Apply it only through `wrangler d1 migrations apply` (one file is one D1 batch)
after taking the Time Travel bookmark. If an apply ever stops after those ALTERs but before wrangler records 0037,
every re-run fails with "duplicate column" and blocks later migrations (red team L2). Recovery: check that
`pragma table_info(transactions)` and `pragma table_info(drafts)` both list `category_source` and that the six new
tiles are allowed (`select sql from sqlite_master where name = 'categories'`), then record the migration by hand with
`insert into d1_migrations (name) values ('0037_fn48_categories.sql')` through `wrangler d1 execute … --remote`, and
re-run `wrangler d1 migrations apply`. If either check fails, restore the bookmark instead.

`0045_lows_services` (low findings, 2026-10-13; built as 0044, renumbered after `0044_passkeys`) rebuilds `gmail_mail` to add the reason `ai_limit` (every row and
index kept; no table references it) and adds `gmail_connections.ai_window_start`/`ai_reads` (FN-19 Gmail red team
L6, daily AI-read cap per connection) and `agent_runs.deleted_at` (FN-23 red team S2, "Hapus" tombstones). Record the
row counts of `gmail_mail`, `gmail_connections` and `agent_runs` and keep the Time Travel bookmark before a remote
apply; the rollback is the same restore. No new binding or secret.

`0046_net_worth_snapshot_classes` (FN-53 period reports, 2026-10-13) adds the nullable `net_worth_snapshots.classes`
JSON column with one `ALTER TABLE … ADD` and a column CHECK (no rebuild, no backfill: older rows stay null and
/kekayaan/laporan says the group split starts later). Order for a remote rollout: take the Time Travel bookmark and
record `select count(*) from net_worth_snapshots`, apply 0046 through `wrangler d1 migrations apply` (old code
ignores the column), then deploy the app Worker **and the jobs Worker**: the jobs Worker's hourly snapshot tick
(`writeSnapshots`) is what writes `classes`, so until it is redeployed every new snapshot keeps `classes` null. No
binding, secret or cron change. A re-run stops at the ALTER with "duplicate column"; if an apply ever stops after the
ALTER but before wrangler records 0046, check that `pragma table_info(net_worth_snapshots)` lists `classes`, record
`0046_net_worth_snapshot_classes.sql` in `d1_migrations` by hand as for 0037 above, and re-run the apply. Rollback is
the bookmark restore. Locally: `npm run db:migrate:local` only.

`0047_credit_cards` (FN-55a/b, 2026-10-13) creates `card_statements` (IF NOT EXISTS, with its partial unique index on
live space/wallet/statement date) and adds `wallets.credit_limit_minor`, `statement_day` and `due_day` with three
`ALTER TABLE … ADD` and column CHECKs (null unless the wallet is a `kartu_kredit`; no rebuild, no backfill). Take the
Time Travel bookmark and record `select count(*) from wallets` first; apply through `wrangler d1 migrations apply`,
then deploy the app Worker and the jobs Worker (the snapshot tick's `classes` split now puts a card's owed balance on
`debt` instead of `wallets`; the total is unchanged, so FN-53's per-group change shows a one-time Wallets-up/Debt-down
move on the first snapshot after deploy). A re-run stops at the first ALTER with "duplicate column"; if an apply
stops after the ALTERs but before wrangler records 0047, check `pragma table_info(wallets)` lists the three columns
and `card_statements` exists, record `0047_credit_cards.sql` in `d1_migrations` by hand as for 0037, and re-run.
Rollback is the bookmark restore. No binding, secret or cron change.

`0049_emoney_cards` (FN-58 pass 1, 2026-10-26) adds the nullable `wallets.emoney_issuer` with one `ALTER TABLE … ADD`
and a column CHECK (null unless the wallet is an `e_wallet`, then one of the seven issuer keys; no rebuild, no
backfill: every existing wallet stays null). Take the Time Travel bookmark and record `select count(*) from wallets`
first; apply through `wrangler d1 migrations apply`, then deploy the app Worker (old code ignores the column; the jobs
Worker needs no redeploy, an e-money card is an e-wallet in every total). A re-run stops at the ALTER with "duplicate
column"; if an apply stops after the ALTER but before wrangler records 0049, check `pragma table_info(wallets)` lists
`emoney_issuer`, record `0049_emoney_cards.sql` in `d1_migrations` by hand as for 0037, and re-run. Rollback is the
bookmark restore. No binding, secret or cron change. Locally: `npm run db:migrate:local` only.

**Logs:** the app Worker has Workers Logs on but its invocation logs off (`observability.logs.invocation_logs:
false`): they record every full request URL, invite tokens included (FN-03 red team L3). `src/hooks.server.ts`
writes one `request` line per request instead (method, route id or the path with any invite token masked, status,
ms; never the query string). `wrangler tail` still streams live URLs; it keeps nothing. Do not switch invocation
logs back on without redacting `/ruang/undangan/*`.

**Site host:** `src/lib/shared/hosts.ts` lists only `site.localhost` as a site host, so on workers.dev only the app
host exists. The public site (`/`, `/blog/*`, `/privasi`, `/ketentuan`, `/hapus-akun`) has no staging hostname until
a domain is chosen; those pages are reachable only locally until then.

## CI/CD

GitHub Actions in `.github/` (public repository; fork pull requests run CI with a read-only token and no secrets).
Every third-party action is pinned to a full commit SHA (version in a comment); Dependabot proposes updates.

| Workflow | When | What |
| -------- | ---- | ---- |
| `ci.yml` | every pull request, every push to `main` (superseded PR runs are cancelled) | `check` + `lint`; `npm run test` in 4 shards; `npm run build`; Playwright e2e; one summary check `CI ok` |
| `codeql.yml` | pull requests, pushes to `main`, Mondays 03:23 UTC | CodeQL `javascript-typescript` (no build) |
| `deploy-staging.yml` | a pushed tag `v*`, or by hand (Run workflow, choosing a `v*` tag) | `npm run gates`, then `npm run deploy:staging` in the `staging` environment |
| `dependabot.yml` | weekly | npm and GitHub Actions; minor and patch grouped per ecosystem; `tesseract.js`, `tesseract.js-core`, `pdfjs-dist` excluded (pinned OCR hashes, FN-16g) |

- Node 24 (LTS) in every job; `package.json` `engines` is `>=22`. `npm ci --ignore-scripts` (dependency install
  scripts do not run, as with the local npm 11) followed by `npx svelte-kit sync`.
- e2e: `npx playwright install --with-deps chromium webkit`, then `npx playwright test --workers=3` with every
  project of `playwright.config.ts` (setup, phone, desktop, ios-se, ios-pro-max). The config's `webServer` builds
  (`scripts/e2e-build.sh` with the runner's real `flock`), applies all migrations to a fresh local D1 in
  `.wrangler/e2e-state-8787` and starts the three Workers with the config's fixed fake keys; no `.dev.vars`, no
  seed, no Cloudflare account. `CI` makes Playwright retry once and never reuse a server. On failure the HTML report
  and traces are uploaded as the `playwright-report` artifact (7 days). Skipped in CI as everywhere without their
  switch: `gmail-configured.spec.ts` (needs `playwright.gmail-configured.config.ts`) and `ui-polish-shots.spec.ts`
  (needs `SHOTS_PHASE`).
- The deploy job runs only in this repository (never in a fork), only on a `refs/tags/v*` ref, refuses a tag that
  is not `v` + `package.json` `version` or whose commit is not on `main` (`git merge-base --is-ancestor`, full
  history), never runs two at once (`concurrency: deploy-staging`) and never cancels one halfway. It first reads
  `https://<staging-app-host>/api/v1/health`: when the live `version` already equals the tag (a local `/ship`
  deploy), it changes nothing and says so in the job summary. Otherwise it installs without the npm cache, runs the
  gates (including the build) without the Cloudflare token, then `npm run deploy:staging -- --skip-build` with the
  secrets. The host is a secret (masked; GitHub prints a step's `env:` before it runs, so a var would leak). It
  redacts every `*.workers.dev` address from the log and writes the Time Travel bookmark (or "no migration ran") to
  the job summary even when a later step fails. There is no production deploy workflow; nothing seeds or resets a
  remote database.

**Cut a staging deploy:** prepare the release commit as usual (version bump, `CHANGELOG.md`, release notes), merge
it to `main`, then `git tag vX.Y.Z <commit> && git push origin vX.Y.Z` (`X.Y.Z` = `package.json` `version`). The
run waits for the `staging` reviewer; after approval read the bookmark in the job summary. Once the `staging`
environment and its secrets exist, this is the deploy path: `/ship` writes the release commit and pushes `main` and
the tag, nothing more. Until then (and as a break-glass fallback) `/ship` still deploys locally with `npm run
deploy:staging` and `.staging.env`, then pushes the tag; the tag run then finds the version already live and skips.
A local deploy is outside the workflow's concurrency group: approve a tag run only after a local deploy finished.

**Owner setup (once, on GitHub):**

1. Settings › Environments › New environment `staging`: Required reviewers = the owner; Deployment branches and
   tags = Selected, add the tag rule `v*` (no branch rules).
2. In `staging`, environment secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `STAGING_D1_DATABASE_ID`,
   `STAGING_KV_CACHE_ID`, `STAGING_APP_HOST` (hostname only); environment variable (optional, public by design):
   `STAGING_TURNSTILE_SITE_KEY`. Values as in `.staging.env.example`. No repository-level secret is needed.
3. `CLOUDFLARE_API_TOKEN`: a custom API token limited to the Montra account (Account Resources: that account only;
   Zone Resources: only the staging zone) with Account › Workers Scripts: Edit (script upload, cron triggers,
   workers.dev), Account › D1: Edit (remote migrations, Time Travel bookmark), Account › Queues: Edit (the jobs
   Worker's queue consumer) and Zone › Workers Routes: Edit (the custom domain). KV, R2, Analytics Engine and
   Workflow bindings need nothing more as far as known; this list is not yet proven by a live run, so if a step
   fails with an authentication error, add only the permission it names. Optional: a client IP filter and an
   expiry date.
4. Settings › Rules › Rulesets › New tag ruleset `release tags`: target `v*`, restrict creations, updates and
   deletions, bypass list = the owner only. Then only the owner can create the tags that start a deploy.
5. Settings › Branches (or Rules › Rulesets) for `main`: require a pull request, require the status checks
   `CI ok` and `analyze` (CodeQL), require branches to be up to date; block force pushes and deletion.
6. Settings › Actions › General: "Require approval for all outside collaborators" for fork pull requests;
   Workflow permissions "Read repository contents".
7. Settings › Code security: enable Dependabot alerts and security updates (the version updates come from
   `.github/dependabot.yml`).

## Types

`npm run types:cf` regenerates `worker-configuration.d.ts` for the three Workers. Run it after any binding change.
