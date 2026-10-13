# FN-02 Offline write queue — engineer report (cycle 1)

Branch `fn-02-offline-queue` from `0c3105f`. WIP commits `task 1` … `task 14`, then `cycle 1`. No migration. Owner
defaults applied: queue not encrypted, UUIDv4 client ids, 200-item cap, 7-day stale threshold, no extra
confirmation on account deletion. New dev dependency: `fake-indexeddb@6.2.5` (Vitest only).

## Per task

1. **Shared schema** `src/lib/shared/offline-queue.ts`: five kinds (`transaction.create|update|delete`,
   `voice.save`, `voice.recordAgain`), zod schemas for the wire body (`parsePushRequest`) and the stored item
   (`parseQueueItem`); payload is a list of `[name, value]` pairs (prototype-safe), ≤ 128 fields, values ≤ 2048;
   update/delete need `targetId` + `expectedUpdatedAt`, voice needs `occurredOn`. Constants: cap 200, stale 7 d,
   body 32 KiB. Tests: `offline-queue.test.ts` (14).
2. **Caller-supplied id.** `repo.ts` change for the FN-36 rebase, exactly: `createTransaction` gained a trailing
   optional parameter `id: string = newId()` (the `const id = newId()` line moved into it). `insertTransactions`
   is untouched. The idempotent path lives in new `src/lib/server/transactions/client-id.ts`
   (`createTransactionOnce`: guard `NOT EXISTS (id)` inside the same insert; nothing inserted + row with this id in
   this space (live or tombstoned) → `ok`, first write authoritative, deleted rows never recreated; id taken in
   another space → `gone`). Fail-before: with the guard removed 5 of 7 tests fail with
   `UNIQUE constraint failed: transactions.id` (run shown in the session); with it 7/7 pass.
3. **Endpoint** `src/routes/api/v1/sync/push/+server.ts` + `src/lib/server/sync/push.ts`. Order: `Origin` must
   equal the request origin (403, before any DB work; SvelteKit 3.0.1's `is_csrf_forbidden` only covers form
   content types — verified in `node_modules/@sveltejs/kit/src/runtime/server/csrf.js`) → session (401
   `session`) → `application/json` (415) → `readRawBody` 32 KiB (413) → JSON (400) → schema (400) →
   `requireSpaceAccess(user, item.spaceId)` (404 `no-access`, one answer for foreign/non-existent/left space) →
   the same functions the page actions call (`readTransactionForm` + `createTransactionOnce` / `updateTransaction`
   / `deleteTransaction`, `checkVoiceRows` + `saveVoiceTransactions`, `recordAgain`). Balance adjustments: never
   created (form type list) and refused for update/delete (`invalid`, "online only").
4. **Response contract** `{ clientId, result, message? }`, statuses ok 200 / invalid 400 / session 401 /
   missing, no-access 404 / stale, limit, gone 409; voice `duplicate` maps to `ok` (already applied). Every result
   reached through the endpoint in `test/integration/sync-push.test.ts` (33 tests incl. WIB boundary vectors).
5. **IndexedDB store** `src/lib/ui/offline-queue/db.ts` (`financer-queue` v1, `items` by `clientId`, index
   `byAccount`), `store.svelte.ts` (`OfflineQueue`: enqueue/list/confirm/remove/markSending/markPending/
   markFailed/retry/clear/discardOtherAccounts, BroadcastChannel refresh). Tests `store.test.ts`.
6. **Cap** 200 per account, counted and added in one readwrite IDB transaction (exact under 20 concurrent
   enqueues from two stores); refusal `full` → `QUEUE_FULL` message, nothing dropped.
7. **Drain loop** `sync.ts` (`Drainer`, `classify`, `backoffDelay`): FIFO per target, ≤ 4 targets in flight,
   backoff 2/4/8/16/30 s full jitter on network errors / 0/408/429/502/503/504 / non-JSON 200, 401 pauses the whole
   queue, other answers fail with the server's message, stale items wait for the user. Tests `sync.test.ts` (13).
