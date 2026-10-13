# FN-49 Patungan (split bill)

Slug: `fn-49-patungan`. Phase 2/3 adjacent (a new optional module beside Langganan/Barang/Koleksi/Ruang). Owner
request 2026-10-11 ("add feature to patungan per user like LINE and GoPay" — behaviour reference only; no name,
mascot, logo or copy of either is reused). Owner decisions taken before the PRD, recorded in
`docs/features/fn-49-patungan/REQUEST.md`:

- People: anyone by name (a guest, no Montra account) or a live member of the current shared space.
- Split modes: equal (remainder to the payer), exact amounts (must sum to the total), per item (reusing FN-15's
  receipt item lines, tax/service shared proportionally), percentage.
- Settling: a read-only share link (plus WhatsApp-ready text) shows each person's amount and the payer's typed
  payment details; the payer ticks "Lunas" when money arrives. Montra never moves money.
- Books: the payer's own expense counts only their own share; the others' shares are money owed to the payer
  ("Piutang", FN-25c) until marked paid.

**Amended 2026-10-11** after the owner reviewed the first draft — see **Owner decisions — answered** below. The
single biggest change: a patungan can be **linked to the transaction that actually paid the whole bill** (e.g. an
imported bank row), and every aggregate surface in the app and the public API must then count only the payer's
own share of that row. This PRD's data model, scope, out-of-scope list and acceptance criteria are rewritten
around that; nothing from the first draft is reused unamended.

Risk tier: **Large** — a `transactions` schema rebuild touching the project's single shared aggregation module,
two further new tables, a signed-out-reachable route, a deterministic rounding engine with four modes, and a
settle flow with partial payments. See **Suggested split into passes** below (re-checked for the linking change).

## Goal

A group of friends splits a bill — the café bill LINE Pay/GoPay users are used to splitting, or a shared grocery
run, a trip, a kos deposit. Today Montra has no way to record "I paid Rp 400.000 (the whole bill, maybe even
already sitting in an imported bank row), three friends owe me Rp 100.000 each": the payer either eats the whole
expense (wrong — it overstates their spending in every report, budget and chart) or quietly edits the imported
row's amount by hand (wrong — it understates what was actually paid, breaks statement reconciliation, and nobody
else sees what they owe). Patungan lets the payer record or link the real bill once, split it four honest ways,
and hand each person a link that shows only their own amount and how to pay the payer back — while every number
Montra shows the payer (and anyone it tells, e.g. the assistant) reflects only their own share, and the
underlying bank/import row is never altered.

## Scope

### Data model

New tables (migration **0040**, see Architecture notes for the renumber-at-merge flag) plus a rebuild of
`transactions` and of `feature_flags`'s module CHECK:

- **`patungan_splits`** — one row per bill being split. `space_id`; `created_by_user_id` (the payer, nullable
  `on delete set null` like `goals.createdByUserId`/`import_batches.createdByUserId`) plus a `payer_name` text
  **snapshot** taken at creation so the payer's display name survives their own account deletion or removal from
  the space (the record stays for the other members, `CLAUDE.md` "shared spaces hold the records"); `title`;
  `total_amount_minor` + `currency` — **must exactly equal the linked transaction's `amount_minor`/`currency`
  when one is linked** (see Linking, below); `occurred_on` (WIB date); `mode` (`equal`, `exact`, `items`,
  `percentage`); `note`; `payment_details` (free text the payer types — "GoPay 0812…", a bank name and account —
  cleaned through the existing `maskAccountNumbers`/`cleanText` pair, `src/lib/shared/text.ts`, the same
  defensive scrub FN-15 runs on its `shop`/`payment_method` fields, even though the payer typed it themselves);
  `is_demo`; `created_at`/`updated_at`/`deleted_at`/`seq`. **No `linked_transaction_id` column** — the link is
  owned by `transactions` (below), one-directional, so there is exactly one place that can ever disagree with
  itself.
