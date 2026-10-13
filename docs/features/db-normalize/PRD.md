# Database normalization review — audit and fix plan

Owner request 2026-10-08: "normalize the database" → chosen option: schema review + fixes. This is not a numbered
feature (no FN id): it is a cross-cutting audit of every table in `src/lib/server/db/schema.ts` against
`CLAUDE.md` § Data and runtime conventions and `docs/ENGINEERING_CHECKLIST.md` § Data access (D1), plus a
prioritised, risk-tiered fix plan. No code is included here; the engineer writes the actual migration(s).

**Scope note on numbering.** Migration `0024` (a `day_closures.closed_on` format CHECK) is in flight on a
parallel branch and not yet on disk (`migrations/` has `0000`–`0023` at the time of this audit). Every migration
this PRD proposes is numbered **0025+** to avoid a collision; the engineer must confirm `0024` has actually
landed (and bump numbering again if it hasn't) before running `drizzle-kit generate`.

## 1. Method

Read every migration `migrations/0000_init.sql` … `migrations/0023_recurring.sql`, the full
`src/lib/server/db/schema.ts` (1495 lines, 43 tables), `src/lib/server/spaces/spaces.ts` (`SPACE_SCOPED_TABLES`,
`purgeSpaces`), `src/lib/server/spaces/access.ts` (`requireSpaceAccess`), `src/lib/server/auth/delete-account.ts`,
and grepped `src/lib/server/**` for the query shape each index is supposed to serve (transactions, drafts,
subscriptions, net-worth items, belongings, notifications, recurring transactions).

## 2. Table inventory

Scope: **S** = space-scoped (child of `spaces`, purged by `SPACE_SCOPED_TABLES`/`purgeSpaces`,
`src/lib/server/spaces/spaces.ts:259-291`). **A** = account-scoped (one row/set per `user_id`, purged explicitly
in `delete-account.ts`). **G** = global/infra (no owner; `app_meta`, `file_deletions`, `auth_attempts`).
PK style: all tables use a `text` UUID surrogate key except the four noted as "natural/composite."

| Table (schema.ts:line) | Scope | space_id | updated_at | deleted_at | seq | PK | Purpose |
|---|---|---|---|---|---|---|---|
| `app_meta` (45) | G | – | yes | – | – | natural (`key`) | app-level markers, not user data |
| `users` (54) | A | – | – | – | – | uuid | one account |
| `user_passwords` (72) | A | – | yes | – | – | natural (`user_id`) | PBKDF2 credential + lockout |
| `sessions` (86) | A | – | – | `revoked_at` | – | uuid | opaque session, token hashed |
| `auth_attempts` (103) | G | – | – | – | – | natural (`client_hash`) | sign-in throttle |
| `spaces` (114) | – | – | yes | yes | – | uuid | the space itself |
| `space_members` (129) | S-ish* | yes | yes | yes | – | uuid | membership + role |
| `space_invites` (157) | S-ish* | yes | yes | yes | – | uuid | one live invite per space |
| `audit_events` (198) | S-ish* | yes | – | – | – | uuid | sharing/connect audit log, write-only |
| `space_seq` (223) | S | yes | – | – | =seq | natural (`space_id`) | the per-space change counter itself |
| `wallets` (236) | S | yes | yes | yes | yes | uuid | wallet + opening balance |
| `categories` (272) | S | yes | yes | yes | yes | uuid | expense/income categories |
| `import_batches` (308) | S | yes | yes | yes | yes | uuid | one row per confirmed import |
| `transactions` (353) | S | yes | yes | yes | yes | uuid | the ledger |
| `recurring_transactions` (437) | S | yes | yes | yes | yes | uuid | recurring series template |
| `goals` (503) | S | yes | yes | yes | yes | uuid | savings goal |
| `goal_contributions` (531) | S | yes | yes | yes | yes | uuid | append-only amounts toward a goal |
| `drafts` (573) | S | yes | yes | yes | yes | uuid | capture inbox row |
| `feature_flags` (629) | A | – | yes | – | – | uuid | per-user module visibility |
| `budgets` (656) | S | yes | yes | yes | yes | uuid | one space-total budget |
| `category_budgets` (686) | S | yes | yes | yes | yes | uuid | one per-category budget |
| `push_subscriptions` (724) | A | – | yes | yes | – | uuid | one browser's Web Push registration |
| `account_keys` (760) | A | – | yes | – | – | uuid | X25519 account key (FN-21) |
| `space_notifications` (789) | S | yes | yes | yes | yes | uuid | in-app notification about a space |
| `user_notifications` (830) | A | – | yes | yes | – | uuid | in-app notification about the user |
| `notification_prefs` (861) | A | – | yes | – | – | uuid | per-user, per-kind opt-out |
| `notification_deliveries` (888) | A | – | yes | – | – | composite (`notification_id`,`subscription_id`) | one push attempt |
| `subscriptions` (917) | S | yes | yes | yes | yes | uuid | recurring bill (FN-26) |
| `net_worth_items` (971) | S | yes | yes | yes | yes | uuid | asset/debt beyond wallets |
| `net_worth_snapshots` (1024) | S | yes | yes | yes | yes | composite (`space_id`,`date`) | daily total cache |
| `belongings` (1062) | S | yes | yes | yes | yes | uuid | FN-27 physical item |
| `file_deletions` (1109) | G | – | – | – | – | natural (`key`) | R2 delete outbox |
| `connected_apps` (1131) | S | yes | yes | yes | yes | uuid | OAuth connection (FN-29) |
| `collectibles` (1187) | S | yes | yes | yes | yes | uuid | FN-28 physical item |
| `user_plan_state` (1243) | A | – | yes | – | – | natural (`user_id`) | current plan |
| `credit_ledger` (1271) | A | – | – | – | – | uuid | append-only credit ledger |
| `vouchers` (1301) | G | – | yes | yes | – | uuid | voucher codes |
| `voucher_redemptions` (1334) | A | – | – | – | – | uuid | append-only, one per (voucher,user) |
| `billing_events` (1367) | A | – | – | – | – | uuid | append-only webhook/replay log |
| `plan_changes` (1415) | A | – | – | – | – | uuid | append-only plan-change audit |
| `consent_records` (1442) | A | – | – | – | – | uuid | UU PDP consent, append-only |
| `usage_stats_prefs` (1467) | A | – | yes | – | – | natural (`user_id`) | analytics opt-out |
| `day_closures` (1481) | A | – | yes | – | – | uuid | "Tutup hari" streak |

\* `space_members`/`space_invites`/`audit_events` carry `space_id` and are listed last in `SPACE_SCOPED_TABLES`
(`spaces.ts:288-290`) but are membership/audit rows, not financial data — they do not need the CLAUDE.md
space-data shape beyond `space_id` + their own lifecycle column.

**Reading this against CLAUDE.md's "every user-data table has `space_id`, `updated_at`, `deleted_at` and a sync
sequence":** every table that actually holds shared, multi-device, space-scoped financial/record data (the 20
rows marked **S** above, all of `wallets` through `collectibles`) has all four. Every **A**-scoped table lacking
one or more of them does so because it is a per-account setting, device registration or append-only audit row —
each one has an inline comment in `schema.ts` naming the reason (e.g. `user_notifications` "not space data...
without `space_id` or `seq`, like `feature_flags`", `schema.ts:826-829`). This is a real but long-standing and
consistently-applied reading of the rule, not a drift — see **Finding F6** for the one thing worth doing about
it (a wording clarification, not a migration).

## 3. Foreign keys and ON DELETE — audit

Three lifecycles, used consistently:

1. **`cascade`** — every `space_id` FK to `spaces.id` (hard space delete removes the row), and `user_id` FKs on
   tables whose rows are *only* that person's own record with no value to anyone else once they're gone:
   `space_notifications.user_id`, `user_notifications.user_id`, `notification_deliveries.user_id`,
   `consent_records.user_id`, `usage_stats_prefs.user_id`, `day_closures.user_id` (schema.ts:798, 836, 895, 1448,
   1470, 1487). These are *not* explicitly deleted in `delete-account.ts` — they rely on cascade.
   **Verified**: none of them are, in fact, listed in `delete-account.ts`'s manual steps, which is correct per
   their `onDelete: 'cascade'`.
2. **`set null`** — tables that must outlive the account for someone else's benefit (a shared space's audit
   trail, an append-only financial ledger that must stay a fact): `audit_events.actor_user_id`/`target_user_id`,
   `import_batches.created_by_user_id`, `goal_contributions.created_by_user_id`, `connected_apps.created_by_user_id`,
   `recurring_transactions.created_by_user_id`, `credit_ledger.user_id`, `voucher_redemptions.user_id`,
   `billing_events.user_id`, `plan_changes.user_id`. **Verified**: correctly *not* deleted in
   `delete-account.ts` (the comment at `delete-account.ts:33-36` names exactly this set).
