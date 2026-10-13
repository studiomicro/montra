# SECURITY_REPORT — FN-25b Kekayaan page (pass 1)

Scope: `git diff 81d7d5a..3463f73` (worktree fn-25b-qa, HEAD 3463f73). Checked against `docs/ENGINEERING_CHECKLIST.md`.

## Verdict: PASS

No medium or high findings. Two low findings tracked below.

## What was attacked

- **Authorization / IDOR.** `/kekayaan` load goes through `pageScope` -> `requireSpaceAccess(locals.db, user.id, locals.space.id)`
  (`src/routes/(app)/kekayaan/+page.server.ts:42-48`) before any new read. `netWorthTrend` (`trend.ts:313-317`) filters
  `space_id = ?`; `walletExpenseTotals` (`aggregate.ts:360-366`) uses `filterWhere(spaceId, ...)` (`t.space_id = ?`)
  plus the wallet-id list, and the ids come only from the space's own `listWallets` result, never from the request.
  A foreign wallet id cannot be supplied; even if it were, the `space_id` predicate excludes its rows. Removed member,
  stranger and unknown space get an identical 404 (integration test `kekayaan-page.test.ts:255`).
- **Forged `rentang`.** `parseTrendRange` is an allowlist of `1m|3m|1y|all`; anything else is `1m`. `all` is bounded by
  `limit 3660` (newest kept). No user value reaches SQL.
- **Forged `saran`.** `suggestionParam` maps only `emas`/`pensiun` to a fixed enum; any other value is `null`. The
  pre-filled form values come from that enum, not from the query string, so no reflected injection. `aset` is
  sliced to 64 chars and only matched against the space's own item ids (pre-existing).
- **D1 limits / CPU.** Wallet ids are bound as one JSON parameter through `json_each` (no 100-parameter limit). Trend
  rows <= 3660; `Math.min(...values)` on 3660 numbers is safe. One grouped query for all cards.
- **Money correctness.** Sums are `cast(sum(...) as text)` -> `BigInt` -> `safeMinor` (null past MAX_SAFE_INTEGER,
  shown as "too large"). Allocation percentages are BigInt largest-remainder; debts never in the denominator; a
  null/negative class goes to `outside`. Section subtotals are per currency (no implicit FX). Demo items excluded in
  `sectionTotals`, `missingSuggestions`; demo transactions excluded via `t.is_demo = 0`. `is_demo` is not writable
  through any form action in the diff, so a member cannot inject demo-flagged rows; other-space rows are excluded
  by `space_id`.
- **XSS / SVG.** No `{@html}` in the diff. Chart and bar render only numbers, enum class names (`c-{cls}`) and
  translated fixed labels; wallet/item names are text-interpolated (Svelte escapes). Links use server-generated
  UUIDs (`/dompet?ubah={w.id}`, `/kekayaan?aset={item.id}`) and the fixed `param` string.
- **PII.** Card numbers: only `lastFour` sent, rendered through `maskedLastFour`. No secrets or tokens added to page
  data; logs use `errorLabel(e)` only.

## Findings

1. **LOW — eye toggle is display-only; amounts are in SSR HTML and page data.**
   `src/lib/ui/kit/amounts.svelte.ts:8,19` (pre-existing, newly relied on by `NetWorthSection.svelte:317`,
   `TrendChart.svelte:57`, `AllocationBar.svelte:48`, `CreditCardCard.svelte:57`). The hidden state lives in
   localStorage and applies after hydration, so the server-rendered HTML shows real figures for a moment on every
   load, and the full figures stay in the serialised page data (view-source / devtools). Repro: hide amounts, reload
   `/kekayaan` with a throttled CPU/network; figures flash before masking. This is a shoulder-surfing privacy
   control, not access control. The copy must not promise more than that; optionally persist the preference in a
   cookie so SSR masks too.
   **Resolution (2026-10-13):** FIXED (the report's cookie option) in `fix(wealth): render hidden amounts masked on the server
   so they never flash` (6aaa72e). The choice is also kept in the `montra-amounts-hidden` cookie; the root layout
   reads it and hands it to `HeroAmount`, which masks the server render and the hydration alike; the root layout
   resets the shared state on every render, so one request's choice never reaches another. Still display-only: the
   figures stay in the page data, and the eye button promises no more ("Sembunyikan nominal"). Tests:
   `src/lib/ui/kit/HeroAmount.test.ts` › "renders the mask, never the figure, when the cookie says hidden" and "a
   later render without the cookie (or without the eye button) shows the figure"; `amount-visibility.test.ts` ›
   "amountsHiddenCookie"; `e2e/beranda.spec.ts` (the server's HTML of the hero is masked after a reload).
2. **LOW — trend shape and allocation percentages stay visible when amounts are hidden.**
   `TrendChart.svelte` draws the line and `AllocationBar.svelte:25,48` keeps `pctText` and the bar widths. Relative
   wealth movement and the asset split stay readable with the eye closed. This is acceptable if intended (the PRD
   masks rupiah only); record it as a product decision.
   **Resolution (2026-10-13):** FIXED per owner decision (2026-10-13, "Everything with money") in `fix(lows): owner decisions for FN-19 L5, FN-20 L2, FN-25b L2, FN-30 L1/L2`. While amounts are hidden the
   trend chart draws no line, area, dots or rising/falling colour (a dashed placeholder; the dates stay), and the
   allocation bar shows one plain segment with every share masked, on the server render too (the L1 cookie).
   Tests: `src/lib/ui/net-worth/wealth-ui.test.ts` › "masks every figure, share and segment width while amounts are
   hidden" and "while hidden: no line, area, dots or rising/falling colour" (failed before); `e2e/kekayaan-halaman.spec.ts`
   (no `%` in the chips after the eye).

## Checks run

- `npx vitest run test/integration/kekayaan-page.test.ts src/lib/shared/wealth.test.ts src/lib/server/net-worth/sections.test.ts`
  -> Test Files 3 passed (3), Tests 25 passed (25).
- No PoC files created; no source edits.
