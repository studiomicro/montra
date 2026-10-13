# FN-29 Connected apps — engineer report (cycle 1)

Branch `fn-29-connected-apps` from `main` c401a94. Migration `migrations/0017_connected_apps.sql` (journal idx 15,
tag `0017_connected_apps`, snapshot `meta/0017_snapshot.json` with `prevId` = 0014's snapshot id; **re-chain at
merge** after FN-27/28/30 land 0015/0016). Risk tier Medium. Everything stops at the credential boundary: no OAuth
flow, no provider call, no app registration; every app reads "Belum dikonfigurasi".

## What works

- **`/pengaturan/aplikasi` "Aplikasi terhubung"** (new route; new `GroupRow` with a new `link` icon after
  "Notifikasi" in `/pengaturan`). Five rows — Gmail, Google Sheets, Google Calendar, Notion, Slack (provider names
  only, no logos) — each "Belum dikonfigurasi". A row opens a `Sheet` with one future-tense line of what the app
  would do ("Nantinya …"), a disabled "Hubungkan" (`type="button"`, no form: no request) captioned "Belum
  dikonfigurasi", and — only when a stored connection exists — a `<details>` "Putuskan" confirm. Without
  JavaScript `?app=<provider>` renders the same detail inline and "Putuskan" is a plain form post.
- States: `Skeleton` on retry, `ErrorState` + retry (load failure logs `errorLabel` only), `EmptyState` "Belum ada
  aplikasi yang terhubung." (the permanent state outside dev seeding), "Memproses…" + disabled buttons, success
  line only after the server answered, 404/409 → `invalidateAll` (`/langganan` `track()` pattern).
- **Dev tools** (`devRoutesEnabled`, 404 otherwise): "Tambah sambungan contoh" (provider select) seeds one
  `Data demo` connection with a synthetic token sealed by the real crypto path; "Kosongkan sambungan contoh"
  tombstones every demo connection. Without a well-formed key the seed answers 503 "Belum dikonfigurasi".

## Data and rules

- `connected_apps` (space-scoped, first in `SPACE_SCOPED_TABLES`): `provider` (5-value CHECK), `status`
  (`connected` live / `disconnected` tombstone), `external_label` (≤ 80), `encrypted_token`, `token_nonce`
  (16 chars = 96-bit), `token_key_id` (11 chars), `scope` (≤ 500), `is_demo`, `created_by_user_id` (FK users,
  set null), `created_at`, `updated_at`, `deleted_at`, `seq`. Partial unique index (space, provider) where live.
  CHECK `connected_apps_content_check`: live rows have all three seal fields or none; tombstones are
  `disconnected` with label, token, nonce, key id and scope all null.
