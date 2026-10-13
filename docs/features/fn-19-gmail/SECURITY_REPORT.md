# Security review: fn-19-gmail (cycle 1)

**Verdict: PASS.** No high or medium finding. Seven low findings are listed below so they can be tracked. L1–L4 were fixed on 2026-10-10 (branch `fix/gmail-lows`, migration 0035). L5–L7: see their resolution notes (2026-10-13).

Reviewed: `git diff integrate/2026-10-10..HEAD` (implementation `f6e95d7`, QA tests `14cffa5`), the PRD
(`docs/features/fn-19-gmail/PRD.md`), the QA report and `docs/ENGINEERING_CHECKLIST.md`. No source code was changed.
The proofs of L1 to L3 come from a temporary integration test, built on the fake Google and the local D1 of
`test/integration/gmail.test.ts`. That test was deleted after the run and is not committed.

## Commands run

- `npx vitest run test/integration/zz-redteam-poc.test.ts` (temporary PoC, deleted afterwards): `Test Files 1 passed (1), Tests 3 passed (3)`. Each test asserts the faulty behaviour, so passing confirms L1, L2 and L3.
- `npx vitest run test/integration/gmail.test.ts test/integration/gmail-qa.test.ts src/lib/server/gmail src/lib/shared/gmail workers/jobs`: `Test Files 6 passed (6), Tests 105 passed (105)`.
- `git status --short` after removing the PoC: clean.

No command reached real Google, Anthropic or remote D1.

## Findings

### L1 (low): disconnect skips pending Gmail drafts whose ledger row has passed the 90-day retention

- Where: `src/lib/server/gmail/repo.ts:217-218`. `deleteConnection` finds the drafts to tombstone through `gmail_mail.draft_id` only. `src/lib/server/gmail/repo.ts:521-524`: `sweepGmail` deletes every `gmail_mail` row with `updated_at` older than 90 days, `draft_created` rows included. Drafts never expire (no draft sweep exists).
- Scenario: a payment mail becomes a draft. The user leaves it pending in Kotak masuk for more than 90 days. The hourly sweep then deletes its ledger row. "Putuskan Gmail" no longer finds the draft, so the draft stays live with its amount and title. This breaks PRD § 8 / AC 36: every pending draft this connection inserted must become a tombstone.
- Repro (PoC R1): connect, check one `bank-qris/payment` mail (1 live draft). Set `gmail_mail.updated_at = now - 91 d`, then run `sweepGmail(db, now)` and the `disconnect` action. The draft still has `deleted_at = null` and `amount_minor` set.
- Why low: no data crosses a user or space boundary. The draft is the user's own, in a space they chose, and it is visible only to members who could already see it.
- Fix direction: keep `gmail_mail` rows that still point at a live pending draft out of the retention delete. Alternatively, mark Gmail drafts with their connection, for example by putting the connection id in the dedupe key namespace.

- **Fixed (2026-10-10, branch `fix/gmail-lows`):** `sweepGmail` keeps a `gmail_mail` row while its draft is pending, so `deleteConnection` always finds it. Test: `test/integration/gmail.test.ts` › red team lows L1–L4 › "L1: disconnect tombstones a pending Gmail draft whose ledger row passed the 90-day retention". The test failed before the fix with `expected [] to deeply equal [ 'old1' ]`.

### L2 (low): account deletion leaves pending Gmail drafts, with their content, in a shared space that stays

- Where: `src/lib/server/auth/delete-account.ts:117-120` deletes the four Gmail tables. Unlike `deleteConnection`, it does not tombstone the drafts first. After the ledger is gone, nothing can link those drafts to the deleted account.
- Scenario: user A routes Gmail into a shared space with B ("Dicatat ke" = shared). A deletes the account. A's pending Gmail drafts (amount, merchant title, WIB date taken from A's mailbox) stay in the shared Kotak masuk, and B can save them as transactions.
- Repro (PoC R2): A is a member of B's shared space and connects with the shared space as target. One check creates one draft. `deleteAccount(A)` returns true, and the draft still has `deleted_at = null` and `amount_minor` set.
- Why low: B could already see these drafts before the deletion. The forwarding path behaves the same today. PRD § 8 does not explicitly require tombstoning on account deletion.
- Fix direction: in the deletion batch, run `discardDraftsWhere` over the account's `gmail_mail.draft_id` before the ledger delete.

