-- FN-39 ride-hailing and food delivery presets: `categories_tile_key_check` gains 'ojek-online' and
-- 'pesan-antar-makanan'. SQLite cannot alter a CHECK constraint, so `categories` is rebuilt with every row and
-- index kept. Schema only: existing spaces get the two presets lazily (categories/repo.ts ensurePresetCategories).
-- D1 always enforces foreign keys (`PRAGMA foreign_keys` is ignored), and four tables reference `categories`:
--   * `transactions.category_id` and `drafts.category_id` (nullable): set aside in a scratch table, cleared, and
--     restored once the rebuilt table holds every id again (the FN-37 `__fn37_links` pattern, 0022);
--   * `recurring_transactions.category_id` cannot be cleared (a live series must have a category) and
--     `category_budgets.category_id` is NOT NULL: both tables are rebuilt without their category foreign key
--     first and rebuilt again with it afterwards. Dropping `recurring_transactions` would clear
--     `transactions.recurring_series_id` (ON DELETE SET NULL), so that link is set aside and restored as well.
-- The `category_budgets_follow_category` trigger lives on `categories` and is recreated unchanged. No
-- `updated_at` or `seq` changes, so nothing syncs as edited. Every step repeats cleanly on a database that
-- already ran it (each scratch and `__new_*` table is gone again at the end).
DROP TRIGGER IF EXISTS `category_budgets_follow_category`;--> statement-breakpoint
CREATE TABLE `__fn39_links` (`col` text NOT NULL, `row_id` text NOT NULL, `ref_id` text NOT NULL, PRIMARY KEY (`col`, `row_id`));--> statement-breakpoint
INSERT INTO `__fn39_links` SELECT 'transactions.category_id', `id`, `category_id` FROM `transactions` WHERE `category_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `__fn39_links` SELECT 'transactions.recurring_series_id', `id`, `recurring_series_id` FROM `transactions` WHERE `recurring_series_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `__fn39_links` SELECT 'drafts.category_id', `id`, `category_id` FROM `drafts` WHERE `category_id` IS NOT NULL;--> statement-breakpoint
UPDATE `transactions` SET `category_id` = NULL, `recurring_series_id` = NULL WHERE `category_id` IS NOT NULL OR `recurring_series_id` IS NOT NULL;--> statement-breakpoint
UPDATE `drafts` SET `category_id` = NULL WHERE `category_id` IS NOT NULL;--> statement-breakpoint
-- Without their category foreign key, so nothing blocks dropping `categories`.
CREATE TABLE `__new_category_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "category_budgets_amount_check" CHECK(("__new_category_budgets"."deleted_at" is null and "__new_category_budgets"."amount_minor" > 0) or ("__new_category_budgets"."deleted_at" is not null and "__new_category_budgets"."amount_minor" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_category_budgets`("id", "space_id", "category_id", "amount_minor", "currency", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "category_id", "amount_minor", "currency", "created_at", "updated_at", "deleted_at", "seq" FROM `category_budgets`;--> statement-breakpoint
DROP TABLE `category_budgets`;--> statement-breakpoint
ALTER TABLE `__new_category_budgets` RENAME TO `category_budgets`;--> statement-breakpoint
CREATE UNIQUE INDEX `category_budgets_space_category_uq` ON `category_budgets` (`space_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `__new_recurring_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`category_id` text,
	`wallet_id` text,
	`title` text,
	`note` text,
	`frequency` text,
	`interval_day` integer,
	`start_on` text,
	`end_on` text,
	`next_run_on` text,
	`status` text DEFAULT 'active' NOT NULL,
	`attention` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recurring_transactions_type_check" CHECK("__new_recurring_transactions"."type" in ('expense', 'income')),
	CONSTRAINT "recurring_transactions_status_check" CHECK("__new_recurring_transactions"."status" in ('active', 'paused', 'stopped')),
	CONSTRAINT "recurring_transactions_attention_check" CHECK("__new_recurring_transactions"."attention" is null or "__new_recurring_transactions"."attention" in ('limit', 'refs', 'member')),
	CONSTRAINT "recurring_transactions_content_check" CHECK(("__new_recurring_transactions"."deleted_at" is null and "__new_recurring_transactions"."amount_minor" is not null and "__new_recurring_transactions"."amount_minor" between 1 and 10000000000000
				and "__new_recurring_transactions"."currency" is not null and "__new_recurring_transactions"."wallet_id" is not null and "__new_recurring_transactions"."category_id" is not null
				and (("__new_recurring_transactions"."frequency" = 'monthly' and "__new_recurring_transactions"."interval_day" between 1 and 31)
					or ("__new_recurring_transactions"."frequency" = 'weekly' and "__new_recurring_transactions"."interval_day" between 1 and 7))
				and "__new_recurring_transactions"."start_on" is not null and "__new_recurring_transactions"."next_run_on" is not null
				and ("__new_recurring_transactions"."end_on" is null or "__new_recurring_transactions"."end_on" >= "__new_recurring_transactions"."start_on"))
			or ("__new_recurring_transactions"."deleted_at" is not null and "__new_recurring_transactions"."amount_minor" is null and "__new_recurring_transactions"."currency" is null
				and "__new_recurring_transactions"."wallet_id" is null and "__new_recurring_transactions"."category_id" is null and "__new_recurring_transactions"."title" is null and "__new_recurring_transactions"."note" is null
				and "__new_recurring_transactions"."frequency" is null and "__new_recurring_transactions"."interval_day" is null and "__new_recurring_transactions"."start_on" is null
				and "__new_recurring_transactions"."end_on" is null and "__new_recurring_transactions"."next_run_on" is null and "__new_recurring_transactions"."attention" is null))
);
--> statement-breakpoint
INSERT INTO `__new_recurring_transactions`("id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "title", "note", "frequency", "interval_day", "start_on", "end_on", "next_run_on", "status", "attention", "created_by_user_id", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "title", "note", "frequency", "interval_day", "start_on", "end_on", "next_run_on", "status", "attention", "created_by_user_id", "created_at", "updated_at", "deleted_at", "seq" FROM `recurring_transactions`;--> statement-breakpoint
DROP TABLE `recurring_transactions`;--> statement-breakpoint
ALTER TABLE `__new_recurring_transactions` RENAME TO `recurring_transactions`;--> statement-breakpoint
CREATE INDEX `recurring_transactions_space_idx` ON `recurring_transactions` (`space_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `recurring_transactions_due_idx` ON `recurring_transactions` (`space_id`,`next_run_on`) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE TABLE `__new_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`tile_key` text NOT NULL,
	`is_preset` integer DEFAULT false NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "categories_kind_check" CHECK("__new_categories"."kind" in ('expense', 'income')),
	CONSTRAINT "categories_tile_key_check" CHECK("__new_categories"."tile_key" in ('kopi', 'makan', 'belanja-harian', 'belanja', 'transportasi', 'ojek-online', 'pesan-antar-makanan', 'tagihan', 'kesehatan', 'hiburan', 'pendidikan', 'tempat-tinggal', 'gaji', 'bonus', 'freelance', 'hadiah', 'lain'))
);
--> statement-breakpoint
INSERT INTO `__new_categories`("id", "space_id", "kind", "name", "tile_key", "is_preset", "is_hidden", "sort_order", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "kind", "name", "tile_key", "is_preset", "is_hidden", "sort_order", "created_at", "updated_at", "deleted_at", "seq" FROM `categories`;--> statement-breakpoint
DROP TABLE `categories`;--> statement-breakpoint
ALTER TABLE `__new_categories` RENAME TO `categories`;--> statement-breakpoint
CREATE INDEX `categories_space_idx` ON `categories` (`space_id`,`deleted_at`,`is_hidden`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_space_id_uq` ON `categories` (`space_id`,`id`);--> statement-breakpoint
-- Their category foreign keys again, against the rebuilt table.
CREATE TABLE `__new_recurring_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`category_id` text,
	`wallet_id` text,
	`title` text,
	`note` text,
	`frequency` text,
	`interval_day` integer,
	`start_on` text,
	`end_on` text,
	`next_run_on` text,
	`status` text DEFAULT 'active' NOT NULL,
	`attention` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recurring_transactions_type_check" CHECK("__new_recurring_transactions"."type" in ('expense', 'income')),
	CONSTRAINT "recurring_transactions_status_check" CHECK("__new_recurring_transactions"."status" in ('active', 'paused', 'stopped')),
	CONSTRAINT "recurring_transactions_attention_check" CHECK("__new_recurring_transactions"."attention" is null or "__new_recurring_transactions"."attention" in ('limit', 'refs', 'member')),
	CONSTRAINT "recurring_transactions_content_check" CHECK(("__new_recurring_transactions"."deleted_at" is null and "__new_recurring_transactions"."amount_minor" is not null and "__new_recurring_transactions"."amount_minor" between 1 and 10000000000000
				and "__new_recurring_transactions"."currency" is not null and "__new_recurring_transactions"."wallet_id" is not null and "__new_recurring_transactions"."category_id" is not null
				and (("__new_recurring_transactions"."frequency" = 'monthly' and "__new_recurring_transactions"."interval_day" between 1 and 31)
					or ("__new_recurring_transactions"."frequency" = 'weekly' and "__new_recurring_transactions"."interval_day" between 1 and 7))
				and "__new_recurring_transactions"."start_on" is not null and "__new_recurring_transactions"."next_run_on" is not null
				and ("__new_recurring_transactions"."end_on" is null or "__new_recurring_transactions"."end_on" >= "__new_recurring_transactions"."start_on"))
			or ("__new_recurring_transactions"."deleted_at" is not null and "__new_recurring_transactions"."amount_minor" is null and "__new_recurring_transactions"."currency" is null
				and "__new_recurring_transactions"."wallet_id" is null and "__new_recurring_transactions"."category_id" is null and "__new_recurring_transactions"."title" is null and "__new_recurring_transactions"."note" is null
				and "__new_recurring_transactions"."frequency" is null and "__new_recurring_transactions"."interval_day" is null and "__new_recurring_transactions"."start_on" is null
				and "__new_recurring_transactions"."end_on" is null and "__new_recurring_transactions"."next_run_on" is null and "__new_recurring_transactions"."attention" is null))
);
--> statement-breakpoint
INSERT INTO `__new_recurring_transactions`("id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "title", "note", "frequency", "interval_day", "start_on", "end_on", "next_run_on", "status", "attention", "created_by_user_id", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "title", "note", "frequency", "interval_day", "start_on", "end_on", "next_run_on", "status", "attention", "created_by_user_id", "created_at", "updated_at", "deleted_at", "seq" FROM `recurring_transactions`;--> statement-breakpoint
DROP TABLE `recurring_transactions`;--> statement-breakpoint
ALTER TABLE `__new_recurring_transactions` RENAME TO `recurring_transactions`;--> statement-breakpoint
CREATE INDEX `recurring_transactions_space_idx` ON `recurring_transactions` (`space_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `recurring_transactions_due_idx` ON `recurring_transactions` (`space_id`,`next_run_on`) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
CREATE TABLE `__new_category_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`category_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`,`category_id`) REFERENCES `categories`(`space_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "category_budgets_amount_check" CHECK(("__new_category_budgets"."deleted_at" is null and "__new_category_budgets"."amount_minor" > 0) or ("__new_category_budgets"."deleted_at" is not null and "__new_category_budgets"."amount_minor" = 0))
);
--> statement-breakpoint
INSERT INTO `__new_category_budgets`("id", "space_id", "category_id", "amount_minor", "currency", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "category_id", "amount_minor", "currency", "created_at", "updated_at", "deleted_at", "seq" FROM `category_budgets`;--> statement-breakpoint
DROP TABLE `category_budgets`;--> statement-breakpoint
ALTER TABLE `__new_category_budgets` RENAME TO `category_budgets`;--> statement-breakpoint
CREATE UNIQUE INDEX `category_budgets_space_category_uq` ON `category_budgets` (`space_id`,`category_id`);--> statement-breakpoint
UPDATE `transactions` SET `category_id` = (SELECT l.`ref_id` FROM `__fn39_links` l WHERE l.`col` = 'transactions.category_id' AND l.`row_id` = `transactions`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__fn39_links` WHERE `col` = 'transactions.category_id');--> statement-breakpoint
UPDATE `transactions` SET `recurring_series_id` = (SELECT l.`ref_id` FROM `__fn39_links` l WHERE l.`col` = 'transactions.recurring_series_id' AND l.`row_id` = `transactions`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__fn39_links` WHERE `col` = 'transactions.recurring_series_id');--> statement-breakpoint
UPDATE `drafts` SET `category_id` = (SELECT l.`ref_id` FROM `__fn39_links` l WHERE l.`col` = 'drafts.category_id' AND l.`row_id` = `drafts`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__fn39_links` WHERE `col` = 'drafts.category_id');--> statement-breakpoint
DROP TABLE `__fn39_links`;--> statement-breakpoint
CREATE TRIGGER `category_budgets_follow_category` AFTER UPDATE OF `deleted_at` ON `categories`
WHEN NEW.`deleted_at` IS NOT NULL AND OLD.`deleted_at` IS NULL
BEGIN
	UPDATE `category_budgets`
	SET `amount_minor` = 0,
		`deleted_at` = NEW.`deleted_at`,
		`updated_at` = max(NEW.`deleted_at`, `updated_at` + 1),
		`seq` = coalesce((SELECT `seq` FROM `space_seq` WHERE `space_id` = NEW.`space_id`), `seq`)
	WHERE `space_id` = NEW.`space_id` AND `category_id` = NEW.`id` AND `deleted_at` IS NULL;
END;
