# FN-43 — Brand badges for wallets, imports and subscriptions

Status: proposed. Risk tier: **Medium** (no migration; a new shared module, a new UI component, `docs/design/
tokens.css` additions, and call-site swaps across five existing screens — no schema, auth or provider change).

Owner request (2026-10-09, Indonesian/English mixed): "add bank, ewallet, ride logo on the wallet and etc."
Orchestrator decision (legal, 2026-10-09): MONTRA does **not** copy or download any bank, e-wallet or
ride-hailing company's logo artwork — these are trademarks and copyrighted marks MONTRA has no brand-guideline
permission to reproduce, and `CLAUDE.md` already forbids copying third-party branding. The default design below
(original monogram badges, a colour *close to*, never a copy of, the real brand hue) satisfies the owner's intent
without that artwork; a clean extension point is left for official logo SVGs if the owner later obtains
permission — recorded as a **You**/legal-review item, not built this pass.

## Goal

Comparable apps show an institution's or service's own logo next to a wallet, a recognised bank transaction and a
subscription so the user can tell their accounts and bills apart at a glance (`docs/FEATURES.md` FN-04's "Ours"
line already named this as a future addition and deliberately deferred it: "Institution logo list (BCA, Mandiri,
GoPay, …) — … a `logo_key` column can be added without breaking this schema later", `docs/features/
fn-04-wallets/PRD.md:77-78`). MONTRA already draws every subscription as a generic initials monogram
(`InitialsTile.svelte`); this feature gives the handful of institutions and services the owner actually asked
for (banks, e-wallets, ride-hailing/food-delivery) their own recognisable colour and short code instead of a
random hashed one, everywhere a wallet or subscription name is already shown — with no new logo asset, no new
database column, and no change to how categories are drawn.

## Scope

### Part 1 — Shared brand registry

- New `src/lib/shared/brands.ts` exporting:
  - `BRANDS: readonly BrandEntry[]` — one entry per recognised institution/service: `{ id: string; name: string;
    aliases: readonly string[]; badgeText: string }`. `id` doubles as the `--badge-<id>` token suffix and the
    `.b-<id>` CSS class name; `name` is the proper noun shown nowhere by this feature except code comments and
    tests (the user's own typed wallet/subscription name is what renders, never a registry copy — see Part 3);
    `aliases` are the strings that count as a match (the registry id itself, the common short code, and, for
    banks, the full legal name); `badgeText` is the 2–5 character monogram drawn in the tile (e.g. `BCA`, `mdr`,
    `BNI`, `BRI`, `BSI`, `GoPay`, `OVO`, `DANA`, `SPay`, `Grab`, `Gojek`).
  - Entries (owner decision 2, defaults below): **banks** — BCA, Mandiri, BNI, BRI, BSI, CIMB Niaga, Permata,
    Danamon, BTN, OCBC, Jago, SeaBank, blu (BCA Digital), Jenius (BTPN), Allo (Allo Bank) — 15; **e-wallets** —
    GoPay, OVO, DANA, ShopeePay, LinkAja, AstraPay, i.saku — 7; **ride/food** — Gojek, Grab, Maxim, ShopeeFood,
    inDrive — 5. 27 entries total. No entry for every other `SUBSCRIPTION_CATALOGUE` id (Netflix, Spotify,
    YouTube, …) — those keep today's generic hashed `InitialsTile` tile unchanged (owner decision 2).
  - `matchBrand(name: string): BrandEntry | null` — normalises `name` with `cleanText` (`src/lib/shared/
    text.ts:12`, already used for untrusted short text) then `asciiLowerKey` (`text.ts:28`); tries, in registry
    order (banks, then e-wallets, then ride/food): (1) the whole normalised string against each entry's
    multi-word aliases ("bank central asia" → `bca`), then (2) a whole-word match — splitting on
    `/[^\p{L}\p{N}]+/u` exactly as `importCategoryFromTitle` already does (`src/lib/shared/
    category-keywords.ts:64-72`) — against each entry's single-word aliases ("Tabungan BCA", "Dompet GoPay" →
    `bca`/`gopay`). Whole-word only, no substring match (so "gojek", "gopay" and "gofood" never cross-match each
    other, mirroring `category-keywords.ts`'s already-tested "grab"/"grabfood" distinction); the first match in
    registry order wins when a name could plausibly match two entries (undefined in practice — no two registry
    aliases currently collide; a test asserts this).
  - `brandById(id: string): BrandEntry | null` — direct lookup by the registry's own id, used where the caller
    already knows the id with certainty (Part 4: a statement parser's own `id`), never alias-matched.
  - Every alias list, `badgeText` and the matching algorithm are MONTRA's own text and code; no bundle, image or
    brand-guideline asset from any bank, e-wallet or ride-hailing company is fetched, copied or embedded.

### Part 2 — `BrandBadge` component and tokens

- New `src/lib/ui/kit/BrandBadge.svelte`: props `name: string`, `size?: 36 | 40 | 44` (default 40), `round?:
  boolean` (default false) — the same prop shape as `InitialsTile.svelte:6-10`. It calls `matchBrand(name)`; when
  it matches, renders `<span class="tile b-{entry.id}" aria-hidden="true">{entry.badgeText}</span>` using the
  **same construction** `CategoryTile`/`InitialsTile` already use and already have a proven AA formula for:
  `background: color-mix(in srgb, var(--c) 16%, var(--bg)); color: var(--ink);` (`InitialsTile.svelte:24-26`),
  with `.b-<id> { --c: var(--badge-<id>); }` per registry entry. When `matchBrand` finds nothing, it renders
  `<InitialsTile {name} {size} {round} />` unchanged — every existing call site's fallback behaviour (hashed
  initials, stable AA, decorative) is preserved exactly.
  - **Logo slot (forward design, not built this pass):** the matched-brand branch is the single place a future
    `BrandEntry.logoAsset` field would switch to an `<img>`/inline `<svg>` instead of `badgeText` — documented in
    a code comment, no asset, no `img-src` CSP entry, no Rive-style placeholder shipped now (owner decision 6).
- `docs/design/tokens.css`: 27 new `--badge-<id>` hex tokens in `:root` (after the `--cat-*` block,
  `docs/design/tokens.css:60-77`), each the engineer's own colour close to — not a sampled or copied value from
  — the real brand's public colour, picked so white-on-background is never used (the tile always reads
  `--ink`, matching the category-tile convention) and so the existing AA formula clears 4.5:1 in both light and
  dark (identical hex serves both, exactly like `--cat-*` today — the 16 % mix changes correctly per theme
  because `--bg` changes, not because the hue token does). One matching grey `--badge-<id>` override per entry in
  the mono block (`docs/design/tokens.css:235-290`, next to `--cat-ojek-online`/`--cat-pesan-antar-makanan` at
  lines 279-280) — `test/contrast.test.ts`'s existing generic mono check ("every colour but money and brand is
  achromatic", `test/contrast.test.ts:137-146`) already fails on any `--badge-*` left un-greyed, with no test
  change needed there.
- New `test/brands-contrast.test.ts` (or extend `src/lib/ui/kit/initials.test.ts`'s pattern): for every
  `BrandEntry`, in light, dark, mono-light and mono-dark, `contrastRatio('--ink', mix(--badge-<id>, --bg, 0.16))
  ≥ 4.5` — the same math `initials.test.ts:54-80` already runs for the 14-colour initials palette, parametrised
  over the 27 badge tokens instead.

### Part 3 — Where badges show (derived from the existing `name`, no migration)

- **Dompet** (`src/routes/(app)/dompet/+page.svelte:353,409`): the two existing `<InitialsTile name={wallet.name}
  round />` calls become `<BrandBadge name={wallet.name} round />`. A wallet named "BCA", "Bank Central Asia",
  "GoPay", "Dompet Gojek", … gets the matching badge; anything else keeps today's hashed initials tile. No
  change to `wallets` (no new column, no edit-form field) — the badge is derived live from `wallet.name` on every
  render, per owner decision 5.
- **Langganan** (`src/routes/(app)/langganan/+page.svelte:377`, `src/lib/ui/subscriptions/
  CataloguePicker.svelte:40`): `InitialsTile name={sub.name}` / `InitialsTile name={entry.name}` become
  `BrandBadge`. This picks up FN-39's `gopay-plus`/`gofood-plus`/`grabunlimited` catalogue entries (their stored
  `name` is "GoPay Plus" etc., which `matchBrand` resolves to `gopay`/`gofood`/`grab` via the whole-word rule —
  "Plus"/"Unlimited" are extra words the whole-word match simply ignores) and any user-typed subscription named
  after a bank or e-wallet (e.g. a typed "BCA kartu kredit" subscription row). Every other catalogue entry
  (Netflix, Spotify, …) is unaffected (owner decision 2).
- **Beranda "Akan datang"** (`src/routes/(app)/+page.svelte:535`): `InitialsTile name={bill.name} size={40}
  round` becomes `BrandBadge name={bill.name} size={40} round`, same reasoning as Langganan. Beranda's space
  avatar (`+page.svelte:240`, a person/space, not a brand) is explicitly **not** touched.
- **Impor statement-institution picker** (`src/routes/(app)/impor/+page.svelte:313-320`,
  `institutionOptions`): `src/lib/ui/kit/picker.ts`'s `PickerOption<T>` gains an optional `brand?: string`
  field alongside the existing `tile?: CategoryKey` (`picker.ts:9`); `PickerSheet.svelte`'s `content` snippet
  (`PickerSheet.svelte:36-43`) renders `{#if option.brand}<BrandBadgeById id={option.brand} size={36} />{/if}`
  before the existing `{#if option.tile}` branch (a tiny new `BrandBadgeById` helper that calls `brandById`
  instead of `matchBrand`, since the caller already has the exact registry id). `institutionOptions`
  (`impor/+page.svelte:315-318`) adds `brand: i.id` to each mapped option — this works today for the one live
  parser (`STATEMENT_PARSERS = [BCA]`, `src/lib/shared/statements/parsers.ts:9`, `id: 'bca'`,
  `src/lib/shared/statements/bca.ts:254`) and for BNI/BRI/Mandiri the moment their parsers land (`docs/
  TASKS.md`'s open "FN-16a BRI row parser" line), with zero further change here — the registry already has
  `bni`/`bri`/`mandiri` entries from Part 1. The "Deteksi otomatis" row and the `institutionLabel` text
  (`impor/+page.svelte:319-320`) are unchanged.
- **Alur uang wallet bars** (`src/routes/(app)/alur-uang/+page.svelte:116-124`, the `r.wallets.map(...)` column
  mapping that sets `series: 'accent'`): changes to `series: matchBrand(w.name) ? \`brand-${matchBrand(w.name)!.id}\`
  : 'accent'`. `src/lib/ui/charts/series.css` gains one `.series-brand-<id> { --c: var(--badge-<id>); }` rule per
  registry entry (reusing the Part 2 tokens, no new colour declarations). `FlowChart.svelte`'s nodes stay
  text-only (`FlowChart.svelte:9-17`); only the bar/ribbon fill colour changes from the flat accent to the
  matched brand's hue — no monogram tile is drawn inside the SVG (no geometry change, no new text, no CLS risk
  in a hand-drawn chart that already has no room for a second label at 360 px).

## Out of scope

- **Official logo artwork** for any bank, e-wallet or ride-hailing/food-delivery brand, in any form (SVG, PNG,
  favicon scrape, bundle extraction) — the legal constraint above. Revisit only after the owner secures
  brand-guideline permission (tracked as a **You** item, see Owner decisions § 6).
- **Category tiles** (`CategoryTile.svelte`) — unchanged, as the owner's constraint explicitly asked.
- **Riwayat's and Beranda's day-grouped transaction rows** (`TransactionRow.svelte`, `row-text.ts`'s `rowMeta`):
  no per-row badge this pass. `rowMeta` returns one flat, already-translated string (`row-text.ts:36-51`)
  consumed as plain text by `TransactionRow.svelte:52` and reused by Riwayat, Beranda's "Terbaru", recurring
  rows, kotak-masuk draft review and Anggaran — splitting it to carry a `BrandBadge` would touch all of those
  call sites for a decorative nicety on top of work that already has no such nicety requested at this layer; a
  fast-follow once the registry/`BrandBadge` pattern is proven on the five surfaces above.
- **Native `<select>` wallet pickers** (`TransactionForm.svelte:101-124`, `RecurringForm.svelte`,
  `AdjustmentForm.svelte`'s wallet `<select>`s): browser `<option>` elements cannot render a badge or any HTML;
  these keep today's plain `{wallet.name} · {wallet.currency}` text.
- **Kekayaan/net-worth accounts**: `net_worth_items` carry a kind (`cash`, `investment_stock`, …) and a free-text
  `name`, with no dedicated per-account list screen this pass — `/kekayaan` is a hub page linking to Barang/
  Koleksi (`src/routes/(app)/kekayaan/+page.svelte:39,71`), not a named-account row list. No badge added here.
- **WalletForm's e-wallet quick-pick chips** (`WalletForm.svelte:76-82`, FN-39): `Chip.svelte`'s `icon` prop is a
  fixed icon-font glyph (`IconName`, `Chip.svelte:10,20`), not a per-brand colour slot; the four chips (GoPay,
  OVO, ShopeePay, DANA) keep their plain text labels.
- A `logo_key`/`brand_id` column on `wallets` or `subscriptions`, or any migration — matching is derived live
  from `name` every render (owner decision 5).
- Extending the registry to the ~35 other `SUBSCRIPTION_CATALOGUE` entries (Netflix, Spotify, YouTube, …) with
  their own brand colour — a separate, later content change (owner decision 2), same as FN-26's own "growing the
  list is a content change, not a schema change" note (`subscriptions-catalogue.ts:8`).
- Any change to statement parsing, detection confidence or FN-16a/16b's balance-check/dedupe logic — Part 3's
  Impor change only adds a `brand` id to an already-computed option list.

## Acceptance criteria

**Registry and matching**

1. Given the name `"BCA"`, `"bca"`, `" BCA "` or `"Bank Central Asia"`, when `matchBrand` runs, then it returns
   the `bca` entry in every case (case-insensitive, whitespace-insensitive, short-code and full-name both match).
   (Automated.)
2. Given `"GoPay"`, `"Gojek"` and `"GoFood"` as three separate names, when each is matched, then they resolve to
   three different entries (`gopay`, `gojek`, the ride/food `gofood` alias of `GoFood`/`ShopeeFood`'s group) —
   none cross-matches another (Automated, mirrors `category-keywords.test.ts`'s existing grab/grabfood vectors).
3. Given `"Tabungan BCA"`, `"Dompet Gopay saya"` and `"GoPay Plus"`, when matched, then each resolves to `bca`,
   `gopay` and `gopay` respectively (whole-word match inside a longer name; "Plus" is an unmatched extra word,
   ignored). (Automated.)
4. Given a name with no recognised word (`"Dompet harian"`, `"Tabungan masa depan"`), when matched, then
   `matchBrand` returns `null`. (Automated.)
5. No two registry entries share an alias (a built-in self-check test over `BRANDS` fails the build if one is
   added later without checking). (Automated.)
6. `matchBrand` only runs on text already passed through `cleanText` (capped, invisible characters stripped) —
   a 10,000-character input costs the same as a 60-character one (bounded, checklist › Data access › "Bounded
   work"). (Automated — a long-input timing/assertion test.)
7. `brandById('bca')` returns the `bca` entry; `brandById('unknown-id')` returns `null` (used only by the Impor
   picker's already-known parser ids, never alias-matched). (Automated.)

**Visual and tokens**

8. For every one of the 27 `BrandEntry` ids, in light, dark, mono-light and mono-dark, the badge's text colour
   (`--ink`) against its 16 %-mixed background clears WCAG AA 4.5:1 — the same check `initials.test.ts` already
   runs for the category palette, parametrised over `--badge-*` instead. (Automated — `test/
   brands-contrast.test.ts`.)
9. Every `--badge-<id>` token declared in `:root` has a grey override in the `:root[data-theme='mono']` block;
   the existing generic mono achromaticity test (`test/contrast.test.ts`'s "every colour but money and brand is
   achromatic") fails before this change's token additions are greyed and passes after (fail-before proof).
   (Automated.)
10. `BrandBadge` renders `aria-hidden="true"` and never as the only accessible name of a row — every call site
    keeps its existing adjacent text label (`wallet.name`, `sub.name`, `bill.name`, the institution option's
    `label`) unchanged. (Automated — render test asserting `aria-hidden` and that the visible text node is
    still present.)
11. `BrandBadge` never renders an `<img>`, inline fetched `<svg>` or a `url(...)` background — same assertion
    `initials.test.ts:50` already makes for `InitialsTile`, extended to `BrandBadge`'s matched-brand branch.
    (Automated.)
12. A name that does not match any registry entry renders through `InitialsTile` unchanged (same `initials()`
    text, same `initialsColour()` palette slot) — `BrandBadge` is a strict superset of today's behaviour, never
    a regression for an unmatched name. (Automated.)

**Where it shows**

13. Given a wallet named "BCA" (or any of the 27 registry names/aliases), when `/dompet` renders its list, then
    the wallet's tile shows the matching badge (`badgeText`, brand-tinted background) instead of a hashed
    initials tile; given a wallet named anything else, the tile is unchanged from today. (Browser/Playwright —
    extends the existing Dompet list screenshot/DOM test.)
14. Given a Langganan subscription or catalogue entry named "GoPay Plus", "BCA" (user-typed) or "Netflix", when
    rendered in the catalogue picker or the due-bills list, then the first two show the matching badge and the
    third keeps the generic hashed tile. (Automated/Browser.)
15. Given the Impor "Pilih institusi" sheet, when it opens, then the "BCA" row shows the `bca` badge next to its
    label (direct id lookup, not alias matching); given a future parser is added to `STATEMENT_PARSERS` (e.g.
    BNI), then its row shows the matching badge with no further code change beyond adding the parser (confirmed
    by a unit test that synthesises a second fake parser id already present in the registry, e.g. `bni`, and
    asserts the option list carries `brand: 'bni'`). (Automated.)
16. Given `/alur-uang` for a month with at least one wallet named "BCA" and one named "Dompet harian", when the
    chart renders, then the BCA bar/ribbon uses the `brand-bca` series colour and the unmatched wallet uses the
    existing flat `accent` colour; the node's text label and amount are unchanged either way (no new text, no
    layout shift). (Automated — extends `money-flow.test.ts`/a `series.css` class-presence test; Browser only if
    cheap.)

**Cross-cutting (every applicable `docs/ENGINEERING_CHECKLIST.md` item)**

17. No load or action anywhere in this feature reads or writes any new table or column — every touched route's
    existing space-authorization call is unchanged (no new space-scoped query introduced; confirmed by diff
    inspection, not a new test). (Automated — existing cross-space tests for Dompet/Langganan/Beranda/Impor/Alur
    uang still pass unmodified.)
18. `{#each}` lists touched by this feature (`BRANDS` iteration in tests, `institutionOptions`) key by a stable
    id (`entry.id`, `option.value`), never by a display name. (Automated.)
19. No new Indonesian or English UI copy is introduced (badge text is a proper noun/short code, decorative and
    `aria-hidden`, like the existing e-wallet quick-pick chip labels and catalogue names) — the i18n coverage
    test (`src/lib/shared/i18n.test.ts`) has nothing new to assert and still passes. (Automated.)
20. No inline `style` attribute is added anywhere (CSP: classes and CSS custom properties only, matching
    `CategoryTile`/`InitialsTile`'s existing pattern of per-key CSS classes setting `--c`). (Automated — grep the
    diff / an existing CSP lint rule if one exists, else a code-review note in the engineer's report.)
21. Fixed tile sizes (36/40/44 px, matching `InitialsTile`'s existing `s36`/`s40`/`s44` classes) — no layout
    shift when a badge replaces a hashed initials tile of the same size. (Browser — 360 px layout probe, no
    horizontal scroll, no CLS.)
22. Touch targets the badge sits inside (Dompet rows, Langganan rows, the Impor picker option) stay ≥ 44 px —
    unchanged, since the badge replaces an existing same-size tile inside an already-44-px-plus row. (Browser.)
23. `npm run gates` (check, lint, test, build) is clean after the change.
24. User-facing copy introduced by this feature (none beyond the registry's own proper nouns) never contains a
    file path or internal identifier — trivially true, confirmed by code review.

## Owner decisions

Proposed defaults below; auto-accepted per standing instruction unless the owner overrides.

1. **Visual style**: a rounded monogram tile, 16 % tint of the brand hue over `--bg`, `--ink` text — the exact
   construction `CategoryTile`/`InitialsTile` already use and already have a proven AA formula for. *Default:
   accept* (lower risk than inventing a new solid-fill/white-text style; still visibly "close to" the brand hue,
   same as every category tile already is).
2. **Registry membership**: 15 banks + 7 e-wallets + 5 ride/food services get a dedicated brand-coloured badge;
   every other `SUBSCRIPTION_CATALOGUE` entry (Netflix, Spotify, YouTube, the ~35 others) keeps today's generic
   hashed `InitialsTile` tile, not a new named colour. *Default: accept* — bounds the token count to 27 (compare:
   the design system already carries 17 category tokens) and matches the owner's literal ask (bank/e-wallet/
   ride logos); extending named colours to every merchant is a separate, larger content pass with no user
   request behind it yet.
3. **Where it shows**: Dompet wallet rows, Langganan's catalogue picker and due-bills list, Impor's
   institution picker, Alur uang's wallet bar colour. *Default: accept.*
4. **Where it does not show this pass**: Riwayat/Beranda's day-grouped transaction rows (would require
   restructuring `rowMeta`'s single translated string across 6+ call sites for a decorative nicety), native
   `<select>` wallet pickers (cannot render HTML), Kekayaan/net-worth accounts (no per-account list screen
   exists yet), WalletForm's quick-pick chips (`Chip`'s icon slot is a fixed icon font). *Default: accept, as a
   bounded first pass*; trade-off: a user importing a statement into a "BCA" wallet sees the badge on the
   wallet row in Dompet and on the Impor institution picker, but not yet inline on each individual imported
   transaction row in Riwayat — the information is still visible (via the wallet), just one tap further away.
5. **How a wallet/subscription gets its badge**: derived live from the existing `name` text via `matchBrand`,
   every render, no new column. *Default: accept* — matches FN-04's own original note that a `logo_key` column
   "can be added without breaking this schema later" (i.e. was deliberately deferred, not forgotten) and avoids
   a migration entirely. Trade-off: a wallet named ambiguously (e.g. "Dompet aku") never gets a badge; there is
   no manual "pick a brand" override UI this pass — if that turns out to matter in practice (owner or QA finds
   real wallets that should badge but do not), a later pass can add an optional explicit field without
   breaking this one's fallback-to-`InitialsTile` behaviour.
6. **Official logo replacement**: out of scope; a code-level extension point only (a future `BrandEntry.
   logoAsset` field swapping `BrandBadge`'s matched branch to an image). *Default: accept — the owner (**You**)
   must first secure brand-guideline permission from each institution/service before any real logo asset is
   added; track this as an open legal-review item, not a blocked engineering task.*

## Architecture notes

| Area | Files | Change |
| --- | --- | --- |
| Shared domain | `src/lib/shared/brands.ts` (new) | registry, `matchBrand`, `brandById` |
| Shared domain | `src/lib/shared/text.ts`, `category-keywords.ts` (no code change, reused) | normalisation + word-split reused unchanged |
| UI kit | `src/lib/ui/kit/BrandBadge.svelte` (new), `BrandBadgeById` helper | matched badge or `InitialsTile` fallback |
| UI kit | `src/lib/ui/kit/picker.ts`, `PickerSheet.svelte` | `PickerOption.brand` field, rendered tile |
| Design tokens | `docs/design/tokens.css` | 27 `--badge-<id>` tokens + 27 mono grey overrides |
| Charts | `src/lib/ui/charts/series.css`, `src/routes/(app)/alur-uang/+page.svelte` | `.series-brand-<id>` rules, wallet `series` key |
| Routes (UI only) | `dompet/+page.svelte`, `langganan/+page.svelte`, `(app)/+page.svelte`, `impor/+page.svelte` | swap `InitialsTile` → `BrandBadge`; add `brand` to `institutionOptions` |
| Tests | `test/brands-contrast.test.ts` (new), `src/lib/shared/brands.test.ts` (new), extends to `initials.test.ts`-style assertions on `BrandBadge` | contrast, matching vectors, render tests |

No Worker other than the main app Worker is touched; `workers/jobs` and `workers/inbound` are unaffected. No
migration, no new table or column, no new route, no new server action.

## Prerequisites

None. No new credential, provider or secret — pure shared-code, design-token and UI work on data MONTRA already
stores (`wallets.name`, `subscriptions.name`/catalogue id, the existing `StatementParser.id`).
`.dev.vars.example` is unchanged. The one open item is **not** a credential but a legal one: before any real
logo asset ever replaces a badge (Owner decision 6), the owner must obtain brand-guideline permission per
institution/service — until then, every surface shows the original monogram badge, which needs no permission.

## Tracker impact

- `docs/TASKS.md` has no existing open or blocked line for this — FN-43 is a new catalogue entry created by this
  PRD. The natural new line (not added by this PRD, per the instruction to touch only `FEATURES.md` and this
  file): "FN-43 brand badges for wallets, imports and subscriptions (no migration; `src/lib/shared/brands.ts`,
  `BrandBadge`, 27 design tokens)" under **To do** (Claude-owned, no credential), plus a **You** line: "Legal
  review: brand-guideline permission from each bank/e-wallet/ride-hailing company, before any official logo
  asset replaces FN-43's original badges."
- `docs/ACCEPTANCE.md` has no per-FN rows (journey- and security-level only, not catalogue-id-indexed) — no
  existing row moves. The "Tokens from `docs/design/tokens.css`; AA contrast both themes" Design row
  (`docs/ACCEPTANCE.md`'s Design table) gains 27 more tokens to its existing `test/contrast.test.ts` coverage
  once criterion 8/9 pass — still the same row, no new row needed.
- `docs/FEATURES.md` gains a new `### FN-43 …` entry after FN-42 (added alongside this PRD).