3. **`no action`** (D1 always enforces FKs — see § 5) — account-core rows that must be deleted *before* `users`
   or the `DELETE FROM users` itself fails: `user_passwords`, `sessions`, `push_subscriptions`, `feature_flags`,
   `account_keys`, `user_plan_state`, `notification_prefs`, `space_members.user_id`. **Verified against
   `delete-account.ts:66-116`**: every one of these is deleted explicitly, in an order that respects the other
   FKs (`push_subscriptions` before `sessions` because it also references `sessions.id`, line 83; the credential
   delete is last before `users` and re-checked with `notExists`). I did not find a missing step — account
   deletion looks orphan-safe today.
4. **`category_id`/`wallet_id`/`transfer_to_wallet_id` on `transactions`/`drafts`/`recurring_transactions`/
   `subscriptions`/`category_budgets`**: `no action`, matching the product rule that categories and wallets are
   "never hard-deleted this pass" (`schema.ts:270`) — archived via `deleted_at` only, so the FK can never be
   exercised today. No orphan risk while that rule holds; a future hard-delete-when-unused pass (mentioned in the
   `categories` comment) would need to check for live references first, exactly like `category_budgets`'s
   migration-0020 trigger already does for its own tombstone-follows-tombstone case.

**No missing or wrong ON DELETE behaviour found.**

