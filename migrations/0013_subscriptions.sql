CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`catalogue_id` text,
	`name` text,
	`category` text,
	`amount_minor` integer,
	`currency` text,
	`billing_cycle` text,
	`billing_day` integer,
	`billing_month` integer,
	`wallet_id` text,
	`linked_transaction_id` text,
	`next_charge_on` text,
	`reminder_days_before` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subscriptions_content_check" CHECK(("subscriptions"."deleted_at" is null and "subscriptions"."name" is not null and "subscriptions"."category" is not null
				and "subscriptions"."amount_minor" is not null and "subscriptions"."amount_minor" > 0 and "subscriptions"."currency" is not null
				and "subscriptions"."next_charge_on" is not null and "subscriptions"."reminder_days_before" between 0 and 14
				and (("subscriptions"."billing_cycle" = 'monthly' and "subscriptions"."billing_day" between 1 and 31 and "subscriptions"."billing_month" is null)
					or ("subscriptions"."billing_cycle" = 'weekly' and "subscriptions"."billing_day" between 1 and 7 and "subscriptions"."billing_month" is null)
					or ("subscriptions"."billing_cycle" = 'yearly' and "subscriptions"."billing_month" between 1 and 12
						and "subscriptions"."billing_day" between 1 and 31)))
			or ("subscriptions"."deleted_at" is not null and "subscriptions"."catalogue_id" is null and "subscriptions"."name" is null
				and "subscriptions"."category" is null and "subscriptions"."amount_minor" is null and "subscriptions"."currency" is null
				and "subscriptions"."billing_cycle" is null and "subscriptions"."billing_day" is null and "subscriptions"."billing_month" is null
				and "subscriptions"."wallet_id" is null and "subscriptions"."linked_transaction_id" is null and "subscriptions"."next_charge_on" is null
				and "subscriptions"."reminder_days_before" is null))
);
--> statement-breakpoint
CREATE INDEX `subscriptions_space_idx` ON `subscriptions` (`space_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `__new_notification_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_prefs_kind_check" CHECK("__new_notification_prefs"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder', 'daily_nudge', 'weekly_summary'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("id", "user_id", "kind", "enabled", "created_at", "updated_at") SELECT "id", "user_id", "kind", "enabled", "created_at", "updated_at" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_prefs_user_kind_uq` ON `notification_prefs` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `__new_space_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`data_key` text NOT NULL,
	`params` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_notifications_kind_check" CHECK("__new_space_notifications"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder')),
	CONSTRAINT "space_notifications_content_check" CHECK(("__new_space_notifications"."deleted_at" is null and "__new_space_notifications"."params" is not null) or ("__new_space_notifications"."deleted_at" is not null and "__new_space_notifications"."params" is null and "__new_space_notifications"."read_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_space_notifications`("id", "space_id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at", "seq" FROM `space_notifications`;--> statement-breakpoint
DROP TABLE `space_notifications`;--> statement-breakpoint
ALTER TABLE `__new_space_notifications` RENAME TO `space_notifications`;--> statement-breakpoint
CREATE UNIQUE INDEX `space_notifications_key_uq` ON `space_notifications` (`user_id`,`kind`,`data_key`);--> statement-breakpoint
CREATE INDEX `space_notifications_user_idx` ON `space_notifications` (`user_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `space_notifications_space_idx` ON `space_notifications` (`space_id`);--> statement-breakpoint
CREATE INDEX `space_notifications_created_idx` ON `space_notifications` (`created_at`);