- **`patungan_participants`** — one row per person's share, **including the payer's own row** (so
  `sum(share_amount_minor) = total_amount_minor` always holds, with no special-cased remainder). `split_id`,
  `space_id` (denormalised for `SPACE_SCOPED_TABLES` purge and indexing, the `goal_contributions` pattern);
  `kind` (`member` | `guest`); `member_user_id` (nullable, set when `kind = 'member'`, `on delete set null`);
  `display_name` (text, **always set** — a snapshot of the member's account name or the typed guest name at the
  time the participant was added/edited, so the UI never needs a live join to `users` and a removed member's
  share still shows a name); `is_payer` (boolean, exactly one true row per split — enforced by a partial unique
  index on `split_id` where `is_payer`); `share_amount_minor` (integer, 1…`MAX_AMOUNT_MINOR`); `breakdown_note`
  (nullable text, e.g. "Nasi goreng, Es teh" for the `items` mode — display only, never re-parsed, same "note not
  a table" choice FN-15 makes for its own item lines, `src/lib/server/receipts/save.ts:197-211`); `paid_amount_minor`
  (integer, 0…`share_amount_minor`; a CHECK ties `is_payer` to `paid_amount_minor = share_amount_minor` — a payer
  can never owe themselves); `paid_at` (nullable, set exactly when `paid_amount_minor = share_amount_minor`);
  `created_at`/`updated_at`/`deleted_at`/`seq`.
- **`patungan_share_links`** — modelled line-for-line on `space_invites` (`schema.ts:292-313`,
  `src/lib/server/spaces/invites.ts`): `split_id`, `space_id`, `token_hash` (unique, SHA-256 of a `randomToken(32)`
  value, the token itself shown exactly once), `created_by_user_id` (`on delete set null`), `expires_at`,
  `created_at`/`updated_at`/`deleted_at`. A partial unique index keeps at most one **live** link per split, so
  regenerating revokes the old one in the same batch the invite flow already uses
  (`createInvite`, `src/lib/server/spaces/invites.ts:63-115`). One link shows the **whole bill** — every
  participant's name and amount — to anyone who opens it (owner decision, answered; see below).
- **`transactions`** gains two nullable columns (a table rebuild, the technique `migrations/0022_balance_adjustment.sql`
  and `migrations/0027_ride_food_categories.sql` already use on this exact table): `patungan_split_id`
  (`references patungan_splits.id, onDelete: 'set null'` — a safety net; the application itself clears it
  explicitly, see below) and `patungan_effective_amount_minor` (integer). A new CHECK: `(patungan_split_id is
  null) = (patungan_effective_amount_minor is null)`, `patungan_effective_amount_minor is null or
  (patungan_effective_amount_minor between 1 and amount_minor)`, and `patungan_split_id is null or type =
  'expense'` (only an expense row can be the bill a patungan splits). `transactions_content_check`
  (`schema.ts:567-570`) is extended so both columns are null on a tombstone like every other content column —
  **this is how deleting the linked transaction automatically un-links it, with no new code path** (see Linking,
  below). A composite foreign key `(space_id, patungan_split_id) references patungan_splits (space_id, id)`
  (the `category_budgets_category_fk` pattern, `schema.ts:858-862`) keeps a link inside one space, DB-enforced.
  A partial unique index `transactions_patungan_split_uq` on `patungan_split_id` where not null and `deleted_at`
  is null makes the relationship one-to-one in both directions: one split has at most one live linked
  transaction, one transaction links to at most one live split.
- **`feature_flags.module`** CHECK gains `'patungan'` (`schema.ts:798-801`) — same small rebuild FN-39 already
  did to `categories.tile_key` (`migrations/0027_ride_food_categories.sql`). Patungan joins Kekayaan/Langganan/
  Barang/Koleksi/Ruang as a togglable module (`src/lib/shared/feature-flags.ts:8`), default on.

### Linking a split to an existing transaction (the effective amount)

This is the owner's answered decision 1, and the part of the feature every other report depends on.

- **Two ways to create a split.** On `/patungan/baru`:
  - **"Dari transaksi"** — pick a live `expense` transaction of the space not already linked to another live
    split (reachable from the create form's own picker, or as a "Buat patungan" row-menu action in Riwayat,
    `/patungan/baru?dariTransaksi=<id>`). Title/total/currency/date pre-fill from that transaction and the total
    is **locked to it exactly** (refused if the typed total or currency would no longer match — linking recomputes
    nothing, it only accepts an already-matching total). No wallet is asked (the real spend is already recorded).
  - **No transaction picked** — a wallet becomes a **required** field (no opt-in checkbox any more — the owner's
    decision 1 retires the old draft's "Catat pengeluaranku" checkbox), and saving the split **always** creates
    one new `transactions` row for the payer's own share only, through FN-05's existing
    `capturedTransactionInput`/`insertTransactions` path (`src/lib/server/transactions/repo.ts`, the exact
    pattern `src/lib/server/receipts/save.ts:282-382` already uses), source `manual`. Because this row's stored
    `amount_minor` already *is* the payer's share, `patungan_effective_amount_minor` is set equal to it (a
    documented no-op through `coalesce`, not a special case the aggregate code has to know about).
- **What a link changes, and what it never changes.** Linking (either path above) sets the transaction's
  `patungan_split_id` and `patungan_effective_amount_minor` (= the payer participant row's `share_amount_minor`)
  in the same `db.batch` that writes the split and its participants. **`amount_minor`, `currency`, `occurred_on`,
  `dedupe_key` and `source` of that transaction are never touched** — FN-16's duplicate detection and FN-18's
  import-batch bookkeeping keep working exactly as before, because they read those columns and those alone.
- **The one shared place every total reads from.** `src/lib/server/transactions/aggregate.ts` already is, by its
  own documentation (`aggregate.ts:13-20`), "the only functions that sum or list `transactions`" that Riwayat,
  Beranda (FN-08), Laporan (FN-09) and budgets (FN-07) all call unchanged — and tracing its callers confirms the
  money-flow chart (`src/lib/server/reports/money-flow.ts`), the assistant and agent's read-only tools
  (`src/lib/server/tanya/tools.ts`, `src/lib/server/agent/facts.ts`), budget-threshold notifications
  (`src/lib/server/notifications/triggers.ts`), and the public API (`src/routes/api/v1/transactions/+server.ts:5,16`
  calling `periodTotals`/`listTransactionsByDay`; `src/routes/api/v1/laporan/ringkasan/+server.ts` → `laporanReport`
  → `periodTotals`/`categoryTotals`/`merchantTotals`/`monthlyTotals`, `src/lib/server/reports/laporan.ts:21-26,414-448`)
  all go through it too, not a second query of their own. This PRD adds one SQL fragment,
  `const EFFECTIVE_AMOUNT = sql`coalesce(t.patungan_effective_amount_minor, t.amount_minor)``, and substitutes it
  for every bare `t.amount_minor`/`sum(t.amount_minor)` used for summing or ordering (never for display) in that
  one file: `periodTotals` (`aggregate.ts:200-204`), the inline per-day sum inside `listTransactionsByDay`
  (`:339-344`), `dailyTotals` (`:371-376`), `categoryTotals` (`:415-421`), `monthlyTotals` (`:450-456`),
  `merchantTotals`'s derived table and its `order by sum(...)` (`:490-497`), `categoryMonthlyTotals`
  (`:521-529`), `largestTransactions`'s `order by` (`:558-562` — "biggest expenses" ranks by what the payer
  actually spent), and `moneyFlowTotals`'s sum and order (`:741-751`). Because every consumer above calls these
  functions, this one file's change is the entire fix — no second patch site anywhere else in the app.
- **Two named, deliberate exceptions**, both already noted in the file's own callers: `frequentManualTransactions`
  (`aggregate.ts:591-638`, "Catat lagi") keeps using the raw `amount_minor` — it recreates a fresh, independent
  manual row, not a view onto an existing one; `listTransactionsForExport` (`:667-710`, FN-18 CSV export) also
  keeps the raw amount — the export is a literal ledger dump of what each row says it is, by design.
- **What the Riwayat row itself shows.** `TransactionListRow` (`aggregate.ts:73-91`) and `LIST_SELECT`
  (`:270-280`) gain the two new columns, exposed as `patungan: { splitId: string; effectiveAmountMinor: number
  } | null`. The row still shows its full stored `amountMinor` (never hidden or replaced) with a small subtext
  under it exactly when `effectiveAmountMinor < amountMinor`: "patungan: bagianmu Rp 100.000" (ID) / "split:
  your share Rp 100,000" (EN), linking through to `/patungan/[id]`. When a fresh own-share row was created
  instead of linked, `effectiveAmountMinor === amountMinor` and no subtext is shown (there is nothing to explain
  — the number already is the share), only a small "Patungan" chip linking to the split.
- **The public API.** `GET /api/v1/transactions` keeps `amountMinor` meaning exactly what it always has (the
  stored ledger value) and gains an optional `patungan: { splitId, effectiveAmountMinor } | null` field per row
  (additive, non-breaking per FN-38's versioning discipline, `src/lib/server/api/schemas.ts`/`serialize.ts`), with
  an OpenAPI description (`src/lib/server/api/openapi.ts`) stating plainly that a consumer summing `amountMinor`
  across rows will overcount a linked row versus `/api/v1/laporan/ringkasan`'s totals, which already use the
  effective amount transparently (inherited for free, see above). The transaction `GET`/list endpoints never
  mutate or reveal the split's other participants — only this row's own two fields.
- **Editing the linked transaction.** While `patungan_split_id` is set, the existing transaction-edit action
  refuses a write that changes `amount_minor` or `currency` ("Transaksi ini tertaut ke patungan '<title>'; lepas
  tautannya dulu untuk mengubah jumlahnya." / the English equivalent) — every other field (title, note, date,
  category, wallet, payment method, tag, reference, photo) stays editable exactly as today, since none of those
  affect reconciliation between the split's total and the real paid amount. This is a new, explicit rule (owner
  decision needed — see Owner decisions, this amendment).
- **Editing the split while linked (and unlocked — no payment recorded yet).** Any edit that changes the payer
  participant row's `share_amount_minor` (changing mode, re-splitting, adding/removing a participant) **writes
  the linked transaction's `patungan_effective_amount_minor` in the same `db.batch`**, so the two numbers can
  never drift apart; a `batchAssert` (`src/lib/server/db/assert.ts`, the `receipts/save.ts:345-349` pattern)
  confirms equality after the write as a defence-in-depth check, not the only guard.
- **Unlinking.** A payer-only "Lepas tautan" action on `/patungan/[id]` nulls the transaction's two columns in
  one write; the transaction becomes a normal, independent, full-amount row from then on (fully counted in every
  total again), and the split goes back to its "no bill row" state — exactly the UI the create flow shows when
  no transaction was ever picked, offering either "Buat transaksi untuk bagianmu" (creates the fresh own-share
  row described above) or "Tautkan transaksi lain".
- **Deleting the split.** The delete action's `db.batch` does three things together: tombstone the split,
  tombstone every participant (content-free, the existing convention), and — when a transaction is linked — null
  its two `patungan_*` columns (the same write "Lepas tautan" makes), reverting it to full-amount counting. The
  transaction itself is never deleted.
- **Deleting the linked transaction.** Ordinary Riwayat delete has no idea Patungan exists, and needs no new
  code: `transactions_content_check`'s existing "every content column null on a tombstone" rule, now covering
  these two columns too, means the moment that row is tombstoned it is already unlinked *and* already excluded
  from every total (a deleted row is never summed at all) — nothing to revert, nothing double-counted. The split
  itself survives, now with no linked transaction; `/patungan/[id]` shows "Transaksi yang menautkan patungan ini
  sudah dihapus" with the same two choices "Lepas tautan" would offer. **No transaction is ever auto-created by
  this path** — only an explicit user action creates one, so money is never invented behind an unrelated delete.
- **Settling never changes any total.** `paid_amount_minor`/`paid_at` on a participant row are never read by
  `aggregate.ts`, `laporan.ts`, `money-flow.ts`, budgets, Tanya, the agent, or the public API's summaries — only
  by `/patungan` itself and (once FN-25c lands) the deferred Kekayaan follow-up. Marking a participant "Lunas"
  cannot change Beranda's total, a budget's spent amount, or any chart, before or after — by construction, not by
  a check that has to remember to exclude it.

### Rounding engine (`src/lib/shared/patungan.ts`)

A pure, tested module, no DB access — the same "domain code the client and server share" rule (`CLAUDE.md`):

- **Equal**: `total_amount_minor` divided by the number of participants (payer included), floored; every leftover
  minor unit goes to the **payer's** row (owner decision, already taken).
- **Exact**: every participant's amount (payer included) is typed; the server refuses the split unless the
  BigInt-exact sum equals `total_amount_minor` — no silent remainder, no auto-fill.
- **Percentage**: each participant's percentage is entered to two decimal places (stored as basis points,
  0…10000) and must sum to exactly 10000 (100.00 %); each share is `floor(total * bp / 10000)`, then the leftover
  minor units (always `< number of participants`) are handed out one each, in participant order, by the
  **largest-remainder method** (ranked by each row's dropped fractional remainder, ties broken by creation order)
  — deterministic and reproducible from the same inputs, so a rounding vector is a fixed, testable answer.
- **Per item**: the payer assigns each receipt item (one or more participants per item, split equally among its
  assignees when more than one) a subtotal; tax + service minus discount is distributed to every participant
  **proportionally to their own item subtotal** using the same largest-remainder method as percentage (so the
  adjustment rows round the same deterministic way); a participant assigned no item at all gets a zero item
  subtotal and a zero adjustment share (not an error — out of scope for a flat "tax-only" participant, see Out
  of scope).
- Every mode's output is asserted (`sum(shares) === total`) before it is ever written — a failed assertion is a
  bug, never a user-facing rounding error.

### Entry points and routes

- **`/patungan`** (new route, behind the `patungan` module flag like `/langganan`): list of the space's splits,
  newest first, each row showing title, total, "Kamu sebagai pembayar" / "Kamu ditagih Rp X" depending on whether
  the signed-in user is the payer or a `member`-kind participant, a settled/unsettled chip, and a small "tertaut"
  tag when a transaction is linked.
- **`/patungan/baru`**: create a split — title, total amount (typed, or exactly fixed once "Dari transaksi" picks
  a row — see Linking above), date, currency, mode picker, participants (a live space member, or a typed guest
  name), mode-specific inputs, and (only when no transaction is picked) a required wallet for the payer's own
  auto-created expense row.
- **Reused entry point — Struk (FN-15):** the receipt review screen gains a third save choice, "Patungan", beside
  today's "Satu transaksi"/"Pisah per item" (`docs/FEATURES.md` FN-15). It hands the **already-parsed, already
  user-edited** item array (`ReceiptDraft.items`, `src/lib/server/receipts/save.ts:94-109`) into
  `/patungan/baru?mode=items` as pre-filled rows — no new receipt-items table, no change to
  `src/lib/server/receipts/schema.ts`. A receipt-originated split has no existing transaction to link to (the
  receipt has not been saved as one yet), so it always takes the "no transaction picked" path above.
- **`/patungan/[id]`**: detail — every participant's share and paid state; the payer (only) sees "Tandai lunas" /
  "Catat sebagian" per unsettled participant, the link/unlink controls described above, "Buat
  tautan"/"Perbarui tautan"/"Cabut tautan" for the share link, and "Hapus".
- **`/patungan/bagikan/[token]`** (public, read-only, **works signed out** — added to `PUBLIC_APP_ROUTES`,
  `src/lib/server/auth/gate.ts:10`, the exact precedent the install guide already uses): shows the split's title,
  total, date, **every** participant's name and amount (owner decision, answered: one link, all names and
  amounts visible to anyone who opens it — a bill forwarded in a group chat, same as the reference behaviour),
  the payer's `payment_details` text, and whether each participant has paid. No wallet, no other transaction, no
  other space data. GET only; a POST/action never reaches this route (settling always goes through the
  authenticated `/patungan/[id]` action). No `(app)` sidebar, no nav — a standalone minimal layout like
  `/ruang/undangan/[token]`'s page but without its "join" action.
