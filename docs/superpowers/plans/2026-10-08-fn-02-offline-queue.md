
# FN-02 — Offline write queue implementation plan

Spec: `docs/superpowers/specs/2026-10-08-fn-02-offline-queue-design.md`. Risk tier: **Large** (new client storage
mechanism, touches sign-out data-loss behaviour, new API route, cross-cutting over three existing route groups).
No D1 migration (queue lives in IndexedDB; server write paths reused unchanged).

Order matters: each task should land with its own tests green and `npm run gates` clean before the next starts.
Tasks 1–4 are the server-side idempotency foundation (needed by everything after); 5–9 build the client queue;
10–12 wire it into the three routes; 13 handles sign-out; 14 is the cross-cutting test pass.

## 1. Shared queue types and schema

- Files: `src/lib/shared/offline-queue.ts` (new), `src/lib/shared/offline-queue.test.ts` (new).
- Tests first: `QueueItem` zod/validation schema round-trips valid items; rejects an oversized payload, an unknown
  `kind`, a non-UUID `clientId`.
- Done when: pure module, no IndexedDB/DOM dependency (importable from a Worker test too), typed `kind` union
  matches exactly the four queued actions from the spec §2.

## 2. Caller-supplied id on `createTransaction`

- Files: `src/lib/server/transactions/repo.ts` (`insertTransactions`, `createTransaction`), new test cases in
  `src/lib/server/transactions/validation.test.ts` or a new `repo.test.ts`.
- Tests first: creating with a given `id` that does not exist yet inserts one row with that id; creating again with
  the *same* `id` and matching fields returns `ok` with zero new rows (idempotent); creating again with the same
  `id` but *different* fields (a bug, or a tampered resend) — decide and test the exact behavior (proposed:
  still returns `ok` treating the first write as authoritative, never a second row, never silently applies the
  new fields — document the choice in the function's doc comment).
- Done when: `insertTransactions`'s guarded `INSERT … SELECT … WHERE` gets an added `NOT EXISTS (id)` arm (or
  equivalent) covered by a concurrency test (20 concurrent identical creates → exactly one row, per
  `docs/ENGINEERING_CHECKLIST.md` pre-handoff probe). Existing callers (`riwayat/baru`'s `create`, voice save) keep
  working with `newId()` as before — this is additive, not a signature break for the no-id case.

## 3. `/api/v1/sync/push` endpoint

- Files: `src/routes/api/v1/sync/push/+server.ts` (new), `src/lib/server/sync/push.ts` (new — the dispatcher logic,
  kept out of the route file so it is unit-testable without a Request), test file alongside.
- Tests first (local D1): one request per `kind` → routes to `createTransaction`/`updateTransaction`/
  `deleteTransaction`/voice save/`recordAgain` with the exact same authorization as the existing page actions;
  wrong/foreign `spaceId` → 404 (space-access gate, no existence oracle); malformed JSON / oversized body → 400,
  never 500 (reuse `readRawBody`-style capping from `src/lib/server/forms.ts`); missing session → 401.
- Done when: the endpoint has zero new business logic beyond mapping `kind` → existing function, same
  `currentSpaceScope`/`requireSpaceAccess` pattern as every other route, origin/CSRF check added explicitly (JSON
  body bypasses SvelteKit's default form-content-type CSRF check — spec §11) and tested (cross-origin POST → 403).

## 4. Response contract test

- Files: extend task 3's test file.
- Tests first: each repo result (`ok`/`stale`/`missing`/`limit`/`gone`/`duplicate`) maps to the documented
  `{ clientId, result }` shape the client queue (task 7) will branch on.
- Done when: every branch from `src/lib/server/transactions/messages.ts` and `voice.ts`'s result union has a test
  hitting it through the endpoint, not just through the repo directly.

## 5. IndexedDB queue store

- Files: `src/lib/ui/offline-queue/db.ts` (new, raw IndexedDB open/upgrade), `src/lib/ui/offline-queue/store.svelte.ts`
  (new, reactive queue state), tests with `fake-indexeddb` (add as a dev dependency if not already present — check
  `package.json` first).
- Tests first: enqueue persists across a simulated reload (new `db.ts` instance over the same fake IDB); items are
  scoped by `accountId` (enqueue under account A, "sign in as" account B, confirm A's items are not drained/shown
  for B); status transitions (`pending`→`sending`→ removed, or →`failed`) are exactly as spec'd.
- Done when: store exposes `enqueue(item)`, `list(accountId)`, `remove(clientId)`, `markFailed(clientId, reason)`,
  `markSending`/`markPending` with no DOM `fetch` inside — networking lives in task 7.

## 6. Queue item cap and eviction message

- Files: same `store.svelte.ts`.
- Tests first: the 201st enqueue on an account is refused with a specific error the caller surfaces, not silently
  dropped.
- Done when: cap (200, from spec §13) enforced, message id added to i18n (task 9).

## 7. Drain loop (network layer)

- Files: `src/lib/ui/offline-queue/sync.ts` (new), test with a fake `fetch`.
- Tests first: a network-error response (fetch throws) keeps the item `pending` and retries on a fake timer with
  the documented backoff schedule (2/4/8/16/30s, jittered — test the bounds, not exact jitter values); a 409
  `stale` response marks `failed` immediately with no further auto-retry; a 401 pauses the *whole* drain loop and
  raises a `session-expired` event rather than retrying each item individually; items targeting the same
  transaction id are sent strictly in enqueue order (assert call order with a spy), items for different ids may
  overlap up to the concurrency cap.
- Done when: `sync.ts` exports a `startDrain(accountId)`/`stopDrain()` pair wired to `online`/`visibilitychange`
  in a later task (10), fully testable headless (no real browser needed — fake `fetch`, fake timers).

## 8. Cross-tab coordination

- Files: `src/lib/ui/offline-queue/lock.ts` (new) — `navigator.locks` with a documented fallback.
- Tests first: with Web Locks available (jsdom/happy-dom shim or feature-detected skip) two concurrent
  `startDrain` calls in the same process only let one proceed; check current MDN/browser support for
  `navigator.locks` before writing the fallback branch (per `CLAUDE.md` "re-check official docs").
- Done when: documented explicitly as a best-effort optimization — a test proves the idempotency path (task 2)
  still prevents a duplicate even if the lock is unavailable/skipped.

## 9. UI: badge, pending-changes sheet, i18n

- Files: `src/lib/ui/offline-queue/OfflineBadge.svelte` (new), `.../PendingSheet.svelte` (new); additions to
  `src/lib/shared/i18n.ts` call sites' message constants and `src/lib/shared/i18n-en.ts` (every new Indonesian
  phrase gets an English entry — the existing test that fails on a missing entry must pass, check its name first,
  e.g. `src/lib/shared/i18n.test.ts` or similar, and run it before/after).
- Tests first: component test / Vitest with `@testing-library/svelte` (check what's already used for similar
  components, e.g. existing kit components under `src/lib/ui/`) rendering 0/1/N pending items and a failed item
  with its specific reason string.
- Done when: every string from spec §8 exists in both locales; badge count matches store state reactively.

## 10. Wire into `riwayat/baru`

- Files: `src/routes/(app)/riwayat/baru/+page.svelte` (locate and read first — not yet opened in this pass's
  research; confirm its current `use:enhance`/fetch pattern before editing), possibly a small change to
  `+page.server.ts` only if the create action needs to accept a client-supplied id field (task 2 adds the
  capability; this task plumbs the form field).
- Tests first: Playwright — offline create → "Menunggu koneksi" → online → row appears, no duplicate on a forced
  double-drain (simulate by calling drain twice).
- Done when: online path is byte-for-byte unchanged in behavior (same redirect, same success state); offline path
  only engages when `navigator.onLine` is false or the first attempt's fetch throws a network error (never
  intercepts a legitimate 400 validation failure into the queue).