8. **Cross-tab** `lock.ts` (`navigator.locks` `financer-queue-drain`, `ifAvailable`; in-tab fallback). Browser
   support taken from MDN knowledge (Baseline 2022), **not re-checked online in this session**. Tests:
   `lock.test.ts`; `test/integration/offline-drain.test.ts` proves two lock-less tabs really send duplicates and
   the server still writes each row once.
9. **UI** `OfflineBadge.svelte` (pill: "Menunggu koneksi · N menunggu", "Mengirim N perubahan…", "N perubahan gagal
   dikirim", session ended, "N perubahan tersimpan." only after server `ok`), `PendingSheet.svelte` (reuses
   `Sheet`; per item kind, title · shared `formatMoney`, state/reason, "Kirim lagi" / "Buka transaksi" for a
   failed edit/delete / "Buang"; "Semua tersinkron" when empty; space named when not the current one),
   `OfflineQueueStatus.svelte` in `(app)/+layout.svelte`, `runtime.svelte.ts`. Layout data gains
   `queue: { accountId, spaceId, spaceName }`. Tests `components.test.ts` (SSR render, id + en).
10. **riwayat/baru**: enhanced form adds a per-view `clientId` to the POST; the `create` action uses
    `createTransactionOnce` when it is a UUID (no-JS posts unchanged). Queued when `navigator.onLine` is false or
    the action result is `error` without status (no answer); server answers (400/401/409/500) never queued. The
    adjustment form keeps its own online-only submit. Tests `test/integration/offline-forms.test.ts`.
11. **riwayat/[id]/edit**: update/delete queued with the loaded `updatedAt`; afterwards the forms give way to the
    "Menunggu koneksi" note (no second conflicting change). Adjustments never queued.
12. **riwayat/suara**: save (dedupe `key` unchanged in the payload, `occurredOn` = device WIB date, clamped by the
    server to its WIB today), Catat lagi (fresh tap key), Urungkan (delete with the confirmed `updatedAt`).
13. **Sign-out gate** in `pengaturan/akun`: non-empty queue → inline confirmation with the count; Batal keeps
    session and queue; "Tetap keluar" submits the unchanged `signOut` action; after the server's redirect the
    queue is cleared explicitly (Clear-Site-Data still sent by the server). `deleteAccount`: no gate, queue cleared
    after the redirect. Closes the deferred `docs/TASKS.md:114` item (tracker not edited).
14. **Verification**: `e2e/offline-queue.spec.ts` (9 tests × phone/desktop), probes below.

## Acceptance criteria

| # | Status | Evidence |
| --- | --- | --- |
| 1 | Pass (browser) | e2e "offline create": "Menunggu koneksi", no "tersimpan", 1 item in IndexedDB; store test survives reload. A real page reload while offline was not exercised (SSR page needs the network). |
| 2 | Pass (automated) | `sync-push.test.ts` 20 concurrent creates / pushes → 1 row; fail-before shown. |
| 3 | Pass | `sync.test.ts` "leaves the queue only after ok"; e2e badge "1 perubahan tersimpan." after online. |
| 4 | Pass | endpoint stale test; e2e two-device edit → failed "Berubah sejak terakhir dimuat…", amount stays 40.000. |
| 5 | Pass | removed-member and foreign-space tests: 404 `no-access`, same body as a non-existent space, not retried. |
| 6 | Pass | drain integration + e2e: 401 pauses with "Sesi berakhir…", same account re-sign-in drains; other account: items discarded on start, never sent (integration). |
| 7 | Pass (browser) | e2e sign-out: confirmation with count, Batal keeps session/queue, Tetap keluar → `/masuk`, queue 0. Clear-Site-Data header unchanged (server code untouched). |
| 8 | Pass (browser) | e2e account deletion with a queued item → `/akun-dihapus`, queue 0. |
| 9 | Pass | e2e two tabs: 1 push request; integration: lock-less duplicates still one row. |
| 10 | Pass | integration: item stamped with shared space applied there while the current space is personal. |
| 11 | Partial | new no-JS create e2e passes; the existing riwayat/edit/suara specs were **not run** (RAM rule: only added/changed specs). |
| 12 | Pass | cross-origin and missing-Origin POST → 403, no row. |
| 13 | Pass | `test/i18n-coverage.test.ts` passes; every new phrase has an English entry; en render tests. |
| 14 | Pass | sheet uses `formatMoney`; summaries integer minor units (zod int), voice totals never across currencies. |
| 15 | Pass | gates below; fail-before regression for criterion 2. |