- **WhatsApp-ready text**: a small `shareText()` helper (new, `src/lib/shared/patungan.ts`) builds one plain-text
  block ("*<title>*\nTotal Rp X\nBagianmu: Rp Y\nBayar ke: <payment details>\n<share link>") through `tr()`/`trf()`
  so it is bilingual, opened via the Web Share API (`navigator.share`) with a `wa.me`/`whatsapp://send?text=`
  fallback link when it is unavailable (desktop) — no WhatsApp Business API, no phone-number requirement.

### Share link protections

- Token: `randomToken(32)` (43 URL-safe base64 characters, `src/lib/server/util.ts`, identical shape to invite and
  session tokens), stored only as its SHA-256 (`sha256Hex`); the raw token exists only in the URL shown once.
- Expiry: **30 days from creation** (owner decision, answered) — longer than FN-03's 7-day invite, since
  settling a multi-person bill can take weeks.
- Revoke: "Cabut tautan" tombstones the live row; "Perbarui tautan" revokes and creates a new one in the same
  batch (the `createInvite` two-statement pattern). An expired or revoked token answers the same 404-shaped
  "Tautan tidak berlaku" page an unknown token answers — no existence oracle.
- `Referrer-Policy: strict-origin` on any response whose URL carries the token (`carriesInviteToken`/
  `withSecurityHeaders`, `src/hooks.server.ts:15,26`, extended to match `/patungan/bagikan/`); `redactedPath`
  (`src/lib/server/spaces/invites.ts:34-42`) gains the same prefix so the one request-log line never carries the
  raw token.
