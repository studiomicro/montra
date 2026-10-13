# Self-hosting Montra

Montra runs entirely on Cloudflare. This page lists what you must create and configure. Deploy and CI/CD steps are
in [RUNBOOK.md](RUNBOOK.md). Resource names below are the defaults in the `wrangler.jsonc` files; replace the
placeholder ids (account id, D1 database id, KV namespace id, route) with your own before deploying.

A Workers Paid plan is needed (Queues and Workflows are not on the free plan).

## Required Cloudflare resources

| Resource | Binding / name | Used by |
| --- | --- | --- |
| Worker: app | `wrangler.jsonc` | SSR, loaders, actions, API routes |
| Worker: jobs | `workers/jobs/wrangler.jsonc` | queue consumer, cron (hourly Gmail checks), Workflows |
| D1 database | `DB`, migrations in `migrations/` (`npm run db:migrate:local` for local; apply to remote with `wrangler d1 migrations apply`) | all three Workers |
| KV namespace | `CACHE` | caches, price data |
| Queue and dead-letter queue | `JOBS_QUEUE` (`montra-jobs`, `montra-jobs-dlq`) | app and inbound produce, jobs consumes |
| Workflow | `WORKFLOW_STATEMENT` (`StatementWorkflow`) | statement reading |
| Analytics Engine dataset | `STATS` | self-hosted usage statistics |
| Custom domain or route | your own host | the app |

## Optional resources

| Resource | Needed for |
| --- | --- |
| R2 bucket `FILES` | attached receipt, item and collectible photos, agent reports. The Workers declare the binding. |
| Worker: inbound (`workers/inbound/wrangler.jsonc`) plus Email Routing on your domain | the e-mail forwarding fallback |
| AI Gateway | AI reading and the assistant. Set `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_ID`. |
| Web Push (VAPID keys) | notifications |
| Google OAuth client | the Gmail connection (read-only scope). Production use with real users needs Google's security assessment (CASA). |
| Turnstile | not used by the code today |

A feature whose configuration is missing shows `Belum dikonfigurasi` and stores nothing; the rest of the app works.
Users bring their own Anthropic key for AI reading (Pengaturan > Integrasi).

## Variables

Set in the `vars` block of each `wrangler.jsonc`.

- Required: `APP_VERSION`, `APP_ENV`.
- Optional: `SOURCE_URL` (see below), `SUPPORT_EMAIL`, `GOOGLE_OAUTH_REDIRECT_ORIGIN` (your app origin, no path),
  `GOOGLE_OAUTH_TESTING`, `INBOUND_EMAIL_DOMAIN`, `INBOUND_AUTHSERV_ID`, `AI_GATEWAY_ACCOUNT_ID`,
  `AI_GATEWAY_ID`.
- Local development only, never set remotely: `DEV_ROUTES`, `BILLING_MOCK_ENABLED`.

## Secrets

Set with `wrangler secret put`, never in the repository. Names are documented in `.dev.vars.example`.

- Required for the features they guard: `CONNECTED_APPS_ENCRYPTION_KEY` (seals connected-app tokens, also needed by
  the jobs Worker for Gmail), `AI_KEYS_ENCRYPTION_KEY` (seals users' own AI keys).
- Optional: `CLAIM_HASH_KEY`, `ADMIN_ACCOUNT_IDS`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
  `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- Each `*_ENCRYPTION_KEY` and `CLAIM_HASH_KEY` accepts a `_PREVIOUS` twin only during rotation.
- Payment: only a mock provider exists; `MOCK_PAYMENT_WEBHOOK_SECRET` is for local testing. Wire a real provider
  yourself if you need paid plans.
- `COMPAT_*_ANTHROPIC_KEY` are for maintainers' real-provider checks and are never needed to run the app.

## Source code requirement (AGPL-3.0 section 13)

Montra is licensed under the AGPL-3.0. If you run a modified version for other people over a network, you must offer
those users the corresponding source of your version. Set the `SOURCE_URL` var to the public URL of your source
repository; the app then links it under Pengaturan > Tentang Montra > Kode sumber. Unset, that row shows
`Belum dikonfigurasi`.
