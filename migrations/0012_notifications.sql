CREATE TABLE `notification_deliveries` (
	`notification_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`notification_id`, `subscription_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_deliveries_state_check" CHECK("notification_deliveries"."state" in ('sending', 'done'))
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_user_idx` ON `notification_deliveries` (`user_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_updated_idx` ON `notification_deliveries` (`updated_at`);--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_prefs_kind_check" CHECK("notification_prefs"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'daily_nudge', 'weekly_summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_prefs_user_kind_uq` ON `notification_prefs` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `space_notifications` (
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
	CONSTRAINT "space_notifications_kind_check" CHECK("space_notifications"."kind" in ('budget_80', 'budget_100', 'goal_milestone')),
	CONSTRAINT "space_notifications_content_check" CHECK(("space_notifications"."deleted_at" is null and "space_notifications"."params" is not null) or ("space_notifications"."deleted_at" is not null and "space_notifications"."params" is null and "space_notifications"."read_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_notifications_key_uq` ON `space_notifications` (`user_id`,`kind`,`data_key`);--> statement-breakpoint
CREATE INDEX `space_notifications_user_idx` ON `space_notifications` (`user_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `space_notifications_space_idx` ON `space_notifications` (`space_id`);--> statement-breakpoint
CREATE INDEX `space_notifications_created_idx` ON `space_notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `user_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`data_key` text NOT NULL,
	`params` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_notifications_kind_check" CHECK("user_notifications"."kind" in ('daily_nudge', 'weekly_summary')),
	CONSTRAINT "user_notifications_content_check" CHECK(("user_notifications"."deleted_at" is null and "user_notifications"."params" is not null) or ("user_notifications"."deleted_at" is not null and "user_notifications"."params" is null and "user_notifications"."read_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_notifications_key_uq` ON `user_notifications` (`user_id`,`kind`,`data_key`);--> statement-breakpoint
CREATE INDEX `user_notifications_user_idx` ON `user_notifications` (`user_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_notifications_created_idx` ON `user_notifications` (`created_at`);