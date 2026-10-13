# FN-02 offline write queue — QA report

**Verdict: PASS**

Worktree `<repo>`, branch `fn-02-offline-queue`,
head `57f94c9` (rebased on `main` `0478484`). Diff vs `main`: 37 files, +4501/−80 (`git diff main...HEAD --stat`).

## Commands run

- `flock /tmp/montra-heavy.lock npm run check` → exit 0, `1545 FILES 0 ERRORS 0 WARNINGS` (real tsc/svelte-check).
- `flock /tmp/montra-heavy.lock npm run lint` → exit 0, "All matched files use Prettier code style!", eslint clean.
- `flock /tmp/montra-heavy.lock npx vitest run --maxWorkers=2` → exit 0, `Test Files 179 passed (179)`, `Tests 2534 passed (2534)` (local D1/fake-indexeddb, mocked).
- `flock /tmp/montra-heavy.lock npm run build` → exit 0, `✔ done`.
- `flock ... LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8830 npx playwright test e2e/offline-queue.spec.ts e2e/riwayat.spec.ts e2e/suara.spec.ts e2e/accounts.spec.ts e2e/berulang.spec.ts --workers=1` → `79 passed, 6 skipped` (real Chromium, local wrangler dev + local D1, no external provider).
- `flock ... npx prettier --write e2e/qa-fn02-offline-reload.spec.ts && flock ... npx eslint e2e/qa-fn02-offline-reload.spec.ts` → exit 0, no findings (QA-authored probe).
- `flock ... LD_LIBRARY_PATH=... E2E_PORT=8830 npx playwright test e2e/qa-fn02-offline-reload.spec.ts --workers=1` → `3 passed` (setup + phone + desktop; real Chromium, local server).

No migration in this diff, so `db:migrate:local` was not re-run. `npm run gates` / `npm test` were never run directly (RAM rule); each gate step above was run separately.

## Checked criteria

