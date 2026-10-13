CREATE TABLE `space_seq` (
	`space_id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`opening_balance_minor` integer DEFAULT 0 NOT NULL,
	`is_favourite` integer DEFAULT false NOT NULL,
	`last_four` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wallets_type_check" CHECK("wallets"."type" in ('tunai', 'bank', 'e_wallet', 'kartu_kredit', 'lainnya')),
	CONSTRAINT "wallets_last_four_check" CHECK("wallets"."last_four" is null or (length("wallets"."last_four") = 4 and "wallets"."last_four" not glob '*[^0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `wallets_space_idx` ON `wallets` (`space_id`,`deleted_at`);