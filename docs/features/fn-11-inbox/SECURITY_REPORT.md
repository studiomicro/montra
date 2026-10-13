# FN-11 Kotak masuk: security report

Reviewed: `git diff 01cc53d..7c1867f` (cycle 1), detached worktree at 7c1867f. Scope is narrow (Medium tier):
the rewritten FN-05 insert path, draft actions, the dev seed, the one-shot notice cookie, caps, tombstones,
rendering, CSRF and body caps. Checked against `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

There are no Critical, High or Medium findings. Two Low findings are listed so they are tracked.

## Findings

### L1 (Low): a saved demo draft becomes a real, counted transaction

- Where: `src/lib/server/transactions/repo.ts:205` (`is_demo` is always `0`) and
  `src/lib/server/drafts/repo.ts:375` (the origin carries source, dedupe key and instant, but not `isDemo`).
- Scenario (reproduced locally with `DEV_ROUTES=1`): "Tambah draf contoh", then "Simpan" on the two complete demo
  drafts. This creates two `transactions` rows with `source='gmail'`, `dedupe_key='demo:…'` and `is_demo=0`
  (checked in local D1). They count in Beranda/Riwayat totals and wallet balances, and `clearDemoDrafts` does not
  remove them. This breaks CLAUDE.md ("seed data … badged `Data demo`, excluded from real totals") and PRD line 253
  ("writes no row with a real (non-demo) provenance").
- Impact: dev-only, because the seed actions answer 404 without `DEV_ROUTES=1` or `vite dev` (verified). Someone
  testing by hand can still pollute their own space's totals with fictional money. No cross-space effect.
- Fix: add `isDemo` to `TransactionOrigin`. Bind it in the JSON and write `${f('isDemo')}` instead of `0`, and pass
  `draft.isDemo` from `saveDrafts`. `MANUAL` keeps `false`. Add a test asserting that a saved demo draft gives
  `is_demo = 1`.

### L2 (Low): there is no per-space cap on drafts

- Where: `src/lib/server/drafts/repo.ts:421-507` (`seedDemoDrafts`) and `migrations/0008_drafts.sql`.
- Scenario: every seed call adds 4 rows without limit, and nothing bounds `drafts` per space. Only the dev seed
  writes drafts today, so the issue cannot be reached in production. FN-14 onward will add real capture writers, and
  without a cap (as transactions have `MAX_TRANSACTIONS_PER_SPACE`) a flood of forwarded mail could grow one
  space's drafts without limit. List and count queries stay bounded (`limit 100`, SQL `count(*)`).
- Fix: add `MAX_DRAFTS_PER_SPACE` as a guarded condition in the drafts insert before FN-14 adds a real writer.

## Verified (no finding)

- **Insert path (`insertTransactions` / `createTransaction(…, origin)`):** the only route caller,
  `riwayat/baru/+page.server.ts:57`, passes no origin, so it gets `MANUAL` (`source='manual'`, `dedupe_key` null,
  time-or-save-instant rule). No form field reaches `source`, `dedupe_key`, `is_demo` or `occurred_at`. Draft saves
  take these only from the stored draft row, never from the request. `refsHold` is repeated per row in SQL: wallet
  live, in the same space, same currency; category visible, same space, same kind. `isLiveMember` and the cap
  (`count + rows <= MAX`) sit in the same statement. `capturedTransactionInput` reuses the FN-05 `fieldsSchema` and
  `refErrors`, checks the amount 1…MAX and that the wallet currency equals the draft currency, and is backed by
  `transactions_content_check`. Hidden categories and archived wallets are excluded from the lookup (`listCategories`
  and `listWallets` defaults) and again in SQL. Transfers cannot happen (the `drafts_type_check` CHECK).
- **Draft IDOR:** tested live with two users. B's save, discard and setWallet on A's draft (with the correct
  `id:updated_at`) answered 409 "sudah tidak ada", 404 "Draf tidak ditemukan" and 400. A's setWallet with B's wallet
  and B's setCategory with A's category answered not found. Zero rows changed. Every query carries `space_id` from
  `currentSpaceScope` (`requireSpaceAccess`) plus `isLiveMember` inside the write. The removed-member case is covered
  by `kotak-masuk-routes.test.ts:428` and `drafts.test.ts:516`. Discarded and saved drafts are excluded by
  `deleted_at is null`.
- **Bulk atomicity:** `allOrNothing` asserts in the same `db.batch` that the number of drafts stamped with this
  batch's seq equals the expected count. The tombstone only applies where its transaction exists. The insert repeats
  "draft pending at this updated_at". Live results: a pre-existing dedupe key made the whole 3-draft save write 0
  rows (409 ALREADY_RECORDED); a double save answered 409 with the count still 2; a tampered `updated_at` (`:1`)
  answered 409 SELECTION_CHANGED with 0 written. `drafts.test.ts:539` (20 concurrent overlapping saves, each draft
  saved exactly once) passes.
- **updated_at tampering:** a per-checkbox token must equal the stored value (in JS and in SQL `matchesRefs`). A
  member can only act on drafts they can already see, so tampering only gives a refusal.
- **Dev seed:** with no `DEV_ROUTES`, `?/seedDemoDrafts` and `?/clearDemoDrafts` answer 404 and leave 0 rows. With
  `DEV_ROUTES=1`, a posted `space=` field is ignored and rows land only in the caller's current space under
  `isLiveMember`. `devRoutesEnabled` needs `dev` or exactly `"1"`.
- **Notice cookie:** HttpOnly, SameSite=Lax, `__Host-` prefix when secure, 60 s, cleared when read, strict
  `^\d{1,5}$`×4 parse, ≤10 000, rendered as text. It is set only after a confirmed batch. Spoofing needs a cookie
  write on the host, and the result is only a misleading count on the user's own screen.
- **Caps:** `parseSelection` reads ≤200 tokens, deduplicates by id and keeps ≤50. The body is capped at 8 KiB
  (a 9 KB body got 400 "Invalid form"). The list is limited to 100 rows and the count is computed in SQL. JSON
  binding avoids the 100-parameter limit.
- **Content-free discard:** tombstones null every content column (`drafts_content_check` enforces it). Verified
  rows have `amount_minor`, `title` and `wallet_id` null and keep only `dedupe_key` and `saved_transaction_id`.
- **Rendering:** no `{@html}` in the new pages or components. Draft title and note render as text. `{#each}` is
  keyed by id or date. `dedupeKey` is excluded from page data (`view()`).
- **CSRF:** a cross-origin POST to `?/save` answered 403 (SvelteKit origin check). CSP `form-action 'self'` is
  unchanged.
- **Account deletion:** `drafts` is listed first in `SPACE_SCOPED_TABLES` (FK order).
- **Logs:** only `console.error` on load failure, with no draft content.

## Commands run

- `npx svelte-kit sync`; `npm run db:migrate:local`, which applied 0001–0008 (✅).
- `npm run build`: done.
- `npx vitest run test/integration/drafts.test.ts test/integration/kotak-masuk-routes.test.ts
  src/lib/server/transactions/validation.test.ts`: 3 files, 59 tests passed.
- Ad-hoc `wrangler dev` on 8810 with a fresh local `--persist-to` in the scratchpad, first without and then with
  `--var DEV_ROUTES:1`. Probes ran with two signed-up users using curl-equivalent fetch. Both servers were stopped.
  Nothing used `--remote`, login or deploy.