- **Fixed (2026-10-10, branch `fix/gmail-lows`):** `deleteAccount` tombstones the account's pending drafts through `gmail_mail.draft_id` and the new `inbound_mail.draft_id` (migration 0035). The forwarding path had the same gap. Both ledger sweeps keep a row while its draft is pending. Forwarded drafts captured before 0035 stay unlinked. Test: `test/integration/gmail.test.ts` › red team lows L1–L4 › "L2: account deletion tombstones the account's pending Gmail and forwarded drafts in a shared space that stays". It failed before the fix with `expected [ …(3) ] to deeply equal [ Array(1) ]`.

### L3 (low): a space purge deletes another user's paused Gmail connection without revoking it at Google

- Where: `src/lib/server/spaces/spaces.ts:271-273` adds `gmail_connections`, `gmail_mail` and `oauth_states` to `SPACE_SCOPED_TABLES`. `purgeSpaces` (`spaces.ts:329`) deletes them by `space_id`, and nobody calls `revokeGmailToken` for that user.
- Scenario: member M routes Gmail into the owner's shared space. M is removed, so the connection pauses with `space_lost`, as designed. The owner then deletes their account, and the shared space is purged. M's connection row, sealed token included, disappears. Google still lists Montra as having Gmail read access. M's page shows "not connected" with no explanation and no "revoke at Google" hint. The disconnect path does show that hint when a revoke fails.
- Repro (PoC R3): as above. After `deleteAccount(owner)`, M's `gmail_connections` row is gone and the fake Google saw 0 revoke calls.
- Why low: the token is destroyed locally, so Montra can never use it again. The only effect is an orphaned grant at Google.
- Fix direction: in the purge, re-point or pause instead of deleting, so M can choose a new "Dicatat ke" or disconnect properly. Another option is to revoke best-effort before the purge.

- **Fixed (2026-10-10, branch `fix/gmail-lows`):** `purgeSpaces` copies the sealed token of every connection in a purged space to the new `gmail_revocations` table (migration 0035), in the same batch. `deleteAccount` also queues the account's own token, so a failed revoke is retried. Each jobs tick, `processGmailRevocations` revokes up to 20 queued grants. A failure is retried for up to 48 ticks, fewest tries first, and any row older than 7 days is dropped, key or no key. The current connection is read again right before each call. A grant that the user's current connection may share (same address, or an address unknown) is dropped without a call. Tests: `test/integration/gmail.test.ts` › red team lows L1–L4 › "L3: a space purge queues another user's paused connection; the jobs sweep revokes it at Google" and "L3: a queued grant is dropped, not revoked, when the user reconnected the same Google account meanwhile", plus "L3: a queued grant older than 7 days is dropped without a call, even while the key is missing". Before the queue was wired, both failed: the drain found nothing (`expected { revoked: 0, dropped: 0, retried: 0 } to match …`).

### L4 (low, QA observation 1): a second completed authorization overwrites the first

- Where: `src/lib/server/gmail/oauth.ts:182-200` (upsert on `user_id`) and `oauth.ts:189` (`coalesce(excluded.google_address, google_address)`).
- Scenario: two tabs both start "Hubungkan" before either finishes. Both states are valid for 10 minutes, and both are bound to the same user and session. Both callbacks complete. The second one replaces the sealed token, the target space and `auto_check`, and the first refresh token is left live and unrevoked at Google. If the second consent was for a different Google account and `users.getProfile` failed for it, the page keeps showing the first mailbox's address while the second mailbox is being read.
- Repro: start connect twice, complete the callback for account X, then for account Y with `/profile` answering 5xx. The row holds Y's token and X's address.
- Why low: every write requires the same user and session plus a live target membership. No other user can drive either step.
- Fix direction: in `completeGmailConnect`, refuse when a `connected` row already exists, or write `excluded.google_address` as is (null when unknown).

