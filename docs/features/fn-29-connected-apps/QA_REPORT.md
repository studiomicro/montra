# FN-29 Connected apps — QA report

**Verdict: PASS**

Reviewed: `git diff 9d3e892..2ff89d6` (isolated worktree detached at `2ff89d6`), PRD, ENGINEER_REPORT (cycles 1–2),
SECURITY_REPORT (L1/L2/L3 all fixed in cycle 2, confirmed live below).

## Commands run

- `npm ci`: 246 packages installed, 0 errors.
- `npx svelte-kit sync`: clean, no output.
- `npm run db:reset:local`: migrations 0000–0015 + 0017 applied, 0 errors.
- `npm run gates` (first run): **17 files failed** — all `UND_ERR_SOCKET`/"other side closed" miniflare socket
  errors on routes unrelated to FN-29 (riwayat, spaces, suara, tabungan, transactions, wallets); confirmed
  machine-load flakiness, not a regression — real provider: none (local D1/miniflare).
- `npx vitest run test/integration/riwayat-routes.test.ts test/integration/spaces.test.ts test/integration/suara-routes.test.ts test/integration/tabungan-routes.test.ts test/integration/transactions.test.ts`: 5 files, 125 tests passed — confirms flakiness, not a real failure.
- `npx vitest run --maxWorkers=4` (full suite, reduced worker count): **121 files, 1900 tests passed**, 0 failed — real D1 (miniflare), no mocked AI, no external provider.
- `npm run check`: `1309 FILES 0 ERRORS 0 WARNINGS`.
- `npm run lint`: prettier + eslint clean.
- `npm run build`: `✔ done` (client + service worker + Cloudflare adapter).
- `npx vitest run --maxWorkers=4 src/lib/server/connected-apps src/lib/shared/connected-apps test/integration/aplikasi.test.ts`: 8 files, 90 tests passed.
- `npx vitest run --maxWorkers=4 test/i18n-coverage.test.ts src/lib/shared/i18n.test.ts`: 2 files, 15 tests passed (every Indonesian phrase, including FN-29's, has an English entry).
- Full Playwright, `E2E_PORT=8864 --workers=2`, `LD_LIBRARY_PATH` for system libs: **240 passed, 15 skipped, 0 failed (5.2m)** — no rerun needed.
- `e2e/aplikasi.spec.ts` alone, `E2E_PORT=8865 --workers=2`: **7 passed** (setup + 3 specs × phone/desktop).
- Ad-hoc `wrangler dev --port 8847` (local test key absent, `DEV_ROUTES:1`, `.dev.vars` never committed): confirms "Belum dikonfigurasi" for all 5 providers, seed → 503.
- Ad-hoc `wrangler dev --port 8848` (local test key present via `.dev.vars`, generated with `openssl rand -base64 32`): full connect → auto-disconnect → disconnect → account-deletion flow exercised through real HTTP requests (below). Server stopped, `.dev.vars` and `.wrangler/qa-*-state` removed after.
- CSV byte-compare: a Vitest test producing a deterministic export (formula vectors + masking vectors + a manual transaction) was run once in this worktree (`2ff89d6`) and once in a temporary `git worktree` at `main` `9d3e892`, both against the same seed/time constants — **`cmp` reports byte-identical, same SHA-256** (`1ed16a9d…`). Temporary worktree and test file removed after.

## Checked criteria (PRD `docs/features/fn-29-connected-apps/PRD.md`)

1. **PASS** — all five providers show "Belum dikonfigurasi"; `e2e/aplikasi.spec.ts` asserts the disabled "Hubungkan"
   button sends zero requests on click (`page.on('request')` recorder, 0 matches) and CSP is clean. Confirmed again
   live via `wrangler dev` without a key.
2. **PASS** — `requireSpaceAccess`/`currentSpaceScope` on every load/action; unknown id, foreign id, removed-member
   id and a stranger's forged id all answer the identical 404 body `"Sambungan ini sudah tidak ada."` — verified
   live: a removed member (B) posting A's connection id → 404; an unknown UUID → the same 404 body.
3. **PASS** — `crypto.test.ts` round-trips a synthetic token and fails closed with a different well-formed 32-byte
   key (`null`, never the wrong plaintext); `isConnectedAppsConfigured` false for unset/31/33-byte/garbage keys,
   forcing every row to "Belum dikonfigurasi" even a dev-seeded "connected" one — verified live: `wrangler dev`
   without `.dev.vars` → seed answers 503 "Belum dikonfigurasi", all 5 rows show "Belum dikonfigurasi".
4. **PASS** — verified live via direct D1 query after seeding/disconnecting/removing a member: `audit_events` has
   exactly one `app_connected`/`app_disconnected`/`app_auto_disconnected` row per connect/disconnect/auto-disconnect,
   always paired with the `connected_apps` write in the same `db.batch`.
5. **PASS** — live probe: seed → disconnect → D1 query shows a content-free tombstone (`external_label`,
   `encrypted_token`, `token_nonce`, `token_key_id`, `scope` all null, `status='disconnected'`); reload shows
   "Belum dikonfigurasi" again; a repeat disconnect on the same id → 404.
6. **PASS** — `sheets-export.test.ts` runs `buildSheetsRows` against the FN-18 formula/masking vectors now shared
   via `test/fixtures/export-vectors.ts` and asserts identical cells to `exportLine`. Additionally, a direct
   byte-compare of the full CSV export between `main` and this branch (same seeded data) is byte-identical
   (SHA-256 match), proving the `ExportRow`/`exportCells` refactor made no behaviour change.
7. **PASS** — `calendar-export.test.ts` covers 23:30 WIB on a month's last day (stays on that WIB date, end crosses
   into the next month), 00:30 WIB on the first (never the UTC date one bucket earlier), the year boundary and leap
   day.