## Pre-handoff probe lines

- Concurrency: 20 concurrent identical creates (repo and endpoint) → exactly 1 row, 20 × ok. Cap: 20 concurrent enqueues at 190 → exactly 10 accepted.
- Two tabs: e2e 1 push request for 1 item with Web Locks; integration without locks → duplicates sent, 5 rows for 5 items.
- Two devices / stale form: device 2 edits first → device 1's queued edit `stale`, row unchanged (integration + e2e).
- Offline → online replay: 2 queued items survive a new store over the same IDB, drain to 2 rows, queue empty.
- Duplicate replay: first attempt applied but answer lost → resend → still 1 row, item confirmed.
- Session expired while offline: 401 → paused, items kept; after sign-in drained (integration + e2e).
- Removed from space while offline: create and edit → 404 `no-access`, nothing written.
- Space switch while queued: applied to the item's own space, not the current one.
- Sign-out clears queue: e2e queue 0 after confirmed sign-out; cancel keeps 1.
- 200-item cap: 201st → `full`, 200 kept; other account unaffected.
- Cross-space: foreign space id and foreign transaction ids → 404 one answer each.
- Month boundaries: voice made 23:30 WIB 31 Oct sent 00:30 WIB 1 Nov → 2026-10-31; device clock ahead → server WIB today.
- 360 px: e2e phone project (360 × 780) badge + sheet, no horizontal scroll, light and dark.
- No-JS forms: no-JS create posts directly (e2e). Existing no-JS specs not run.
- User copy: messages are msg() phrases; no paths or ids shown.
- Money vectors: not applicable (no parser change; amounts go through the existing form parsers).

## Gates (each step separately, under the heavy lock)

- `npm run check` → exit 0, `0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS`.
- `npm run lint` → exit 0, "All matched files use Prettier code style!", eslint clean.
- `npx vitest run --maxWorkers=2` → exit 0, `Test Files 176 passed (176)`, `Tests 2475 passed (2475)`.
- `npm run build` → exit 0, `✔ done`.
- Playwright `e2e/offline-queue.spec.ts --workers=1` (both projects) → `19 passed` (9 phone + 9 desktop + setup).
  `npm run gates` / `npm test` deliberately not run (RAM rule).

## Not verified / notes

- Existing Playwright specs (riwayat, suara, accounts …) not re-run; existing sign-out tests should be unaffected
  (gate only when the queue is non-empty) but that is unrun.
- Web Locks / BroadcastChannel support on the iOS PWA target not checked on a device or against current MDN.
- Real offline reload of an (app) page (service-worker shell) not covered: pages are server-rendered.
- Known limitation: an update whose first attempt landed but whose answer was lost replays as `stale` (truthful
  "changed meanwhile"; no overwrite). An offline edit followed by an offline delete of the same row: the delete
  carries the pre-edit `updatedAt` and fails `stale` after the edit lands.
- Offline create with an empty amount is refused on the page (not queued); other field errors surface later as
  a failed item with the server's field message.
