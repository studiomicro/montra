
# FN-02 — Storage and offline write queue (server-first, the earlier project model)

Status: design. Owner decision 2026-10-07 (`CLAUDE.md`, `docs/ARCHITECTURE.md:26-42`): D1 is the working copy,
signed-in only. Guest mode and full local-first IndexedDB sync (`docs/ARCHITECTURE.md` "Local-first sync (FN-02)"
section) stay deferred. This spec covers only the piece the owner asked to keep: **an offline write queue** so a
signed-in device can keep working — and queue a few specific writes — while briefly offline, with no data loss and
no silent duplication.

## 1. Goal

Today every write is a direct form action/fetch to the app Worker (`src/routes/(app)/riwayat/baru/+page.server.ts:50-62`,
`src/routes/(app)/riwayat/[id]/edit/+page.server.ts:81-106`, `src/routes/(app)/riwayat/suara/+page.server.ts:87-173`).
A flaky mobile connection (the main journey happens on a phone) turns "record by voice" or "edit a transaction" into
a lost tap: no network, no response, no saved row, and SvelteKit's own fetch throws. The user does not get a
guest-mode fallback (deferred) and must not get a silent duplicate when retried. FN-02's offline queue closes that
gap for the small set of writes that matter most on the go — recording and fixing a transaction — while everything
that must never run twice or must never be attempted without a live server (auth, billing, invites, deletion,
exports, AI capture) stays online-only, exactly as the owner's server-first decision intends.

## 2. Scope — which writes queue offline

Only mutations that are idempotent, personal (not account/billing-grade), and already optimistic-concurrency-safe
server-side queue:

1. **Create transaction** (manual, `riwayat/baru` `create` action, `src/routes/(app)/riwayat/baru/+page.server.ts:51-62`).
2. **Edit transaction** (`riwayat/[id]/edit` `update` action, `src/routes/(app)/riwayat/[id]/edit/+page.server.ts:82-98`).
3. **Delete transaction** (same file, `delete` action, lines 100-105; also `riwayat/suara` `urungkan`,
   `src/routes/(app)/riwayat/suara/+page.server.ts:161-173`).
4. **Voice quick entry** (`riwayat/suara` `save` and `catatLagi` actions, lines 104-157) — the main journey's
   "record by voice" step explicitly needs to survive a flaky connection.

Everything else that touches these rows (`createTransaction`/`updateTransaction`/`deleteTransaction`,
`src/lib/server/transactions/repo.ts:245-376`) is reused unchanged: the queue is a client-side retry mechanism in
front of the existing actions, not a new server write path.

### Never queued (always require a live round trip, fail immediately offline)

- Auth: sign-in, sign-up, sign-out, password change, account key operations
  (`src/routes/(app)/pengaturan/akun/+page.server.ts`).
- Billing/plan changes, invites (`/ruang/*`), account deletion, data export
  (`docs/TASKS.md` red-team items on refunds/exports confirm these must stay online, server-confirmed, auditable).
- Any AI capture path (Gmail, voice-AI recheck, receipt, statement, spreadsheet) — needs the server's AI Gateway call;
  nothing to queue client-side.
- Wallets, categories, budgets, goals, net worth, subscriptions, notifications, settings — out of scope for this
  pass (see §3); the owner can ask for a wave 2 once the transaction queue is proven.

### UI, routes and modules touched

- `src/lib/shared/offline-queue.ts` (new): queue item schema, idempotency key, serialization — shared so a future
  Worker-side replay tool can reuse the same types.
- `src/lib/ui/offline-queue/` (new): `store.svelte.ts` (queue state), `OfflineBadge.svelte` (pending/failed chip),
  `sync.ts` (drain loop, `online`/`offline` listeners, `visibilitychange` flush).
- `src/routes/(app)/riwayat/baru/+page.svelte`, `.../edit/+page.svelte`, `.../suara/+page.svelte`: enqueue instead of
  (or in addition to, see §9 progressive enhancement) `fetch`/form submit when `navigator.onLine` is false or the
  request fails with a network error; show the pending state.
