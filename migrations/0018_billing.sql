CREATE TABLE `billing_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text,
	`plan` text,
	`amount_minor` integer,
	`currency` text,
	`signature_valid` integer NOT NULL,
	`created_at` integer NOT NULL,
	`replay_count` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "billing_events_kind_check" CHECK("billing_events"."provider" in ('mock', 'xendit', 'midtrans')
				and "billing_events"."kind" in ('checkout_created', 'payment_succeeded', 'payment_failed', 'paid_not_applied')
				and "billing_events"."replay_count" >= 0
				and ("billing_events"."plan" is null or "billing_events"."plan" in ('pro', 'agen'))
				and ("billing_events"."amount_minor" is null or "billing_events"."amount_minor" between 0 and 9007199254740991))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_events_provider_event_uq` ON `billing_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_events_paid_reference_uq` ON `billing_events` (`provider`,`reference`) WHERE kind in ('payment_succeeded', 'paid_not_applied');--> statement-breakpoint
CREATE UNIQUE INDEX `billing_events_checkout_reference_uq` ON `billing_events` (`provider`,`reference`) WHERE kind = 'checkout_created';--> statement-breakpoint
CREATE INDEX `billing_events_user_idx` ON `billing_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_events_kind_idx` ON `billing_events` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`reference_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "credit_ledger_delta_check" CHECK(typeof("credit_ledger"."delta") = 'integer' and "credit_ledger"."delta" <> 0
				and "credit_ledger"."delta" between -1000000000 and 1000000000
				and "credit_ledger"."reason" in ('starter_grant', 'monthly_grant', 'voucher_redeemed', 'gmail_lookback_purchase', 'admin_adjustment', 'ai_capture_spend'))
);
--> statement-breakpoint
CREATE INDEX `credit_ledger_user_idx` ON `credit_ledger` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `plan_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`from_plan` text NOT NULL,
	`to_plan` text NOT NULL,
	`period_end` integer NOT NULL,
	`source` text NOT NULL,
	`reference_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plan_changes_check" CHECK("plan_changes"."from_plan" in ('gratis', 'pro', 'agen') and "plan_changes"."to_plan" in ('pro', 'agen')
				and "plan_changes"."source" in ('payment', 'voucher'))
);
--> statement-breakpoint
CREATE INDEX `plan_changes_user_idx` ON `plan_changes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_plan_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`plan` text DEFAULT 'gratis' NOT NULL,
	`billing_period` text,
	`current_period_end` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_plan_state_plan_check" CHECK("user_plan_state"."plan" in ('gratis', 'pro', 'agen')
				and ("user_plan_state"."billing_period" is null or "user_plan_state"."billing_period" in ('weekly', 'monthly'))
				and ("user_plan_state"."plan" = 'gratis' or "user_plan_state"."current_period_end" is not null))
);
--> statement-breakpoint
CREATE TABLE `voucher_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`voucher_id` text NOT NULL,
	`user_id` text,
	`redeemed_at` integer NOT NULL,
	FOREIGN KEY (`voucher_id`) REFERENCES `vouchers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voucher_redemptions_voucher_user_uq` ON `voucher_redemptions` (`voucher_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`kind` text NOT NULL,
	`credits_amount` integer,
	`plan` text,
	`plan_days` integer,
	`max_redemptions` integer NOT NULL,
	`redemption_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "vouchers_content_check" CHECK("vouchers"."max_redemptions" >= 1 and "vouchers"."redemption_count" between 0 and "vouchers"."max_redemptions"
				and (("vouchers"."kind" = 'credits' and "vouchers"."credits_amount" between 1 and 1000000000
						and "vouchers"."plan" is null and "vouchers"."plan_days" is null)
					or ("vouchers"."kind" = 'plan_days' and "vouchers"."credits_amount" is null and "vouchers"."plan" in ('pro', 'agen')
						and "vouchers"."plan_days" between 1 and 366)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_code_hash_unique` ON `vouchers` (`code_hash`);
