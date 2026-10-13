# MONTRA — Architecture

Initial design, 2026-10-07. Locked decisions are in `CLAUDE.md`; this file explains them and grows with the code.

## Runtime map

```
Device (PWA)                         Cloudflare
┌───────────────────────────┐        ┌──────────────────────────────────────────────────────────────┐
│ Svelte UI                 │  sync  │ app Worker (SvelteKit SSR, actions, /api/v1)                 │
│ IndexedDB (working copy)  │◄──────►│   D1 (server copy + change log)   R2 (kept photos, reports)  │
│ shared parsers (money,    │        │   KV (caches)   Analytics Engine (usage statistics)          │
│ dates, CSV, voice)        │        │   AI Gateway ──► Claude          Workers AI (Whisper fallback)│
│ Web Speech API (voice)    │        │   Agents SDK: assistant Durable Object per space             │
│ account private key       │        │   JOBS_QUEUE ──► jobs Worker (Queues, Cron, Workflows)       │
└───────────────────────────┘        │ inbound Worker ◄── Email Routing (forwarding fallback)      │
                                     │ Gmail via connection partner or own OAuth app (jobs Worker)  │
                                     │ Payments webhook ──► app Worker                              │
                                     └──────────────────────────────────────────────────────────────┘
```

SvelteKit 3 config lives in `vite.config.ts`; shared code is imported as `#lib/*`. Kit 3 and the Cloudflare adapter
never populate `event.platform`: server code reads bindings through `getEnv()` (`src/lib/server/env.ts`, wrapping
`cloudflare:workers`), and `dev` comes from `$app/env`. `Handle` and `Reroute` are imported from
`@sveltejs/kit/hooks`; param matchers are registered in `src/params/index.ts` with `defineParams`. Storage is
server-first for now (owner decision 2026-10-07: guest/local-first deferred), so the section below is the later
target for FN-02.

## Local-first sync (FN-02)

- Every synced record has `id` (UUIDv7, made on the device), `space_id`, `updated_at`, `updated_by`, `deleted_at`,
  and a server-assigned `seq`.
- Client keeps a per-space `cursor`. Push: changed records since the last push, one batch per space. Pull: records
  with `seq > cursor`. The server assigns `seq` from a per-space counter in the same `db.batch`.
- Conflict rule (proposed): last writer wins per record by server receive order; a delete (tombstone) wins over an
  older edit. Money fields are never merged field by field.
- Guest → account: on first sign-in the guest space uploads as the personal space; on a second device the account
  data downloads.
- Guests run all deterministic paths locally (manual entry, voice parser, CSV import/export). AI paths need an
  account.
- The server validates every pushed record (space membership, role, schema, money integer) exactly as a form action
  would.

## Capture pipeline

1. **Gmail:** Cron (hourly 06–23 WIB) enqueues one check per connected user → list new messages matching sender and
   subject filters, skipping Promotions/Social and mails without an amount → AI classifies (payment, promo, unpaid
   bill, shipping, OTP) and extracts → dedupe (reference + amount; deleted-row memory; manual same amount within 12 h
   → draft) → wallet matching → FX → transaction saved (tagged `gmail`) or draft → mail text discarded, only fields,
   sender and subject kept → optional push.
2. **Look-back scan:** Workflow over the chosen range, results kept as an import batch in review state until the user
   imports; undo deletes the batch.
3. **Statement / screenshot / receipt:** upload → memory only → AI partner read under a random name → partner copy
   deleted and verified → result sealed to the account key → review on the device → import batch.
4. **Spreadsheet:** AI returns only the layout map; code copies cells; totals checked against the sheet.
5. **CSV and voice:** parsed on the device by the shared parsers; voice drafts optionally re-checked by AI.
6. **Forwarding fallback:** inbound Worker → size and SPF/DKIM/DMARC check → same path as Gmail from step 1's AI step.

## Account key (FN-21)

- On sign-up or first sign-in the device makes an X25519 key pair. The private key is wrapped with AES-256-GCM under
  a key derived from the password with scrypt (OWASP parameters, per-user salt); the server stores the public key
  and the wrapped private key only.
- The jobs Worker seals each result with an ephemeral X25519 key, HKDF-SHA256 and AES-256-GCM to the user's public
  key. Only a signed-in device holding the password-derived key can open it.
- Password change re-wraps the private key on the device. Password reset without the old password cannot recover
  sealed results; the UI says so before reset.

## Data model (first cut)

`users`, `sessions`, `account_keys`, `spaces`, `space_members`, `space_invites`, `space_seq`, `wallets`,
`categories`, `tags`, `transactions`, `transaction_tags`, `attachments`, `budgets`, `goals`, `drafts`,
`import_batches`, `capture_seen` (source dedupe and deleted-row memory), `merchants`, `merchant_rules`,
`gmail_connections`, `gmail_messages` (id, date, kind), `fx_rates`, `holdings`, `prices`, `belongings`,
`collectibles`, `subscriptions`, `subscription_catalog`, `assistant_threads`, `agent_reports`, `connected_apps`,
`notifications`, `push_subscriptions`, `feature_flags`, `plans`, `credit_ledger`, `vouchers`, `billing_events`,
`audit_events`.

IDR uses the ISO 4217 exponent 2: `amount_minor` is sen (Rp 25.000 = 2 500 000). Display drops `,00`.

Money: `amount_minor INTEGER`, `currency TEXT`; dates: `occurred_on TEXT` (WIB `YYYY-MM-DD`), `occurred_at INTEGER`
(UTC ms, nullable).

## Open questions

Owner decisions live in `docs/TASKS.md` › Owner decisions.
