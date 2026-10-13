-- FN-49 Patungan (split bill), pass 1. Numbered 0041 (0040 is reserved for FN-48 Part B); renumber at merge if
-- that changes.
-- 1. Three new tables: `patungan_splits` (one bill), `patungan_participants` (one share each, the payer's own row
--    included, so the shares always add up to the total) and `patungan_share_links` (pass 2 fills it).
-- 2. `feature_flags_module_check` gains 'patungan'. SQLite cannot alter a CHECK constraint, so `feature_flags` (a
--    small per-user table nothing points at) is rebuilt with every row and its unique index kept.
-- 3. `transactions` gains `patungan_split_id` and `patungan_effective_amount_minor` with `ALTER TABLE … ADD`
--    (nullable, no default): NOT a rebuild of the largest table. What a rebuild would add is stated without one:
--    - the column CHECK `transactions_patungan_check` (SQLite lets a column CHECK name other columns, as 0037's
--      `category_source` precedent does at table level in Drizzle): both set or both null; the effective amount
--      1 … `amount_minor`; only a live `expense` row carries a link (so a tombstone is content-free of both, like
--      every other content column — `TOMBSTONE_CONTENT` clears them on every delete path);
--    - a column foreign key to `patungan_splits(id)` (no action: a split is only ever tombstoned, and the space
--      purge deletes `transactions` before `patungan_splits`);
--    - the "same space" rule the PRD names as a composite foreign key cannot be added by ALTER, so two triggers
--      refuse an insert or update that links a row to another space's split (DB-enforced all the same);
--    - a partial unique index: one split has at most one live linked transaction.
-- Re-running: 1 is IF NOT EXISTS and 2 repeats cleanly (the scratch table is gone again at the end); the two
-- ALTERs cannot be repeated, so a re-run stops at the first one harmlessly with "duplicate column" (as 0037) —
-- the index and triggers after them, which need the columns, already exist from the first run. Remote apply only through `wrangler d1 migrations apply` after a Time Travel
-- bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `patungan_splits` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`created_by_user_id` text,
	`payer_name` text,
	`title` text,
	`total_amount_minor` integer,
	`currency` text,
	`occurred_on` text,
	`mode` text NOT NULL,
	`note` text,
	`payment_details` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "patungan_splits_mode_check" CHECK("patungan_splits"."mode" in ('equal', 'exact', 'items', 'percentage')),
	CONSTRAINT "patungan_splits_content_check" CHECK(("patungan_splits"."deleted_at" is null and "patungan_splits"."payer_name" is not null
				and length("patungan_splits"."payer_name") between 1 and 80 and "patungan_splits"."title" is not null
				and length("patungan_splits"."title") between 1 and 80 and "patungan_splits"."total_amount_minor" is not null
				and "patungan_splits"."total_amount_minor" between 1 and 10000000000000 and "patungan_splits"."currency" is not null
				and length("patungan_splits"."currency") = 3 and "patungan_splits"."occurred_on" is not null
				and ("patungan_splits"."note" is null or length("patungan_splits"."note") <= 500)
				and ("patungan_splits"."payment_details" is null or length("patungan_splits"."payment_details") <= 200))
			or ("patungan_splits"."deleted_at" is not null and "patungan_splits"."payer_name" is null and "patungan_splits"."title" is null
				and "patungan_splits"."total_amount_minor" is null and "patungan_splits"."currency" is null
				and "patungan_splits"."occurred_on" is null and "patungan_splits"."note" is null and "patungan_splits"."payment_details" is null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `patungan_splits_space_idx` ON `patungan_splits` (`space_id`,`deleted_at`,`occurred_on`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `patungan_participants` (
	`id` text PRIMARY KEY NOT NULL,
	`split_id` text NOT NULL,
	`space_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`member_user_id` text,
	`display_name` text,
	`is_payer` integer DEFAULT false NOT NULL,
	`share_amount_minor` integer,
	`breakdown_note` text,
	`paid_amount_minor` integer,
	`paid_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`split_id`) REFERENCES `patungan_splits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "patungan_participants_kind_check" CHECK("patungan_participants"."kind" in ('member', 'guest')),
	CONSTRAINT "patungan_participants_content_check" CHECK(("patungan_participants"."deleted_at" is null and "patungan_participants"."display_name" is not null
				and length("patungan_participants"."display_name") between 1 and 80
				and "patungan_participants"."share_amount_minor" is not null
				and "patungan_participants"."share_amount_minor" between 1 and 10000000000000
				and "patungan_participants"."paid_amount_minor" is not null
				and "patungan_participants"."paid_amount_minor" between 0 and "patungan_participants"."share_amount_minor"
				and ("patungan_participants"."is_payer" = 0 or "patungan_participants"."paid_amount_minor" = "patungan_participants"."share_amount_minor")
				and ("patungan_participants"."paid_amount_minor" = "patungan_participants"."share_amount_minor") = ("patungan_participants"."paid_at" is not null)
				and ("patungan_participants"."kind" = 'member' or "patungan_participants"."member_user_id" is null)
				and ("patungan_participants"."is_payer" = 0 or "patungan_participants"."kind" = 'member')
				and ("patungan_participants"."breakdown_note" is null or length("patungan_participants"."breakdown_note") <= 200))
			or ("patungan_participants"."deleted_at" is not null and "patungan_participants"."display_name" is null
				and "patungan_participants"."member_user_id" is null and "patungan_participants"."share_amount_minor" is null
				and "patungan_participants"."breakdown_note" is null and "patungan_participants"."paid_amount_minor" is null
				and "patungan_participants"."paid_at" is null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `patungan_participants_split_idx` ON `patungan_participants` (`space_id`,`split_id`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `patungan_participants_one_payer_uq` ON `patungan_participants` (`split_id`) WHERE is_payer = 1 and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `patungan_participants_member_uq` ON `patungan_participants` (`split_id`,`member_user_id`) WHERE member_user_id is not null and deleted_at is null;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `patungan_share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`split_id` text NOT NULL,
	`space_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`split_id`) REFERENCES `patungan_splits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `patungan_share_links_token_hash_unique` ON `patungan_share_links` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `patungan_share_links_live_uq` ON `patungan_share_links` (`split_id`) WHERE deleted_at is null;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_feature_flags`;--> statement-breakpoint
CREATE TABLE `__new_feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`module` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feature_flags_module_check" CHECK("__new_feature_flags"."module" in ('kekayaan', 'langganan', 'barang', 'koleksi', 'ruang', 'patungan'))
);
--> statement-breakpoint
INSERT INTO `__new_feature_flags`("id", "user_id", "module", "enabled", "created_at", "updated_at") SELECT "id", "user_id", "module", "enabled", "created_at", "updated_at" FROM `feature_flags`;--> statement-breakpoint
DROP TABLE `feature_flags`;--> statement-breakpoint
ALTER TABLE `__new_feature_flags` RENAME TO `feature_flags`;--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_user_module_uq` ON `feature_flags` (`user_id`,`module`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `patungan_split_id` text REFERENCES `patungan_splits`(`id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `patungan_effective_amount_minor` integer CONSTRAINT "transactions_patungan_check" CHECK(("patungan_split_id" is null) = ("patungan_effective_amount_minor" is null) and ("patungan_effective_amount_minor" is null or "patungan_effective_amount_minor" between 1 and "amount_minor") and ("patungan_split_id" is null or ("type" = 'expense' and "deleted_at" is null)));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `transactions_patungan_split_uq` ON `transactions` (`patungan_split_id`) WHERE patungan_split_id is not null and deleted_at is null;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `transactions_patungan_same_space_insert`
BEFORE INSERT ON `transactions`
WHEN NEW.`patungan_split_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `patungan_splits` s WHERE s.`id` = NEW.`patungan_split_id` AND s.`space_id` = NEW.`space_id`)
BEGIN
	SELECT RAISE(ABORT, 'transactions.patungan_split_id: split of another space');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `transactions_patungan_same_space_update`
BEFORE UPDATE OF `patungan_split_id`, `space_id` ON `transactions`
WHEN NEW.`patungan_split_id` IS NOT NULL AND NOT EXISTS (SELECT 1 FROM `patungan_splits` s WHERE s.`id` = NEW.`patungan_split_id` AND s.`space_id` = NEW.`space_id`)
BEGIN
	SELECT RAISE(ABORT, 'transactions.patungan_split_id: split of another space');
END;
