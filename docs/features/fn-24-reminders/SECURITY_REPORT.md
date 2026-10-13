# FN-24 Notifications and reminders: security report (cycle 1)

Reviewed commit `5af42ac` against base `9c77de9` (`git diff 9c77de9..5af42ac`). Risk tier Medium. Narrow review
of background jobs, notifications and push. No source changes made.

## Verdict: PASS

No critical, high or medium findings. Five low findings are listed below so they are tracked.

## What was checked and held

- **Idempotency under replay and concurrency.** `createIfAbsent` (`src/lib/server/notifications/repo.ts:65-110`)
  is one `INSERT … SELECT … WHERE` with `ON CONFLICT DO NOTHING` on the unique `(user_id, kind, data_key)` indexes
  (`migrations/0012_notifications.sql:43,61`). It has no `deleted_at` condition, so a dismissed key never comes
  back. Push delivery claims `(notification_id, subscription_id)` (the primary key, `0012:7`) before it sends.
  Live probe: 5 and 8 concurrent cron ticks, each with queue fan-out, left exactly one `budget_80` per member and
  one `daily_nudge` per user.
- **Queue message validation.** zod discriminated union with ids up to 64 characters and `isDateString` dates
  (`src/lib/shared/jobs.ts`). Messages carry ids and dates only. An invalid message gets `retry()` and reaches
  the DLQ after `max_retries: 3`. The switch is exhaustive (`never`). Logs hold only `type`, `attempts` and
  counts, never bodies (`workers/jobs/src/queue.ts:43-80`). The probe log held no figures, ids or params.
- **No amplification loop.** The jobs Worker produces only into its own queue. `budget_check`, `daily_nudge` and
  `weekly_summary` enqueue at most one `send_push` per row: at most 5 members per space, re-enqueued only when
  `attempts > 1`, and the queue caps retries at 3. `send_push` enqueues nothing. The cron is capped at 100 pages of
  100 per kind per tick.
- **Cross-space and removed-member leakage.** Membership is checked when a row is created (`isLiveMember` in the
  insert, `liveMemberIds` with active accounts only) and again when it is read: the list and unread count use
  `stillMember` (`repo.ts:134-136`), push uses `pushTarget` (`repo.ts:311-327`), and open/dismiss use
  `requireSpaceAccess` plus `isLiveMember` in the update. Live probe: a member removed before the space crossed
  100 % got no `budget_100`, and a non-member got no budget row.
- **IDOR.** `findOwned` and `changeNotification` are scoped by `user_id = locals.user.id`. Another user's id, an
  unknown id and a row from a space the user left all get the same `404 Not found`. Preferences are keyed only
  on `locals.user.id`, and `kind` is checked against an allowlist (`pengaturan/notifikasi/+page.server.ts:146-155`).
  The `open` redirect goes through `safeReturnTo(notificationUrl(...))`, where `goalId` must match `^[0-9a-f-]{1,64}$`.
- **Rendering.** No `{@html}` in the new or changed Svelte files. Space names and goal names (user-controlled, 60
  characters at most) reach the page and the push only as text.
- **Push transport.** Subscriptions come only from the recipient's live sessions (`listActiveSubscriptions`). No
  VAPID keys means nothing is sent. Nothing is sent 00:00–05:59 WIB, and a tick in that window enqueues nothing
  (probe at 03:00 WIB: `budgets: 0, nudges: 0`). The changes to `push/encrypt.ts` and `push/send.ts` are
  type-only (byte copies and a `deriveBits` cast). The RFC 8291 Appendix A byte-for-byte vector test still asserts
  and passes.
- **Deletion.** `deleteAccount` deletes the user's `space_notifications`, `user_notifications`,
  `notification_prefs` and `notification_deliveries` in the same batch (`src/lib/server/auth/delete-account.ts`).
  `space_notifications` is in `SPACE_SCOPED_TABLES`, so purged spaces lose every member's rows. A dismissed row is
  a content-free tombstone, enforced by a CHECK constraint (`0012:40,58`).
- **No AI, no SSRF.** No new outbound host: push endpoints keep FN-13's push-service allowlist. No raw SQL
  interpolation: every `sql` template binds its values as parameters.

## Findings

1. **Low: a push can be sent twice if recording the delivery fails after a successful send.**
   `src/lib/server/notifications/triggers.ts:257-264`. `finishDelivery` runs inside the same `try` as
   `sendPushNotification`. If D1 fails after the push service accepted the message, the `catch` releases the claim
   and the queue retries, so the same device gets the push a second time. A crash between send and finish has the
   same result once the 5-minute stale claim (`repo.ts:25,354`) is taken over. Exploit: none for an attacker; this
   is an at-least-once duplicate. Fix: move `finishDelivery` out of the send `try`, and on its failure log without
   releasing the claim.
