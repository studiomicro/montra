# FN-04 Wallets — QA Report

## Verdict: PASS

Reviewed at commit `9c004eb` (engineer cycle 2, rebased onto `main` 1bcaa94). `npm run gates` is clean, the
full Playwright e2e suite passes, a fresh local D1 applies migration `0003_wallets.sql` without error, and
every acceptance criterion in `docs/features/fn-04-wallets/PRD.md` is covered by an automated test that was
run and passed, or verified directly in code review.

## Commands run

- `npm ci` — installed dependencies, exit 0, no network calls beyond local registry (fixture/local).
- `npx svelte-kit sync` — generated types, exit 0 (local).
- `npm run gates` — exit 0: svelte-check 1011 files / 0 errors / 0 warnings; prettier + eslint clean; Vitest 44 files / 389 tests passed; build done (local D1/mocked bindings, no real provider).
- `rm -rf .wrangler/state/v3/d1 && npm run db:migrate:local` — fresh local D1: 0000/0001/0002/0003 all ✅, `0003_wallets.sql` applied cleanly (local D1, not remote).
- `LD_LIBRARY_PATH=<scratchpad> CI=1 npx playwright test` — exit via summary: 93 passed, 12 skipped, 0 failed, 0 flaky (local wrangler dev on 127.0.0.1:8787, local D1, no real provider).