- Rate limit: the existing `countAttempt`/`overAttemptLimit` fixed-window throttle (`src/lib/server/auth/
  throttle.ts`) is applied per client to the share-view route, bounding brute-force token guessing the same way
  sign-in attempts are bounded.
- `noindex`: automatic — the share route is served on the app host, which `hooks.server.ts:121` already marks
  `x-robots-tag: noindex` for every response (the marketing site is the only indexed host, FN-32); confirmed by a
  test on this route specifically.
- The share page never shows wallet names, wallet balances, other transactions, the space's name, other members'
  roles, or any account identifier — only the split's own content as scoped above.

### Settling

- "Tandai lunas" (payer-only action): sets `paid_amount_minor = share_amount_minor`, `paid_at = now` for one
  participant. Idempotent — settling an already-settled row is a no-op, not an error.
- "Catat sebagian" (partial payment): the payer types an amount; the server adds it to `paid_amount_minor`
  (refusing any value that would push the total past `share_amount_minor`) and sets `paid_at` only once the sum
  reaches the full share.
- **No transaction is ever created by settling.** Montra does not know which wallet received the repayment and
  never invents one — `CLAUDE.md` "money never invented". If the payer wants the repayment on their own books,
  they record it themselves as an ordinary income/transfer transaction. **Auto-matching an imported statement row
  to a settlement is explicitly deferred — owner decision, answered: "later, not this feature."**
- Un-settling ("Batalkan lunas") is allowed only while the split is not yet "locked" (below) and only by the
  payer.

### Edits after sharing (locking)

- Before any participant has `paid_amount_minor > 0`: the payer may freely edit title, mode, participants, and
  amounts (a full re-save, same shape-then-DB-check discipline as `parseReceiptForm`/`saveReceiptTransactions`);
  any such edit that changes the payer's own share re-syncs a linked transaction's effective amount in the same
  batch (Linking, above).
