-- FN-37 balance adjustment ("Penyesuaian saldo"): `transactions` gains the `adjustment` type and the
-- `adjustment_direction` column (set exactly on a live adjustment; cleared on a tombstone). SQLite cannot alter a
-- CHECK constraint, so the table is rebuilt with every row and index kept.
-- D1 always enforces foreign keys (`PRAGMA foreign_keys` is ignored) and `drafts.saved_transaction_id` /
-- `subscriptions.linked_transaction_id` reference this table, so dropping it while referenced fails. Those links
-- are set aside in a scratch table, cleared, and restored once the rebuilt table holds every id again; no
-- `updated_at` or `seq` changes, so nothing syncs as edited.
CREATE TABLE `__fn37_links` (`tbl` text NOT NULL, `row_id` text NOT NULL, `tx_id` text NOT NULL);--> statement-breakpoint
INSERT INTO `__fn37_links` SELECT 'drafts', `id`, `saved_transaction_id` FROM `drafts` WHERE `saved_transaction_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `__fn37_links` SELECT 'subscriptions', `id`, `linked_transaction_id` FROM `subscriptions` WHERE `linked_transaction_id` IS NOT NULL;--> statement-breakpoint
UPDATE `drafts` SET `saved_transaction_id` = NULL WHERE `saved_transaction_id` IS NOT NULL;--> statement-breakpoint
UPDATE `subscriptions` SET `linked_transaction_id` = NULL WHERE `linked_transaction_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`category_id` text,
	`wallet_id` text,
	`transfer_to_wallet_id` text,
	`title` text,
	`note` text,
	`occurred_on` text,
	`occurred_at` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`dedupe_key` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	`import_batch_id` text,
	`payment_method` text,
	`recurrence` text,
	`tag` text,
	`reference` text,
	`adjustment_direction` text,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_to_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_type_check" CHECK("__new_transactions"."type" in ('expense', 'income', 'transfer', 'adjustment')),
	CONSTRAINT "transactions_source_check" CHECK("__new_transactions"."source" in ('manual', 'gmail', 'voice', 'receipt', 'statement', 'spreadsheet', 'csv', 'slack')),
	CONSTRAINT "transactions_content_check" CHECK(("__new_transactions"."deleted_at" is null and "__new_transactions"."amount_minor" is not null and "__new_transactions"."amount_minor" between 1 and 10000000000000 and "__new_transactions"."currency" is not null and "__new_transactions"."wallet_id" is not null and "__new_transactions"."occurred_on" is not null and "__new_transactions"."occurred_at" is not null and ("__new_transactions"."type" = 'transfer') = ("__new_transactions"."transfer_to_wallet_id" is not null) and ("__new_transactions"."type" in ('expense', 'income') or "__new_transactions"."category_id" is null) and ("__new_transactions"."transfer_to_wallet_id" is null or "__new_transactions"."transfer_to_wallet_id" <> "__new_transactions"."wallet_id") and ("__new_transactions"."type" = 'adjustment') = ("__new_transactions"."adjustment_direction" is not null) and ("__new_transactions"."adjustment_direction" is null or "__new_transactions"."adjustment_direction" in ('increase', 'decrease'))) or ("__new_transactions"."deleted_at" is not null and "__new_transactions"."amount_minor" is null and "__new_transactions"."currency" is null and "__new_transactions"."wallet_id" is null and "__new_transactions"."transfer_to_wallet_id" is null and "__new_transactions"."category_id" is null and "__new_transactions"."occurred_on" is null and "__new_transactions"."occurred_at" is null and "__new_transactions"."title" is null and "__new_transactions"."note" is null and "__new_transactions"."adjustment_direction" is null))
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "transfer_to_wallet_id", "title", "note", "occurred_on", "occurred_at", "source", "dedupe_key", "is_demo", "created_at", "updated_at", "deleted_at", "seq", "import_batch_id", "payment_method", "recurrence", "tag", "reference") SELECT "id", "space_id", "type", "amount_minor", "currency", "category_id", "wallet_id", "transfer_to_wallet_id", "title", "note", "occurred_on", "occurred_at", "source", "dedupe_key", "is_demo", "created_at", "updated_at", "deleted_at", "seq", "import_batch_id", "payment_method", "recurrence", "tag", "reference" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
CREATE INDEX `transactions_import_batch_idx` ON `transactions` (`space_id`,`import_batch_id`);--> statement-breakpoint
CREATE INDEX `transactions_space_day_idx` ON `transactions` (`space_id`,`deleted_at`,`occurred_on`);--> statement-breakpoint
CREATE INDEX `transactions_wallet_idx` ON `transactions` (`space_id`,`wallet_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `transactions_transfer_to_idx` ON `transactions` (`space_id`,`transfer_to_wallet_id`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_dedupe_uq` ON `transactions` (`space_id`,`source`,`dedupe_key`) WHERE dedupe_key is not null;--> statement-breakpoint
UPDATE `drafts` SET `saved_transaction_id` = (SELECT l.`tx_id` FROM `__fn37_links` l WHERE l.`tbl` = 'drafts' AND l.`row_id` = `drafts`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__fn37_links` WHERE `tbl` = 'drafts');--> statement-breakpoint
UPDATE `subscriptions` SET `linked_transaction_id` = (SELECT l.`tx_id` FROM `__fn37_links` l WHERE l.`tbl` = 'subscriptions' AND l.`row_id` = `subscriptions`.`id`) WHERE `id` IN (SELECT `row_id` FROM `__fn37_links` WHERE `tbl` = 'subscriptions');--> statement-breakpoint
DROP TABLE `__fn37_links`;