## 4. Indexes vs. actual query patterns

Grepped every repo module that queries a space- or user-scoped table. Every bounded per-space/per-user read I
found is covered by an index that leads with `space_id` (or `user_id`) and matches the next WHERE column:

- `transactions_space_day_idx`, `transactions_wallet_idx`, `transactions_transfer_to_idx` — the last one is used
  (`src/lib/server/transactions/repo.ts:109`, `or(eq(walletId,…), eq(transferToWalletId,…))`), not dead.
- `subscriptions_space_idx` matches `dueBillReminders`'s `space_id = ? and deleted_at is null and is_demo = 0`
  scan, bounded by `MAX_SUBSCRIPTIONS_PER_SPACE` (`src/lib/server/subscriptions/reminders.ts:48-53`).
- `net_worth_items_price_idx` on `(price_source, price_symbol)` (no `space_id`) is deliberately a cross-space
  index for the jobs Worker's price-refresh cron grouping by coin/metal symbol.
- `belongings_space_idx`, `collectibles_space_idx`, `recurring_transactions_due_idx` (partial, `status='active'`),
  `category_budgets_space_category_uq`, `space_notifications_*`, `drafts_space_day_idx` — all match their repos.
- `notification_deliveries` is only ever touched by its composite primary key (point lookups from an upsert,
  `src/lib/server/notifications/repo.ts:351-402`) — no scan, no missing index.

**No missing index found for an existing query path. No unused index found** (every index I could trace to a
query is matched by one). Two *small, low-traffic* tables have no index beyond their unique key and could
table-scan under a future feature, both fine at current/expected row counts — **defer, do not fix now**:
- `vouchers.expires_at` (an expiry sweep, if ever built, would scan the whole table — admin-authored, tiny).
- `connected_apps.token_key_id` (a key-rotation "find every row under the retiring key" query, if ever built).

## 5. CHECK constraints, enums, money, dates

Every money column is `integer … _minor` + a sibling `currency text`, exactly as CLAUDE.md requires; every
space-scoped content table uses the established "tombstone is content-free" CHECK (every content column null
exactly when `deleted_at` is set) — `transactions_content_check`, `drafts_content_check`,
`goal_contributions_content_check`, `belongings_content_check`, `collectibles_content_check`,
`net_worth_items_content_check`, `subscriptions_content_check`, `budgets_amount_check`,
`category_budgets_amount_check`, `connected_apps_content_check`, `space_notifications_content_check`,
`user_notifications_content_check`. `occurred_on`/`purchased_on`/`acquired_on`/`next_charge_on`/`start_on`/
`end_on`/`next_run_on`/`closed_on` are all `text` WIB calendar dates (`YYYY-MM-DD`), never the UTC timestamp;
`net_worth_items_content_check` and the date-shaped columns elsewhere enforce `length(col) = 10` where they
have a CHECK at all.