- Once any non-payer participant has `paid_amount_minor > 0`, the split is **locked**: `mode`, participant list,
  and every `share_amount_minor` become read-only server-side — the edit action refuses the write, not just hides
  the form. Title, note, date, and `payment_details` remain editable; settling/un-settling still works; the share
  link can still be revoked/regenerated; the split can still be deleted (unlinking its transaction as above).
- A **linked transaction's `amount_minor`/`currency`** is locked independently of payment state, for as long as
  the link exists at all (Linking, above) — the two locks are separate rules for separate reasons.

### Shared-space member view

- Any live member of the space can see every split in `/patungan` and its detail (space data is shared, FN-03) —
  but only the split's `created_by_user_id` can settle, edit, delete, link/unlink, or manage the share link
  (owner decision, answered — "other defaults as proposed"). A member who is also a participant sees their own
  row highlighted ("Bagianmu").
- **Payer gone (owner decision 9, 2026-10-11):** once the split's payer is no longer a live member of the space
  (removed, left, or account deleted), the space's Pemilik may "Lepas tautan" or "Hapus" that split, so its bill
  counts in full again. Nothing else changes: settling and editing stay payer-only, an Anggota is still refused,
  and while the payer is still a member the Pemilik is refused like anyone else. No automatic unlink.
- A removed member loses access the same way every other space route already enforces it
  (`requireSpaceAccess`'s existing 404-shaped refusal) — no new authorization code path, reused directly.

### Currency and multi-currency rule

- A split has exactly one currency (the linked transaction's, or typed when standalone); every participant's
  share is in that same currency — no mixed-currency splits. 2-decimal currencies (FN-47: USD, SGD, MYR, EUR,
  AUD, GBP, TWD, HKD, CNY) accept cents in every mode's amount/percentage inputs, decimal mark per `t.locale`
  exactly as FN-47 already does; IDR/JPY stay whole-unit-only.

### Demo rows

- The seed script (`scripts/seed-local.ts`) gains one fictional split (`is_demo: true`), excluded from every real
  total it could touch (its own "Belum dilunasi" total) and badged "Data demo" in its list row. Its linked demo
  transaction (if any) is already excluded from every real total by FN-05's existing `is_demo` rule
  (`aggregate.ts` queries already filter `t.is_demo = 0`), unaffected by this PRD's `EFFECTIVE_AMOUNT` change.

### i18n, 360 px, themes

- Every new string (mode names, participant rows, settle actions, the share page's own copy, the WhatsApp
  template, the locked-split and locked-link explanations, the Riwayat "bagianmu" subtext, the feature-flag label
  "Patungan") goes through `tr()`/`i18n-en.ts`; a test fails on a missing English entry, the existing project-wide
  rule.
- Phone-first to 360 px, 44 px touch targets, all four themes (light, dark, Hitam-putih, the two Pro themes) via
  existing design tokens only — no new colour tokens needed.

## Out of scope

- **Kekayaan ("Piutang") integration this pass is conditional, not guaranteed** — see Architecture notes and
  Owner decisions: it requires FN-25c's `receivable` net-worth kind/class to exist first, and FN-25c has not
  merged. If FN-49 ships first, it ships with its own "Belum dilunasi" (unsettled) total on `/patungan` only; the
  Kekayaan wiring is a tracked follow-up, not invented ahead of FN-25c.
- **Linking an imported bank/e-wallet statement row to auto-settle a participant — explicitly deferred (owner
  decision, answered: "later, not this feature").** No auto-match heuristic, no "mungkin ini pembayarannya"
  suggestion this pass; settling is always a manual tap.
- A participant who owes tax/service but is assigned no receipt item in `items` mode getting a non-zero share —
  every participant in `items` mode must be assigned at least one item (or zero, with a zero share), no flat
  "cover the tax only" row.
- Reminders, push notifications, or scheduled nudges to unpaid participants — the share link and WhatsApp text
  are the only "ask for payment" mechanism this pass.
- A public API **write** surface for Patungan (create/settle/link via `/api/v1`) — FN-38's named scope is
  unchanged; only the read-only `patungan` field on `GET /api/v1/transactions` is added (Linking, above).
- Counterparty contact details beyond a typed name (no phone number, no linked contact book).
- Group-level recurring splits ("split every Friday's lunch automatically") — one-off splits only.
- Linking a split to more than one transaction, or one transaction to more than one split — the one-to-one unique
  index refuses both.
- Linking to a non-`expense` transaction (income, transfer, balance adjustment) — refused server-side.
- Any financial, tax or legal guidance about who should pay what — Patungan only records what the user already
  decided.

## Acceptance criteria

### Rounding

1. Given a payer creates an equal split of Rp 100.000 among 3 participants (payer included), then the two
   non-payer shares are Rp 33.333 each and the payer's own share is Rp 33.334 (the remainder), summing to
   Rp 100.000 exactly.
2. Given a payer creates an equal split of 100 cents (2-decimal currency) among 3 participants, then shares are
   33/33/34 cents (payer gets the 34), summing to 100 cents exactly.
3. Given an exact-amounts split where the typed amounts do not sum to the total, when the payer submits, then
   the write is refused server-side with a field-level error naming the mismatch, and no row is written.
4. Given a percentage split of 33.33 % / 33.33 % / 33.34 % on Rp 999.999, then the three shares sum to exactly
   Rp 999.999, computed by floor-then-largest-remainder, and the same input produces the same per-participant
   shares on every run (a fixed test vector).
5. Given a per-item split from a scanned receipt with tax and service, when items are assigned to participants
   and tax+service is distributed proportionally to each participant's item subtotal, then the sum of every
   participant's final share equals exactly the receipt's total (items + tax + service − discount).

### Linking and the effective amount (every aggregate surface)

6. Given a `transactions` row of Rp 400.000 is linked to a split where the payer's own share is Rp 100.000, then
   that row's stored `amount_minor` stays Rp 400.000 forever (confirmed unchanged after the link), while Riwayat's
   header total, Beranda's month total, every Laporan breakdown (month/period summary, per-category,
   per-merchant, monthly/yearly, biggest expenses), the budget/safe-to-spend figure, the Alur uang (money-flow)
   totals, and the Tanya/Agent answers for the same period all count exactly Rp 100.000 for that row — verified by
   one test per surface asserting the same period's total changes by exactly the payer's share, not the full bill.
7. Given the same linked row, then `GET /api/v1/laporan/ringkasan` and `GET /api/v1/transactions`'s own summary
   both reflect Rp 100.000 for that row, and the row's own `GET` response keeps `amountMinor: 400000` and adds
   `patungan: { splitId, effectiveAmountMinor: 100000 }`.
8. Given the linked row, when `/riwayat` or `/patungan`'s underlying list renders it, then the row shows the full
   Rp 400.000 with a "patungan: bagianmu Rp 100.000" subtext (ID) / "split: your share Rp 100,000" (EN) beneath
   it, linking to the split.
9. Given a split created with no transaction picked, when it saves, then exactly one new `transactions` row is
   written with `amount_minor` equal to the payer's own share only (never the full bill), and it is indistinguishable
   in every total from any other manual expense of that amount (no "bagianmu" subtext, since there is nothing to
   explain).
10. Given a payer attempts to link a split whose `total_amount_minor`/`currency` does not exactly match the
    chosen transaction's `amount_minor`/`currency`, then the link is refused with a clear error and nothing is
    written.
11. Given a payer attempts to link a transaction that is an income, transfer or balance-adjustment row, or one
    already linked to another live split, then the link is refused server-side (the CHECK/unique-index guard,
    not only a hidden picker option).
12. Given a linked transaction, when the payer attempts to edit its `amount_minor` or `currency`, then the write
    is refused with an explanatory error; every other field of that transaction (title, note, date, category,
    wallet, payment method, tag, reference, photo) remains editable exactly as before linking.
13. Given the payer edits the split's shares while unlocked (no payment yet) and a transaction is linked, then
    the linked transaction's `patungan_effective_amount_minor` changes in the same write to match the payer's new
    share, and every aggregate from criterion 6 reflects the new share immediately on the next read.
14. Given the payer taps "Lepas tautan", then the transaction's two `patungan_*` columns are cleared in one write,
    it is fully counted (its real stored amount) in every aggregate from the very next read, and the split shows
    its "no bill row" state with the "create my share"/"link another transaction" choice.
15. Given a split is deleted while linked, then in one batch the split and every participant become content-free
    tombstones and the linked transaction's two `patungan_*` columns are cleared — the transaction is never
    deleted and is fully counted again from the next read.
16. Given a linked transaction is deleted through the ordinary Riwayat delete action (which has no Patungan-aware
    code), then it becomes a content-free tombstone (its `patungan_*` columns null like every other content
    column) and disappears from every total as any deleted row does; the split survives, unlinked, and no
    transaction is auto-created by this path.
17. Given a participant is marked "Lunas" or given a partial payment, then every total from criterion 6, computed
    before and after that action on the same period, is byte-for-byte identical — settling never moves a total.
18. Given a statement import that would previously have produced a duplicate-detection warning (same amount,
    within a day, same wallet) against a now-linked transaction, then that detection still fires exactly as
    before linking — `amount_minor`, `dedupe_key` and `source` are unread and unchanged by linking.
19. Given the Tanya assistant or the Agent (beta) is asked for a figure covering a period with a linked
    transaction, then its answer equals Beranda/Riwayat/Laporan's figure for the same period (the existing
    cross-surface equality test, reconfirmed once this PRD's `EFFECTIVE_AMOUNT` substitution lands, since both
    read the same `aggregate.ts` functions).

