# FN-04 Wallets — Security report

Reviewed: `git diff 1bcaa94..9c004eb` (cycle 2), against `docs/features/fn-04-wallets/PRD.md` and
`docs/ENGINEERING_CHECKLIST.md`. Reviewer: red-team-pentester, 2026-10-08.

## Verdict: PASS

No critical, high or medium findings. Two low findings are tracked below.

## Scope checked

- **IDOR / cross-space.** Every load and action resolves the space from `locals.space` and calls
  `requireSpaceAccess(locals.db, user.id, …)` (`src/routes/(app)/kekayaan/+page.server.ts:34-41`). No client-sent
  `spaceId` is read. Every repo write filters `wallets.id` and `wallets.space_id` together and repeats
  `isLiveMember` inside the same statement (`src/lib/server/wallets/repo.ts:144,210,266,303,336`). Live probe
  (user B against user A's wallet id): `archiveWallet`, `setFavourite` and `updateWallet` each returned
  `404 "Dompet tidak ditemukan."`, the same answer as for an unknown id. `whyNot` looks up only inside the
  caller's space, so another space's id and an unknown id take the same code path, which gives no existence
  oracle. `?ubah=<foreign id>` only echoes the id back as `open` and returns no wallet data.
- **Removed member / archived wallet.** The hook re-validates `locals.space` on every request, and
  `isLiveMember` covers removal that happens between the access check and the write (tests
  `wallets.test.ts:299`, `kekayaan-routes.test.ts:358,393`). An archived wallet gets `missing` on
  update/favourite, and only `restoreWallet` matches `deleted_at IS NOT NULL`.
- **Favourite swap.** One guarded `UPDATE … CASE` (`repo.ts:125-148`) sets the new favourite and clears the
  old one in a single statement. The 20-way concurrent test holds exactly one favourite. `favouriteRepair` has
  no member guard, but it only fills an empty favourite slot and cannot change data the caller could not
  already change.
- **space_seq.** An upsert `+1` comes first in every batch. D1 runs a batch as one transaction, so `seq`
  increases strictly per space, and a client never sends it. Refused writes leave gaps, which is acceptable.
- **Money.** No `parseFloat` is used. Input must match `/^[\d. ]*$/` with at most 13 digits and then goes
  through `digitsToMinor`. zod then requires `int` and `Number.isSafeInteger`. Probes: `1e20`,
  `99999999999999999` and `-500` are each refused with 400. A negative value is possible only through the
  explicit `negative=on` checkbox (owner decision D).
- **Currency.** The server-side `z.enum(WALLET_CURRENCIES)` check holds. Probes: `XXX` and `idr` are both
  refused with 400.
- **Last-4.** The value must match `/^\d{4}$/` (ASCII only), and a DB `CHECK` constraint backs this up. A
  16-digit number and full-width `１２３４` are both refused. The value is never truncated, never stored and
  never logged.
- **50-wallet cap.** The cap is enforced by a guarded `INSERT … SELECT … WHERE count < 50`, which counts
  archived wallets too, and it is covered by a concurrent test (`wallets.test.ts:118`).
- **Forms and CSRF.** All actions read the body through `readFormBody` (8 KiB cap, 415 for non-form bodies).
  SvelteKit's default origin check stays on: probes with no Origin header and with
  `Origin: https://evil.test` both got 403, and `text/plain` got 415.
  `action="?arsip=1&/restoreWallet"` routes correctly to `restoreWallet` (200 `restored`).
- **Purge.** `wallets` and `space_seq` are in `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts:224-230`),
  ahead of `spaces`. A test (`wallets.test.ts:327`) fails if any table with a `space_id` column is missing
  from the list.
- **Output.** There is no `{@html}`. Signed-in responses carry `cache-control: private, no-store`. Error copy
  contains no ids or stack traces.

## Findings

### L1 (low): a refused full card number is echoed back in the action response

- **Where:** `src/lib/server/wallets/validation.ts:65` (`lastFour: … .slice(0, 64)` copied into `values`),
  returned at `src/routes/(app)/kekayaan/+page.server.ts:94,108–113`, and re-rendered at
  `src/lib/ui/wallets/WalletForm.svelte:110`.
- **Scenario:** A user pastes `4111111111111111` into the last-4 field. The 400 response body (devalue JSON,
  or the no-JS HTML page) contains the full PAN, which is then put back into the input. The number is not
  stored or logged, but it travels in a response body and sits in the DOM, where browser autofill history,
  screen recorders or a shared screen can capture it.
- **Reproduction:** `POST /kekayaan?/createWallet` with `lastFour=4111111111111111` returns 400, and the body
  contains `"4111111111111111"`.
- **Fix:** On a last-4 error, echo `''` or only the last 4 characters as a hint (e.g. `values.lastFour = ''`).

### L2 (low): a decimal opening balance in a 2-decimal currency is silently read as 100× (no-JS path)

- **Where:** `src/lib/server/wallets/validation.ts:22,44-49`. `BALANCE_TEXT` accepts `.`, which is then
  stripped as a thousands separator.
- **Scenario:** With JavaScript off, or with a crafted POST, a user enters `12.50` for a USD wallet and the
  form stores `125000` minor units (US$1,250.00) with no error. With JavaScript on, `AmountInput` shows
  `1.250`, so the user can see it. This breaks money integrity, not security. It belongs in the report
  because the checklist rule "money is never invented" applies.
- **Reproduction:** `POST ?/createWallet` with `currency=USD&openingBalance=12.50` returns 200 and stores
  `openingBalanceMinor: 125000`.
- **Fix:** Accept `.` only as a well-formed group separator (`^\d{1,3}(\.\d{3})*$`), or reject a `.` group
  of a length other than 3, and return `BALANCE_INVALID`.

## Commands run

- `npx vitest run test/integration/wallets.test.ts test/integration/kekayaan-routes.test.ts src/lib/server/wallets`:
  3 files, 48 tests passed.
- `npm run build`: exit 0. `npm run db:migrate:local` applied `0003_wallets.sql`.
- Ad-hoc `wrangler dev --port 8800` (local only), with two accounts probed via curl as listed above. Server
  stopped afterwards.
