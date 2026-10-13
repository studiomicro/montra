# FN-02 offline write queue — security report

Reviewer: red-team-pentester, 2026-10-08. Scope: `git diff main...fn-02-offline-queue` (head 57f94c9), checked
against `docs/ENGINEERING_CHECKLIST.md`. Read-only worktree `.claude/worktrees/rt-02`.

## Verdict: PASS

No medium or high findings. Four low findings are listed below so they stay tracked.

## What was checked and held

- **Origin** (`src/routes/api/v1/sync/push/+server.ts:23`): exact match against `url.origin`. A missing Origin,
  `null`, `HTTP://LOCALHOST`, `http://localhost:80`, `http://localhost.evil.example` and a cross-site origin all
  get 403 (probe). There is no Referer fallback, which is the right call. The check runs before the session is
  read, and the site host is a different origin, so it is refused.
- **Session**: `locals.user` only. 401 `session` comes before any body read. The user id is never taken from the
  client: `accountId` is dropped by the zod schema.
- **Body**: content-type must be `application/json` (415), the body is capped at 32 KiB through `readRawBody` with
  a timeout (413/408), and bad JSON gets 400. A 16k-deep array, a 5k-deep object and `__proto__`/`constructor`
  keys all came back as 400 or a clean 200, with no 500 and no prototype pollution (probe). `payload` is an array
  of `[name, value]` tuples, which are prototype-safe.
- **Kinds allowlist**: `z.enum(QUEUE_KINDS)` has 5 kinds. Adjustments, recurring series, billing, invites,
  deletion and auth cannot be queued:
  - A create cannot produce `type=adjustment`.
  - An update or delete of an adjustment is refused.
  - `recurring_series_id`, `is_demo`, `source` and `dedupe_key` are not form fields. A create always uses source
    `manual` and voice uses `voice`; existing tests cover this and I re-read the code.
- **Per-item space re-authorisation**: `requireSpaceAccess(db, session user, item.spaceId)` (`push.ts:164`) runs
  before any payload id is read. A removed member, a foreign space and an unknown space all get the same 404
  `no-access`. All wallet, category, target and voice-source ids are then looked up inside that space only.
  Probes:
  - A foreign wallet, category or transfer target in a create returns `invalid`.
  - An update that moves an own row to a foreign wallet returns `invalid`.
  - A voice row with a foreign wallet returns `invalid`.
  - `voice.recordAgain` of a foreign row returns `missing`.
  - Nothing is written to the other space.
- **Roles**: same as the page actions (members may write transactions; no owner-only kind is queueable).
- **Client-supplied ids**: lowercase UUID regex only (an uppercase one is refused, probe). The `NOT EXISTS` guard
  is global (`client-id.ts:26`), so a create can never overwrite or adopt another space's row; that case reads as
  `gone`. A resend never changes the first write and never recreates a tombstone.
- **Idempotency and replay**: `clientId` is the row id, and the voice dedupe key is unique per space and source. A
  voice key reused across spaces still writes in the caller's own space (probe). Replaying another user's item
  needs that user's session, because the item's space is re-checked for the replaying user.
- **`expectedUpdatedAt`**: this is conflict detection, not authorisation. A client sending the current value gets
  the same result the online form gives.
- **Oracles**: a missing target and another space's target give one answer (404 `missing`). `no-access` covers
  "no space" and "not a member" together.
- **D1 cost**: about 3–6 queries per item, plus one batch. Voice is capped at 20 rows and uses one
  `listWallets`/`listCategories`. This is far below 1,000 per invocation.
- **Client**:
  - IndexedDB holds only the form fields, the summary, `accountId` and `spaceName`. No token, password or key
    material.
  - Records are re-validated with zod on read and filtered by `accountId`. Another account's items are discarded
    at start.
  - Sign-out clears the queue and sends `Clear-Site-Data: "storage"`; account deletion also clears it.
  - BroadcastChannel messages only trigger a re-read or a drain, and their content is ignored, so spoofing a
    message achieves nothing beyond a refresh.
  - The Web Lock is only an efficiency measure; correctness rests on server idempotency.
  - No `{@html}` was added. Queued text and the server `message` render escaped. `reopenHref` uses
    `encodeURIComponent`.