### Settling, sharing and space isolation

20. Given "Tandai lunas" is tapped for a participant, then that row's `paid_amount_minor` becomes its
    `share_amount_minor` and `paid_at` is set; tapping it again is a no-op, not an error.
21. Given "Catat sebagian" records a partial amount less than the share, then `paid_at` stays null; given a
    further partial payment reaches the full share, then `paid_at` is set on that write; given an amount that
    would exceed the share, then the write is refused and the stored amount is unchanged.
22. Given a signed-out visitor opens a live, unexpired share-link URL, then they see the split's title, total,
    date, **every** participant's name/amount/paid state, and the payer's typed payment details, and nothing else
    — verified against the exact field list the page's `load` returns.
23. Given the share link is revoked, or 30 days have passed since it was created, then the same URL answers the
    same "tautan tidak berlaku" page an unknown/malformed token answers — identical status, body shape and
    timing (no existence oracle).
24. Given the payer taps "Perbarui tautan", then the previous token stops working immediately (same batch) and a
    new token is issued; at most one live link ever exists per split, probed with 10 concurrent submissions.
25. Given 25 requests to one share-link URL within the throttle window from the same client, then requests beyond
    the configured limit are refused, matching the existing `auth/throttle.ts` response shape.
26. Given any response under `/patungan/bagikan/`, then its `x-robots-tag` header is `noindex` and its URL never
    appears in the request log line unredacted.
27. Given a space the requesting user is not a live member of, every authenticated `/patungan*` load/action
    (list, detail, create, link/unlink, settle, share-link management) answers exactly as `requireSpaceAccess`
    already does elsewhere — same status/body/timing for "not a member" as for "space does not exist".
28. Given two different spaces each with their own splits (and, for one, a linked transaction), a query or action
    scoped to space A never returns or mutates a row of space B.
29. Given the account-deletion or space-purge path runs, every `patungan_splits`, `patungan_participants` and
    `patungan_share_links` row of a purged space is removed through the existing `SPACE_SCOPED_TABLES` sweep.
30. Given a `Data demo` split (and its demo-linked transaction, if any) exists in a space, then it is excluded
    from `/patungan`'s "Belum dilunasi" total and from every real total, badged "Data demo" in its own row.
31. Given the page loads, errors, or a save/link/settle action is in flight, then every new screen shows the
    project's standard loading, empty, error, saving and success states (success only after the server confirms
    the write).
32. Given every new Indonesian string this feature introduces, each has a working English counterpart; every
    money figure renders through `formatMoney`/`formatMoneyCompact`.
