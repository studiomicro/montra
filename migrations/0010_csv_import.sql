CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`source` text NOT NULL,
	`format` text,
	`filename` text,
	`row_count` integer NOT NULL,
	`imported_count` integer NOT NULL,
	`skipped_count` integer NOT NULL,
	`already_imported_count` integer DEFAULT 0 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`undone_at` integer,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "import_batches_source_check" CHECK("import_batches"."source" in ('csv', 'statement', 'spreadsheet', 'gmail_lookback')),
	CONSTRAINT "import_batches_format_check" CHECK("import_batches"."format" is null or "import_batches"."format" in ('template', 'money_manager'))
);
--> statement-breakpoint
CREATE INDEX `import_batches_space_idx` ON `import_batches` (`space_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `import_batch_id` text REFERENCES import_batches(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_method` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `recurrence` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `tag` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `reference` text;--> statement-breakpoint
CREATE INDEX `transactions_import_batch_idx` ON `transactions` (`space_id`,`import_batch_id`);