- `src/routes/api/v1/sync/push/+server.ts` (new): the one server endpoint that accepts queued writes in order,
  JSON body, one call per queue item (not a batch endpoint — §4) so each item reuses the exact existing action
  logic. No new `/api/v1/sync/pull` in this pass (no multi-device pull without local-first; see §11).
- i18n: new strings in `src/lib/shared/i18n.ts` table consumers / `i18n-en.ts`, e.g. `Menunggu koneksi`,
  `Tersimpan`, `Gagal disimpan — {reason}`, `N perubahan menunggu`, `Coba lagi`, `Ketinggalan sinkron — muat ulang`.
- No migration: the queue lives in IndexedDB on the device; the server-side write path and tables are unchanged.
  `src/lib/server/sync/seq.ts:11-21` (`bumpSpaceSeq`/`currentSpaceSeq`) is reused as-is by the existing repo
  functions; no new column.

## 3. Out of scope

- Guest mode (records without an account) — explicitly deferred by the owner decision.
- Full local-first IndexedDB working copy, multi-device pull/cursor sync, `docs/ARCHITECTURE.md`'s "Local-first
  sync (FN-02)" section in general — deferred; this spec implements none of it. Nothing here blocks revisiting it.
- Queuing wallets, categories, budgets, goals, net worth, subscriptions, collectibles, belongings writes.
- Queuing anything that creates a draft requiring AI (receipt/statement review actions).
- Background Sync API (`ServiceWorkerRegistration.sync`) — Safari/iOS (the PWA's primary constraint per
  `docs/FEATURES.md` FN-13 "on iPhone the installed app keeps its own storage") does not support it; the drain
  loop runs from the page (foreground) and the existing service worker, not a Background Sync registration.
- Changing `Clear-Site-Data` policy for unrelated flows (push subscription, cache) — only sign-out's interaction
  with a *non-empty* queue is addressed (§8).
- A server-side outbox/replay-from-server feature; the queue is client → server only in this pass.

## 4. Data model — the queue (IndexedDB)

One IndexedDB database per **origin**, scoped per **account** inside it (not per space — a queued item can only
belong to the space the user was in when it was created; see §7).

```
db: "financer-queue" (v1)
store: "items", keyPath: "clientId"
indexes: "byAccount" (accountId), "byStatus" (status)

QueueItem {
  clientId: string;        // crypto.randomUUID(), generated on enqueue — the idempotency key end to end
  accountId: string;       // locals.user.id at enqueue time, so a sign-out/sign-in swap never leaks across accounts
  spaceId: string;         // the space cookie's value at enqueue time
  kind: 'transaction.create' | 'transaction.update' | 'transaction.delete' | 'voice.save' | 'voice.recordAgain';
  payload: Record<string, string>;   // the exact form field set the existing action already reads
  expectedUpdatedAt?: number;        // update/delete only, copied from the loaded row
  createdAt: number;       // device clock, display only, never trusted by the server
  attempts: number;
  status: 'pending' | 'sending' | 'failed';
  lastError?: string;      // last server message id, for the failed-state UI; never a stack or raw response body
}
```

- **Encrypted or not — not encrypted, and why:** item payloads are transaction field values (amount, title, wallet
  id, category id, dates) — the same class of data IndexedDB already risks holding transiently via normal page
  state and form autofill, and the device is assumed to be the user's own signed-in device (this is server-first,
  not a shared-kiosk product). FN-21's sealing applies to *server-held* AI capture results that must be unreadable
  to the operator at rest; this queue is a local retry buffer that lives seconds to minutes and is covered by the
  OS/browser profile's own sandboxing. Encrypting it with the FN-21 account key would require the key to be
  unwrapped (password-derived) at every enqueue, which defeats "survive briefly offline" (the key may not be
  unwrapped if the tab was reloaded offline). **Owner decision (default: do not encrypt; revisit only if a red
  team finding says otherwise.)**
- **Cleared on sign-out:** sign-out already sets `locals.clearSiteData` →
  `Clear-Site-Data: "cache", "storage"` (`src/hooks.server.ts:86-88`, `src/app.d.ts:26-30`), which wipes IndexedDB
  with everything else. Today that is correct (nothing durable to lose). Once this queue exists it is a real risk:
  signing out with unsynced items loses user data silently. See §8 for the required change — this is exactly the
  deferred item `docs/TASKS.md:114`.
