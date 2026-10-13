CREATE TABLE `belongings` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text,
	`purchase_price_minor` integer,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`purchased_on` text,
	`current_value_minor` integer,
	`photo_key` text,
	`photo_type` text,
	`note` text,
	`created_at` integer,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "belongings_photo_check" CHECK(("belongings"."photo_key" is null and "belongings"."photo_type" is null)
				or ("belongings"."photo_key" is not null and "belongings"."photo_type" in ('image/jpeg', 'image/png', 'image/webp'))),
	CONSTRAINT "belongings_content_check" CHECK(("belongings"."deleted_at" is null and "belongings"."name" is not null and "belongings"."purchase_price_minor" is not null
				and "belongings"."purchase_price_minor" >= 0 and "belongings"."purchased_on" is not null and "belongings"."created_at" is not null
				and ("belongings"."current_value_minor" is null or "belongings"."current_value_minor" >= 0))
			or ("belongings"."deleted_at" is not null and "belongings"."name" is null and "belongings"."purchase_price_minor" is null
				and "belongings"."purchased_on" is null and "belongings"."current_value_minor" is null and "belongings"."photo_key" is null
				and "belongings"."photo_type" is null and "belongings"."note" is null and "belongings"."created_at" is null))
);
--> statement-breakpoint
CREATE INDEX `belongings_space_idx` ON `belongings` (`space_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `file_deletions` (
	`key` text PRIMARY KEY NOT NULL,
	`due_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `file_deletions_due_idx` ON `file_deletions` (`due_at`);