- **Fixed (2026-10-10, branch `fix/gmail-lows`):** `completeGmailConnect` stores the address as read, so an unknown address is null and never the previous mailbox's. When the stored grant belongs to another known Google account, the same batch queues it for revocation (see L3). A grant for the same account is not queued, because revoking it would end the new connection. An unknown address is not queued either, because it cannot be told apart. Test: `test/integration/gmail.test.ts` › red team lows L1–L4 › "L4: a second authorization for another Google account revokes the replaced grant; the same account is kept". Before the queue was wired, it failed with `expected … to match { revoked: 1 }`.

### L5 (low): Gmail sender trust depends on the topmost Authentication-Results header

- Where: `src/lib/server/gmail/read.ts:139-149`, using `trustedAuthResults` (`src/lib/shared/inbound/auth-results.ts:99-109`).
- Scenario: when `GMAIL_AUTHSERV_ID` is set (for example `mx.google.com`), mail that reached the mailbox without Gmail prepending its own header can carry a sender-written `Authentication-Results: mx.google.com; dkim=pass header.d=bca.co.id; dmarc=pass header.from=bca.co.id` as its topmost copy. Such mail includes messages added by IMAP APPEND, the Gmail import/insert API or a migration tool. That forged header gives a `verified` capture.
- Impact: only the "Perlu ditinjau" flag is lost. Every capture is still a pending draft, never a transaction, and an attacker cannot put mail into the victim's mailbox through these routes without the victim's access. The RUNBOOK already leaves the variable unset (every capture `unverified`) until a real header has been checked.
- Fix direction: also require Gmail's own `ARC-Authentication-Results`/`Received` evidence, or keep Gmail captures always `unverified`.

- **Resolution (2026-10-13):** ACCEPTED by owner decision (2026-10-13, "Never verified"): Gmail captures always stay tagged for
  review and deletable; there is no verified state. Enforced in `fix(lows): owner decisions for FN-19 L5, FN-20 L2, FN-25b L2, FN-30 L1/L2`: `read.ts` sets every Gmail capture
  `unverified` and no longer reads `Authentication-Results` or `GMAIL_AUTHSERV_ID` (removed from the jobs env,
  RUNBOOK, SELF_HOSTING and `.dev.vars.example`). Test: `test/integration/gmail.test.ts` › "L5 (owner decision
  2026-10-13): a Gmail capture is never verified, whatever its Authentication-Results say" (failed before:
  `verified`, no review flag).

### L6 (low): any outside sender can trigger AI reads on the victim's own Anthropic key

- Where: `src/lib/shared/gmail/query.ts:56` (`subject:(invoice OR receipt OR …)` from any sender) and `src/lib/server/gmail/read.ts:185-189`.
- Scenario: an attacker sends many mails that pass the spam filter, with a payment subject and a figure in the body, from a domain that is not a bank. Each one reaches the AI read with the victim's personal key, and each valid answer becomes an `unverified` draft until the space's draft cap.
- Bounds: 2,000 ids per scan, 3,000 Gmail units per minute per connection, the draft cap, Promotions, Social and Spam excluded, and gateway calls without cache or logs. Forwarding has the same exposure, but there the user picks what to forward.
- Fix direction: put a per-connection daily cap on AI reads, or limit AI reads to allowlisted sender domains and send everything else to `unparsed`.

- **Resolution (2026-10-13):** FIXED in `fix(gmail): cap AI reads per connection per day and re-seal tokens on key rotation`
  (0067ca2, migration 0045). Each connection may make `GMAIL_AI_READS_PER_DAY` (200) AI reads per 24 hours,
  counted by `claimAiRead` in one guarded UPDATE; over it the mail is `unreadable/ai_limit` (it says so on the
  settings page) and "Baca ulang yang tertunda" can queue it again later. Tests: `test/integration/gmail.test.ts` ›
  "L6: over the daily cap the mail is unreadable/ai_limit, the AI is never called, and "Baca ulang" can re-queue
  it" (failed before: the AI was called and a draft created) and "L6: the window resets after 24 hours, and 20
  concurrent claims never pass the cap".

### L7 (low): key rotation cannot re-seal tokens, and an unopenable token cannot be revoked