- No per-field encryption of money fields: amounts stay integer minor units in the payload, never floats, matching
  `CLAUDE.md` money convention end to end.

## 5. Idempotency: client id → server dedupe → D1 batch

- `clientId` (UUIDv4 via `crypto.randomUUID()`, matching the existing `newId()` pattern,
  `src/lib/server/util.ts:1` — not UUIDv7 as `docs/ARCHITECTURE.md:31` sketches; see §12 note) is minted once, at
  enqueue, never regenerated on retry.
- **Create:** the queue item's `clientId` becomes the transaction's row `id`. `createTransaction`
  (`src/lib/server/transactions/repo.ts:245-263`) currently mints `id` itself (`newId()` at line 253); it needs a
  thin variant/parameter that accepts a caller-supplied id and checks it does not already exist in the space
  (`insertTransactions`'s `json_each` + `refsHold` + cap guard, lines 181-238, already runs one guarded `INSERT …
  SELECT … WHERE` per row — adding `AND NOT EXISTS (SELECT 1 FROM transactions WHERE id = …)` keeps it one
  statement). A resend of the same `clientId` after a successful-but-unacknowledged first attempt then inserts
  zero rows instead of a duplicate; the push endpoint treats "0 rows because it already exists and matches" as
  success, not `gone`/`limit`.
- **Update/delete:** these already key off `transactions.id` + `expectedUpdatedAt`
  (`src/lib/server/transactions/repo.ts:298-376`); the existing "stale" vs "missing" vs "ok" result *is* the
  dedupe/conflict mechanism — no change needed beyond calling it from the new endpoint instead of (or alongside)
  the form action.
- **Voice save:** already has its own `submissionKey`/dedupe path (`src/lib/server/transactions/voice.ts`,
  referenced at `src/routes/(app)/riwayat/suara/+page.server.ts:109,121`) — reused unchanged; the queue item's
  `payload` carries the same `key` field so a resend is a no-op server-side.
- **D1 batch:** no change to `bumpSpaceSeq`/`currentSpaceSeq` (`src/lib/server/sync/seq.ts`) or to the
  `db.batch([...])` shape already used by `createTransaction`/`updateTransaction`/`deleteTransaction` — the queue
  calls the existing functions one item at a time (not a multi-row batch endpoint), so every D1 invariant already
  proven for the form actions (one statement, no interactive transaction, bounded) holds unchanged.
- The new `/api/v1/sync/push` endpoint is a **thin dispatcher**, not new business logic: it reads one `QueueItem`-
  shaped JSON body, maps `kind` to the matching existing repo call with `currentSpaceScope`/`requireSpaceAccess`
  exactly as the page action does, and returns `{ clientId, result: 'ok' | 'stale' | 'missing' | 'limit' | 'gone' }`.

## 6. Conflict rules

- **Create:** idempotent by `clientId` as above — no "conflict" state, only "already applied" (treated as `ok`).
- **Update/delete:** last-writer-wins is already the *client's* rule implicitly (the loaded `updatedAt` it sends),
  but the **server rejects** rather than merges: `updateTransaction`/`deleteTransaction` only succeed while
  `transactions.updated_at = expectedUpdatedAt` (`src/lib/server/transactions/repo.ts:327-336,364-371`). A queued
  edit whose `expectedUpdatedAt` no longer matches (because another device's write — queued or live — landed first,
  or the row was deleted) comes back `stale`/`missing`. The queue surfaces this as "changed meanwhile" per item,
  never silently retries past it, never merges fields. This matches the checklist rule verbatim
  (`docs/ENGINEERING_CHECKLIST.md:55` "a tombstone beats an older edit").
- **Ordering within one device's queue:** items for the *same* transaction id are sent strictly in enqueue order
  (FIFO per `clientId`-of-target, not globally) so a create→edit→delete sequence made entirely offline resolves as
  intended instead of racing; items for different transactions may send concurrently (bounded, see §7).
- **Across devices/tabs:** no new rule is invented — the existing `updated_at` guard *is* the conflict rule; the
  queue only decides when to retry, never what wins.

## 7. Retry and backoff

- Drain loop runs: on `online` event, on `visibilitychange` → visible, and immediately after a successful enqueue
  while already online.
- One item in flight per **target row** at a time (serializes create→edit→delete on the same transaction); up to
  4 different rows in flight concurrently.
- Backoff on a *network* failure (fetch rejects / `TypeError`, or 0/502/503/504): exponential, 2s/4s/8s/16s/30s cap,
  full jitter; item stays `pending`, retried automatically, no user action needed, badge says "Menunggu koneksi".
- On a *server* answer that is not transient (400 validation, 401 session expired, 403, 404 missing, 409 stale/limit,
  413, 415): item moves to `failed` immediately, no further auto-retry; UI shows the specific reason and one manual
  "Coba lagi" (discard-and-retry where the data is now stale, e.g. re-opens the edit form with current server
  values) — never a blind resubmit of a provably-wrong payload.
- A `failed` item never silently disappears: it stays queued (visible in the pending-changes list) until the user
  acknowledges it (dismiss, which deletes the queue item only, never the transaction) or fixes and resubmits.
- Max queue age: items older than 7 days are flagged "Ketinggalan sinkron" and require explicit user action (dismiss
  or retry) rather than retrying forever against a session that has likely expired.

## 8. UI states

Per the `CLAUDE.md` rule "success only after the write is confirmed (by the server)" — nothing in this queue
changes that: an enqueued item is never shown as "Tersimpan" until the server round trip returns `ok`.

- **Composing (online or offline, before submit):** unchanged form UI.
- **Submitting while online:** unchanged (existing `use:enhance` spinner/disabled state).
- **Submitting while offline / request fails with a network error:** item is enqueued; toast/row state
  "Menunggu koneksi" (not "Tersimpan", not an error) with the pending badge; the form returns to editable/closed
  state immediately — the user is not blocked waiting for a timeout.
- **Pending (queued, not yet sent):** a small badge on the affected row/tab ("Riwayat" tab icon and the row itself)
  showing a count, e.g. "2 menunggu"; tapping opens a pending-changes sheet listing each item in plain language
  ("Kopi Rp 25.000 — menunggu koneksi").
- **Sending:** the pending-changes row shows a spinner; no change to badge count yet.
- **Success:** item removed from the queue, row/list updates from the server response exactly as the online path
  does today (redirect to `/riwayat?saved=created|updated|deleted`, or the voice page's own success state).
- **Failed with reason:** row shows the specific message ("Perubahan ditolak — transaksi sudah berubah di
  tempat lain", "Transaksi sudah dihapus", "Sesi berakhir, masuk kembali") sourced from the existing message
  constants (`TRANSACTION_CHANGED`, `TRANSACTION_NOT_FOUND`, `REFS_GONE`, `TRANSACTION_LIMIT`,
  `src/lib/server/transactions/messages.ts`, `SESSION_ENDED` `src/lib/server/auth/gate.ts:22`) — never a generic
  "error occurred".
- **Sign-out with a non-empty queue:** see §9 — must warn, not silently discard.
- **Empty state:** no badge, no sheet entry point beyond a quiet "Semua tersinkron" when the sheet is opened with
  nothing pending.

## 9. Multi-tab and two-device behaviour

- **Multi-tab (same device, same browser):** the IndexedDB store is shared across tabs of the same origin; use a
  `BroadcastChannel('financer-queue')` (or `storage`-event-style IndexedDB polling as a fallback) so every open tab
  shows the same pending count and so only one tab's drain loop actually sends at a time (a `navigator.locks`
  Web Lock on `'financer-queue-drain'`, falling back to a simple "elect the tab that got the lock" pattern if Web
  Locks is unavailable — check current browser support before relying on it, per `CLAUDE.md` "re-check official
  docs" rule).
- **Two devices:** each device has its own queue; there is no cross-device visibility of *pending* items (no pull
  sync in this pass). Once a device's queued item reaches the server, it is visible to other devices the normal
  way (next load/refresh of `/riwayat`), via the existing `space_seq`/`updated_at` columns — no new mechanism
  needed since there is no live push of list updates in scope.
- **Progressive enhancement / no-JS:** the queue is a `<script>`-only enhancement. Without JavaScript the existing
  `use:enhance`-free form actions already behave exactly as before (direct POST, native browser "offline" error
  page) — this spec must not regress the no-JS path per `docs/ENGINEERING_CHECKLIST.md:97`.

## 10. Space switching while queued

- A queue item is stamped with the `spaceId` active at enqueue time and is always pushed against that `spaceId`,
  never the space the user has since switched to — the server still re-checks membership of that exact `spaceId`
  per item through `currentSpaceScope`/`requireSpaceAccess` (`src/lib/server/spaces/current.ts:9-15`,
  `src/lib/server/spaces/access.ts:48-72`), so a queued item cannot leak into whatever space happens to be current
  when it finally sends.
- If the user leaves that space (or is removed) before the item sends, the server answers `404 Not found` through
  the same space-access gate (no existence oracle) — surfaced to the queue as a non-retryable failure: "Ruang ini
  sudah tidak bisa diakses" — never silently redirected into the user's current space.
- The pending-changes sheet shows which space each item belongs to when the user has more than one, so switching
  spaces does not hide a pending item from view.

## 11. Security

- **No secrets in IndexedDB:** queue payloads are transaction field values only — no session token, no password,
  no account key material. The push endpoint authenticates the request the normal way (session cookie,
  `event.locals.user`), never a token carried in the queue item.
- **CSRF on replay:** SvelteKit's default CSRF check (origin check against same-origin, applied by the framework to
  requests whose `Content-Type` is `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`) does
  **not** cover a JSON `fetch` POST to a `+server.ts` endpoint — `src/routes/api/v1/sync/push/+server.ts` must do
  its own `Origin` header check (same pattern as needed for any JSON API route) before touching the DB, matching
  how the rest of the app only ever accepts same-origin form posts. Verify SvelteKit's current CSRF default scope
  against the installed version before implementing (`CLAUDE.md` "re-check official docs").
- **Session expiry while offline:** a session can expire while the device was offline with items queued. The drain
  loop must treat a `401`/redirect-to-`/masuk` response (`authGate`, `src/lib/server/auth/gate.ts:60-81`) as
  non-retryable and surface `SESSION_ENDED` on every queued item at once, with a single "Masuk kembali" action that
  does not discard the queue (items stay, retried after re-sign-in, still gated by `accountId` matching the newly
  signed-in user — a different account signing in on the same device must never auto-send another account's
  queued items; mismatch → discard with a warning, never silently apply to the new account).
- **Space isolation:** every push call re-runs the full existing authorization path (`currentSpaceScope` →
  `requireSpaceAccess`) exactly like the page action — no new trust boundary, no bypass of `isLiveMember`/
  `isSharedSpaceOwner` checks baked into `refsHold`/the update/delete `WHERE` clauses.
- **Rate limiting:** the existing `MAX_TRANSACTIONS_PER_SPACE` cap (`src/lib/server/transactions/repo.ts:108`)
  and the open per-user rate-limit item (`docs/TASKS.md:111`) both still apply; a device replaying a large stale
  queue must not be a way to defeat either — the queue drains at the same pace a user could tap "save" by hand
  (one in flight per row, capped concurrency per §7), so no new rate-limit logic is required for this pass.
- **Sign-out / `Clear-Site-Data` (the deferred item, `docs/TASKS.md:114`):** `signOut` and `deleteAccount`
  (`src/routes/(app)/pengaturan/akun/+page.server.ts:180-211`) currently set `locals.clearSiteData` unconditionally.
  Once a non-empty queue can exist, sign-out must first check the queue (client-side, before submitting the
  sign-out form) and show a confirmation ("N perubahan belum tersinkron — keluar tetap akan membuangnya") rather
  than silently losing data; account deletion is a stronger action and may proceed regardless (the account's own
  data is being deleted anyway). This is a client-side gate in the sign-out UI, not a server change — the server
  keeps answering `Clear-Site-Data` exactly as today once the user confirms.

## 12. Testing strategy

- **Vitest (unit/integration, local D1 via `db:migrate:local`/miniflare, no network):**
  - Idempotency: resend the same `clientId` for create twice → one row, second call returns `ok` with the
    existing id, never a duplicate (extends the existing pattern in
    `src/lib/server/transactions/validation.test.ts` / repo tests).
  - Conflict: update with a stale `expectedUpdatedAt` from a queue item → `stale`, row unchanged (reuses the
    existing `updateTransaction` behavior, new test only exercises it through the push endpoint).
  - Space isolation: a queue item with a `spaceId` the user no longer belongs to → `404`, no row touched (two
    users, two spaces, per `CLAUDE.md` verification rule).
  - Voice save/recordAgain through the push endpoint hit the same dedupe path as the direct action
    (`src/lib/server/transactions/voice.ts`) — one shared test fixture, two entry points.
  - Queue store logic (enqueue/dequeue/backoff schedule/status transitions) as pure unit tests against
    `src/lib/shared/offline-queue.ts` with a fake IndexedDB (e.g. `fake-indexeddb`) — no real browser needed for
    this part.
- **Playwright (`npm run test:e2e`, offline mode via `page.context().setOffline(true/false)` — confirm the exact
  Playwright API for the installed version before writing the test):**
  - Record a transaction with the network set offline → see "Menunggu koneksi", no crash, form closes; set online
    → item drains → row appears in `/riwayat`, badge clears. Reload mid-offline → item survives (IndexedDB, not
    memory state).
  - Two tabs, one device: enqueue in tab A while offline, bring tab B online → only one network call is made
    (Web Lock / broadcast assertion via a network-call counter).
  - Session expired while a queue item is pending → "Sesi berakhir" surfaces, re-sign-in drains it.
  - Sign-out with a pending item → confirmation shown, cancel keeps the queue, confirm clears it (and
    `Clear-Site-Data` still fires).
  - No-JS run of the existing `riwayat/baru`/`edit`/`suara` Playwright specs must still pass unmodified (regression
    guard for progressive enhancement).
- Both suites run against the local D1 binding per `CLAUDE.md`; no mocked AI involved (none of these writes touch
  AI). Never report Playwright offline-mode runs as passed without Chromium's system libs installed — currently
  blocked locally per `docs/TASKS.md:36-37`; note this explicitly in the engineer's completion report if still
  unresolved when this ships.

## 13. Risks

- **Scope creep toward full local-first.** The temptation to "just add a pull cursor too" must be resisted — that
  is a separate, larger, still-deferred decision (`docs/ARCHITECTURE.md` FN-02 section). This spec is additive and
  does not block it.
- **UUIDv4 vs UUIDv7 drift.** `docs/ARCHITECTURE.md:31` sketches UUIDv7 client ids for the eventual full sync
  design; this pass keeps `crypto.randomUUID()` (UUIDv4, matching `src/lib/server/util.ts:1`) for simplicity.
  Flag for the engineer: if/when full sync lands, decide once whether to migrate id generation, rather than having
  two id schemes drift apart silently.
- **`Clear-Site-Data` data loss.** The single highest-risk interaction (§9/§11 sign-out) — must not ship without
  the confirmation gate; this is the exact item `docs/TASKS.md:114` flags as a prerequisite.
- **Web Locks / BroadcastChannel browser support** on the PWA's target set (notably older iOS Safari in the
  installed-app context) is not yet verified for this codebase; a missing API must degrade to "last tab to open
  wins occasional duplicate network calls, deduped by `clientId` anyway" rather than breaking — the idempotency
  guarantee (§5) is the real safety net, multi-tab coordination is only an efficiency nicety.
- **IndexedDB quota/eviction.** A long-offline device with many queued items could hit storage pressure; cap the
  queue at a sane item count (propose 200) and surface "terlalu banyak perubahan menunggu — sambungkan ke internet"
  rather than silently failing to enqueue further items.
- **False "online" events.** `navigator.onLine`/the `online` event can fire while the network is still unusable
  (captive portals); the drain loop must treat a failed fetch after an `online` event as a normal retry, not a
  surprising error — covered by the same backoff in §7.
