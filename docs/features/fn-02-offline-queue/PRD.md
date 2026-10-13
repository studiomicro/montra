# FN-02 — Storage and offline write queue, server-first like the earlier project

Full design: `docs/superpowers/specs/2026-10-08-fn-02-offline-queue-design.md`.
Implementation plan: `docs/superpowers/plans/2026-10-08-fn-02-offline-queue.md`.
Risk tier: **Large**. No D1 migration.

## Goal

D1 stays the only working copy (owner decision 2026-10-07, `CLAUDE.md`): there is no guest mode and no local-first
IndexedDB sync in this pass. What the owner did ask for is an **offline write queue**: on a flaky mobile connection
— the exact condition the main journey's "record by voice" and "edit a transaction" steps run under — a signed-in
device should queue the small set of idempotent personal writes instead of losing the tap, and drain them once the
network returns, without ever creating a duplicate row or silently discarding data at sign-out.

## Scope

- `src/lib/shared/offline-queue.ts`: queue item schema and types (shared, no DOM dependency).
- `src/lib/ui/offline-queue/`: IndexedDB store (`db.ts`, `store.svelte.ts`), drain loop with backoff (`sync.ts`),
  best-effort cross-tab lock (`lock.ts`), `OfflineBadge.svelte`, `PendingSheet.svelte`.
- `src/routes/api/v1/sync/push/+server.ts` + `src/lib/server/sync/push.ts`: one dispatcher endpoint mapping a
  queued item to the existing `createTransaction`/`updateTransaction`/`deleteTransaction`
  (`src/lib/server/transactions/repo.ts:245-376`) or voice save/`recordAgain`/`urungkan`
  (`src/lib/server/transactions/voice.ts`, called from `src/routes/(app)/riwayat/suara/+page.server.ts:104-173`).
- `src/lib/server/transactions/repo.ts`: `createTransaction`/`insertTransactions` accept a caller-supplied id so a
  resent `clientId` is idempotent (no new migration — reuses `bumpSpaceSeq`/`currentSpaceSeq`,
  `src/lib/server/sync/seq.ts`).
- Wiring into `src/routes/(app)/riwayat/baru/+page.svelte`, `.../[id]/edit/+page.svelte`, `.../suara/+page.svelte`:
  enqueue on a network failure or while `navigator.onLine` is false; pending/sending/failed UI states.
- Sign-out gate in `src/routes/(app)/pengaturan/akun/+page.svelte`: a non-empty queue must be confirmed away before
  `signOut` runs (closes `docs/TASKS.md:114`); `deleteAccount` is unaffected.
- i18n: `src/lib/shared/i18n.ts` message constants + `src/lib/shared/i18n-en.ts` entries for every new string
  ("Menunggu koneksi", "N perubahan menunggu", failed-reason strings, sign-out confirmation).

Queued writes: transaction create, edit, delete; voice quick-entry save, "Catat lagi", "Urungkan". Nothing else.

## Out of scope

- Guest mode; full local-first IndexedDB working copy and multi-device pull/cursor sync
  (`docs/ARCHITECTURE.md` "Local-first sync (FN-02)" section) — both stay deferred.
- Queuing wallets, categories, budgets, goals, net worth, subscriptions, belongings/collectibles writes.
- Auth, billing/plan, invites, account deletion, exports, any AI capture path — always online-only, never queued.
- A server-side `/api/v1/sync/pull` endpoint or change-log cursor.
- Background Sync API registration (not supported on the PWA's iOS Safari target).

## Acceptance criteria

1. Given the device is offline, when the user submits "Simpan" on `riwayat/baru`, then the transaction is not
   lost: the UI shows "Menunggu koneksi" (never "Tersimpan"), and the item persists in IndexedDB across a reload.
2. Given a queued create item whose `clientId` is later resent (retry after an ambiguous network failure), when
   the server processes it twice, then exactly one transaction row exists (`insertTransactions` idempotency,
   verified with 20 concurrent identical requests per `docs/ENGINEERING_CHECKLIST.md` pre-handoff probe).
3. Given the device comes back online with N queued items, when the drain loop runs, then each item is sent
   through `src/routes/api/v1/sync/push`, success is shown only after the server's `ok` response (never
   optimistically before), and the badge/pending count reaches zero only once every item is confirmed.
4. Given a queued edit whose `expectedUpdatedAt` no longer matches the row (another device wrote first), when the
   push endpoint runs `updateTransaction`, then it returns `stale`, the row is unchanged, and the UI shows
   "Perubahan ditolak — transaksi sudah berubah di tempat lain" — never a silent overwrite, never a merge.
5. Given a queued item targets a transaction the user's session no longer has access to (removed from the space,
   or the space deleted), when the push endpoint runs `requireSpaceAccess`, then it answers 404 with the same
   body/timing as any other not-found case (no existence oracle) and the item is marked failed, not retried
   forever.
6. Given the session expires while items are queued, when the drain loop next runs, then every pending item
   surfaces "Sesi berakhir. Silakan masuk kembali." and auto-retry pauses until re-sign-in; after re-sign-in as
   the **same** account the queue drains; after sign-in as a **different** account on the same device, the first
   account's queued items are never sent or shown to the second account.