33. Given the layout at 360 px width, every new screen has no horizontal scroll and every tappable control is at
    least 44 px.
34. Given JavaScript is disabled, every write this feature introduces (create, link/unlink, settle, partial
    payment, edit, delete, share-link create/revoke) still works as a plain form POST.
35. Given the `patungan` feature flag is turned off, `/patungan*` routes (other than the signed-out share page,
    reachable regardless of the viewer's own flag state) are hidden from navigation but change no stored total.

## Architecture notes

- **New modules**: `src/lib/shared/patungan.ts` (modes, rounding engine, `shareText()`, pure, unit-tested with
  rounding vectors); `src/lib/server/patungan/repo.ts` (create/link/unlink/edit/settle/delete — every write that
  touches both a split and a transaction does so in one `db.batch`, the `receipts/save.ts`/`budgets/repo.ts`
  guarded-write pattern); `src/lib/server/patungan/share-links.ts` (modelled on
  `src/lib/server/spaces/invites.ts`); `src/lib/server/patungan/messages.ts`; `src/lib/ui/patungan/*.svelte`.
- **Touched — schema and the shared aggregate**: `src/lib/server/db/schema.ts` (three new tables; the
  `transactions` rebuild adding `patungan_split_id`/`patungan_effective_amount_minor`, their CHECKs, the
  composite FK and the unique index; the `feature_flags.module` CHECK rebuild); **`src/lib/server/transactions/
  aggregate.ts`** (the `EFFECTIVE_AMOUNT` SQL fragment and its nine substitution sites listed in Linking, above
  — this is the single highest-leverage, highest-care change in the whole PRD: every existing test of
  `periodTotals`/`dailyTotals`/`categoryTotals`/`monthlyTotals`/`merchantTotals`/`categoryMonthlyTotals`/
  `largestTransactions`/`moneyFlowTotals` must keep passing unchanged for the common case where
  `patungan_split_id is null`, i.e. `coalesce(null, amount_minor) = amount_minor`).
- **Touched — everything downstream, unchanged in code**: `src/lib/server/reports/laporan.ts`,
  `src/lib/server/reports/money-flow.ts`, `src/lib/server/budgets/{summary,math,anggaran}.ts`,
  `src/lib/server/tanya/tools.ts`, `src/lib/server/agent/facts.ts`, `src/lib/server/notifications/triggers.ts`,
  `src/routes/api/v1/transactions/+server.ts`, `src/routes/api/v1/laporan/ringkasan/+server.ts` — none of these
  files change; they inherit the corrected totals for free because they all call into `aggregate.ts`.
- **Touched — display and API shape**: `src/lib/server/transactions/aggregate.ts`'s `TransactionListRow`/
  `LIST_SELECT` (the new `patungan` field); the Riwayat row component that renders `TransactionListRow` (the
  "bagianmu" subtext); `src/lib/server/api/schemas.ts`/`serialize.ts`/`openapi.ts` (the additive `patungan` field
  on the transaction response schema); `src/lib/server/auth/gate.ts` (`PUBLIC_APP_ROUTES` gains
  `/(app)/patungan/bagikan/[token]`); `src/hooks.server.ts`/`src/lib/server/spaces/invites.ts`
  (`carriesInviteToken`/`redactedPath` extended); `src/lib/ui/transactions/TransactionForm.svelte` and the Struk
  review screen (third save choice); `src/lib/shared/i18n.ts` + `i18n-en.ts`; wherever `SPACE_SCOPED_TABLES` is
  defined (add the three new tables).
- **Not touched**: `src/lib/server/receipts/save.ts` is read, not modified — `ReceiptDraft.items` passes through
  to `/patungan/baru?mode=items`, never persisted a second way.
- **Migration number**: this worktree and `main` both end at `migrations/0036_agent_runs.sql`. Per the task
  brief, `feat/fn-48-import-categories` is expected to take **0037**, `fn-34b` **0038**, `fn-26b` **0039** on
  branches not yet in this tree, and FN-25c is "later" with no number claimed yet. This PRD's migration is
  therefore numbered **0040 at the earliest candidate**; the engineer renumbers at merge time to whatever is the
  next free contiguous number once those branches land first.
- **Kekayaan integration is a dependency, not a given**: `docs/features/fn-25b-wealth-page/PRD.md` (branch
  `feat/fn-25b-wealth-page`, not merged) scopes the `receivable` net-worth kind/class as its own **pass 2
  (FN-25c)** — not built yet. FN-49 does not touch `net_worth_items` and does not invent a second "money owed to
  you" kind: once FN-25c's `receivable` class exists, `summarizeNetWorth` is extended (a small follow-up, not
  part of this PRD) to add every space's unsettled non-payer `share_amount_minor − paid_amount_minor` into the
  `receivable` class total, read-side only. Until then `/patungan` shows its own "Belum dilunasi" total.
- **No new Worker, no new cron, no AI call.**

## Prerequisites

- **No new credential.** No `.dev.vars.example` entry is added or required.
- **Soft dependency, not a hard credential gate**: the Kekayaan ("Piutang") line only renders once FN-25c merges;
  until then it is simply absent, not "Belum dikonfigurasi" (there is nothing to configure).

## Owner decisions — answered (2026-10-11)

1. **A patungan can be linked to the transaction that paid the whole bill; every aggregate counts only the
   payer's own share for that row; the transaction's stored amount never changes; a standalone split (no
   transaction picked) always creates the payer's own-share expense (no longer opt-in).** Built exactly as
   specified above — the full "Linking" section, the `transactions` schema change, and the `aggregate.ts`
   `EFFECTIVE_AMOUNT` substitution across all nine of its sum/order sites, plus the public API's additive
   `patungan` field.
2. **One share link for the whole bill: every participant's name and amount visible to anyone who opens it; 30
   days; revocable.** Built exactly as specified in Share link protections, above.
3. **Auto-settling from an imported repayment is deferred — not this feature.** Settling stays a manual
   "Tandai lunas"/"Catat sebagian" tap only; recorded as an explicit Out-of-scope line.