- Where: `src/lib/server/gmail/crypto.ts` (open with the current or `_PREVIOUS` key only; no re-seal on use), `oauth.ts:221-222` (`revokeGmailToken` answers false when the token does not open). The RUNBOOK notes this.
- Scenario: after a rotation, `_PREVIOUS` is removed before every user has reconnected. Those connections become `needs_reconnect/key`, and "Putuskan" can only delete them locally ("Akses di Google belum bisa dicabut …"). Their grants stay live at Google. After a suspected key leak, rotating does not protect the existing ciphertexts until users reconnect.
- Fix direction: a re-seal job, or re-seal on a successful refresh while `_PREVIOUS` is still present.

- **Resolution (2026-10-13):** FIXED in `fix(gmail): cap AI reads per connection per day and re-seal tokens on key rotation`
  (0067ca2). After Google accepts a refresh token that opened only with `_PREVIOUS`, `resealIfPrevious`
  (`token.ts`) seals it again with the current key, guarded on the nonce it was read with (`updated_at` untouched),
  so removing `_PREVIOUS` later keeps it openable and revocable. Test: `test/integration/gmail.test.ts` › "L7: a token
  opened with _PREVIOUS is re-sealed with the current key, so removing _PREVIOUS keeps it working" (failed before:
  `needs_reconnect/key`). Cycle 2 (red team N4): connections that never refresh (paused, needs reconnect, checks
  off) are re-sealed too, by an hourly jobs sweep without Google (`resealGmailTokens`, `fix(lows): cycle 2: masking, guard and lure normalisation, Gmail re-seal sweep, sliding AI cap, page-level amount mask`; test
  `test/integration/gmail.test.ts` › "N4 (cycle 2): the hourly sweep re-seals connections that never refresh …").
  RUNBOOK › Connected apps › Rotation says when `_PREVIOUS` may go: no `gmail_connections` row left with the old
  `token_key_id`, and 7 days after the rotation for queued revocations.

### Informational (no finding)

- QA observation 3: `days=07` is accepted as 7. `lookbackDaysOf` (`src/lib/shared/gmail/lookback.ts:20-23`) still allows only listed values, and the plan check uses the parsed number. This is not a gate bypass.
- After a long pause ("Periksa otomatis" off, or `needs_reconnect`, which keeps `checked_through`), checks catch up from the old `checked_through`, limited by 20 pages / 2,000 ids. This only covers mail received after the first connection (`checked_through` starts at connect − 1 h), so it does not get around the plan's look-back limit for older mail.
- `CONNECTED_APPS_ENCRYPTION_KEY` now also protects Gmail tokens. The labels are separate, so ciphertexts do not cross over, but one key compromise exposes both (owner decision 3).
- Account deletion revokes before the deletion batch (`src/routes/(app)/pengaturan/akun/+page.server.ts:180-182`). If the batch then fails, the kept connection turns `needs_reconnect` on its next refresh. This is harmless.

## Areas checked and found sound

