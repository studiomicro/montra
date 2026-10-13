# FN-04 Wallets — engineer report (cycle 1)

Branch `fn-04-wallets` from `a1ef466` (FN-00 + FN-01 cycle 1 + FN-03 cycle 1). Not pushed. Rebase onto `main`
once FN-01 and FN-03 merge: FN-04's changes are self-contained (own migration, `src/lib/server/wallets/`,
`src/lib/server/sync/seq.ts`, `/kekayaan` route); the only touches to shared files are listed below.

## What works

- `/kekayaan` lists the current space's live wallets (favourite first, then oldest), each with name, type label,
  `•••• 1234` when a last-4 is set, and the balance via `formatMoney` (balance = `walletBalanceMinor(w, 0)` =
  opening balance). Empty state "Belum ada dompet. Tambah satu untuk mulai mencatat." with "Tambah dompet" and no
  figure. "Lihat yang diarsipkan" (`?arsip=1`) shows archived wallets marked "Diarsipkan" with only "Pulihkan".
- Add / edit in a `Sheet` (JS) or inline via `?tambah=1` / `?ubah=<id>` and refused submissions (no JS): name,
  type (5 radio pills), currency (allow-list select), opening balance (`AmountInput`, whole units) with a
  "Saldo minus" checkbox (decision D), optional last-4, "Jadikan favorit". Archive (details confirm) in the edit
  form; favourite star per row; restore in the archive view.
- Success is shown only after the action returns; the list is reloaded from the server (`update()` →
  `invalidateAll`); 404/409 refusals reload the list and refresh an open edit form; a network/500 error shows
  "Tidak bisa menyimpan…" instead of the error page. A failing list read renders `ErrorState` with retry
  (skeleton rows while retrying).

## Files

- Migration `migrations/0003_wallets.sql` (+ snapshot, journal): `wallets` (CHECKs on type and last-4 = 4 ASCII
  digits, index `(space_id, deleted_at)`, FK → spaces ON DELETE CASCADE) and `space_seq` (per-space counter, FK
  cascade). Schema in `src/lib/server/db/schema.ts`.
- New: `src/lib/server/wallets/{repo,balance,validation,messages}.ts`, `src/lib/server/sync/seq.ts`,
  `src/lib/shared/wallets.ts`, `src/lib/ui/wallets/WalletForm.svelte`, `src/routes/(app)/kekayaan/+page.server.ts`.
- Changed: `src/routes/(app)/kekayaan/+page.svelte` (replaces stub), `src/lib/server/spaces/access.ts`
  (+`isLiveMember` SQL guard next to `isSharedSpaceOwner`), `src/lib/ui/shell/Sheet.svelte`,
  `src/lib/ui/kit/AmountInput.svelte` (+`name`, `currency`, server-rendered initial value),
  `src/lib/ui/shell/EmptyState.svelte` (+optional `onaction`), `src/lib/ui/icons.ts` (+`star`),
  `src/lib/shared/i18n-en.ts` (45 entries), `vitest.config.ts` (svelte plugin for `svelte/server` render tests).
- Tests: `test/integration/wallets.test.ts` (18), `test/integration/kekayaan-routes.test.ts` (16),
  `src/lib/server/wallets/validation.test.ts` (12), `src/lib/shared/wallets.test.ts` (3),
  `src/lib/ui/shell/Sheet.test.ts` (2), `src/lib/ui/kit/AmountInput.test.ts` (3), fixture
  `test/fixtures/TwoSheets.svelte`.

## FN-00 deferred items closed

1. `Sheet`: title id from `$props.id()` (two sheets on one page — the layout's add sheet and this one — no
   longer share `sheet-title`), `max-height: calc(100dvh − 24px − safe-area)` + `overflow-y: auto` +
   `overscroll-behavior: contain` with a sticky header, optional `onclose` callback. Server-render test + CSS test.
2. Unknown currencies: wallet currency is an explicit allow-list `IDR, USD, SGD, MYR, EUR, JPY, AUD, GBP`
   (`WALLET_CURRENCIES`), validated server-side with zod; `__proto__`/`constructor`/`XAU` refused; a test checks
   every allowed code has a known exponent.

## Gates

`npm run gates` exit 0: svelte-check 999 files 0 errors 0 warnings; prettier + eslint clean; Vitest 41 files /
359 tests passed; build ✔ done.

## Fail-before proof (mutation runs, each reverted with `git checkout`)

