CREATE TABLE `categories` (
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
	CONSTRAINT "categories_kind_check" CHECK("categories"."kind" in ('expense', 'income')),
	CONSTRAINT "categories_tile_key_check" CHECK("categories"."tile_key" in ('kopi', 'makan', 'belanja-harian', 'belanja', 'transportasi', 'tagihan', 'kesehatan', 'hiburan', 'pendidikan', 'tempat-tinggal', 'gaji', 'bonus', 'freelance', 'hadiah', 'lain'))
);
--> statement-breakpoint
CREATE INDEX `categories_space_idx` ON `categories` (`space_id`,`deleted_at`,`is_hidden`);--> statement-breakpoint
CREATE TABLE `transactions` (
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
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_to_wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transactions_type_check" CHECK("transactions"."type" in ('expense', 'income', 'transfer')),
	CONSTRAINT "transactions_source_check" CHECK("transactions"."source" in ('manual', 'gmail', 'voice', 'receipt', 'statement', 'spreadsheet', 'csv', 'slack')),
	CONSTRAINT "transactions_content_check" CHECK(("transactions"."deleted_at" is null and "transactions"."amount_minor" is not null and "transactions"."amount_minor" between 1 and 10000000000000 and "transactions"."currency" is not null and "transactions"."wallet_id" is not null and "transactions"."occurred_on" is not null and "transactions"."occurred_at" is not null and ("transactions"."type" = 'transfer') = ("transactions"."transfer_to_wallet_id" is not null) and ("transactions"."type" <> 'transfer' or "transactions"."category_id" is null) and ("transactions"."transfer_to_wallet_id" is null or "transactions"."transfer_to_wallet_id" <> "transactions"."wallet_id")) or ("transactions"."deleted_at" is not null and "transactions"."amount_minor" is null and "transactions"."currency" is null and "transactions"."wallet_id" is null and "transactions"."transfer_to_wallet_id" is null and "transactions"."category_id" is null and "transactions"."occurred_on" is null and "transactions"."occurred_at" is null and "transactions"."title" is null and "transactions"."note" is null))
);
--> statement-breakpoint
CREATE INDEX `transactions_space_day_idx` ON `transactions` (`space_id`,`deleted_at`,`occurred_on`);--> statement-breakpoint
CREATE INDEX `transactions_wallet_idx` ON `transactions` (`space_id`,`wallet_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `transactions_transfer_to_idx` ON `transactions` (`space_id`,`transfer_to_wallet_id`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_dedupe_uq` ON `transactions` (`space_id`,`source`,`dedupe_key`) WHERE dedupe_key is not null;