- **CSP and service worker**: unchanged. The service worker leaves `/api/*` untouched and never caches it.
- **Logging**: the diff adds no `console.*`. Unexpected errors go through `handleError` (route plus `errorLabel`
  only).

## Findings

### L1 (low): a stale tab of account A can push A's queued item under account B's session
`src/lib/server/sync/push.ts:164`, `src/lib/ui/offline-queue/runtime.svelte.ts:28`.

The wire body does not carry the account the item was queued for, and the queue does not listen to the
`signed-out` broadcast (`announceSignOut`). Scenario on a shared device:

1. Tab 1 is a loaded page of A. A's session ends (it expires, or A signs out in tab 2).
2. A's page in tab 1 still enqueues a write, or still holds a pending one, and has not yet seen a 401.
3. B signs in in tab 2, which shares the cookie jar.
4. Tab 1 drains, and the POST carries B's cookie.

If A and B share a space, the item is written there with B as its author. In A's personal space it returns 404
`no-access`, so nothing leaks. Tab 2 discarding A's items at its own start narrows this but does not close it,
because tab 1 can still enqueue afterwards.

Fix: send `accountId` in the push body and answer 401 `session` when it differs from `locals.user.id`. Also stop
the queue on the `signed-out` broadcast.

### L2 (low): a queued `voice.save` / `voice.recordAgain` may be backdated to any date from 2000-01-01
`src/lib/server/sync/push.ts:88-90`, `src/lib/shared/offline-queue.ts:57`.

The online voice actions always date rows today (WIB). Through push, the client's `occurredOn` is used whenever it
is earlier than today. Probe: `occurredOn: '2000-01-01'` gives `ok` and a row dated 2000-01-01. This grants no
privilege the compose form lacks (which also accepts any valid date), but it breaks parity with the "same checks
as the page action" claim.

Fix: optionally bound it, for example to at most `QUEUE_STALE_MS` plus a day before the server date.

### L3 (low, owner-accepted): queued financial text stays in unencrypted IndexedDB after a session ends without sign-out
`src/lib/ui/offline-queue/db.ts:4-8`.

After a session expires, is revoked remotely or the password is changed, this device keeps the items until
someone signs in on this browser again or the browser storage is cleared. Recording it so that FN-02 parity with
the "short-lived retry buffer" decision is tracked. A future option is to drop items when `sessionStillSignedIn`
answers false.

### L4 (low): no per-user rate limit on `/api/v1/sync/push`
`src/routes/api/v1/sync/push/+server.ts`.

This matches the existing form actions. The 32 KiB body cap, one item per request, the per-space transaction cap
and the 3–6 D1 queries per request bound the damage. A signed-in client can still hammer the endpoint to burn D1
reads and writes. This should be covered when a global limiter is added.

## Engineering checklist
- Data access: no `inArray` with a growing list, bounded queries, and a guarded single-statement insert (20
  concurrent creates tested). OK.
- Access: every query goes through `requireSpaceAccess`, with one answer for hidden and missing ids. OK.
- Form bodies: capped, 400/413/415, never 500, prototype-safe. OK (probed).
- Truthful state: an item leaves the queue only on the server's `ok`. OK.
- Sync, one validator: push reuses `readTransactionForm`, `checkVoiceRows`, `recordAgain`, `updateTransaction` and
  `deleteTransaction`. The only deviation is the voice day (L2).
- Pre-handoff probes: cross-space as a non-member and as a removed member, concurrency at 20, two tabs (lock plus
  idempotency), and WIB voice-day boundaries are covered by tests.

## Commands run
- `flock … npx vitest run --maxWorkers=2 test/integration/zz-rt-probe.test.ts`: 14 passed (7 red-team probes plus
  the copied setup). The temporary probe file was deleted afterwards.
- `flock … npx vitest run --maxWorkers=2 test/integration/sync-push.test.ts src/lib/shared/offline-queue.test.ts
  src/lib/ui/offline-queue/store.test.ts`: 3 files, 58 tests passed.
- `npm run gates` / `npm test`: not run (RAM rule).
