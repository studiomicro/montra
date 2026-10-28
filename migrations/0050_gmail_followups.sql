-- FN-19b Gmail follow-ups (docs/features/fn-19b-gmail-followups/PRD.md, "Data and migration plan"):
-- 1. `notification_prefs` and 2. `space_notifications` rebuilt (the 0013/0038 precedent: SQLite cannot widen a
--    CHECK in place) with the new space kind `gmail_payment`, starting from the newest kind lists (0038, 0013).
--    Every row is copied unchanged (same ids, `seq`, `hour`), and every index is recreated. D1 always enforces
--    foreign keys (`PRAGMA foreign_keys` is ignored); no table references either rebuilt table
--    (`notification_deliveries.notification_id` carries no foreign key).
-- 3. `gmail_connections` gains the opt-in auto-save (`auto_save` 0/1, app-validated; `auto_save_wallet_id`, ON
--    DELETE SET NULL) and its per-WIB-day burst counter (`auto_save_day`, `auto_saves`), appended last by ALTER
--    (no rebuild: `gmail_scans` and `gmail_mail` cascade from it). Existing rows read `auto_save = 0`.
-- 4. `gmail_scans.undone_at`: when "Urungkan pemindaian" ran (null = not undone).
-- 5. `gmail_mail.reread_at`: when "Baca ulang yang tertunda" queued the row again (red team L2: a re-read never
--    notifies or auto-saves, however it is delivered). Null for every existing row.
-- No new table, no mail-text column. The rebuilds are re-runnable (a leftover copy is dropped); the ALTERs (last)
-- cannot be repeated, so a re-run stops there harmlessly with "duplicate column". Deploy order: this migration,
-- then the app and jobs Workers (old code ignores the new columns and kind). Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
DROP TABLE IF EXISTS `__new_notification_prefs`;--> statement-breakpoint
CREATE TABLE `__new_notification_prefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`hour` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_prefs_kind_check" CHECK("__new_notification_prefs"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder', 'daily_nudge', 'close_reminder', 'weekly_summary', 'gmail_payment')),
	CONSTRAINT "notification_prefs_hour_check" CHECK("__new_notification_prefs"."hour" is null or ("__new_notification_prefs"."kind" = 'close_reminder' and "__new_notification_prefs"."hour" between 6 and 23))
);
--> statement-breakpoint
INSERT INTO `__new_notification_prefs`("id", "user_id", "kind", "enabled", "hour", "created_at", "updated_at") SELECT "id", "user_id", "kind", "enabled", "hour", "created_at", "updated_at" FROM `notification_prefs`;--> statement-breakpoint
DROP TABLE `notification_prefs`;--> statement-breakpoint
ALTER TABLE `__new_notification_prefs` RENAME TO `notification_prefs`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_prefs_user_kind_uq` ON `notification_prefs` (`user_id`,`kind`);--> statement-breakpoint
DROP TABLE IF EXISTS `__new_space_notifications`;--> statement-breakpoint
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
	CONSTRAINT "space_notifications_kind_check" CHECK("__new_space_notifications"."kind" in ('budget_80', 'budget_100', 'goal_milestone', 'bill_reminder', 'gmail_payment')),
	CONSTRAINT "space_notifications_content_check" CHECK(("__new_space_notifications"."deleted_at" is null and "__new_space_notifications"."params" is not null) or ("__new_space_notifications"."deleted_at" is not null and "__new_space_notifications"."params" is null and "__new_space_notifications"."read_at" is null))
);
--> statement-breakpoint
INSERT INTO `__new_space_notifications`("id", "space_id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at", "seq") SELECT "id", "space_id", "user_id", "kind", "data_key", "params", "read_at", "created_at", "updated_at", "deleted_at", "seq" FROM `space_notifications`;--> statement-breakpoint
DROP TABLE `space_notifications`;--> statement-breakpoint
ALTER TABLE `__new_space_notifications` RENAME TO `space_notifications`;--> statement-breakpoint
CREATE UNIQUE INDEX `space_notifications_key_uq` ON `space_notifications` (`user_id`,`kind`,`data_key`);--> statement-breakpoint
CREATE INDEX `space_notifications_user_idx` ON `space_notifications` (`user_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `space_notifications_space_idx` ON `space_notifications` (`space_id`);--> statement-breakpoint
CREATE INDEX `space_notifications_created_idx` ON `space_notifications` (`created_at`);--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `auto_save` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `auto_save_wallet_id` text REFERENCES `wallets`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `auto_save_day` text;--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `auto_saves` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_scans` ADD `undone_at` integer;--> statement-breakpoint
ALTER TABLE `gmail_mail` ADD `reread_at` integer;