- `AUDIT_ACTIONS` + `audit_events_action_check` gain `app_connected` / `app_disconnected` (table rebuilt in the
  migration; drizzle's `PRAGMA foreign_keys` lines removed as in 0013 — nothing references `audit_events`).
  Events are content-free (actor + action only).
- **Crypto** (`src/lib/server/connected-apps/crypto.ts`): server-held `CONNECTED_APPS_ENCRYPTION_KEY` (32 bytes,
  base64url; standard base64 accepted), WebCrypto AES-256-GCM, fresh random 96-bit nonce per seal, AAD =
  JSON `[label, keyId, rowId, spaceId, provider]`. `isConnectedAppsConfigured(env)` false unless exactly 32 bytes.
  `encryptToken(env, plaintext, binding) → {ciphertext, nonce, keyId} | null`, `decryptToken(env, sealed,
  binding) → string | null` (fails closed: wrong key, unknown key id, tampered or moved ciphertext, bad nonce).
  Rotation: `CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS` opens rows whose `token_key_id` matches it; new seals use
  the current key. Token ≤ 8000 bytes; errors never carry it; nothing logs.
- **Repo** (`connected-apps/repo.ts`): `listConnections` selects only id/provider/label/isDemo/updatedAt (token
  columns never selected for a page); `disconnectApp`, `seedDemoConnectedApp`, `clearDemoConnectedApps` — each one
  `db.batch` with `bumpSpaceSeq`, the audit row(s) under the same guard (`isLiveMember` + row state) and the write.
  Seed is `INSERT … SELECT … WHERE NOT EXISTS` (unique index as backstop → `exists`).
- **Access**: every load/action goes through `currentSpaceScope` (→ `requireSpaceAccess`); connection ids are
  looked up only inside that space; unknown, foreign, already-disconnected and over-long ids get one 404 body.
- **Display rule** (`appRows`, shared): a row is `connected` only for a live row **and** a configured key; with
  the key unset even a seeded row reads "Belum dikonfigurasi" (but stays disconnectable).
- **Pure builders** (`src/lib/shared/connected-apps/`, no I/O):
  - `buildSheetsRows(ExportRow[])` → header + rows for `values.append`; cells = FN-18's `exportCells` (masking)
    through `guardFormula` (FN-18's formula guard, now exported from `shared/csv.ts`).
  - `buildCalendarEvents` → Google Calendar all-day events `{summary, start:{date}, end:{date+1}, description?}`;
    input `{title, note?, date}` (WIB date) or `{…, at}` (UTC instant, bucketed in WIB).
  - `buildNotionReportBlocks(summary, translator)` → Notion block objects; every amount via `formatMoney`.
  - `parseSlackMessage({text, teamId, channelId, ts}, VoiceContext)` → `SlackDraft[] | null`: strips Slack markup
    (`<…>`, `:emoji:`, `*_~\``, entities), then FN-14's `parseVoiceSentence` unchanged; drafts carry
    `source: 'slack'`, WIB `occurredOn` from `ts`, `dedupeKey slack:<team>:<channel>:<ts>:<i>`; capped at
    `VOICE_BATCH_MAX`; `null` for chat without an amount or a malformed identity.
- **FN-18 refactor (no behaviour change)**: `ExportRow` moved to `shared/csv.ts`; `exportCells` + `guardFormula`
  added; `exportLine = csvLine(exportCells(row))`. FN-18's vectors moved to `test/fixtures/export-vectors.ts` and
  shared by `impor.test.ts` and the Sheets test.
- Config: `src/app.d.ts` `Env` + `.dev.vars.example` + `docs/RUNBOOK.md` › "Connected apps (FN-29) encryption key".

## Decisions (adopted, recorded)

1. Disconnect takes the **connection id**, not the provider: a stale tab cannot disconnect a newer connection.
2. Added `token_key_id` + `CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS` for key versioning/rotation (brief); AAD binds
   key id + row + space + provider; signatures take a `binding` (PRD sketch had none).
3. Added `is_demo` (fixture rows badged "Data demo", per CLAUDE.md).
4. Disconnect works even with the key unset (deleting a token needs no key); the row still reads "Belum
   dikonfigurasi".
5. Calendar output uses the real Events all-day shape and accepts a UTC instant (so the WIB vector tests the
   builder); Notion takes the translator for labels; Slack takes the message identity (needed for dedupe key and
   date) and `VoiceContext` (wallet ids/types, what the voice parser needs) instead of `walletNames`, and returns
   one draft per amount.
6. No live Slack endpoint, no drafts insert function (no caller yet): an integration test inserts the parser's
   output into `drafts` to prove it fits the CHECKs and the dedupe index.

## Tests

- Unit: `crypto.test.ts` (round trip, 50 fresh nonces, wrong key, relabelled key id, row/space/provider swap,
  delimiter confusion, tamper, malformed fields, no key, rotation, size limits), `validation.test.ts`,
  `providers.test.ts`, `sheets-export.test.ts` (AC6 vs `exportLine` on shared vectors), `calendar-export.test.ts`
  (23:30 WIB last day, 00:30 WIB first, year end, leap day), `notion-export.test.ts` (AC8),
  `slack-draft-parse.test.ts` (AC9 vs 19 FN-14 vectors, hostile text, markup, ReDoS-shaped input, identity).
- Integration `test/integration/aplikasi.test.ts` (19): no-key screen, 503 seed, dev gate 404, `?app=`, load
  failure; seed/connected/audit; ciphertext only, swap/wrong key, no token in page data; SQL-copied ciphertext;
  disconnect tombstone + audit + "Belum dikonfigurasi" again; CHECK refusals; key removed later; 20 concurrent
  seeds / disconnects; clear; shared member; non-member + removed member 404 (forged space and own-space id);
  signed out; account deletion; Slack drafts insert + replay.
- E2E `e2e/aplikasi.spec.ts` (phone + desktop): five rows "Belum dikonfigurasi", each sheet's disabled Hubungkan
  makes no request, CSP clean, no horizontal scroll at 360 px; seed without key shows "Belum dikonfigurasi";
  no-JS `?app=slack` inline.

## Gaps

- No real OAuth/API for any provider (no client/app exists); no live Slack Events endpoint.
- No re-seal job for key rotation; the jobs Worker has no key yet (not needed until a job decrypts a token).
- A real Gmail disconnect must also purge FN-19's mail-derived rows (FN-19's job).
- The configured seed → disconnect path is proven in integration tests and an HTTP probe, not in e2e (the e2e
  server has no key, matching production).

## Checks run

- `npm run db:reset:local`: 0000–0014 + 0017 applied ✅.
- `npm run gates`: exit 0 — svelte-check `0 ERRORS 0 WARNINGS` (+ service-worker/jobs/inbound tsc clean),
  prettier + eslint clean, Vitest `116 files, 1803 tests passed`, build `✔ done`.
- E2E full suite `E2E_PORT=8861 --workers=2`: `230 passed, 15 skipped (4.6m)`, 0 failed (no rerun needed);
  `e2e/aplikasi.spec.ts` alone: 7 passed (setup + 3 × phone/desktop).

## Pre-handoff probes

- Ciphertext swap between rows: `decryptToken` with another row's / space's / provider's binding → `null`
  (unit + integration; an SQL-copied ciphertext into another space's row → `null`) ✅.
- Wrong key: a different well-formed 32-byte key (also relabelled with its own key id) → `null` ✅.
- Missing key: unset / empty / 31 / 33 bytes / garbage → `isConnectedAppsConfigured` false, all five rows
  "Belum dikonfigurasi", seed 503 "Belum dikonfigurasi", no row written; a stored row with the key removed reads
  "Belum dikonfigurasi" and still disconnects ✅.
- Tokens absent from page data: integration (`JSON.stringify(load)` contains no token, ciphertext, nonce, key id,
  nor `encrypted|nonce|keyId|token`) and HTTP probe on `wrangler dev :8842` with a key: seeded row's
  `encrypted_token` (84), `token_nonce` (16), `token_key_id` (11) and `demo-token` absent from the HTML and
  `__data.json` ✅. Same probe: unknown id disconnect 404; disconnect 200 → tombstone `disconnected`, token/nonce/
  label null, 2 audit rows; repeat no-JS disconnect 404 "Sambungan ini sudah tidak ada." ✅. Server stopped.
- Cross-space: stranger and removed member → 404 `Not found` on load, disconnect, seed, clear (forged space);
  in their own space the shared row's id, a random UUID, a 5000-char id and '' all answer the same 404 body;
  rows + audit snapshot unchanged ✅.
- Concurrency: 20 concurrent seeds of one app → 1 ok, 19 × 409, 1 row, 1 audit; 20 concurrent disconnects → 1 ok,
  1 audit ✅.
- Slack parser vectors: 19 FN-14 voice vectors equal (with and without wallets); chat without amount, links,
  mentions, emoji codes → `null`; `&lt;script&gt;` / HTML stays inert text; control, zero-width, bidi stripped;
  500 KB input capped and ≤ 20 drafts; 200 KB `<`/`:` run < 1 s; `__proto__` plain; malformed ts/team/channel →
  `null`; 00:30 WIB → next WIB date; redelivery/edit → same dedupe keys, drafts insert + replay → 2 rows ✅.
- Export builders' formula injection: shared FN-18 vectors + fullwidth, leading-space, tab, CR, LF, `'=x` → Sheets
  cells identical to FN-18 `exportLine` cells, all guarded; masking vectors identical ✅.
- Month boundaries: Calendar 23:30 WIB 31 Oct → 2026-10-31 (end 11-01), 00:30 WIB 1 Nov → 2026-11-01, 31 Dec →
  end 2027-01-01 ✅. 360 px: e2e phone project no horizontal scroll; rows/summary/select ≥ 44 px ✅. No-JS: e2e
  `?app=slack` inline + HTTP disconnect refusal shown ✅. Two tabs: disconnect keyed by connection id, a stale
  tab's second disconnect → 404 + reload ✅. User copy: no paths or internal ids ✅.

## Checklist items applied

Bounded queries (list `limit 5`, ids bound as single params, no `inArray`); guarded writes in one `db.batch`
(INSERT…SELECT WHERE NOT EXISTS, UPDATE…RETURNING) with a concurrency test; new migration only; one access rule /
no oracle; masking (`maskExternalLabel`, `maskAccountNumbers` in Sheets); untrusted text (cap before work, invisible
chars stripped, never HTML); idempotent capture (Slack dedupe key); sealed results (WebCrypto AES-256-GCM, fresh
nonce, round-trip + wrong-key tests); tombstones content-free (CHECK); CSV/spreadsheet formula guard; i18n EN for
every phrase (coverage test); shared formatter; truthful state; keyed `{#each}` by provider; no inline styles; no
real providers in tests.

## Cycle 2 (red team Lows)

Rebased onto `main` 9d3e892 (FN-27 `0015_belongings`). The migration was regenerated as `0017_connected_apps.sql`
(journal idx 16, snapshot `prevId` = 0015's id; renumber at merge), with the new audit action included.

- **L1** `slack-draft-parse.ts`: entities are decoded first, then `<…>` stripped, then any lone `<`/`>` dropped,
  so `kopi 25rb &lt;!channel&gt; &lt;@U12345&gt;` gives the title `kopi`, and no title holds `<` or `>`. The
  fail-first run showed 2 failing tests; they pass after the fix.
- **L2** `connected-apps/repo.ts › autoDisconnectItems`: when a member is removed (`removeMember`), leaves
  (`leaveSpace`) or deletes their account (`deleteAccount`, every space), every live connection they made in that
  space becomes a content-free tombstone (token, nonce, key id, label and scope deleted). Each one gets a
  content-free `app_auto_disconnected` audit row (actor null, target = the creator) and a space change-counter
  bump. All of this happens in the same batch, under the same guard as the membership change. A refused
  removal or leave changes nothing. `AUDIT_ACTIONS` and its CHECK gain `app_auto_disconnected`. AC10 changed:
  a shared space keeps its other members' connections, and the deleted user's connections end. The fail-first
  run showed 4 failing tests; they pass after the fix.
- **L3**: only the connection's creator or the space's Pemilik may disconnect. Any other live member gets
  `fail(403, "Hanya yang menghubungkan atau Pemilik ruang yang bisa memutus sambungan ini.")`. They can already
  see the connection, so this reveals nothing. Unknown or foreign ids still get the one 404. The guard is part of
  the UPDATE and the audit insert. `ConnectionView.canDisconnect` (computed in SQL) hides "Putuskan" for anyone
  else. The fail-first run showed this test failing; it passes after the fix.

Cycle 2 checks: `npm run check` exit 0 (`0 ERRORS 0 WARNINGS`), `npm run lint` exit 0, Vitest `--maxWorkers=4`
`121 files, 1900 tests passed`, build `✔ done`; `npm run db:reset:local` 0000–0015 + 0017 ✅; e2e
`e2e/aplikasi.spec.ts e2e/ruang.spec.ts` (`E2E_PORT=8861 --workers=2`): `19 passed, 2 skipped`, 0 failed.