1. PASS — offline Simpan on `riwayat/baru` shows "Menunggu koneksi", never "Tersimpan"; item in IndexedDB. Evidence: `e2e/offline-queue.spec.ts:76` ("offline create…"), own probe `e2e/qa-fn02-offline-reload.spec.ts` additionally proves the item survives a **real page reload while offline** (engineer's "not verified" gap) — `page.reload()` while offline shows the FN-13 offline shell (`Kamu sedang offline.`) and `queueSize(page)` stays 1 across it, then drains to 0 and the row appears in Riwayat once online.
2. PASS — 20 concurrent identical creates → 1 row. Evidence: `test/integration/sync-push.test.ts` concurrency test; `src/lib/server/transactions/client-id.ts` `createTransactionOnce` (guarded `NOT EXISTS` insert inside one `db.batch`, no interactive transaction, matches `ENGINEERING_CHECKLIST.md` "Concurrent writes").
3. PASS — success shown only after server `ok`; badge reaches zero only once every item confirmed. Evidence: `sync.test.ts` "leaves the queue only after ok"; `e2e/offline-queue.spec.ts:76` badge → "1 perubahan tersimpan." only post-`setOffline(false)`.
4. PASS — stale edit (`expectedUpdatedAt` mismatch) → `stale`, row unchanged, "Berubah sejak terakhir dimuat"/"Data ini sudah berubah" shown, never overwritten. Evidence: `sync-push.test.ts` stale test; `e2e/offline-queue.spec.ts:105` two-device edit, amount stays 40.000.
5. PASS — removed member / foreign / non-existent space → 404 `no-access`, identical body, item marked failed not retried. Evidence: `sync-push.test.ts:638` ("another user's space and a space that does not exist get the same 404 no-access") and `:650` ("a member removed while offline: their queued create and edit are 404 no-access, nothing written"). `requireSpaceAccess` (`src/lib/server/spaces/access.ts:48-72`) is the one unchanged shared helper, reused as-is — satisfies "one access rule".
6. PASS — session expiry pauses the whole queue with "Sesi berakhir…"; same-account resume drains; a different account's queue is discarded, never shown/sent. Evidence: `sync.test.ts` 401-pause tests, `e2e/offline-queue.spec.ts:206`, `store.svelte.ts` `discardOtherAccounts` + `runtime.svelte.ts:45` called on every start.
7. PASS — sign-out with a non-empty queue asks first (named count), Batal keeps session+queue, confirming proceeds and still clears via `Clear-Site-Data` (server code at `src/hooks.server.ts:86-88` untouched). Evidence: `pengaturan/akun/+page.svelte:76-124` (`use:enhance` `cancel()` gate before the real POST fires), `e2e/offline-queue.spec.ts:175`.
8. PASS — account deletion proceeds without the confirmation; queue cleared after redirect. Evidence: `+page.svelte:133-148`, `e2e/offline-queue.spec.ts:250`.
9. PASS — two tabs online together send the item once. Evidence: `e2e/offline-queue.spec.ts:225` (`sent` counter = 1 via Web Locks); `test/integration/offline-drain.test.ts` additionally proves that *without* a lock the server-side idempotency (criterion 2) still collapses duplicate sends to one row.
10. PASS — a queued item drains to its own `spaceId`, re-checked by `requireSpaceAccess` for that space, never the now-current space. Evidence: integration test in `sync-push.test.ts`/`offline-drain.test.ts` space-switch coverage; `push.ts:154-171` takes `item.spaceId`, never a "current space" value.
11. PASS — no-JS forms byte-for-byte unaffected. Evidence: this run's own Playwright pass of the **existing, unmodified** `riwayat.spec.ts`, `suara.spec.ts`, `accounts.spec.ts`, `berulang.spec.ts` no-JS specs (79 passed, 6 skipped — matching the engineer's cycle-1b note) plus the new `offline-queue.spec.ts:277` no-JS compose test.
12. PASS — cross-origin/missing-Origin JSON POST to `/api/v1/sync/push` → 403 before any DB work. Evidence: `+server.ts:23` (`Origin` check first line of the handler); `sync-push.test.ts` cross-origin tests.
13. PASS — every new string has an English entry; `test/i18n-coverage.test.ts` passed as part of the full vitest run (2534/2534). Spot-checked `src/lib/shared/i18n-en.ts:1758-1781` ("Menunggu koneksi" → "Waiting for a connection", "Tetap keluar" → "Sign out anyway", etc.).
14. PASS — `PendingSheet.svelte` imports and uses the shared `formatMoney` (never hand-formatted); amounts are integer minor units via zod `z.number().int()`; WIB `occurred_on` convention followed for voice (`voiceDay()` in `push.ts:88-91`), with explicit WIB-month-boundary vectors: "made 23:30 WIB 31 Oct, sent 00:30 WIB 1 Nov → counts 2026-10-31" and "device dated ahead → server WIB today" (`sync-push.test.ts:697,706`), both re-verified in this run (full vitest pass).
15. PASS — `check`, `lint`, `test` (vitest), `build` all clean (see Commands run); `client-id.ts` / `createTransactionOnce` has its own fail-before-fix regression evidence (engineer report: guard removed → `UNIQUE constraint failed`, 5/7 fail; with guard, 7/7 pass) — not independently re-broken in this cycle since no production code was touched.

### Specifically verified per the task brief