--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers): the four FN-30 history tables are append-only. Every DELETE is refused. An UPDATE is allowed only (a) when it sets `user_id` to null, changes nothing else, and no `users` row with the old id exists any more (the FK `on delete set null` once the account row is gone: a live account's history can never be detached), or (b) on billing_events, when it raises `replay_count` by exactly one and sets `last_seen_at`, changing nothing else.
CREATE TRIGGER `credit_ledger_no_update` BEFORE UPDATE ON `credit_ledger` WHEN NOT (NEW.`user_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`) AND NEW.`id` = OLD.`id` AND NEW.`delta` = OLD.`delta` AND NEW.`reason` = OLD.`reason` AND NEW.`reference_id` IS OLD.`reference_id` AND NEW.`created_at` = OLD.`created_at`) BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `credit_ledger_no_delete` BEFORE DELETE ON `credit_ledger` BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `billing_events_no_update` BEFORE UPDATE ON `billing_events` WHEN NOT (NEW.`id` = OLD.`id` AND NEW.`provider` = OLD.`provider` AND NEW.`provider_event_id` = OLD.`provider_event_id` AND NEW.`kind` = OLD.`kind` AND NEW.`reference` IS OLD.`reference` AND NEW.`plan` IS OLD.`plan` AND NEW.`amount_minor` IS OLD.`amount_minor` AND NEW.`currency` IS OLD.`currency` AND NEW.`signature_valid` = OLD.`signature_valid` AND NEW.`created_at` = OLD.`created_at` AND ((NEW.`user_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`) AND NEW.`replay_count` = OLD.`replay_count` AND NEW.`last_seen_at` IS OLD.`last_seen_at`) OR (NEW.`user_id` IS OLD.`user_id` AND NEW.`replay_count` = OLD.`replay_count` + 1 AND NEW.`last_seen_at` IS NOT NULL))) BEGIN SELECT RAISE(ABORT, 'billing_events is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `billing_events_no_delete` BEFORE DELETE ON `billing_events` BEGIN SELECT RAISE(ABORT, 'billing_events is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `voucher_redemptions_no_update` BEFORE UPDATE ON `voucher_redemptions` WHEN NOT (NEW.`user_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`) AND NEW.`id` = OLD.`id` AND NEW.`voucher_id` = OLD.`voucher_id` AND NEW.`redeemed_at` = OLD.`redeemed_at`) BEGIN SELECT RAISE(ABORT, 'voucher_redemptions is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `voucher_redemptions_no_delete` BEFORE DELETE ON `voucher_redemptions` BEGIN SELECT RAISE(ABORT, 'voucher_redemptions is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `plan_changes_no_update` BEFORE UPDATE ON `plan_changes` WHEN NOT (NEW.`user_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`) AND NEW.`id` = OLD.`id` AND NEW.`from_plan` = OLD.`from_plan` AND NEW.`to_plan` = OLD.`to_plan` AND NEW.`period_end` = OLD.`period_end` AND NEW.`source` = OLD.`source` AND NEW.`reference_id` = OLD.`reference_id` AND NEW.`created_at` = OLD.`created_at`) BEGIN SELECT RAISE(ABORT, 'plan_changes is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `plan_changes_no_delete` BEFORE DELETE ON `plan_changes` BEGIN SELECT RAISE(ABORT, 'plan_changes is append-only'); END;--> statement-breakpoint
-- Accounts created before FN-30 start like a new sign-up: on Gratis with the 300 starter credits (re-runnable: skips users who already have them).
INSERT INTO `user_plan_state` (`user_id`, `plan`, `billing_period`, `current_period_end`, `created_at`, `updated_at`) SELECT `id`, 'gratis', NULL, NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM `users` WHERE `id` NOT IN (SELECT `user_id` FROM `user_plan_state`);--> statement-breakpoint
INSERT INTO `credit_ledger` (`id`, `user_id`, `delta`, `reason`, `reference_id`, `created_at`) SELECT lower(hex(randomblob(16))), `id`, 300, 'starter_grant', NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM `users` WHERE `id` NOT IN (SELECT `user_id` FROM `credit_ledger` WHERE `reason` = 'starter_grant' AND `user_id` IS NOT NULL);
