CREATE TABLE `collectibles` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text,
	`purchase_price_minor` integer,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`purchased_on` text,
	`manual_value_minor` integer,
	`photo_key` text,
	`photo_type` text,
	`note` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "collectibles_photo_check" CHECK(("collectibles"."photo_key" is null and "collectibles"."photo_type" is null)
				or ("collectibles"."photo_key" is not null and "collectibles"."photo_type" in ('image/jpeg', 'image/png', 'image/webp'))),
	CONSTRAINT "collectibles_content_check" CHECK(("collectibles"."deleted_at" is null and "collectibles"."name" is not null and "collectibles"."purchase_price_minor" is not null
				and "collectibles"."purchase_price_minor" >= 0 and "collectibles"."purchased_on" is not null and "collectibles"."created_at" is not null
				and "collectibles"."manual_value_minor" is not null and "collectibles"."manual_value_minor" >= 0)
			or ("collectibles"."deleted_at" is not null and "collectibles"."name" is null and "collectibles"."purchase_price_minor" is null
				and "collectibles"."purchased_on" is null and "collectibles"."manual_value_minor" is null and "collectibles"."photo_key" is null
				and "collectibles"."photo_type" is null and "collectibles"."note" is null and "collectibles"."created_at" is null))
);
--> statement-breakpoint
CREATE INDEX `collectibles_space_idx` ON `collectibles` (`space_id`,`deleted_at`,`created_at`);