- favourite as two separate writes (clear, then set) → 2 fail (repo 20-concurrent, route 20-concurrent).
- no `updated_at` guard on update → 4 fail (stale edit ×2, stale favourite edit, malformed `updatedAt`).
- favourite swap without the space filter → 2 fail (cross-space route probe, repo other-space favourite).
- last-4 truncated to 4 instead of refused → 2 fail. Currency regex instead of allow-list → 2 fail.
- FN-03's original `Sheet.svelte` → 2 fail (duplicate title id, no max-height/scroll).

## Pre-handoff probes (wrangler dev 127.0.0.1:8795, scratch `--persist-to`, fetch with `accept: text/html`, no JS)

- Concurrency: 20 concurrent `?/setFavourite` across two wallets → `{"200":20}`, exactly 1 favourite shown.
  Repo: 10 concurrent creates at cap−3 → 3 created / 7 `limit`; 10 concurrent first wallets → 1 favourite.
- Two tabs / stale forms: same `updatedAt` twice → 200 "Perubahan disimpan." then 409 "Berubah sejak terakhir
  dimuat. Muat ulang lalu coba lagi."; list keeps the first edit. Stale archive/restore → 409 (Vitest).
- Cross-space: non-member — GET `/kekayaan?arsip=1` 200 without the wallet; updateWallet / archiveWallet /
  restoreWallet / setFavourite 404/404 (theirs/unknown id), bodies identical after nonce normalisation. Removed
  member with the `space` cookie still naming the shared space → falls back to personal; same 404/404 identical
  on all four; shared wallet unchanged. Stale `locals.space` after removal → helper's 404 (Vitest). Timing:
  median 7.6 ms (not mine) vs 7.3 ms (missing), 30 each.
- 20 KB body → 400; JSON body → 415 (no row written).
- No-JS forms: create → 200 with "Dompet ditambahkan.", row listed, `•••• 1234`, `Rp 25.000` (NBSP); 16-digit
  last-4 → 400 with "Isi tepat 4 angka terakhir saja…", typed values echoed, no row; `XAU` → 400 "Pilih mata
  uang dari daftar."; empty page → empty copy, no "Rp" in `<main>`.
- `{#each}`: wallet lists keyed by `wallet.id`; type/currency pickers by the constant code.
- User copy: refusal bodies carry only the fixed messages; no id, path or stack in a non-member's refusal page.
- 360 px / contrast / focus return in a browser: **not run** (no Playwright this cycle; see e2e list). Kit
  components and tokens only, 44 px targets (rows, star, pills, checkboxes, toggle).
- Money vectors / month boundaries / two devices: not applicable (no parser, dates or sync in FN-04).

## Checklist items applied

Concurrent writes (favourite swap = one guarded `UPDATE`; create cap and first-favourite in one guarded
`INSERT … SELECT`; all in `db.batch` with the seq bump; concurrency tests); bounded work (list `LIMIT 50` = per-
space cap, counts in SQL); migrations (new 0003, none edited); integers only (`digitsToMinor`, 13-digit cap, no
`parseFloat`, safe-integer balance); one currency per figure (no cross-wallet total); one access rule / no oracle
(`requireSpaceAccess` on every load/action + `isLiveMember` inside every write; unknown and other-space ids get
the same 404 body); masking (last-4 validated, never truncated, CHECK in SQL); untrusted text (`cleanText`);
tombstones (`deleted_at`, seq advances); form bodies (`readFormBody`); keyed lists; CSP (no inline styles);
i18n; currency display (`formatMoney`/`moneyParts`); truthful state; accessibility (labels, fieldset/legend,
`role=status`/`alert`, focus returns to the opener via `Sheet`); gates; fail-before proof.

## Decisions taken under the owner's standing instruction (recommended defaults)

1. Seq counter: a `space_seq` table (named in `docs/ARCHITECTURE.md` › Data model) with `bumpSpaceSeq` /
   `currentSpaceSeq` in `src/lib/server/sync/seq.ts`, instead of the PRD's `app_meta` fallback — it cascades with
   the space and FN-05 reuses it.
2. Per-space cap of 50 wallets (archived included), which also bounds the list query.
3. Archive keeps the row's content (it is shown in the archive view and restorable, criteria 5/18); the
   content-free tombstone rule applies to sync payloads once FN-02 exists.
4. Type picker: native radio pills instead of `Segmented` (5 options do not fit 360 px, and `Segmented` buttons
   do not submit without JS). Type shown as text in the meta line; favourite as a filled star (not `Chip`/`Badge`:
   `Chip` is a button).