## 11. Wire into `riwayat/[id]/edit`

- Files: `src/routes/(app)/riwayat/[id]/edit/+page.svelte` (read first), minimal server action change if needed.
- Tests first: Playwright — edit offline, the loaded `updatedAt` is carried in the queue item; bring online while
  another device has changed the same row meanwhile → "changed meanwhile" surfaces per spec §6, not a silent
  overwrite.
- Done when: delete path (same file's `delete` action) covered identically.

## 12. Wire into `riwayat/suara`

- Files: `src/routes/(app)/riwayat/suara/+page.svelte` (read first).
- Tests first: Playwright — record by voice offline (type the sentence in the no-JS-equivalent text path is out of
  scope since offline requires JS anyway) → queued → online → saved; `catatLagi`/`urungkan` covered too.
- Done when: voice's existing dedupe key (`submissionKey`) flows through the queue item payload unchanged.

## 13. Sign-out data-loss gate

- Files: `src/routes/(app)/pengaturan/akun/+page.svelte` (read first for the sign-out button's current markup),
  small client-side check before submitting the `signOut` form action.
- Tests first: Playwright — pending item + click "Keluar" → confirmation dialog with the count; cancel keeps the
  session and the queue; confirm submits the existing `signOut` action unchanged (still sets `Clear-Site-Data`
  server-side) and the queue is gone after.
- Done when: `deleteAccount` is confirmed to proceed without this extra gate (spec §11 — account deletion removes
  the data anyway) and a test says so explicitly; closes the deferred item `docs/TASKS.md:114`.

## 14. Cross-cutting verification pass

- Run the full `docs/ENGINEERING_CHECKLIST.md` "Sync and account key" and "Pre-handoff probes" sections against the
  diff: two users/two spaces, two devices with deletes, concurrent 20-request probe on create idempotency,
  stale-form probe, cross-space crawl on the new endpoint, no-JS regression run of all three routes' existing specs.
- `npm run gates` clean. List which Playwright offline-mode specs actually ran vs. were skipped (Chromium system
  libs prerequisite, `docs/TASKS.md:36-37`) — never report an unrun command as passed, per `CLAUDE.md`.
- Update `docs/TASKS.md` (close the FN-02 line) and `docs/ACCEPTANCE.md` only with named checks actually run, per
  the PRD's tracker-impact section.
