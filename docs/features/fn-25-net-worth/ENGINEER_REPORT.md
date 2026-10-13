# FN-25 Net worth (Kekayaan) — engineer report (cycle 1)

Branch `fn-25-net-worth` from `main` at `e2780ce` (FN-18). Not pushed. `main` has since gained FN-21 and FN-24
(`ff2a392`, `1b098e2`): `git merge-tree` shows append-only conflicts in `_journal.json`, `schema.ts`, `spaces.ts`
(`SPACE_SCOPED_TABLES`), `i18n-en.ts`, `workers/jobs/src/index.ts` and the jobs `worker-configuration.d.ts`; all are
"keep both sides". `src/lib/server/push/encrypt.ts` is byte-identical to FN-24's version and merges cleanly.

## What works

- `/kekayaan` opens with a **Kekayaan bersih** section above Dompet and Tabungan. It shows:
  - The total ("Total aset dikurangi utang"): wallet balances (FN-04's contract) plus items minus debts.
  - The change line ("Naik Rp42 jt dalam 30 hari" / "Turun …" / "Tidak berubah …"), in rupiah, never as a percent.
  - "Pembagian": Dompet, Kas, Investasi, Kripto, Emas, Properti & aset, Utang. The rows add up exactly to the
    total.
  - Items grouped by kind, each with its quantity, value and source line. Sources: "Nilai manual", "Harga dari
    Indodax · <WIB time>", "Harga emas: gold-api.com · <WIB time>", "Harga terakhir <time>, belum diperbarui",
    "Harga belum tersedia, memakai nilai manual", "Belum ada harga dan belum ada nilai manual".
  - The rates used ("Kurs USD: Rp 17.881 (7 Okt, Frankfurter)"), source attribution, and "bukan saran
    investasi … tidak menyimpan atau memindahkan asetmu".
  - With nothing recorded there is no figure, only the empty state; Rp 0 is never invented.
- Add, edit and delete use a Sheet with JS, and inline forms without JS (`?aset=baru`, `?aset=<id>`, refused
  posts echo their values). Success shows only after the server confirms (the `track()` pattern). On 404 or 409
  the page reloads the data and shows "Berubah sejak terakhir dimuat…".
- Item kinds: cash, investment_stock, investment_crypto, investment_gold, property, vehicle, debt, other_asset.
  - Crypto may use Indodax (coin code + quantity, ×10^8).
  - Gold may use gold-api.com (grams, ×10^3).
  - Stocks and every other kind are manual only (PRD owner decision 3).
  - A priced item's manual value is an optional fallback.
- **Prices are fetched only by the jobs Worker** on the existing hourly 06–23 WIB cron (`workers/jobs/src/net-worth.ts`),
  written to KV `CACHE`, then today's WIB snapshot is written for each due space. Page loads only read KV, and at
  most three reads. The CSP is unchanged (`connect-src 'self'`).
- The 30-day change compares against the snapshot dated exactly 30 WIB days ago (`days30`). If that day is
  missing it uses an older snapshot, with the date shown ("sejak 1 Sep"). If the space is younger it uses the
  oldest snapshot ("sejak mulai mencatat (…)"). With no earlier snapshot it shows "Perubahan tampil setelah satu
  hari pencatatan."

## Decisions taken (own recommendation, per instruction)

1. **Indodax via one `GET /api/ticker_all` per tick**, not one `/api/ticker/<pair>` per coin. One request covers
   every coin in use (~75 KB; documented limit 180 req/min). Coin code stored lowercase (`btc`), pair `<code>_idr`.
   An unlisted coin is simply absent, so its items fall back to their manual value.
2. **Frankfurter v2** `GET /v2/rate/<CUR>/IDR`, not the PRD's `/v1/<date>` (v1 now answers with a
   `Deprecation` header and `Link: successor-version` to v2). The rate's own date is stored. It is fetched once
   per WIB day per currency in use: USD for gold, plus the non-IDR currencies of live items and wallets.
