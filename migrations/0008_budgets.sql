CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_amount_check" CHECK(("budgets"."deleted_at" is null and "budgets"."amount_minor" > 0) or ("budgets"."deleted_at" is not null and "budgets"."amount_minor" = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_one_per_space_uq` ON `budgets` (`space_id`);