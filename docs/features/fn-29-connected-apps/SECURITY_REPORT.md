# FN-29 Connected apps — Security report

Reviewed: `git diff c401a94..cd047c5` (worktree detached at `cd047c5`), PRD and ENGINEER_REPORT.
Reviewer: red-team pentester, 2026-10-08.

## Verdict: PASS

No Critical, High or Medium findings. Three Low findings, tracked below. L2 must be closed before any real
provider token is written (the OAuth follow-up).

## What was checked

- **AES-256-GCM** (`src/lib/server/connected-apps/crypto.ts`): WebCrypto only; fresh `getRandomValues` 96-bit
  nonce on every seal (no nonce is ever carried over on re-encrypt); AAD is a JSON array of label, key id, row id,
  space id and provider, so there is no delimiter ambiguity, and a ciphertext moved to another row, space or provider fails
  closed. The key must decode to exactly 32 bytes (standard or url base64, padding tolerated); anything else
  means not configured, with no default key. Rotation: the key id is a labelled, truncated SHA-256 (64 bits, which reveals
  nothing about the key), lookup is by exact key id, and new seals always use the current key, so the previous key can
  only open its own rows. It cannot downgrade new seals. Errors are `null`/`RangeError('token length out of range')`
  with no token text and no logging. The DB CHECK pins nonce = 16 chars and key id = 11 chars.
- **Tokens never leave the server**: `listConnections` selects no token columns. HTTP probe (wrangler dev :8846 with
  a local test key): `__data.json` after a seed contains none of `token|nonce|keyId|encrypted|demo-token`; the
  wrangler log contains no token. Audit rows hold only `action` + actor (`app_connected`/`app_disconnected`,
  `target_user_id` null).
- **Dev seed gate**: `devAction` calls `error(404)` before any form read or scope when `devRoutesEnabled` is false.
  Probe without `.dev.vars`: `?/seedDemoConnectedApp` → 404. `DEV_ROUTES` appears in no wrangler config (only in
  `.dev.vars.example`), so it is dev-only in staging and production.
- **Disconnect IDOR / stale tab / removed member / concurrency**: id is matched with `space_id` of the
  re-checked current space plus `isLiveMember` inside the UPDATE and the audit guard (one batch). Probe: user B
  posting user A's connection id → 404 "Sambungan ini sudah tidak ada." (same body as a random id); A → 200
  tombstone (status `disconnected`, label/token/nonce/key id null, `deleted_at` set) and exactly one
  `app_disconnected` audit row; a repeat → 404. Cross-site Origin → 403 (SvelteKit CSRF). Engineer's 20-way
  concurrency test (1 ok, 1 audit) also passes here.
- **FN-18 refactor**: `exportLine` is now `csvLine(exportCells(row))` with identical cells/order/masking;
  `csvCell` = `guardFormula` + unchanged quoting; `needsGuard`/`FORMULA_START` unchanged. No regression;
  `test/integration/impor.test.ts` passes.
- **Sheets**: same cells as CSV + `guardFormula` on header and every cell. Probe: `=1+1`, `\t=x`, `+62`, `-1`,
  ` @SUM(A1)`, `'=x` all prefixed with `'`; `BCA 1234567890` → `BCA ••••7890`. Fine for `USER_ENTERED`.
- **Calendar**: WIB dates via `wibDateString`; `isDateString`-validated; titles/notes `cleanText`-capped.
- **Notion**: plain `rich_text.text.content` (no markdown/mention object injection possible); labels capped at
  80 chars; at most 10 categories plus 5 fixed blocks, well under Notion's 2000-char/100-children limits; money only via
  `formatMoney`.
- **Slack parser**: input sliced to 4000 chars before any regex; all regexes linear/bounded. Probe: 4000 `<`,
  2000 `:a`, 10 MB input, 1000 amounts → each ≤ 5 ms; drafts capped at `VOICE_BATCH_MAX` (20). The dedupe key
  includes team, channel, `ts` and index, which are validated `[A-Z0-9]{1,24}` / `\d{1,12}\.\d{6}`, so no cross-team/channel
  collision and the key cannot contain `:`. Drafts unique index is per space and source.
- **`is_demo`**: connection rows never enter money totals; demo rows are only created by the dev seed.

## Findings

### L1 (low): Slack entity decoding re-creates mention markup in draft titles
`src/lib/shared/connected-apps/slack-draft-parse.ts:51-57`: `<…>` markup is removed first, and `&lt;`/`&gt;`/`&amp;` are
decoded after that. Slack sends user-typed `<` as `&lt;`, so the text `kopi 25rb &lt;!channel&gt; &lt;@U12345&gt;`
gives the title `kopi <!channel> <@U12345>` (reproduced). Svelte escapes it today, so this is inert. If a future
Slack follow-up echoes a draft title back to Slack (a confirmation reply or a digest), anyone in the channel can
trigger `@channel` pings or mention spam through the bot.
Fix: decode the entities first and then strip `<…>`, or drop `<`/`>` after decoding.

### L2 (low; blocker for the real OAuth build): a person's provider credential outlives their membership
`src/lib/server/spaces/spaces.ts:245` (AC10 "shared space's connections survive"), `src/lib/server/db/schema.ts:940`
(`created_by_user_id` set null). A connection's token is one person's credential (their Gmail, Notion, Slack).
Suppose a member connects their Gmail to a shared space and is then removed, leaves, or deletes their account. The
row and its sealed token stay live, and unattended jobs would keep reading that person's mailbox into a space they
can no longer see. That breaks "account deletion completeness" and "a removed member loses access at once". Not
exploitable this pass, because only synthetic dev-seed tokens exist.
Fix, before any real token is stored: on member removal, leave and account deletion, tombstone (and revoke with the
provider) every connection with `created_by_user_id = user` in every space. For personal-credential providers,
consider allowing a connection only in the connecting user's own personal space, or require its creator to be a
live member before any decrypt.

### L3 (low): no role rule for disconnect in shared spaces
`src/lib/server/connected-apps/repo.ts:57-80`: any live member (Anggota) can disconnect a connection that the Pemilik or
another member made. Disconnect only removes access, so there is no confidentiality impact, but a member can
silently break another person's integration (the audit row records who did it). Decide and document the rule
(creator or Pemilik only), together with the connect-role rule, when "Hubungkan" goes live.

## Checklist (`docs/ENGINEERING_CHECKLIST.md`)
Bounded queries, guarded writes in one `db.batch`, content-free tombstones (CHECK), one access rule with no existence
oracle, untrusted text capped before work and never HTML, CSV/spreadsheet formula guard, masking, sealed-results
primitive (WebCrypto, fresh nonce, wrong-key test): met. The only gap is the L1 entity-ordering nuance.

## Commands run
- `npm ci`, `npx svelte-kit sync`, `npm run db:reset:local`, `npm run build`: ok (`✔ done`).
- `npx vitest run src/lib/server/connected-apps src/lib/shared/connected-apps src/lib/shared/csv test/integration/aplikasi.test.ts test/integration/impor.test.ts --maxWorkers=2`: `10 files, 143 tests passed`.
- Ad-hoc probe test (Slack/Sheets vectors above, then deleted): passed.
- `wrangler dev --port 8846` without `.dev.vars`: seed → 404, disconnect unknown → 404, cross-origin → 403.
  With a local test key + `DEV_ROUTES=1`: seed 200, no token material in `__data.json`/log, B→A disconnect 404, A
  200 → tombstone + 1 audit, repeat 404. Server stopped, `.dev.vars` removed. Full Playwright not run (machine load).