8. **PASS** — `notion-export.test.ts`; code review of `notion-export.ts` confirms every money figure goes through
   `formatMoney`, the function is synchronous with no `fetch`/`db` argument.
9. **PASS** — `slack-draft-parse.test.ts` runs the 19 FN-14 voice vectors through `parseSlackMessage` with identical
   results, plus the ordinary-chat-no-amount → `null` case. Red-team L1 fix (entity-decode-before-strip) is now
   its own regression test (`'red team L1: decoded entities never re-create mention markup'`) and verified live in
   the source: `plainText()` decodes `&lt;`/`&gt;`/`&amp;` first, strips `<…>` markup, then drops any lone `<`/`>`.
10. **PASS** — live probe end-to-end: a shared space with owner A and members B, C; B seeds a Slack connection; A
    removes B → D1 shows B's Slack connection tombstoned (content-free) with an `app_auto_disconnected` audit row
    (no actor, target = B), while A's own Notion connection in the same space stays `connected`. C then seeds a
    Google Sheets connection and deletes their account → C's connection is tombstoned by the same mechanism while
    the shared space and A's connection survive. Matches the AC10 text as updated by the red-team L2 fix.
11. **PASS** — `test/i18n-coverage.test.ts` passes (every new Indonesian string has an English entry); source review
    of `providers.ts`/`crypto.ts`/the settings page confirms every provider description uses future tense
    ("Nantinya …"), "Terhubung" is only ever rendered when `state === 'connected'` (configured key + live row), and
    no logo/image asset is imported or fetched — names only.
12. **PASS** — settings screen has `Skeleton` (on retry), `ErrorState` + retry, `EmptyState` ("Belum ada aplikasi
    yang terhubung." — the default and, this pass, permanent state), a `track()`-based submit with "Memproses…" and
    success only after the server answers, and `invalidateAll` on 404/409 — matches `/kekayaan`/`/langganan`.

## Additional verification beyond the PRD list

- **Server-side authorization, live (not just unit-tested):** created a real shared space via HTTP with owner A and
  members B and C (signup → `/ruang/baru` → invite → accept, all via raw `curl` cookie jars against a real
  `wrangler dev`). Confirmed: B (creator of a connection, non-owner) sees and can use "Putuskan"; A (Pemilik,
  non-creator) also sees and can use it; C (plain member, neither creator nor owner) does **not** see "Putuskan" in
  the rendered page, and a forged direct POST of the same action from C's session answers **403** with the exact
  message `"Hanya yang menghubungkan atau Pemilik ruang yang bisa memutus sambungan ini."` — the red-team L3 rule
  verified from both the UI and the wire.
- **No token material leaks:** grepped the full `wrangler dev` console log and the seeded page's HTML for
  `token|nonce|keyId|encrypted|demo-token` after a real seed+connect — no match (aside from an unrelated CSP
  `nonce` attribute).
- **Sync scoping:** `listConnections` query never selects token columns (confirmed by reading `repo.ts`); live probe
  confirms the rendered page and `__data.json`-equivalent carry no token/nonce/key id.
- **Demo badge:** seeded connections carry `is_demo=1` and render the `Data demo` badge; `is_demo` rows are never
  money-affecting (connected_apps has no money columns at all).
- **ENGINEERING_CHECKLIST.md**: bounded queries (`limit` on the provider-count list), guarded writes in one
  `db.batch` with a concurrency test (engineer's 20-way probe, not independently re-run here but code-reviewed:
  `INSERT…SELECT…WHERE NOT EXISTS` + unique-index backstop, `UPDATE…RETURNING`), one access rule with no existence
  oracle (verified live above), masking (`maskExternalLabel` unit-tested), untrusted text handling in the Slack
  parser (cap-before-regex, invisible/control stripped, never HTML), idempotent capture (Slack dedupe key format
  verified by code review), sealed results (WebCrypto AES-256-GCM only, fresh nonce, round-trip + wrong-key tests),
  content-free tombstones (CHECK constraint, verified live by direct D1 query), CSV/spreadsheet formula guard
  shared between CSV and Sheets, i18n coverage (test green), truthful state (`track()` pattern), keyed `{#each}` by
  `app.provider`. No violation found.

## Findings

None. All three SECURITY_REPORT Low findings (L1 Slack entity-decode ordering, L2 credential outliving
membership, L3 no disconnect role rule) were fixed in ENGINEER_REPORT cycle 2 and are independently re-verified
live above (not just by re-reading the diff).

## Notes for the record

- The first `npm run gates` run failed 17 unrelated integration-test files with `UND_ERR_SOCKET`/"other side
  closed" (miniflare socket churn under full parallel load on a loaded machine — the project's own
  `vitest.config.ts` already documents this class of flakiness from a prior QA cycle). Re-running the same files
  alone, and the full suite with `--maxWorkers=4`, both passed clean (121 files / 1900 tests). `check`, `lint` and
  `build` were run separately and were clean on the first try. No FN-29 file was ever among the flaky failures.
- `test/integration/qa-export-compare.test.ts` and a temporary `git worktree` at `main` `9d3e892` were created
  solely to byte-compare the CSV export before/after the `ExportRow` move; both were deleted after use and are not
  part of this commit.