**F2 — `day_closures.closed_on` has no format CHECK** (`migrations/0021_streak.sql:1-11`,
`schema.ts:1481-1494`), unlike `net_worth_items.acquired_on`. **Already being fixed in migration `0024` on a
parallel branch** per the owner's note — this PRD does not propose a duplicate fix; the engineer must only
confirm `0024` lands first and renumber if it hasn't (§ "Scope note on numbering" above).

**F1 — no automated check that a D1 CHECK-constraint enum list stays in sync with its TS source of truth.**
Every `in (...)` CHECK (`transactions_type_check`, `transactions_source_check`, `wallets_type_check`,
`categories_tile_key_check`, `drafts_source_check`, `recurring_transactions_type_check`,
`net_worth_items_content_check`'s `kind`, `connected_apps_provider_check`, `billing_events_kind_check`,
`vouchers_content_check`, `notification_prefs_kind_check`, `feature_flags_module_check`,
`consent_records_kind_check`, `audit_events_action_check`, …) is hand-written SQL that must match a TS array in
`src/lib/shared/*` imported into `schema.ts` (`TRANSACTION_TYPES`, `TILE_KEYS`, `MODULES`, …, lines 13-42). I
found no test asserting these stay equal. A developer who adds a new enum value in TS without a matching
migration passes `check`/`lint`/`test`/`build` cleanly — the drift only surfaces as a D1 CHECK failure (plain
500) the first time a real row with the new value is inserted, in staging or production, not CI. This is the
single highest-value finding of this audit: **fix now, additive, test-only** (§ 6).

## 6. Normalization violations, duplicated/derivable data, naming

- **`transactions.recurrence`** (`migrations/0010_csv_import.sql:26`, `schema.ts:383`) is free text from a CSV
  import ("Bulanan", etc.), sitting beside the fully relational `recurring_transactions` +
  `transactions.recurring_series_id` built in migration 0023. **This is the exact shape the owner asked me to
  look for.** It is intentional and explicitly documented three times (`migrations/0023_recurring.sql:5-7`,
  `docs/features/fn-36-recurring/PRD.md:159` "Explicitly does not touch: `transactions.recurrence`",
  `fn-26-subscriptions/PRD.md:34` "Why `transactions.recurrence` is not used"): it is a label from an imported
  file, never a classification the app computes or depends on, and FN-36 deliberately chose not to repurpose it.
  **Recommendation: leave it.** Unifying it into `recurring_series_id` would require a D1 rebuild of
  `transactions` (again) for no behavioural gain and against two features' explicit decisions.
- **`subscriptions.category`** (`schema.ts:926`) is free text, not an FK into `categories`. Confirmed intentional
  (`docs/features/fn-26-subscriptions/PRD.md:17-20,47-48`): it is a label snapshot copied from a static,
  global, non-space-scoped catalogue of common bills, distinct from the user's own per-space `categories`
  table. **Recommendation: leave it**, documented here so it is not "fixed" by surprise later.
- **`credit_ledger.reference_id` / `plan_changes.reference_id`** (`schema.ts:1279`, `1424`) are untyped
  polymorphic references (a voucher-redemption id or a billing-event id depending on `reason`/`source`), with no
  FK and no discriminator column enforced by the database. This is the normal shape for an append-only audit
  ledger that must outlive either referent (a real FK would block exactly that), but it means a malformed id
  would be stored silently. **Recommendation: document only, no DB change** — a CHECK can validate "looks like
  a UUID" but can't validate "exists," so it would not close the real gap; not worth a rebuild for a write path
  that already goes through one guarded, reviewed billing module.
- **F3 — `belongings` and `net_worth_items` are the only two space-scoped content tables without `is_demo`**,
  unlike `transactions`, `drafts`, `subscriptions`, `connected_apps` and `collectibles` (`schema.ts:374, 594,
  937, 1145, 1203` vs. `belongings` 1062-1100 and `net_worth_items` 971-1016). Harmless today —
  `scripts/demo-seed.ts:9,98-99,157-167` only seeds transactions/subscriptions/collectibles — but it is a latent
  schema asymmetry: the day FN-25/FN-27 local-review demo data is wanted, a migration will be needed *first*,
  blocking that work. **Fix now, additive, cheap** (§ 7).