7. Given a non-empty queue, when the user taps "Keluar" (sign out), then a confirmation naming the pending count
   is shown before the existing `signOut` action runs; cancelling keeps the session and the queue intact;
   confirming proceeds and still sets `Clear-Site-Data: "cache", "storage"` exactly as today
   (`src/hooks.server.ts:86-88`).
8. Given the user deletes their account with items queued, when `deleteAccount` runs, then it proceeds without the
   sign-out confirmation (the account's data is being removed regardless).
9. Given two browser tabs of the same signed-in device, when both come online with items queued, then the queued
   items are each sent exactly once (not once per tab) — or, if cross-tab locking is unavailable, the server-side
   idempotency in criterion 2 still prevents a duplicate row.
10. Given a queued item's `spaceId` is the space active when it was created, when the user has since switched to
    a different space and the item drains, then it is still applied to its original `spaceId`, re-validated by
    `requireSpaceAccess` for that space, never applied to the currently active space.
11. Given JavaScript is unavailable, when the user submits `riwayat/baru`, `.../edit`, or `.../suara` forms, then
    behaviour is byte-for-byte the same as before this feature (direct POST, no queue involvement) — a Playwright
    run of the existing no-JS specs for these three routes passes unmodified.
12. Given a cross-origin JSON POST to `/api/v1/sync/push`, when it is sent without a matching `Origin`, then the
    endpoint refuses it (CSRF/origin check) before touching the database.
13. Given every string this feature adds ("Menunggu koneksi", pending/failed messages, sign-out confirmation),
    then each has an English entry in `src/lib/shared/i18n-en.ts` and the existing i18n completeness test passes.
14. Given a transaction amount or date is shown anywhere in the new UI (pending sheet, failed reason), then money
    is formatted with the shared formatter (never hand-formatted, integer minor units throughout) and dates use
    the WIB `occurred_on` convention, matching every other screen.
15. Given `npm run gates` (check, lint, test, build) is run after the change, then it is clean, and the Vitest
    file for `insertTransactions`/the push endpoint includes a fail-before-fix regression test for criterion 2
    shown failing on the pre-change code.

## Architecture notes

- Server: `src/lib/server/transactions/repo.ts` (id-accepting create, lines 245-263), `src/lib/server/sync/seq.ts`
  (`bumpSpaceSeq`/`currentSpaceSeq`, unchanged, reused), `src/lib/server/spaces/current.ts` /
  `src/lib/server/spaces/access.ts` (unchanged authorization gate, reused per item), `src/lib/server/transactions/
  voice.ts` (unchanged dedupe), new `src/lib/server/sync/push.ts` dispatcher, new route
  `src/routes/api/v1/sync/push/+server.ts`.
- Shared: new `src/lib/shared/offline-queue.ts`.
- Client: new `src/lib/ui/offline-queue/*`; edits to `src/routes/(app)/riwayat/{baru,[id]/edit,suara}/+page.svelte`
  and `src/routes/(app)/pengaturan/akun/+page.svelte`.
- i18n: `src/lib/shared/i18n.ts` message tables, `src/lib/shared/i18n-en.ts`.
- No migration. No Worker other than the existing app Worker is touched (no Queues/Workflows involvement — this
  is a client-side retry queue, not a server job).

## Prerequisites

No new provider credentials. Existing session/cookie auth is reused. Playwright offline-mode specs need Chromium
system libraries installed locally (`sudo npx playwright install-deps chromium`, open item
`docs/TASKS.md:36-37`) to actually run — until then those specific tests cannot be reported as passed.

## Owner decisions

| Decision | Proposed default |
| --- | --- |
| Encrypt the IndexedDB queue payload with the FN-21 account key? | No — local retry buffer, seconds-to-minutes lifetime, device assumed to be the user's own signed-in device; revisit only if red team finds a concrete risk. |
| Client id scheme for queued creates: UUIDv4 (matches current `newId()`) or UUIDv7 (as `docs/ARCHITECTURE.md` sketches for the later full-sync design)? | UUIDv4 now, for consistency with today's code; decide once, together, if/when full local-first sync is built. |
| Queue item cap per account | 200 items; past that, enqueue is refused with a message asking to reconnect rather than failing silently. |
| Stale queue item age before requiring explicit user action | 7 days. |
| Does account deletion get the same "pending changes" confirmation as sign-out? | No — deletion removes the account's data regardless, so queued items are moot. |

## Tracker impact

Closes `docs/TASKS.md:50-51`: "**Claude** — FN-02 Storage and offline write queue, server-first like the earlier project
(decided 2026-10-07; guest mode and local-first sync deferred). Spec first. Risk: Large." (spec now delivered;
this PRD carries it into implementation).

Also closes the deferred item `docs/TASKS.md:114`: "Revisit `Clear-Site-Data: 'storage'` on sign-out before any
IndexedDB working copy (FN-02 local-first) lands" — via acceptance criterion 7.

`docs/ACCEPTANCE.md` has no existing row for FN-02 specifically (it is not in the "Required journey" table, which
covers guest mode and multi-device sync — both deferred). This PRD does not move any existing `docs/ACCEPTANCE.md`
row; once implemented, add a new row under a "Sync" section with the checks named in Acceptance criteria 1-15
above, Automated/Browser per criterion, not Pass (no external provider involved).