- `main` moved to `ef89a3f` (FN-36). `git merge-tree` shows `repo.ts` auto-merges; textual conflicts only in
  `src/lib/shared/i18n-en.ts` (both appended at the end) and `riwayat/[id]/edit/+page.svelte` (FN-36's series
  note vs this queue's `{#if queued}{:else}` wrapper) — both mechanical.

## Cycle 1b — rebase on FN-36 (main `0478484`)

- Rebased all WIP commits onto `0478484`. Conflicts resolved: `src/lib/shared/i18n-en.ts` (union of FN-36 and
  FN-02 entries, no duplicate keys — checked), `src/routes/(app)/riwayat/[id]/edit/+page.svelte` (FN-36's series
  note with "Ubah seri" link kept above the FN-02 `{#if queued}…{:else}` forms wrapper). `repo.ts` merged
  automatically; the FN-02 change there is still only the trailing `id` parameter of `createTransaction`.
- FN-36 interaction (new tests in `test/integration/sync-push.test.ts`): a queued edit of a generated occurrence
  changes that row only (edit-one), keeps `recurring_series_id` and leaves the series untouched; a queued create
  never sets `recurring_series_id`, even with a `recurringSeriesId` field in its payload (the form parser has no
  such field and `createTransactionOnce` passes none).
- Gates (each under the heavy lock): `npm run check` exit 0 (`1545 FILES 0 ERRORS 0 WARNINGS`); `npm run lint`
  exit 0; `npx vitest run --maxWorkers=2` exit 0 (`Test Files 179 passed`, `Tests 2534 passed`); `npm run build`
  exit 0 (`✔ done`).
- Playwright `--workers=1`, both projects: `riwayat`, `suara`, `accounts`, `berulang`, `offline-queue` specs →
  `79 passed`, `6 skipped` (project-specific `test.skip`, e.g. accounts "phone project only"), exit 0. This
  closes the cycle-1 gap on criterion 11 for the riwayat/edit/suara no-JS specs. No dev server left running.

## Cycle 2 — red team L1, L2, L4 and QA finding 1

Each fix has a test first. Run against the cycle-1b code, the 8 new tests fail: 6 in `sync-push.test.ts`
(L1 ×2, L2 ×2, L4, QA 1) and 2 in `sync.test.ts` (429 Retry-After, sign-out broadcast). With the fixes they pass.

- **L1:** the wire body now carries the queuing `accountId` (required in `parsePushRequest`; `pushBody` sends
  it). `pushQueuedWrite` answers 401 `session` when it differs from the session user, before any space lookup or
  write. The device treats that like any 401: the whole queue pauses with the items kept (parked), so they are
  never sent under the other account. The queue also listens on the session channel (`SESSION_CHANNEL`, now
  exported from `account-key/device.ts`) through the new `pauseOnSignOut` in `sync.ts`, wired in
  `runtime.svelte.ts`: a `signed-out` broadcast from another tab pauses this tab's queue at once.
- **L2:** voice day rule, documented on `voiceDay` in `push.ts`. A queued voice entry keeps the WIB date it was
  queued on only when that date is from 8 days ago (`VOICE_DAY_MAX_BACK_DAYS`, the 7-day stale window plus one
  day) up to today on the server. Anything else is the server's WIB today, as in the online voice action
  (`2000-01-01` → today; a future date → today).
- **L4:** new throttle scope `sync-push`. This is the only change to `throttle.ts`: one union member and one
  comment line. The route counts each push with `overUserAttemptLimit(user)` after the session check. Budget:
  `SYNC_PUSH_MAX_PER_WINDOW = 600` per 10-minute window. When over it, the route answers 429 with
  `Retry-After` set to the seconds left in the window. The drain loop keeps the item pending and waits
  max(backoff, Retry-After); nothing is lost.
- **QA 1:** before an update whose `expectedUpdatedAt` no longer matches, the server checks whether the row
  already holds exactly what the edit writes (type, amount, currency, wallets, category, title, note, date, and
  time when one is given). If it does, the answer is `ok` (already applied) and nothing is written. A different
  edit on the same stale `updatedAt` is still refused as `stale`. No schema change. A delete resent after it
  landed still answers "Transaksi tidak ditemukan" (unchanged, documented).

Gates (each under the heavy lock):

- `npm run check` exit 0 (`1546 FILES 0 ERRORS 0 WARNINGS`).
- `npm run lint` exit 0.
- `npx vitest run --maxWorkers=2` exit 0 (`Test Files 179 passed`, `Tests 2544 passed`).
- `npm run build` exit 0 (`✔ done`).
- Playwright `--workers=1`, both projects: `offline-queue`, `qa-fn02-offline-reload` and `suara` specs →
  `35 passed`, exit 0.

No dev server is left running.