- **Naming: `belongings.current_value_minor` vs. `collectibles.manual_value_minor`.** Both are "the user's own
  estimate of what the item is worth now," but named differently. This is not an oversight — the two columns
  have different nullability and semantics by design: `belongings.current_value_minor` is nullable (null ⇒ the
  page shows a computed straight-line estimate, `schema.ts:1055-1057`), while `collectibles.manual_value_minor`
  is always set on a live row (no computed fallback exists for a collectible, `schema.ts:1179-1181`).
  **Recommendation: leave the names different** — they correctly signal the different behaviour; renaming either
  for cosmetic consistency would need a D1 rebuild for zero functional gain.
- **F6 — per-user (account-scoped) tables disagree on which of `deleted_at`/`seq` they carry**, all by design
  (`space_notifications` has `seq`, `user_notifications` does not even though it is otherwise identical in
  shape; `push_subscriptions` has `deleted_at` but no `seq`; `feature_flags`/`notification_prefs`/
  `usage_stats_prefs` have neither). Every one is commented inline with the same reasoning: these are not
  space-scoped sync data, so FN-02's offline queue and any future per-device sync (`docs/ARCHITECTURE.md`,
  deferred) do not need to resolve conflicts on them. CLAUDE.md's "every user-data table has `space_id`,
  `updated_at`, `deleted_at` and a sync sequence" reads categorically, which this body of consistent exceptions
  quietly contradicts. **Recommendation: a one-line wording fix to CLAUDE.md** ("every *space-scoped* table"),
  not a migration — see Owner decisions.

**No JSON blob holding relational data was found.** The one JSON-ish column, `space_notifications.params` /
`user_notifications.params` (`schema.ts:801, 839`), holds only the rendering numbers for a templated message
(e.g. the budget percentage), never a row's identity or a relationship — consistent with the schema comment
"never rendered text" and not a normalization violation.

## 7. Prioritised fix list

### (a) Safe additive — no D1 table rebuild, propose now

| # | Change | Risk | Why safe |
|---|---|---|---|
| 1 | **New Vitest integration test** (e.g. `test/integration/schema-enum-sync.test.ts`): for every CHECK-bearing enum column, insert one row per value of its TS source array (`TRANSACTION_SOURCES`, `CATEGORY_KINDS`, `TILE_KEYS`, `WALLET_TYPES`, `DRAFT_SOURCES`, `DRAFT_FLAGS`, `RECURRING_TYPES/FREQUENCIES/STATUSES/ATTENTION`, `NET_WORTH_KINDS`, `PRICE_SOURCES`, `CONNECTED_APP_PROVIDERS/STATUSES`, `BILLING_CYCLES`, `PLANS`, `BILLING_PERIODS`, `LEDGER_REASONS`, `CONSENT_KINDS`, `MODULES`, `NOTIFICATION_KINDS`/`SPACE_NOTIFICATION_KINDS`/`USER_NOTIFICATION_KINDS`, `VOUCHER_KINDS`, `BILLING_PROVIDERS`, `BILLING_EVENT_KINDS`, `PLAN_CHANGE_SOURCES`, `AUDIT_ACTIONS`) against the local D1, and one row per value **not** in that array, asserting the CHECK rejects it. | **Tiny.** Test-only, no schema or runtime change, no migration file. | Fails loudly in CI the next time TS and SQL drift, instead of in production. |
| 2 | **Migration `0025_belongings_net_worth_demo.sql`**: `ALTER TABLE belongings ADD COLUMN is_demo integer NOT NULL DEFAULT 0;` and the same on `net_worth_items`. | **Small.** Pure `ADD COLUMN` with a literal default, no FK, no CHECK, no rebuild (same technique as migration 0010's `transactions` extras). | Closes F3; makes the schema self-consistent before any future FN-25/FN-27 demo-seed work; zero behavioural change today (nothing reads the column yet; both tables already exclude themselves from `scripts/demo-seed.ts`). |

**Staging steps (both, run together in one deploy):**
1. Note the D1 Time Travel bookmark for the staging database *before* applying (`wrangler d1 time-travel info
   montra-staging`, or the dashboard — record the bookmark id in the deploy log).
2. `npm run db:migrate:local` first, run the full `npm run gates` plus the new test, confirm green.
3. Apply to staging only via the project's existing remote-migrate command (never `db:reset:local`'s remote
   equivalent); staging already has real migrations 0000–0023 (0024 pending) and test data — the two new steps
   are additive and affect zero existing rows (default literal, no backfill needed since there are no existing
   `belongings`/`net_worth_items` rows with a non-default value to reconcile).