4. **Only the split's creator (the payer) can settle, edit, delete, link/unlink, or manage the share link; any
   live space member can view.** Accepted as proposed. Trade-off (unchanged from the first draft): another
   member cannot act on the payer's behalf, must ask them.
5. **Kekayaan integration ships only after FN-25c exists**, as a small read-side follow-up, not a second
   net-worth kind invented in this PRD. Accepted as proposed. Trade-off (unchanged): `/patungan` carries its own
   "Belum dilunasi" total until that follow-up lands.

### New sub-decisions raised by building decision 1 — proposed defaults (not yet owner-confirmed)

These did not exist in the owner's original three answers because they only arise from implementing the linking
model; flagged here so the owner can override before or during the build rather than after.

6. **Linking requires the split's total/currency to exactly equal the chosen transaction's amount/currency** —
   no partial-linking (e.g. "this transaction also included a non-split item") and no recomputation on link.
   Trade-off: a bill that mixed a shared meal with the payer's own separate unshared purchase on the same
   statement row cannot be split as one link — the payer would record two transactions (or edit the import)
   first. Alternative (allowing the split's total to be less than the transaction's amount, with the remainder
   silently being "the payer's own, unshared" spend) was rejected as a second kind of implicit effective-amount
   math layered on the first, harder to explain on the Riwayat row. **Default: exact match required.**
7. **Editing a linked transaction's `amount_minor`/`currency` is refused outright (must unlink first), for as
   long as the link exists — independent of whether any participant has paid.** Trade-off: fixing a typo'd
   import amount on a linked row takes two steps (unlink, fix, decide whether to re-link) instead of one.
   Alternative (auto-adjusting the payer's share proportionally when the linked amount changes) was rejected as
   silently changing what every participant was told they owed, without their knowledge, the day after a share
   link may have already been sent. **Default: refuse the edit, require an explicit unlink.**
8. **Deleting a linked transaction through ordinary Riwayat delete silently unlinks the split (via the existing
   tombstone-nulls-every-content-column rule) and never auto-creates a replacement expense.** Trade-off: the
   payer who deletes the wrong row loses their own tracked share too, with only `/patungan/[id]`'s banner to
   notice and fix it. Alternative (refusing to delete a linked transaction at all) was rejected as surprising —
   Riwayat's delete action has no reason to know Patungan exists, and making it reason about that would spread
   Patungan-specific logic into FN-05's own code. **Default: silent unlink, explicit banner, no auto-create.**

## Suggested split into passes

Re-checked against decision 1 — linking is no longer separable from "basic" Patungan, since it is now how the
payer's own-share bookkeeping works even in the simplest case (equal/exact split, no receipt, no share link).

- **Pass 1** — the `transactions` rebuild + `aggregate.ts`'s `EFFECTIVE_AMOUNT` substitution (the highest-risk,
  highest-leverage change — ships first, alone, re-running every existing aggregate test before anything else is
  built on top of it); all three new tables + the `feature_flags` module; `equal`/`exact` modes; both creation
  paths (link-to-existing, auto-create-own-share); full settle only (no partial payments yet); the Riwayat
  "bagianmu" subtext and the public API's additive field; delete/unlink cascades; both locking rules
  (payment-lock, link-lock). No share link yet (space-member view only).
- **Pass 2** — `percentage` and `items` modes (the largest-remainder rounding engine + the Struk third-save-choice
  entry point); the share link (token, public page, revoke/regenerate, rate limit, `noindex`/referrer/redaction
  wiring); the WhatsApp text helper; partial payments ("Catat sebagian").
- **Pass 3** (after FN-25c merges) — the Kekayaan `summarizeNetWorth` read-side follow-up. Not blocked on this
  feature's own build; tracked separately once FN-25c lands.

## Tracker impact

- `docs/TASKS.md` gains a new Phase 2/3 line: "FN-49 Patungan (split bill): `transactions` schema change +
  `aggregate.ts` effective-amount fix (every report/budget/Beranda/Laporan/Alur uang/Tanya/Agent/public-API total
  counts only the payer's own share of a linked bill row), three new tables (migration 0040, renumber at merge),
  equal/exact/percentage/per-item modes, settle with partial payments, share link (token, revoke, 30-day expiry,
  rate-limited, noindex), WhatsApp text, `patungan` feature flag. Kekayaan ("Piutang") integration tracked as a
  follow-up once FN-25c merges."
- No existing `docs/ACCEPTANCE.md` row names Patungan (it is new). Once built, it adds a "Required journey" row
  ("Link a split to an imported bill row, confirm every total counts only the payer's share, settle with partial
  payments, open the share link signed out, revoke it") and a "Money and dates" row ("A linked transaction's
  stored amount never changes; every aggregate surface counts the payer's own share only; split rounding is
  deterministic and sums to the total exactly in every mode") — both "Not run" until the engineer's own gates and
  the QA pass confirm them.
- Does not close any existing `docs/TASKS.md` item (new feature); depends on, but does not block, FN-48/FN-34b/
  FN-26b's migration numbers and on FN-25c's `receivable` kind for its one deferred integration line.

## Owner decisions — answered 2026-10-11

9. **Payer leaves the space (red team L2, answered 2026-10-11):** the payer's splits are *not* unlinked
   automatically. Once the payer is no longer a live member (removed, left, account deleted), the space's
   Pemilik may unlink or delete such a split, so the bill counts in full again; every other write stays payer-only
   and the exception never applies while the payer is still a member. (This replaces a briefly considered
   "unlink automatically on leaving" rule, which was never built.)

Asked and answered: link a split to the bill transaction (reports count only the payer's share); one share link for
the whole bill, 30 days, revocable; auto-settle from imported repayments later. The three follow-on defaults
(exact total/currency match to link, refuse edits to a linked row's amount/currency until unlinked, silent unlink
when the linked transaction is deleted) are taken by the orchestrator as proposed. Build pass 1 first.