5. Negative opening balance via a "Saldo minus" checkbox (AmountInput is digits only).
6. Unticking favourite on the favourite wallet is a no-op (always exactly one); the form says so.
7. Load is awaited on the server (not streamed), so no-JS clients get the list; there is therefore no
   in-flight first render — skeleton rows show while a retry reloads (criterion 3 read in that sense).
8. Every wallet write re-checks live membership in its own SQL (`isLiveMember`, mirroring FN-03's
   `isSharedSpaceOwner`).

## Concerns

- Rebase: `money-format.ts` `Object.hasOwn` fix is on `main` only; FN-04 does not depend on it (currencies are
  allow-listed, and `validation.ts` reads the exponent only for allowed codes). `Sheet.svelte` will need a trivial
  merge with `main`'s `--scrim` backdrop change.
- `vitest.config.ts` now loads `@sveltejs/vite-plugin-svelte` (needed for `svelte/server` component tests).
- No total across wallets on `/kekayaan` (would mix currencies; net worth is FN-25).

## E2E journeys FN-04 needs (not added; needs FN-01's signed-in fixture)

1. Signed-in user on `/kekayaan` sees the empty state → "Tambah dompet" opens the sheet → fills name, type,
   balance, last-4 → saves → sheet closes, row appears with `•••• 1234`, focus back on the opener; reload keeps it.
2. Edit → change balance with "Saldo minus" → row shows `−Rp …`; second tab's stale save shows "Berubah sejak…".
3. Star another wallet → favourite moves; archive the favourite → favourite passes on; "Lihat yang diarsipkan"
   → "Pulihkan".
4. Long form in the sheet scrolls inside the sheet at 360 × 640; Escape/backdrop close; two sheets (Tambah tab +
   wallet sheet) labelled correctly.
5. No-JS variant of add (refusal + success), 360 px layout, both themes, AA contrast of pills/star.

## Cycle 2 (rebase onto `main` 1bcaa94, purge list, e2e)

- Rebased onto FN-03 final (1bcaa94). `access.ts`: main's version plus `isLiveMember`; `Sheet.svelte` keeps
  main's `--scrim` with `$props.id()` / max-height / `onclose`; migration stays 0003 (snapshot and journal
  regenerated against main's 0002; SQL identical).
- `wallets` and `space_seq` (per-space counter rows) added to `SPACE_SCOPED_TABLES`, before `space_members`.
  Tests: every schema table with a `space_id` column must be in the list (fails when `wallets`/`space_seq` are
  removed from it); `purgeSpaces` removes a space's wallets (archived too) and counter and nothing of another
  space; account deletion leaves no wallet or counter row. (The FK `ON DELETE CASCADE` would also remove them; the
  list makes it explicit.)
- Restore form posts to `?arsip=1&/restoreWallet`, so the archive view stays open after a restore (with and
  without JavaScript); found by the new e2e journey.
- `e2e/kekayaan.spec.ts` (each test signs up its own user in its own context with its own simulated
  CF-Connecting-IP): first wallet through the sheet incl. refused 16-digit last-4, reload persists; focus returns
  to the opener on Escape; negative balance edit + second tab's stale save refused; favourite star, archive of the
  favourite passes it on, restore from the archive view; sheet scrolls at 360 × 640 with unique title ids;
  360 px light/dark with 44 px targets; no-JS refused + successful add.
- `npm run gates` exit 0: svelte-check 1011 files 0 errors 0 warnings; prettier + eslint clean; Vitest 44 files /
  389 tests; build done. `npm run test:e2e` (CI=1): 93 passed, 12 skipped, 0 failed, 0 flaky.

## Cycle 3 (red-team Lows)

- L2: the opening balance is read strictly per the form contract (whole units; plain digits or Indonesian
  thousands dots in groups of three, trimmed): `12.50`, `12,50`, `1e3`, `1 250`, `1.2500` → 400 "Isi saldo awal
  dengan angka bulat, tanpa sen."; `1.250` → 1 250 units, `1.250.000`, ` 25000 ` accepted. Fail-first: unit test
  and route test failed before the fix.
- L1: a refused last 4 is never echoed (`values.lastFour` emptied on that error) and the sheet's field is cleared
  client-side; unit, route (400 body has no submitted digits) and e2e (JS and no-JS) assertions.
- Gates exit 0 (svelte-check 0/0, lint clean, Vitest 44 files / 391 tests, build done); e2e 93 passed, 12
  skipped, 0 failed.
