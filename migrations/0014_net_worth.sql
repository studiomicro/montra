CREATE TABLE `net_worth_items` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`kind` text,
	`name` text,
	`currency` text,
	`price_source` text,
	`price_symbol` text,
	`quantity_scaled` text,
	`quantity_scale` integer,
	`manual_value_minor` integer,
	`acquired_on` text,
	`note` text,
	`created_at` integer,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "net_worth_items_content_check" CHECK(("net_worth_items"."deleted_at" is null and "net_worth_items"."kind" in ('cash', 'investment_stock', 'investment_crypto', 'investment_gold', 'property', 'vehicle', 'debt', 'other_asset')
				and "net_worth_items"."name" is not null and "net_worth_items"."currency" is not null and "net_worth_items"."created_at" is not null
				and "net_worth_items"."price_source" in ('manual', 'indodax', 'gold_api')
				and ("net_worth_items"."manual_value_minor" is null or "net_worth_items"."manual_value_minor" between 1 and 10000000000000)
				and ("net_worth_items"."price_source" <> 'manual' or ("net_worth_items"."manual_value_minor" is not null and "net_worth_items"."price_symbol" is null))
				and ("net_worth_items"."price_source" <> 'indodax' or ("net_worth_items"."kind" = 'investment_crypto' and "net_worth_items"."currency" = 'IDR' and "net_worth_items"."quantity_scaled" is not null
					and "net_worth_items"."price_symbol" is not null and length("net_worth_items"."price_symbol") between 1 and 15 and "net_worth_items"."price_symbol" not glob '*[^a-z0-9]*'))
				and ("net_worth_items"."price_source" <> 'gold_api' or ("net_worth_items"."kind" = 'investment_gold' and "net_worth_items"."currency" = 'IDR' and "net_worth_items"."quantity_scaled" is not null and "net_worth_items"."price_symbol" is null))
				and (("net_worth_items"."quantity_scaled" is null and "net_worth_items"."quantity_scale" is null)
					or ("net_worth_items"."quantity_scaled" not glob '*[^0-9]*' and "net_worth_items"."quantity_scaled" not glob '0*' and length("net_worth_items"."quantity_scaled") between 1 and 24
						and (("net_worth_items"."kind" = 'investment_crypto' and "net_worth_items"."quantity_scale" = 8) or ("net_worth_items"."kind" = 'investment_gold' and "net_worth_items"."quantity_scale" = 3))))
				and ("net_worth_items"."acquired_on" is null or length("net_worth_items"."acquired_on") = 10))
			or ("net_worth_items"."deleted_at" is not null and "net_worth_items"."kind" is null and "net_worth_items"."name" is null and "net_worth_items"."currency" is null and "net_worth_items"."price_source" is null
				and "net_worth_items"."price_symbol" is null and "net_worth_items"."quantity_scaled" is null and "net_worth_items"."quantity_scale" is null and "net_worth_items"."manual_value_minor" is null
				and "net_worth_items"."acquired_on" is null and "net_worth_items"."note" is null and "net_worth_items"."created_at" is null))
);
--> statement-breakpoint
CREATE INDEX `net_worth_items_space_idx` ON `net_worth_items` (`space_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `net_worth_items_price_idx` ON `net_worth_items` (`price_source`,`price_symbol`);--> statement-breakpoint
CREATE TABLE `net_worth_snapshots` (
	`space_id` text NOT NULL,
	`date` text NOT NULL,
	`total_minor` integer,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`partial` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	PRIMARY KEY(`space_id`, `date`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "net_worth_snapshots_total_check" CHECK(("net_worth_snapshots"."deleted_at" is null and "net_worth_snapshots"."total_minor" is not null and abs("net_worth_snapshots"."total_minor") <= 9007199254740991 and length("net_worth_snapshots"."date") = 10)
			or ("net_worth_snapshots"."deleted_at" is not null and "net_worth_snapshots"."total_minor" is null))
);