**OAuth state, PKCE, CSRF**
- The state has 32 random bytes and only its SHA-256 is stored.
- The verifier has 48 random bytes, is S256, and is sealed with AAD = state hash.
- The state row is written only while the target space is a live membership, at most 5 per user, with a 10-minute TTL.
- The callback consumes the state with one `DELETE … WHERE state_hash AND user_id AND session_hash AND expires_at > now RETURNING` (`oauth.ts:109-124`). That makes it single use and bound to both the user and the session. All misses get the same answer.
- `error=` also consumes the state.
- Login-CSRF in either direction (the victim finishing the attacker's state, or the attacker's code landing in the victim's session) fails on the session hash.
- 20 concurrent callbacks are covered by the existing test.

**Redirect URI and Host**
- `redirect_uri` comes from `GOOGLE_OAUTH_REDIRECT_ORIGIN` only. `redirectOrigin` rejects paths, userinfo, raw IPs and plain http outside localhost.
- The callback answers 404 on any other origin.
- The target is the constant `/pengaturan/aplikasi/gmail`. There is no `next`/`return` parameter, so no open redirect.
- The answer is a 303 without a query, with `Referrer-Policy: no-referrer` and `no-store`.
- Nothing from the request goes into the authorization URL. The no-JS link and `window.location.assign` use the URL the server built.

**Token leakage**
- Page data and loaders (`getConnection`) never select token columns.
- The flash cookie holds a code from a fixed list.
- Logs carry only `errorLabel` (error class names) and the queue's type and attempts.
- Google error text is mapped to fixed codes.
- Tokens travel only in POST bodies and the `Authorization` header. Every call uses `redirect: 'manual'` and capped reads.
- The export leaves out the token, nonce, key id, quota, page token, Gmail id and state tables.
- AI Gateway calls send `cf-aig-skip-cache: true` and `cf-aig-collect-log: false`.
- The access token stays in isolate memory for at most 50 minutes, keyed by the seal nonce.

**Refresh-token sealing**
- AES-GCM with Gmail-only labels, AAD bound to (connection id, user id), and a key id per row.
- A tampered, moved or wrong-key ciphertext gives `needs_reconnect/key` and never crashes.
- Rotation: see L7.

**Cross-user and cross-space**
- Every action repeats `user_id = session user`.
- `target`, `connect` and `completeGmailConnect` require `liveMemberOf`, which checks for a live member and a live space.
- Both roles (`owner`, `member`) may create drafts, which matches forwarding.
- Reads check membership of the row's space before calling Google. The draft insert repeats `isLiveMember` and requires the connection to still be `connected`.
- A removed member's connection pauses (`space_lost`) in the fan-out, in the check and in the hourly sweep.
- The QA cross-user test with real ids passes.

**Malicious mail**
- `messages.get` is capped at 2 MB. Parts are capped by depth (8), count (100), headers (200 × 4 KB) and size (512 KB decoded). Errors are caught and give `malformed`.
- Parts that have a filename or an attachmentId are never decoded, and no attachment endpoint exists.
- The AI output is checked with zod, and its amount must be a figure printed in the mail. Account and card numbers are masked before the AI read and in the stored subject.
- There is no `{@html}` in the diff, and Svelte escapes draft text.
- The Gmail query is built from constants and one integer only.
- Spoofed senders only ever make pending drafts. No code path writes a transaction (AC 26 test), and trust is `unverified` unless the trusted header verifies it (see L5).

**Replay and duplicate jobs**
- Scans are unique per (connection, kind, window), so cron overlap and repeated ticks open nothing twice.
- A page advances only through `pages = job.page AND status = running`. Redelivered pages are acknowledged without work.
- Ledger inserts use `ON CONFLICT DO NOTHING` on (connection, gmail_id).
- Reads are guarded on `status = 'listed'`, and the draft dedupe key stops a second draft.
- A read racing a disconnect creates nothing.
- Invalid queue bodies fail the zod check.

**Quota and backoff**
- A guarded per-connection budget of 3,000 units per minute.
- Gmail's backoff on 429, rate-related 403 and 5xx (max 64 s), with `check_after` hold-off.
- 3 queue retries, then the DLQ. A scan stuck for 6 hours is marked failed.
- User triggers are throttled: `gmail-connect` and `gmail-scan` allow 10 per window and fail closed. "Periksa sekarang" is limited to one per 5-minute bucket, look-backs to 3 per day with one running.

**Disconnect**
- Revoke first, then one batch whatever the revoke result: tombstone pending drafts, then delete the ledger, scans, states and the connection.
- Transactions and forwarding drafts stay (test passes).
- Gaps: L1 and L7.

**Account deletion**
- Revoke first, best effort, then delete all four tables by `user_id` (test passes).
- Gaps: L2 and L3.

**invalid_grant**
- The connection goes to `needs_reconnect/revoked`, drops out of the fan-out, and nothing loops. Reconnecting reuses the same row.

**Look-back plan gate**
- Only listed values are accepted. The server re-reads the plan (403 on Gratis for more than 7 days, no scan row).
- The worker clamps `days`/`after_s` again on page 0, so a plan that lapses in between is honoured.
- Forged values were tested by QA.

**Engineering checklist**
- None of `inArray`, `LIKE`, `parseFloat`, `startsWith('/')` redirects or `unsafe-inline` appears in the diff.
- All 8 actions call `readFormBody` first.
- Deletes are bounded by subqueries, and sweep steps are capped at 200 rows.
- i18n entries are present and `csp.ts` is untouched.
