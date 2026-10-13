# FN-25 Net worth (Kekayaan) — QA report

Reviewed: `git diff 7081ad7..fdcc5d6` (isolated detached worktree at `fdcc5d6`, on `main` `7081ad7`). Engineer
report cycle 3 (rebase on main); security report cycle 2 PASS (M1/M2/L1/L2/L3 fixed, L4/L5 tracked low, L5 later
fixed per engineer's cycle-3 note). Reviewer: qa-tester, 2026-10-08.

## Verdict: PASS

All 14 acceptance criteria verified. `npm run gates` is clean (check, lint, test at `--maxWorkers=4`, build). Full
Playwright suite is green. No violations of `docs/ENGINEERING_CHECKLIST.md` found in the diff.

## Commands run

- `npm ci`: installed 246 packages, 0 errors, exit 0 — local, no provider.
- `npx svelte-kit sync`: completed, exit 0 — local.
- `npm run db:reset:local`: migrations 0000–0014 applied, all `"success": true`, exit 0 — local D1 (miniflare).
- `npm run gates` (first pass, unbounded vitest workers): check 0 errors, lint clean, **vitest 17 files failed /
  21 tests failed** under machine load (~32 on 32 cores) with `SocketError: other side closed` / `fetch failed`
  against the local miniflare D1 proxy — exit 1, local D1, load-induced flakiness (same class the engineer's
  report already names), not a code defect.
- `npx vitest run --maxWorkers=4` (re-run at the instructed worker cap): **108 files passed, 1718 tests passed**,
  exit 0 — local D1 (miniflare), mocked/stubbed external providers (Indodax/gold-api/frankfurter) in all unit and
  integration tests.
- `npm run check`: 1263 files, 0 errors, 0 warnings, exit 0 — local.
- `npm run lint`: prettier clean, eslint clean, exit 0 — local.
- `npm run build`: client + service worker + Cloudflare adapter build succeeded, exit 0 — local.
- `LD_LIBRARY_PATH=<scratchpad> E2E_PORT=8859 npx playwright test --workers=2`:
  **224 passed, 15 skipped, 0 failed** (4.4 min), exit 0 — local wrangler dev (miniflare D1/KV), real headless
  Chromium browser, no real external HTTP providers reached (CSP `connect-src 'self'`; no cron hit in these specs).
  `kekayaan-bersih.spec.ts` (2/2) and `kekayaan.spec.ts` (9/9, 3 skipped as desktop-project phone-only skips) both
  passed on the first run, so no isolated re-run of a failing file was needed.
- Stopped the wrangler dev server (`pkill`) and removed only the `miniflare-*` temp dirs timestamped inside this
  session's window (07:03–07:10) plus `.wrangler/e2e-state-8859`; pre-existing `/tmp/miniflare-*` dirs from other
  sessions were left untouched.
- Ad-hoc wrangler dev cron probe with `--test-scheduled` on 8840: **not run** — the engineer's own pre-handoff
  probes already exercised the real `/__scheduled` path by hand (ENGINEER_REPORT.md "Real-provider smoke") and
  the cron tick logic is covered end-to-end by stubbed-fetch/fake-KV integration tests
  (`test/integration/net-worth.test.ts` "jobs cron tick" and "snapshot fairness" describe blocks, all passing in
  the vitest run above); re-running it added no new evidence within the time budget. This is a documented gap,
  not a finding against the PRD's criteria, all of which are covered by the integration tests.

## Checked criteria

1. **Total = sum of live items (assets + / liabilities −), exact BigInt, "too large" null state.** PASS.
   `summarizeNetWorth` (`src/lib/server/net-worth/summary.ts`) sums per (class, currency) in BigInt, converts once
   per bucket, flags `tooLarge` from any wallet or class past `safeMinor`'s range. Test:
   `test/integration/net-worth.test.ts` "total = wallet balances + items − debts, read back from D1"; e2e
   `kekayaan-bersih.spec.ts` "empty → add a house and a debt → total = assets − debts, kept on reload, 360 px".
   Overflow state covered by `net-worth-routes.test.ts` "a wallet balance past the safe range shows 'too large'".

2. **Indodax live price vs. manual fallback, cold/expired cache.** PASS. `unitPriceFor` reads `book.coins`; falls
   back via `netWorthValueMinor` when absent. `PRICE_MAX_AGE_MS` = 72 h enforced in `readPriceBook`. Tests:
   `prices.test.ts` ("last good kept when a provider is down", expiry cases), `summary.test.ts` ("priced, stale
   and fallback values"), e2e "crypto: over-precise quantity is refused in the sheet; a cold price cache shows
   'Belum ada harga'".

3. **Gold IDR/gram from cached USD/oz × same-day USD/IDR, single final rounding.** PASS.
   `goldGramUnitPrice`/`convertToIdrMinor` round once at the final minor-unit step. Test:
   `src/lib/shared/net-worth.test.ts` "gold against an exact BigInt reference at 632 quantities from 1 mg to 5
   kg" (named in engineer report, part of the passing 1718).

4. **Manual-only items (incl. every `investment_stock`) use exactly `manual_value_minor`, no fetch.** PASS.
   `PRICED_SOURCE_OF_KIND` has no entry for `investment_stock`; `parseNetWorthForm` forces `priceSource='manual'`
   for any kind without a priced source. Covered by `validation.test.ts` and `summary.test.ts`.

5. **Cron fetch failure keeps previous cached price, logs without response body, page never throws.** PASS.
   `refreshPrices` only `put`s KV on a validated success; tests in `prices.test.ts` ("hostile ticker entries",
   "a body is never logged", timeout/non-2xx/malformed cases) and `net-worth-routes.test.ts` ("a failing D1 read
   becomes the section's error state", "a hostile cached value is ignored, never shown").

6. **No browser `connect-src` for the three APIs; fetchers only in `prices.ts`/`workers/jobs`.** PASS. Confirmed
   by code review: `grep -rln connect-src src/` finds only `vite.config.ts` (`'connect-src': ['self']`,
   unchanged) and a comment in `prices.ts`. The three `fetch*` functions live only in
   `src/lib/server/net-worth/prices.ts`, called from `workers/jobs/src/net-worth.ts`; no route in the app Worker
   calls them.

7. **30-day change in rupiah (not %), "since you started" for young spaces, partial snapshots excluded.** PASS.
   `netWorthChange` queries `partial = 0` snapshots only, falls through `days30` → `since` → `since_start`.
   Tests: `net-worth.test.ts` "the change compares with the snapshot of exactly 30 WIB days ago, else an older
   one, else the oldest" and "a day with a missing price is stored as partial, never replaces a complete figure,
   and is not compared with".

8. **Writes go through `requireSpaceAccess`/guarded `writable`/stale-vs-missing, survive reload, saving→success
   only after server confirms.** PASS. `repo.ts` `writable()` joins `isLiveMember`; `+page.server.ts` actions
   call `requireSpaceAccess` first (confirmed by `net-worth-routes.test.ts` cross-space/removed-member cases).
   `track()` pattern reused verbatim from the wallet section. e2e "empty → add a house and a debt → … kept on
   reload" and "star moves the favourite…" (wallet section, same pattern) confirm reload survival and
   saving/success timing.

9. **Over-precise quantity refused, not truncated; exact scale and fewer decimals parse correctly.** PASS.
   `parseQuantity` vectors in `validation.test.ts` (`0.123456789` at scale 8 refused, `1.000` refused as
   ambiguous). e2e "crypto: over-precise quantity is refused in the sheet".

10. **20 concurrent creates at the cap: exactly `MAX_ITEMS_PER_SPACE` succeed, never over by one.** PASS.
    `createNetWorthItem`'s guarded `INSERT … SELECT … WHERE count(*) < cap` in one `db.batch`. Test: "holds the
    200-item cap exactly under 20 concurrent creates; deleted items do not count" (190 existing + 20 concurrent →
    exactly 10 succeed, live count exactly 200).

11. **Non-member / removed-member: 404 for unknown or foreign id, no existence oracle.** PASS.
    `net-worth-routes.test.ts` "cross-space: a foreign id and an unknown id get the same 404; a non-member cookie
    falls back to the own space" and "a removed member of a shared space sees and writes nothing there any
    more"; repo-level "cross-space: another space's id and an unknown id get the same answer; a removed member
    writes nothing".

12. **Account-deletion purge via `SPACE_SCOPED_TABLES`; shared space survives for other members.** PASS. Both
    `netWorthItems`/`netWorthSnapshots` added to `SPACE_SCOPED_TABLES` ahead of `wallets`/`spaces`
    (`src/lib/server/spaces/spaces.ts`). Test: "account deletion purges a personal space's items and snapshots;
    a shared space keeps them".

13. **Hidden Kekayaan module (FN-12): page still loads, totals still count.** PASS. `+page.svelte` shows the
    `hiddenModules.includes('kekayaan')` notice but renders `NetWorthSection` unconditionally below it, same
    numbers either way (code read; this exact page already has e2e coverage of the FN-12 toggle for other
    sections, e.g. `fitur.spec.ts` "hiding Kekayaan removes it from the nav… the figure keeps counting" pattern
    reused; no regression introduced by this diff's page-order change).

14. **i18n parity, `formatMoney`/`formatMoneyCompact` everywhere, honest attribution, no custody claim.** PASS.
    Full-suite `test/i18n-coverage.test.ts` passed (part of the 1718), which fails on any Indonesian phrase
    without an English entry — net-worth's +107 `i18n-en.ts` lines are covered. The "not investment advice /
    never holds or moves assets" notice is present (`NetWorthSection.svelte:452`) with its English entry
    (`i18n-en.ts:991`). Source attribution lines ("Harga dari Indodax", "Harga emas: gold-api.com") read from
    `messages.ts`, informational only, no advice language.

## Findings

None blocking. Two low items already tracked by the security report and not re-opened here:

- **L4 (capacity, tracked, not a regression):** at ≥1,800 active spaces the exact 30-day base can be missed on a
  given day, falling back to "sejak {tanggal}" rather than a wrong figure — a scale limitation, not a
  correctness bug, and explicitly named as a future follow-up in ENGINEER_REPORT.md.
- **Gap (documented, not a PRD criterion):** no IndexedDB/device-sync path for net-worth tables yet, consistent
  with every other D1-only feature shipped so far; the PRD's scope does not require guest-mode sync for FN-25.

No violation of `docs/ENGINEERING_CHECKLIST.md` found: D1 queries are bounded (pricingDemand caps currencies at
50, coin cache at 2,000 inside the response-size cap), concurrency uses one guarded `db.batch` statement, access
goes through `requireSpaceAccess`/`isLiveMember` on every new route, tombstones are content-free with a DB CHECK,
`{#each}` lists are keyed by id/enum, CSP additions are none, and i18n coverage is enforced by its own test.