3. **Net worth is converted per currency with stored rates** (task brief). Each (class, currency) sum is
   converted to IDR once, at the cached daily rate. A currency without a rate is listed apart ("Belum termasuk
   (kurs belum tersedia): …") and never summed.
4. **KV keys, one per source:** `price:indodax`, `price:gold_api:xau`, `fx:idr`. This replaces the PRD's
   `price:<source>:<symbol>:<date-hour>`, so a page costs ≤ 3 reads and last-good is natural.
   - TTL: `expirationTtl` 7 days.
   - Age policy: a price older than 8 h is labelled stale (the cron skips 00–05 WIB, so ~7 h is the normal
     night gap). After 72 h it is not used, and the item falls back to its manual value (AC2 "expired"). Rates
     stay usable for 7 days.
5. **Content-free tombstones, so "Hapus" not "Arsipkan".** A deleted item keeps only id, space, `updated_at`,
   `deleted_at` and `seq` (CHECK), so there is no restore. The 200-item cap counts live items only.
6. **No `is_liability` column.** A debt is `kind = 'debt'`. A separate flag would duplicate the kind, which
   no-speculative-abstractions rules out.
7. **Quantities are integer TEXT** (`quantity_scaled`, CHECK digits only, no leading zero, ≤ 24 chars) plus
   `quantity_scale` (8 crypto, 3 gold). A billion PEPE × 10^8 passes 2^53.
   - The parser accepts comma or dot as the decimal separator.
   - It refuses an ambiguous `1.000` / `2.500` (dot + 3 digits after a non-zero whole), excess precision,
     zero, signs and exponents.
8. **Snapshots** are `net_worth_snapshots (space_id, date) PK`, IDR. Upserted by every tick, so the 23:00 WIB
   tick's figure stands for the day.
   - At most 100 due spaces per tick, in id order. A space is due when it has a live wallet or item and no
     snapshot for today newer than 30 min.
   - A space whose total is "too large" is skipped (not written).
9. **Sanity bounds** (refused, never stored):
   - Coin price > 0 and ≤ 10^13 IDR, ≤ 12 decimals.
   - Gold 100–100.000 USD/oz.
   - USD→IDR 1.000–100.000. Other currencies 0,0001–1.000.000.
   - Rate date ≤ tomorrow and ≥ 14 days back.
   - Body caps: 512 KB (ticker_all), 8 KB (others).
10. **Wallets appear as their own "Dompet" class** in the allocation, rather than folded into Kas.
11. **The net-worth tick lives in `workers/jobs/src/net-worth.ts`**, called from `scheduled`, rather than being
    written into `cron.ts`. This keeps the merge with FN-24's cron rewrite to one call line.

## Files

- Migration `migrations/0013_net_worth.sql` + `meta/0013_snapshot.json` + journal tag `0013_net_worth`
  (idx 11, `prevId` = 0010's snapshot; **re-chain at merge** after 0011/0012).
  - `net_worth_items`: content CHECK, value cap `between 1 and 10^13`, source/kind/currency/symbol/quantity
    rules, content-free tombstone. Indexes `(space_id, deleted_at)` and `(price_source, price_symbol)`.
  - `net_worth_snapshots`: PK `(space_id, date)`, CHECK `abs(total_minor) ≤ 2^53−1`.
- New:
  - `src/lib/shared/net-worth.ts`: kinds, classes, labels, scales, `TROY_OUNCE_GRAMS`, `parseDecimal`,
    `divRound`, `netWorthValueMinor`, `goldGramUnitPrice`, `convertToIdrMinor`, `formatQuantity`.
  - `src/lib/server/net-worth/{prices,repo,summary,validation,messages}.ts`
  - `src/lib/ui/net-worth/{NetWorthSection,NetWorthItemForm}.svelte`
  - `workers/jobs/src/net-worth.ts`
  - `test/helpers/kv.ts`
  - `e2e/kekayaan-bersih.spec.ts`
- Changed:
  - `schema.ts`, `spaces.ts` (both tables first in `SPACE_SCOPED_TABLES`).
  - `kekayaan/+page.server.ts`: `netWorth`, `openItem`, `createItem`/`updateItem`/`deleteItem`.
  - `kekayaan/+page.svelte`, `i18n-en.ts` (+99).
  - `workers/jobs/src/index.ts`, `workers/jobs/wrangler.jsonc`: `CACHE` KV binding, local + staging (same
    namespace as the app). The jobs `worker-configuration.d.ts` was regenerated.
  - `push/encrypt.ts`: FN-24's Workers-types casts, needed because the jobs Worker now type-checks the
    access/session import chain.
  - `docs/RUNBOOK.md`: KV row.
  - `e2e/kekayaan.spec.ts`: one locator scoped to the wallet section, because the net-worth list now comes first.

## Tests

- `src/lib/shared/net-worth.test.ts` (11): decimal parsing, rounding, value vectors (satoshi, PEPE past 2^53),
  gold against an exact BigInt reference at 632 quantities from 1 mg to 5 kg, conversion, quantity text.
- `src/lib/server/net-worth/validation.test.ts` (11): quantity vectors, including `0.123456789` refused at scale
  8 and `1.000` refused as ambiguous; form rules; the 10^13 cap.
- `src/lib/server/net-worth/prices.test.ts` (16, all stubbed):
  - Hostile ticker entries, schema, status, redirect, size (declared and streamed), bad JSON, timeout.
  - Gold and FX bounds and mislabels; allow-list.
  - Last good kept when a provider is down; a body is never logged.
  - FX once per WIB day; partial coin merge.
  - KV outage on refresh and on read; corrupt, future-dated and expired cache.
- `src/lib/server/net-worth/summary.test.ts` (5): total = wallets + assets − debts with classes reconciling;
  priced, stale and fallback values; per-bucket conversion and unconverted currencies; too-large states.
- `test/integration/net-worth.test.ts` (13, local D1): CRUD, the tombstone, DB CHECKs, the 20-concurrent cap
  probe, cross-space and removed member, account-deletion purge, `pricingDemand`, change kinds, the WIB
  30-day base, the WIB snapshot date, same-day overwrite, and the cron tick end to end (stub fetch + fake KV;
  provider down → last good + stale; expiry).
- `test/integration/net-worth-routes.test.ts` (10): load, KV prices, KV outage fallback, hostile KV value, D1
  failure confined to the section, actions, the 409 for a stale form, the identical 404 for a foreign or unknown
  id, the non-member cookie, the removed member, too large.

## Checks run

- `npm run gates`:
  - check: 0 errors, 0 warnings (1209 files).
  - prettier: clean. eslint: clean.
  - vitest: 97 files, 1383 tests passed.
  - build: ✔ done.
  - An earlier plain `npm test` under machine load average ~72 timed out 20 unrelated D1 tests at 30 s.
    `--maxWorkers=6` then passed 97/1383, and the final `npm run gates` passed at load ~20.
- Full e2e (`E2E_PORT=8852 --workers=2`): **196 passed, 15 skipped, 0 failed**. The skips are the existing
  desktop-project skips of phone-only checks.
  - After the last change, `kekayaan-bersih` + `kekayaan` were rerun: 18 passed, 3 skipped.
  - Cycle-1 first run: `kekayaan.spec.ts` "star moves the favourite" failed (it asserted the first `listitem`
    on the page). It was scoped to the wallet section and passes.

## Pre-handoff probes (result lines)

- **Provider down → last good + stale label:** PASS. Unit tests (502 / bad JSON) leave KV unchanged, and the
  page reads `priceAt = previous`, `stale: true`.
  - Dev: KV `price:indodax` written 9 h old → "Harga terakhir 7 Oktober 2026 pukul 21.11 WIB, belum
    diperbarui".
  - After 72 h without a success the price is no longer used ("Belum ada harga" or the manual fallback).
- **Hostile provider payload:** PASS. Refused, nothing written: `-5`, `1e9`, numeric `last`, `0`, `10^14`,
  13-decimal, `__proto__`, an XAG/EUR label, price as a string, an out-of-range rate or date, a 302 to another
  host, a 10 MB declared or 600 KB streamed body, HTML. A hostile KV value is ignored, never shown.
- **Overflow:** PASS. A wallet at 2^53−1 plus an item gives total `null`, "Total terlalu besar untuk
  ditampilkan", and no change line. An item value past 2^53 is null with its basis kept. The DB refuses
  `manual_value_minor` 10^13+1 and 0.
- **Cross-space:** PASS. A foreign item id and an unknown id get an identical `404 {nwError: 'Aset tidak
  ditemukan.'}` for update and delete. A cookie naming another user's space shows only one's own items. A
  removed member gets 404, and the item survives for the owner. Repo writes by a non-member: `gone` / `stale`.
- **WIB snapshot boundary:** PASS. A tick at 16:00 UTC writes `2026-10-08` (23:00 WIB); a tick at 23:00 UTC writes
  `2026-10-09` (06:00 WIB). At 23:30 UTC on 7 Oct (06:30 WIB, 8 Oct) the 30-day base is 8 Sep.
- **30-day change:** PASS.
  - The exact 30-day snapshot gives `days30` with the delta.
  - With that day missing, an older snapshot gives `since` with its date.
  - In a younger space the oldest snapshot gives `since_start`.
  - Today's snapshot alone gives none. A null total gives none.
- **Concurrency:** PASS. With 190 items, 20 concurrent creates: exactly 10 succeed and 10 get `limit`, and the
  live count is exactly 200. A deleted item frees a slot.
- **Two tabs / stale forms:** PASS. A second edit carrying the old `updatedAt` gets `409 "Berubah sejak
  terakhir dimuat…"`, and the first edit stays.
- **No-JS forms:** PASS (dev, curl). `?aset=baru` renders `action="?/createItem"`. An over-precise quantity
  POST returns 400 with "Jumlah punya terlalu banyak angka di belakang koma." in the HTML.
- **360 px:** PASS. The e2e spec runs `expectNoHorizontalScroll` at 360 × 780 with a house and a debt.
- **Money vectors / two devices:** n/a. There is no money-text parsing beyond `wholeAmountMinor` (reused,
  covered), and net-worth items are not in device sync yet (see gaps).
- **CSP:** PASS. On `/kekayaan` under wrangler dev: `connect-src 'self'`. There were no e2e CSP violations.

## Real-provider smoke (separate from `npm test`; labelled)

The only real-provider calls in this cycle were made 2026-10-07 23:05 UTC by hand from scratchpad scripts
(not in the repo):

1. `curl --proto =https --max-time 8`:
   - `indodax.com/api/ticker_all`: 200, 74.965 B, 0,19 s.
   - `api.gold-api.com/price/XAU`: 200, 182 B.
   - `api.frankfurter.dev/v2/rate/USD/IDR`: 200, 61 B.
   - `…/v2/rate/SGD/IDR`: 200, 61 B.
2. The saved bodies went through the production fetchers via a stubbed fetch. They validated, and an unlisted
   coin was absent:
   - btc `1493000000`, eth `46082000`, usdt `17909`, pepe `0.073316`.
   - gold `4110.799805` USD/oz.
   - USD/IDR `17881` (2026-10-07), SGD/IDR `13985`.
   - Derived: 1 BTC = Rp 1.493.000.000; 1 g gold = Rp 2.363.247,42.
3. Local `wrangler dev` (jobs config first, `--test-scheduled`, scratch persist dir): `/__scheduled` called the
   real hosts. Log: `coins ok 1, gold ok, fx ok 1, snapshots written 1`. Restarting with the app config first,
   `/kekayaan` showed:
   - BTC 0,015 = Rp 22.395.165.
   - Gold 2,5 g = Rp 5.907.687,67.
   - Debt −Rp 1.000.000.
   - Total Rp 27.302.852,67 (sum checked by hand).

Sources verified 2026-10-08 (all keyless):

- https://github.com/btcid/indodax-official-api-docs/blob/master/Public-RestAPI.md: "Public API rate limited to
  180request/minute". `indodax.com/downloads/BITCOINCOID-API-DOCUMENTATION.pdf` now 301s to that repo. An
  invalid pair answers 200 `{"error":"invalid_pair"}`, which is refused by the schema.
- https://gold-api.com/pricing and https://gold-api.com/terms (effective 2026-09-10):
  - The free real-time price API has no rate limiting (history endpoints: 10/hour, unused).
  - §4: no multiple requests per second.
  - §9: commercial use permitted.
- https://frankfurter.dev: no API key; free for commercial use; "no quotas… rate-limited to prevent abuse". v1
  is deprecated in favour of v2 (header seen on v1 responses).

## Gaps / not done

- **Guest mode and device sync:** items and snapshots are server-only (D1). The IndexedDB working copy and the
  sync change log for these tables are not built, same as the other D1-only features so far.
- **Snapshot scan:** `spacesDueForSnapshot` scans all spaces per tick (limit 100, id order). At ~1.800 active
  spaces per day it needs paging by cursor or a queue fan-out.
- **Snapshot gaps:** a "too large" space is skipped each tick and keeps a slot. This is rare, but it means no
  snapshot for that space.
- **IDX stocks:** manual only (PRD owner decision 3).
- **Portfolio screenshot import:** out of scope (on-hold AI key).
- **Staging:** deploy needs no new secret. The jobs Worker now binds the existing staging KV
  `40600d64d47444109d10ba65ecd47d49`. Not deployed.

## Cycle 2 (red team findings, `SECURITY_REPORT.md`)

- **M1 fixed:** snapshots now rotate with a cursor persisted in `app_meta` (`net_worth_snapshot_cursor`,
  `nextSnapshotBatch`). Each tick takes due spaces after the cursor and wraps to the start when fewer than 100
  remain. A skipped ("too large") or failed space falls behind the cursor instead of holding a slot. Test: 105
  new spaces plus a too-large one all get a snapshot within ceil(105/100)+1 = 2 hourly ticks.
- **M2 fixed:** `fetchIndodaxPrices` caches **every** valid `<coin>_idr` pair from the one `ticker_all` answer
  (cap 2.000). The demand is only "any crypto item exists", so no list of user codes reaches the fetch path.
  - Coin codes are checked on save against the cached ticker: an unknown code gets "Kode koin ini tidak ada di
    Indodax…". With a cold cache or a KV outage the code is accepted, and the item shows no price.
  - An existing item with an unknown code shows "Kode koin tidak ada di Indodax, harga tidak tersedia".
  - Test: 600 junk pairs plus btc; all 601 are cached and btc is fresh.
- **L1 fixed:** a coin price moving more than ×1,5 / ÷1,5 against the last good price is held, with the last
  good price kept and stored as `pending`, and logged as "price jump held". It is accepted when the next tick
  confirms the same level. Test covers hold, return to normal, and a two-tick confirmed move.
- **L2 fixed:** a new `net_worth_snapshots.partial` column marks days with an item without a price or an
  unconverted currency. A partial figure never overwrites a complete one for the same day (`setWhere`). The
  30-day change uses complete snapshots only.
- **L3 fixed:** both currency-demand queries (items and wallets) join live spaces. Test: a deleted space's GBP
  wallet and AUD item drop out.
- Migration `0013_net_worth.sql` was regenerated with the `partial` column (it is not applied anywhere but
  locally). The coordinator renames it to 0014 at rebase.
- Fail-before: with cycle-1 `summary.ts`, `prices.ts` and `repo.ts` restored, the new M1, M2, L1, L2 and L3 tests
  fail (20 failures in the two files); with the fixes all pass.
- Checks:
  - `npm run check`: 0 errors. `lint`: clean. `npm run test -- --maxWorkers=4`: 97 files, 1391 tests passed.
    `build`: ✔ done.
  - e2e `kekayaan-bersih` + `kekayaan`: 18 passed, 3 skipped.

## Cycle 3 (red-team re-check: PASS; L4, L5)

- **L5 fixed:** a priced item using its manual fallback now marks the day's snapshot partial. The regression
  test failed with the cycle-2 `summary.ts` and passes now.
- **L4 (scale item, not fixed):** 18 ticks × 100 spaces gives at most 1.800 snapshots per WIB day. Past that
  number of active spaces, the exact 30-day base is often missing and the change falls back to "sejak {tanggal}".
  When that happens: a larger per-tick budget, or a queue fan-out of snapshot jobs (one message per space batch).

## Rebase on main (after FN-21, FN-24, FN-26)

- Reset to `main` (`7081ad7`), then re-applied the branch diff (`git apply -3`) and resolved the conflicts.
  - `SPACE_SCOPED_TABLES`: subscriptions, space notifications, then net-worth items and snapshots, then the
    existing tables.
  - Jobs `scheduled`: FN-24/26 `runCronTick` and the sweep, then `runNetWorthTick` (same `db`).
  - The schema and i18n keep both sides. Jobs worker types were regenerated (`CACHE`).
- The migration was regenerated as **`0014_net_worth.sql`**: journal idx 14, snapshot `prevId` = 0013's id
  `8c3abfc1-…`.
- The snapshot cursor now reuses FN-24's `getCronCursor`/`setCronCursor` (`app_meta`) instead of its own copy.
- The `/kekayaan` order is: Kekayaan bersih, Dompet, Tabungan, Langganan row.
- Checks:
  - `npm run db:reset:local`: 0000–0014 ✅.
  - check: 0 errors. lint: clean. `npm run test -- --maxWorkers=4`: 108 files, 1718 tests passed. build: ✔ done.
  - Full e2e (`E2E_PORT=8852 --workers=2`): 224 passed, 15 skipped, 0 failed.
