-- FN-34b streak extensions. Numbered 0038: FN-48 holds 0037 on a parallel branch (renumber at merge if another
-- migration lands first). Three changes:
-- 1. `budget_streak_days`: one within/over verdict per space and WIB date, written once by the jobs Worker. Its
--    `date` must be a real `YYYY-MM-DD` WIB date, refused otherwise by two triggers (the 0024 pattern).
-- 2. `notification_prefs` rebuilt (the 0013 precedent, SQLite cannot widen a CHECK in place): kind
--    `close_reminder` and a nullable `hour` (the WIB hour 06–23 a kind acts at; only `close_reminder` uses it).
--    Existing rows are copied unchanged (`hour` null = the kind's default).
-- 3. `user_notifications` rebuilt for kind `close_reminder`; existing rows copied unchanged.
-- D1 always enforces foreign keys (`PRAGMA foreign_keys` is ignored); no table references either rebuilt table.
CREATE TABLE IF NOT EXISTS `budget_streak_days` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budget_streak_days_status_check" CHECK("budget_streak_days"."status" in ('within', 'over'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `budget_streak_days_space_date_uq` ON `budget_streak_days` (`space_id`,`date`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `budget_streak_days_date_format_insert` BEFORE INSERT ON `budget_streak_days`
WHEN date(NEW.`date`) IS NOT NEW.`date`
BEGIN
	SELECT RAISE(ABORT, 'budget_streak_days.date must be YYYY-MM-DD');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `budget_streak_days_date_format_update` BEFORE UPDATE OF `date` ON `budget_streak_days`
WHEN date(NEW.`date`) IS NOT NEW.`date`
BEGIN
	SELECT RAISE(ABORT, 'budget_streak_days.date must be YYYY-MM-DD');
END;
--> statement-breakpoint
CREATE TABLE `__new_notification_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hour` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_prefs_kind_check" CHECK("__new_notification_prefs"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder', 'daily_nudge', 'close_reminder', 'weekly_summary')),
	CONSTRAINT "notification_prefs_hour_check" CHECK("__new_notification_prefs"."hour" is null or ("__new_notification_prefs"."kind" = 'close_reminder' and "__new_notification_prefs"."hour" between 6 and 23))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("id", "user_id", "kind", "enabled", "hour", "created_at", "updated_at") SELECT "id", "user_id", "kind", "enabled", null, "created_at", "updated_at" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_prefs_user_kind_uq` ON `notification_prefs` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `__new_user_notifications` (
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
	CONSTRAINT "user_notifications_kind_check" CHECK("__new_user_notifications"."kind" in ('daily_nudge', 'close_reminder', 'weekly_summary')),
	CONSTRAINT "user_notifications_content_check" CHECK(("__new_user_notifications"."deleted_at" is null and "__new_user_notifications"."params" is not null) or ("__new_user_notifications"."deleted_at" is not null and "__new_user_notifications"."params" is null and "__new_user_notifications"."read_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_user_notifications`("id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at") SELECT "id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at" FROM `user_notifications`;--> statement-breakpoint
DROP TABLE `user_notifications`;--> statement-breakpoint
ALTER TABLE `__new_user_notifications` RENAME TO `user_notifications`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_notifications_key_uq` ON `user_notifications` (`user_id`,`kind`,`data_key`);--> statement-breakpoint
CREATE INDEX `user_notifications_user_idx` ON `user_notifications` (`user_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `user_notifications_created_idx` ON `user_notifications` (`created_at`);