(`kj::getCaughtExceptionAsKj` / "Connection reset by peer" lines in the e2e webServer log are workerd's own dev-server teardown noise between projects, not a test failure — no test in the run reports failed/flaky.)

## Checked criteria

1. PASS — empty state copy + "Tambah dompet" action, no "Rp" in `<main>`. `test/integration/kekayaan-routes.test.ts` › "an account without wallets gets an empty list"; e2e "first wallet: empty state …".
2. PASS — active wallets listed favourite-first then oldest, name/type/masked last-4/`formatMoney` balance. `test/integration/wallets.test.ts` › "lists live wallets favourite first then oldest first"; e2e row assertions (`•••• 1234`, `Rp 1.250.000`).
3. PASS — load is awaited server-side (no client fetch race); skeleton rows cover the retry-after-error path (`ErrorState` + retry, confirmed in route source and test "a failing list read becomes the error state").
4. PASS — a throwing `listWallets` is caught in `+page.server.ts`'s `load` and returns `loadError`, never an unhandled 500. `test/integration/kekayaan-routes.test.ts` › "a failing list read becomes the error state, never a 500".
5. PASS — archived wallets hidden by default, shown under `?arsip=1` with "Diarsipkan" and only "Pulihkan". `test/integration/wallets.test.ts` › "lists live wallets … archived only on request"; e2e archive/restore journey.
6. PASS — `createWallet` validates then inserts with `digitsToMinor`, sheet closes, list refreshed via `invalidateAll`. e2e "first wallet …"; `test/integration/kekayaan-routes.test.ts` › "saves, survives a reload…".
7. PASS — same test reloads the page and the wallet is still present (server-persisted, not in-memory).
8. PASS — `cleanText` strips control/zero-width and empty name fails `NAME_REQUIRED` before any row is written. `src/lib/server/wallets/validation.test.ts`; `kekayaan-routes.test.ts` › "refuses invalid fields … writes nothing".
9. PASS — `lastFour` regex `^\d{4}$` refuses a 16-digit paste with a field error, never truncates. e2e "first wallet…" (16-digit refusal) and no-JS test; `validation.test.ts`.
10. PASS — first wallet forced favourite via guarded `INSERT…SELECT` (`not exists … is_favourite=1`); second wallet defaults non-favourite, first untouched. `wallets.test.ts` › "stores integer minor units … the first wallet is the favourite, the second not".
11. PASS — `favouriteSwap` is one guarded `UPDATE…CASE` inside one `db.batch`, never two separate writes. `wallets.test.ts` › "ticking favourite moves it…"; 20-concurrent test (see 22).
12. PASS — `?tambah=1`/`?ubah=<id>` inline form works without JS; e2e "without JavaScript: a refused add shows the error, a valid add is listed".
13. PASS — `updateWallet` updates row, advances `updated_at`, list reflects only after server confirms (`invalidateAll` after action success). `kekayaan-routes.test.ts` › "an edited opening balance is the balance on the next load".
14. PASS — stale `updated_at` guard refused with "Berubah sejak terakhir dimuat." `kekayaan-routes.test.ts` › "a second tab's stale edit gets changed meanwhile"; e2e two-tab test.
15. PASS — balance recomputed as `openingBalanceMinor + 0` on reload, no cached figure (server-rendered load, no client cache). Same test as 13.
16. PASS — archive sets `deleted_at`, bumps `seq`, disappears from default view immediately after confirmation. `wallets.test.ts` › "archiving the favourite passes it…"; `kekayaan-routes.test.ts` › "archive hides the wallet and moves the favourite…".
17. PASS — `favouriteRepair` gives the favourite to the oldest live wallet, or leaves none favourite if the space is empty. `wallets.test.ts` › "archiving the favourite passes it to the oldest live wallet, or to none when none is left".
18. PASS — restore clears `deleted_at`, bumps `seq`, reappears. `wallets.test.ts` › "restores an archived wallet with a new seq…"; e2e restore-from-archive step.
19. PASS — `walletBalanceMinor(wallet, 0) === wallet.openingBalanceMinor` exactly; signature unchanged (`wallet`, `transactionsSumMinor = 0`) for FN-05. `src/lib/server/wallets/balance.ts` reviewed directly; used identically at the one load call site.
20. PASS — every load/action calls `requireSpaceAccess`/`walletScope` with `locals.user`/`locals.space`, never a client-supplied `spaceId`; unknown vs. other-space ids answer identically (`whyNot` → `missing`/`stale` only, same `fail(404/409)` bodies). `kekayaan-routes.test.ts` › "answers missing for an unknown id and for another space's wallet alike, writing nothing" and the "one access rule" describe block.
21. PASS — non-member and removed-member probes get 404/404 on every action, nothing 200s with another space's data. `kekayaan-routes.test.ts` › "a non-member and a removed member see nothing and get the unknown-id answer on every action"; engineer's pre-handoff wrangler-dev probe (report, cross-space section) corroborates with real HTTP requests.
22. PASS — 20 concurrent `setFavourite` across two wallets leave exactly one favourite, verified at both the repo layer and the route layer. `wallets.test.ts` › "20 concurrent swaps across two wallets end with exactly one favourite"; `kekayaan-routes.test.ts` › "20 concurrent favourite submissions across two wallets leave exactly one favourite".
23. PASS — `readFormBody` (FN-01's shared guard) used for every action; oversized/malformed body answers 400/415, never 500, no row written. `kekayaan-routes.test.ts` › "answers 400 to a 20 KB body and 415 to a non-form body, never 500, writing nothing".
24. PASS — `{#each active as wallet (wallet.id)}` and `{#each archived as wallet (wallet.id)}` in `+page.svelte`, confirmed by direct read of the file.
25. PASS — repo-wide `test/i18n-coverage.test.ts` (part of `npm run test`, in the clean gates run) fails the build on a missing English entry; 61 new lines added to `i18n-en.ts` per the diff stat, all type labels/form copy verified present in `src/lib/shared/wallets.ts`/`WalletForm.svelte`.
26. PASS — every balance figure goes through `formatMoney` (`+page.server.ts` load, `+page.svelte` display); no hand-built `Rp` string found by direct grep of the route files.
27. PASS — `Sheet.svelte` restores focus to `opener` on close (`handleClose`); e2e "focus returns to the opener when the sheet closes" and the two-sheets 360 px test confirm unique title ids and 44 px targets; light/dark 360 px test passed in the e2e run (phone project).
28. PASS — refusal bodies are fixed strings (`WALLET_NOT_FOUND`, `WALLET_CHANGED`, etc.), no id/path/stack. `kekayaan-routes.test.ts` › "user-facing answers never carry an id".
29. PASS — `npm run gates` clean (re-verified this run, not just trusted from the engineer report); engineer report documents fail-before proof for the favourite race, stale-edit guard, cross-space probe and last-4 validation (mutation-and-revert method, each one specifically named).

## Cross-cutting / checklist spot-checks

- `wallets` and `space_seq` are both present in `SPACE_SCOPED_TABLES` (`src/lib/server/spaces/spaces.ts`), ahead of `space_members`; `test/integration/wallets.test.ts` › "every table with a space_id column is in SPACE_SCOPED_TABLES" and "removes the space's wallets and seq counter … and nothing of another space" both pass, confirming the purge test specifically requested.
- Currency is an explicit server-side allow-list (`WALLET_CURRENCIES`, zod `z.enum`), not a regex; `XAU`/`__proto__`/`constructor` are rejected (validation tests + e2e no-JS currency-rejection path in the engineer's probes).
- `lastFour` is refused by a CHECK-backed regex, never truncated on write or display (`maskedLastFour` only ever reads a stored 4-digit value).
- Negative opening balance allowed for any wallet type via the "Saldo minus" checkbox (owner decision D); e2e credit-card test shows `−Rp 2.500.000` rendered correctly.
- Money is integer-only throughout (`digitsToMinor`, `Number.isSafeInteger` guards in both `validation.ts` and `balance.ts`); no `parseFloat` found in the wallet modules.
- No WIB/date-bucket logic applies to this feature (no `occurred_on` concept yet — correctly out of scope per PRD).
- No fabricated figures: balance is exactly `openingBalanceMinor`, no invented transaction sum.
- `docs/ENGINEERING_CHECKLIST.md` items checked against the diff: concurrent writes (guarded single-statement swaps), bounded work (`MAX_WALLETS_PER_SPACE` = 50, enforced in SQL), migrations (new `0003` only, none edited), integers only, one access rule / no existence oracle, masking, untrusted text, tombstones, form-body guard, keyed lists, i18n, currency display, accessibility (focus return, `role=status`/`alert`, fieldset/legend) — all satisfied, no violation found.

## Findings

None. No FAIL criteria this run.
