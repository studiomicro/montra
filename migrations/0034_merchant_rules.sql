-- FN-20 merchant recognition: two new tables, no change to any existing one. `merchant_rules` holds what a space
-- learned from its members' category corrections (one live rule per space, key and kind; deletes are content-free
-- tombstones), `merchant_cache` the AI step's answers for 90 days. Both store only the cleaned descriptor key and
-- name, never raw bank text, amounts, dates or account numbers. Numbered 0035 (0033 and 0034 are reserved for other
-- branches; journal idx 33). Hand-edited to IF NOT EXISTS so a re-run is harmless. Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `merchant_cache` (
	`space_id` text NOT NULL,
	`match_key` text NOT NULL,
	`kind` text NOT NULL,
	`merchant_name` text,
	`category_id` text,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`space_id`, `match_key`, `kind`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "merchant_cache_kind_check" CHECK("merchant_cache"."kind" in ('expense', 'income')),
	CONSTRAINT "merchant_cache_reason_check" CHECK("merchant_cache"."reason" in ('ai')),
	CONSTRAINT "merchant_cache_content_check" CHECK(length("merchant_cache"."match_key") between 1 and 60
				and ("merchant_cache"."merchant_name" is null or length("merchant_cache"."merchant_name") between 1 and 80)
				and "merchant_cache"."expires_at" > "merchant_cache"."created_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `merchant_cache_expiry_idx` ON `merchant_cache` (`space_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `merchant_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`match_key` text NOT NULL,
	`merchant_name` text,
	`category_id` text,
	`kind` text NOT NULL,
	`hits` integer DEFAULT 1 NOT NULL,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "merchant_rules_kind_check" CHECK("merchant_rules"."kind" in ('expense', 'income')),
	CONSTRAINT "merchant_rules_source_check" CHECK("merchant_rules"."source" in ('correction', 'manual')),
	CONSTRAINT "merchant_rules_content_check" CHECK(length("merchant_rules"."match_key") between 1 and 60 and "merchant_rules"."hits" >= 1
				and ("merchant_rules"."deleted_at" is not null or ("merchant_rules"."merchant_name" is not null
					and length("merchant_rules"."merchant_name") between 1 and 80 and "merchant_rules"."category_id" is not null))
				and ("merchant_rules"."deleted_at" is null or ("merchant_rules"."merchant_name" is null and "merchant_rules"."category_id" is null)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `merchant_rules_live_uq` ON `merchant_rules` (`space_id`,`match_key`,`kind`) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `merchant_rules_space_idx` ON `merchant_rules` (`space_id`,`deleted_at`,`updated_at`);