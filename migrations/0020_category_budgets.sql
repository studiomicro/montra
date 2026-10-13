CREATE UNIQUE INDEX `categories_space_id_uq` ON `categories` (`space_id`,`id`);--> statement-breakpoint
CREATE TABLE `category_budgets` (
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
	CONSTRAINT "category_budgets_amount_check" CHECK(("category_budgets"."deleted_at" is null and "category_budgets"."amount_minor" > 0) or ("category_budgets"."deleted_at" is not null and "category_budgets"."amount_minor" = 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_budgets_space_category_uq` ON `category_budgets` (`space_id`,`category_id`);--> statement-breakpoint
-- A category's tombstone tombstones its budget in the same statement (and so the same batch), content-free per
-- category_budgets_amount_check, stamped with the space's current change counter: whatever path deletes a category
-- (none in the app yet; sync or purge later), no live budget outlives it.
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
