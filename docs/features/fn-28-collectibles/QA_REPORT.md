# FN-28 Collectibles (Koleksi): QA report

## Verdict: PASS

Reviewed `git diff 9d3e892..aca978e` (isolated detached checkout at `aca978e`, on `main` 9d3e892). `npm run gates`
is clean, the full Playwright suite is clean (incl. `koleksi.spec.ts` on phone and desktop, 10/10), and every
acceptance criterion is verified below, either by the engineer's tests (independently re-run) or by my own
reading of the code and the live Pokémon TCG API.

## Commands run

- `npm ci` → exit 0 (installs from lockfile, no provider).
- `npx svelte-kit sync` → exit 0.
- `npm run db:reset:local` → exit 0, local D1 reset through migration 0016 (mock/local D1, no provider).
- `curl -s -m 8 https://pokemontcg.io/` and `…/docs.pokemontcg.io/` → real provider, confirms "Scrydex" migration
  banner and "deprecated" text, independently verifying the engineer's build-time check.
- `npm run gates` → exit 0: check 0 errors/0 warnings (1305 files); lint clean; vitest 117 files / 1869 tests
  passed; build OK. Local D1/KV/R2 (miniflare), no real provider.
- `npx vitest run --maxWorkers=2 test/integration/koleksi.test.ts test/integration/barang.test.ts
  test/integration/delete-account.test.ts src/lib/server/collectibles src/lib/server/photos
  src/lib/shared/collectibles.test.ts src/lib/ui/shell/nav.test.ts scripts/demo-seed.test.ts` → 9 files / 134
  tests passed (local D1 + miniflare R2, re-run independent of the engineer's own run).
- `E2E_PORT=8867 LD_LIBRARY_PATH=<scratchpad> npx playwright test --workers=2`
  → 244 passed, 15 skipped, 0 failed, exit 0 (local wrangler dev + miniflare, real headless Chromium browser; no
  real external provider). No rerun needed — zero failures on the first pass. `koleksi.spec.ts`: 5/5 phone, 5/5
  desktop, all passed.

## PRD-flagged question: no automatic price, separate /kekayaan row

- **No automatic pricing at all (manual-only for every collectible).** The PRD's own Prerequisites section
  explicitly pre-authorises this exact outcome: "if that [keyless Pokémon TCG access] has changed since this PRD
  was written (2026-10-08), the feature ships with every collectible on manual value only and the toggle removed
  or disabled… the acceptance criteria above already require a graceful manual fallback, so no PRD rewrite is
  needed either way." I independently fetched `https://pokemontcg.io/` and `https://docs.pokemontcg.io/` and
  confirmed the deprecation/Scrydex-migration banner the engineer cited. **Not a FAIL**: this is PRD-sanctioned,
  and AC2/AC5/AC6 (which only apply when `price_source = 'pokemontcg'` exists) hold vacuously/trivially since
  that path was never built — correctly, per the PRD's own fallback clause.
- **Not folded into the FN-25 net-worth total; its own `/kekayaan` row instead.** The PRD's Goal section says
  collectibles "complete the net-worth picture" but no acceptance criterion or architecture note requires the
  figure to be summed into FN-25's own total rather than shown as its own Kekayaan row — the same pattern
  FN-27 (Barang) already uses and that FN-27's own QA_REPORT ruled was not a FAIL for the identical reason.
  Consistent precedent, not a new deviation. **Not a FAIL.**

## Checked criteria (PRD acceptance criteria 1–11)

1. **Manual value is exact, no fetch** — PASS. `toCollectible()` sets `valueMinor = manual_value_minor` always;
   there is no `prices.ts`, no `price_source` column, no fetch call anywhere in `src/lib/server/collectibles/`
   or the route (`grep -rn pokemontcg src/ workers/` → no hits). Test:
   `test/integration/koleksi.test.ts` "no create, edit or delete calls out to any network".
2. **Pokémon TCG caching/fallback** — N/A, PRD-sanctioned (see above): the path was never built, verified
   deprecated upstream.
3. **Gain = currentValue − purchasePrice, exact integer, rupiah first, percent secondary** — PASS.
   `collectibleGainMinor()` (src/lib/shared/collectibles.ts) does the subtraction with a safe-integer guard;
   `+page.svelte` renders `formatMoney(gainMinor, 'signed')` first and `formatPermille(gainPermille(...))` as a
   smaller secondary line; percent omitted for a zero purchase price. Unit test
   `src/lib/shared/collectibles.test.ts` (gain exactness at the 13-digit max, permille rounding toward zero).
4. **Photo upload/serving matches FN-27 AC4–6** — PASS. Shared `src/lib/server/photos/` module used by both
   `/barang` and `/koleksi` identically (magic-byte sniffing, 8 MiB cap, random space-scoped key, authenticated
   serve-only route, tombstone clears `photo_key`, best-effort R2 cleanup via outbox + sweep). Re-ran
   `test/integration/koleksi.test.ts` photo describe block (10 tests) and `src/lib/server/photos` unit tests
   myself — all passed.
5. **Toggle off ⇒ no network call** — PASS trivially: there is no toggle wired to a real call; "Harga pasar
   otomatis" is a disabled checkbox with "Belum dikonfigurasi…" and no handler. e2e
   `koleksi.spec.ts:206` asserts zero off-origin requests.
6. **No browser ever calls the price/FX host; CSP lists no such host** — PASS. Global CSP `connect-src 'self'`
   is untouched by this diff (`grep -rn connect-src src/` shows only the FN-25 comment, unchanged); no
   `api.pokemontcg.io` reference anywhere in `src/` or `workers/`.
7. **`koleksi` hidden via FN-12 still loads and counts** — PASS. `/koleksi` shows "Koleksi disembunyikan dari
   menu. Angkanya tetap dihitung." and the Kekayaan row keeps its total. e2e `fitur.spec.ts:128`.
8. **Space authorization on every route/action** — PASS. `collectibleScope()` (load, create, update, archive)
   and the photo route both call `requireSpaceAccess`; an unknown id resolves to space `''` first, giving the
   same 404 as an unknown id. Verified by re-running `test/integration/koleksi.test.ts` "one access rule" block
   (member/stranger/removed-member/signed-out/odd-id → identical 404; removed member loses list/edit/delete)
   and e2e `koleksi.spec.ts:179` (another account's photo request vs. unknown id — identical body).
9. **Guarded write pattern, reload survival, saving→success only after confirm** — PASS. `writable()` guards
   id + live + not-demo + `updated_at` + live membership in one statement; stale gives 409, missing gives 404.
   e2e `koleksi.spec.ts:68` confirms add→reload keeps the item; no-JS test (`:236`) confirms
   refusal-then-success through plain form posts.
10. **Account deletion purges collectibles + R2 photos for a space where the user was the last live member; a
    shared space's rows survive** — PASS. `collectibles` is in `SPACE_SCOPED_TABLES`; `purgeSpaces` calls
    `releasePhotoKeys(db, collectibles, …)` under the same `stillPurgeable` guard as belongings. Re-ran
    `test/integration/delete-account.test.ts` and the koleksi "account deletion" describe block myself — pass.
11. **i18n, formatMoney, WIB dates, no appraisal/grading/authentication claim** — PASS. `grep` on
    `src/lib/shared/i18n-en.ts` shows English entries for every new Indonesian string checked (disclosure,
    AI-disabled hint, "Harga pasar otomatis" hint, etc.); `npm run gates`' i18n-completeness test (part of the
    vitest run) is green. The page's only disclosure text is "Nilai diisi sendiri, bukan taksiran harga pasar
    atau penilaian keaslian." — explicitly disclaims appraisal/authentication. Dates use `wibTodayString()`
    (the same shared helper whose 23:30/00:30 WIB month-boundary vectors are covered in
    `src/lib/shared/dates.test.ts`, reused unchanged here).

## Additional verification (task-specific checks)

- **`/kekayaan` row order** — PASS. Confirmed by reading `src/routes/(app)/kekayaan/+page.svelte`: `NetWorthSection`
  → "Dompet" (wallets) → `GoalsSection` → "Langganan" → "Barang" → "Koleksi", exactly net worth, wallets, goals,
  Langganan, Barang, Koleksi.
- **Archive access-before-body on both routes** — PASS. Both `/koleksi` and `/barang` `archive` actions resolve
  `collectibleScope`/`belongingScope` (which calls `requireSpaceAccess`) before `readFormBody`. Read directly in
  both `+page.server.ts` files; matches the cycle-2 L1 fix.
- **FN-12 Koleksi toggle** — PASS, see AC7; `src/lib/ui/shell/nav.test.ts` covers the entry and its hiding.
- **Demo rows read-only and excluded** — PASS. `collectiblesTotalsOf()` skips `isDemo` rows from both sums;
  `+page.svelte` renders demo rows without an edit `<a>` (plain `<div>`); server `writable()` requires
  `isDemo = false`, so edit/delete of a demo row fail with 400 "Data demo tidak bisa diubah." — confirmed by
  reading `collectibles/repo.ts` and re-running the "L2: Data demo rows are read-only" integration test.
- **Svelte keyed lists** — PASS: both `{#each}` loops in `+page.svelte` are keyed by `item.id` / `total.currency`.
- **Cross-space / removed member / caps / stale 409** — PASS, see AC8/AC9 evidence; cap test
  "20 concurrent creates… stop at exactly 300" re-run and passing.
- **No-JS, 360 px** — PASS via e2e `koleksi.spec.ts:206` (360 px, no horizontal scroll) and `:236` (no-JS upload
  round trip).
- **ENGINEERING_CHECKLIST.md** — no violations found: integer money with safe-integer guards and BigInt totals
  (null-on-overflow, never rounded), one access rule reused everywhere, keyed lists, shared i18n, CSP unchanged
  per-route, no `{@html}` or raw SQL interpolation in the diff.

## Findings

None. No FAIL findings against the PRD's acceptance criteria or the engineering checklist.

## Gaps carried from the engineer's report (not criteria, informational)

- No automated market price for any collectible category (Pokémon TCG verified deprecated at build time, so the
  feature correctly ships manual-only per the PRD's own fallback clause).
- No AI identification/valuation (disabled, "Belum dikonfigurasi", as required).
- Sync pull for the new table is not built (matches FN-27's precedent; guest mode/sync remain deferred app-wide).
- Real R2/staging not exercised; local R2 (miniflare) only, consistent with this QA pass's own scope (no deploy,
  no remote D1, no login).