4. Verify: `select count(*) from belongings where is_demo is null` and the same for `net_worth_items` both
   return 0; `PRAGMA foreign_key_check` empty (no FK touched, but keep the probe for consistency with how 0023's
   QA report verified its own additive change).
**Rollback:** D1 Time Travel to the pre-deploy bookmark. A new nullable-with-default column is also safe to
leave in place even if the surrounding feature is rolled back (no code reads it yet), so Time Travel is a
belt-and-suspenders step, not a requirement.
**Tests:** the new enum-sync test (item 1) plus a one-line schema-coverage addition confirming `belongings`/
`net_worth_items` now also satisfy whichever shared "does this table have `is_demo`" helper, if one exists, or a
direct `select is_demo from belongings limit 1` smoke assertion if not.

### (b) Needs a D1 table rebuild — found, evaluated, **none proposed for now**

D1 always enforces foreign keys (`PRAGMA foreign_keys` is ignored, confirmed by the comment and pattern in
`migrations/0022_balance_adjustment.sql:1-8`), so changing a CHECK constraint, a column's nullability/type, or
dropping a column requires the `CREATE __new_<table>` → `INSERT … SELECT` → `DROP TABLE` → `RENAME` sequence —
and if any other table's FK points at the one being rebuilt, those links must be set aside in a scratch table,
cleared, rebuilt, then restored (exactly `migrations/0022_balance_adjustment.sql:8-12,57-59`'s
`__fn37_links` pattern for `drafts.saved_transaction_id`/`subscriptions.linked_transaction_id` pointing at
`transactions`).

Two changes surfaced by this audit **would** need that treatment, and both are explicitly **not recommended**
(§ 6): removing/repurposing `transactions.recurrence` (rebuild `transactions`, the most expensive and most
heavily cross-referenced table — `drafts`, `subscriptions`, `recurring_transactions` all point at or through it)
and converting `subscriptions.category` to a `category_id` FK (rebuild `subscriptions`, smaller but still a
full `__new_subscriptions` cycle). Listed here only so a future owner who wants either one can see the real cost
before asking for it; **do not schedule unless the product requirement changes.**

## 8. Owner decisions

| # | Decision | Proposed default |
|---|---|---|
| D1 | Run fix (a) now (enum-sync test + `is_demo` columns on `belongings`/`net_worth_items`)? | **Yes, now** — both are additive, low-risk, and close the two concrete gaps this audit found. |
| D2 | Amend CLAUDE.md's "every user-data table has `space_id`, `updated_at`, `deleted_at` and a sync sequence" to read "every space-scoped table" (documents the existing, consistent exception for account-scoped tables; no code change)? | **Yes** — the current wording is already contradicted by eight consistently-designed tables; a wording fix removes the ambiguity for the next reviewer without touching any migration. |
| D3 | Pursue either rebuild in § 7(b) (`transactions.recurrence`, `subscriptions.category` → FK)? | **No, defer indefinitely** — both are deliberate product decisions already recorded in FN-26/FN-36 PRDs; revisit only if a feature actually needs the relational version. |
| D4 | Add indexes now for `vouchers.expires_at` / `connected_apps.token_key_id` (§ 4)? | **No, defer** — no query exists yet that would use them; add alongside whichever feature (expiry sweep, key rotation) first needs the scan. |

## 9. Tracker impact

No existing `docs/TASKS.md` line names this audit (checked: no "normalize"/"schema debt"/index-related open
item). Recommend adding one line under a hardening/cross-cutting section once this PRD is accepted:
`[ ] Claude — db-normalize: enum-sync test + belongings/net_worth_items is_demo column (docs/features/db-normalize/PRD.md)`,
moved to `docs/HISTORY.md` with the migration number and test-run evidence once shipped.

No `docs/ACCEPTANCE.md` row applies — this is infrastructure/audit work, not a user-facing FN feature, so it
does not move an acceptance row. If the owner wants one tracked, the natural home is a new "Data integrity"
checklist line in `docs/ENGINEERING_CHECKLIST.md` § Data access (D1): "**Enum drift.** A CHECK constraint's
`in (...)` list is asserted against its TS source array by a test; a new enum value needs a migration *and* a
green test, not just a migration."

## 10. Risk tier

**Small.** One test file, one two-column additive migration, no behavioural change, no rebuild, no data
migration beyond a default-value backfill of zero existing rows.
