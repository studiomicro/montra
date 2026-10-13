CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`type` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`title` text,
	`note` text,
	`category_id` text,
	`wallet_id` text,
	`occurred_on` text,
	`occurred_at` integer,
	`source` text NOT NULL,
	`dedupe_key` text,
	`flag` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`saved_transaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`saved_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "drafts_type_check" CHECK("drafts"."type" in ('expense', 'income')),
	CONSTRAINT "drafts_source_check" CHECK("drafts"."source" in ('gmail', 'voice', 'receipt', 'statement', 'spreadsheet', 'csv', 'slack')),
	CONSTRAINT "drafts_flag_check" CHECK("drafts"."flag" is null or "drafts"."flag" in ('duplicate', 'needs_review')),
	CONSTRAINT "drafts_saved_check" CHECK("drafts"."saved_transaction_id" is null or "drafts"."deleted_at" is not null),
	CONSTRAINT "drafts_content_check" CHECK(("drafts"."deleted_at" is null and "drafts"."amount_minor" is not null and "drafts"."amount_minor" between 1 and 10000000000000 and "drafts"."currency" is not null and "drafts"."occurred_on" is not null and "drafts"."occurred_at" is not null) or ("drafts"."deleted_at" is not null and "drafts"."amount_minor" is null and "drafts"."currency" is null and "drafts"."title" is null and "drafts"."note" is null and "drafts"."category_id" is null and "drafts"."wallet_id" is null and "drafts"."occurred_on" is null and "drafts"."occurred_at" is null and "drafts"."flag" is null))
);
--> statement-breakpoint
CREATE INDEX `drafts_space_day_idx` ON `drafts` (`space_id`,`deleted_at`,`occurred_on`);--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_dedupe_uq` ON `drafts` (`space_id`,`source`,`dedupe_key`) WHERE dedupe_key is not null;