-- FN-36 recurring transactions: the `recurring_transactions` series table and `transactions.recurring_series_id`.
-- SQLite allows `ALTER TABLE … ADD COLUMN … REFERENCES` when the new column defaults to NULL (it does), even with
-- foreign keys enforced (D1 always enforces them), so `transactions` is not rebuilt: every existing row keeps
-- NULL and nothing else changes (no `updated_at`/`seq` change, nothing syncs as edited). Not the FN-18
-- `transactions.recurrence` column, which stays free text from a CSV import. `recurring_series_id` is ON DELETE
-- SET NULL (allowed in ADD COLUMN, no rebuild): a hard delete of a series row (a future tombstone sweep) never
-- fails on its transactions; they stay as plain rows without a series link.
CREATE TABLE `recurring_transactions` (
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
	CONSTRAINT "recurring_transactions_type_check" CHECK("recurring_transactions"."type" in ('expense', 'income')),
	CONSTRAINT "recurring_transactions_status_check" CHECK("recurring_transactions"."status" in ('active', 'paused', 'stopped')),
	CONSTRAINT "recurring_transactions_attention_check" CHECK("recurring_transactions"."attention" is null or "recurring_transactions"."attention" in ('limit', 'refs', 'member')),
	CONSTRAINT "recurring_transactions_content_check" CHECK(("recurring_transactions"."deleted_at" is null and "recurring_transactions"."amount_minor" is not null and "recurring_transactions"."amount_minor" between 1 and 10000000000000
				and "recurring_transactions"."currency" is not null and "recurring_transactions"."wallet_id" is not null and "recurring_transactions"."category_id" is not null
				and (("recurring_transactions"."frequency" = 'monthly' and "recurring_transactions"."interval_day" between 1 and 31)
					or ("recurring_transactions"."frequency" = 'weekly' and "recurring_transactions"."interval_day" between 1 and 7))
				and "recurring_transactions"."start_on" is not null and "recurring_transactions"."next_run_on" is not null
				and ("recurring_transactions"."end_on" is null or "recurring_transactions"."end_on" >= "recurring_transactions"."start_on"))
			or ("recurring_transactions"."deleted_at" is not null and "recurring_transactions"."amount_minor" is null and "recurring_transactions"."currency" is null
				and "recurring_transactions"."wallet_id" is null and "recurring_transactions"."category_id" is null and "recurring_transactions"."title" is null and "recurring_transactions"."note" is null
				and "recurring_transactions"."frequency" is null and "recurring_transactions"."interval_day" is null and "recurring_transactions"."start_on" is null
				and "recurring_transactions"."end_on" is null and "recurring_transactions"."next_run_on" is null and "recurring_transactions"."attention" is null))
);
--> statement-breakpoint
CREATE INDEX `recurring_transactions_space_idx` ON `recurring_transactions` (`space_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `recurring_transactions_due_idx` ON `recurring_transactions` (`space_id`,`next_run_on`) WHERE status = 'active' and deleted_at is null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurring_series_id` text REFERENCES recurring_transactions(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `transactions_recurring_idx` ON `transactions` (`space_id`,`recurring_series_id`);