- **Server-side space authorization on every new load/action**: `requireSpaceAccess` reused unchanged (`push.ts`); removed member and foreign-space both 404 with identical body (`sync-push.test.ts:638,650`). Sync push is the only new endpoint in scope (no pull endpoint exists in this feature — confirmed out of scope in the PRD).
- **State survives reload**: own probe `qa-fn02-offline-reload.spec.ts` (new) — IndexedDB queue item count unchanged across a real offline reload.
- **Money sums are exact integers, never mixed currencies**: zod `z.number().int()` on `expectedUpdatedAt`; amounts flow through existing `readTransactionForm`/shared money parser, unchanged by this diff; `formatMoney` used in the UI.
- **Month/day buckets use WIB**: `voiceDay()` WIB-boundary tests, re-run and passing.
- **Captured data shows source and review state**: unchanged `source`/dedupe-key paths (`checkVoiceRows`/`saveVoiceTransactions`); push dispatcher calls the same functions, so source `voice`/`manual` tagging is unaffected.
- **No fabricated figures**: pending sheet renders only `QueueItem` fields already entered by the user; no server-computed totals invented client-side.
- **Indonesian strings have English entries**: confirmed (criterion 13).
- **Loading/empty/error states**: `OfflineBadge` (sending/pending/failed/session-ended states), `PendingSheet` ("Semua tersinkron" empty state, per-item failed reason) — covered by `components.test.ts` and e2e.
- **Two devices with deletes / stale edits**: `sync-push.test.ts:470` "delete after delete → 404 missing" (device 2 deletes, device 1's queued delete of the same row 404s, no crash, no silent success) and the stale-edit e2e (criterion 4).
- **Queued edits of recurring occurrences keep `recurring_series_id`**: `sync-push.test.ts` "FN-36 recurring rows through the queue" — edit-one keeps `recurring_series_id`, the series row itself untouched; a queued create never sets `recurring_series_id` even when the payload names one (re-verified, full vitest pass).
- **Never-queued actions stay online-only**: scope list confirms only transaction create/update/delete and voice save/recordAgain/urungkan are queued; balance adjustments explicitly refused in `push.ts:114` (`QUEUE_ONLINE_ONLY`) and never created via the queue path; auth, billing, invites, account deletion, exports, AI capture are untouched by this diff (grep of the 37-file diff stat shows no routes under `pengaturan/billing`, `impor`, `tanya`, invites, or auth routes besides the sign-out/delete gate in `akun`).
- **360 px light + dark, no horizontal scroll**: `offline-queue.spec.ts` phone project (360×780, default light) runs all 9 specs; an explicit dark-mode test (`:265`) also checks `expectNoHorizontalScroll`.
- **No-JS forms unaffected**: criterion 11.

## Findings

None blocking. Two pre-existing, honestly-disclosed limitations (unchanged from the engineer's report, not regressions):

1. An offline edit whose first attempt actually landed but whose server answer was lost replays as `stale`
   ("changed meanwhile") rather than `ok` — truthful (something *did* change meanwhile: the device's own earlier
   write), never a silent overwrite or a duplicate, but the user sees an avoidable "conflict" notice for their own
   resend. Low severity, documented in `ENGINEER_REPORT.md`; acceptable for this pass per the PRD's scope.
2. Web Locks / BroadcastChannel behaviour on an actual iOS PWA device is still unverified (Chromium-only in CI);
   the design degrades correctly without locks (server-side idempotency still holds, proven in
   `offline-drain.test.ts`), so this is a coverage gap, not a defect.

## Engineering checklist spot-check

- Concurrent writes: one guarded `INSERT ... WHERE NOT EXISTS` inside `db.batch`, no interactive transaction — `client-id.ts`.
- One access rule / no existence oracle: `requireSpaceAccess` reused verbatim; identical 404 body for foreign/missing/removed — `sync-push.test.ts:638`.
- Form bodies: shared `readRawBody` cap (413 too large, 408 timeout) reused unchanged from `src/lib/server/forms.ts`, not reimplemented.
- Prototype-safe parsing: queue payload is `[name, value][]` tuples (never an object with attacker-controlled keys) — `offline-queue.ts:46-48`.
- i18n: every new phrase has an English entry, test passes.
- Currency display: shared `formatMoney`, never hand-formatted.
- Gates clean (see Commands run); fail-before proof for criterion 2 documented in `ENGINEER_REPORT.md`.

No violations found in the diff against `docs/ENGINEERING_CHECKLIST.md`.