2. **Low: a push can be lost when a retry finds a fresh claim.** `triggers.ts:256` and `repo.ts:343-359`. If an
   attempt dies while holding a `sending` claim and the queue retries within 5 minutes, `claimDelivery` returns
   false. The handler skips that device, returns `delivered` and acks the message, so that device never gets the
   push. The in-app row stays. Fix: when the claim is held by someone else, count it as not done and retry with
   `delaySeconds` longer than the stale window, instead of acking.
3. **Low: the cron stops at a fixed cap and starts from the beginning on every tick.** `workers/jobs/src/cron.ts:23,39-50`.
   `walk` starts at `after = ''` on every tick and stops after 10,000 ids. Spaces past the 10,000th id are never
   budget-checked. Users past the 10,000th never get the nudge or weekly summary, because those run on one tick
   only. The comment "the rest waits for the next tick" is wrong. This affects availability and correctness, not
   confidentiality. Fix: keep a cursor per kind and day (in KV or D1), or fan out page messages through the queue.
4. **Low: rows of a removed member keep the space's figures.** `repo.ts:65-110` and `triggers.ts:96,129-137`.
   Budget rows store `spentMinor` and `budgetMinor`, and goal rows store the goal `name` and amounts. After the user
   leaves or is removed, the rows are hidden on every read path, but they stay in D1 under the user's id until the
   space is purged or the user deletes the account. Nothing serves them, so there is no exposure, but the shared
   space's data outlives the membership. Fix: tombstone the leaving user's `space_notifications` for that space
   in the leave/remove batch. This fits the planned retention pass (owner decision 7).
5. **Low (accepted by the PRD, tracked): money figures appear on the lock screen.** `src/lib/shared/notifications.ts:208-254`.
   Budget, goal and weekly pushes show amounts in rupiah and the shared space or goal name on the lock screen. The
   PRD's goal accepts this, and the payload is encrypted end to end (RFC 8291), so the push service cannot read
   it. There is no "hide amounts on the lock screen" option. Also untracked: no retention for notification rows,
   so daily nudge rows grow by one per active user per day. Fix (later): an option for push text without amounts,
   and a retention sweep.

Informational: `deliverPush` does not re-check `notification_prefs` when it sends. A kind turned off after its row
was created can still push once. Creation itself is correctly gated (acceptance criterion 6).

## Engineering checklist

- Idempotent capture: met (unique index, guarded insert, delivery claim, replay probe).
- Space isolation on every load, action and push: met (create-time and read-time membership, same 404 for any
  unknown or foreign id).
- Bounded queries: met. The list is capped at 50, unread counts at 100, cron pages at 100, members at 5 and
  subscriptions at `SUBSCRIPTIONS_MAX`. Starvation past the cron cap is finding 3.
- No secrets or PII in logs or loaders: met. VAPID public key only, endpoint hashes only, logs carry counts and
  status only.
- Content-free tombstones: met (CHECK constraint).

## Commands run (worktree at 5af42ac)

- `npm ci`, `npx svelte-kit sync`, `npm run db:reset:local`: OK.
- `npx vitest run --maxWorkers=2 test/integration/notifications.test.ts src/lib/shared/notifications.test.ts
  workers/jobs/src/cron.test.ts workers/jobs/src/queue.test.ts src/lib/server/push`: 6 files, 67 tests passed
  (includes the RFC 8291 vector).
- Live probe: `wrangler dev -c workers/jobs/wrangler.jsonc --test-scheduled --port 8831` on a scratch local
  persist dir with migrations 0001–0012 applied. The data was users A, B and C; a shared space holding A and B;
  a budget of Rp 1.000.000; and spending of Rp 850.000.
  - 5 concurrent ticks at 07:00 WIB, then 8 concurrent ticks at 08:00 WIB: one `budget_80` for each of A and B,
    none for C, and one `daily_nudge` per user.
  - B removed and spending raised to Rp 1.050.000, then 3 concurrent ticks: a `budget_100` for A only.
  - A tick at 03:00 WIB enqueued nothing.
  - The log held no figures or ids.
  - Server stopped.
- Not run: the full Playwright suite (the machine is loaded, as instructed) and a real push service (no VAPID
  keys).
