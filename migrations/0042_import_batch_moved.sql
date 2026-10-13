-- FN-16j: audit_events gains the content-free 'import_batch_moved' action ("Pindahkan ke dompet lain"). SQLite
-- cannot alter a CHECK, so the table is rebuilt as in 0016_connected_apps.sql. D1 always enforces foreign keys
-- (`PRAGMA foreign_keys` is ignored); no table references audit_events. Re-runnable: a leftover copy is dropped.
DROP TABLE IF EXISTS `__new_audit_events`;--> statement-breakpoint
CREATE TABLE `__new_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_action_check" CHECK("__new_audit_events"."action" in ('space_created', 'invite_created', 'invite_revoked', 'member_joined', 'member_removed', 'member_left', 'ownership_transferred', 'app_connected', 'app_disconnected', 'app_auto_disconnected', 'import_batch_moved'))
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("id", "space_id", "actor_user_id", "action", "target_user_id", "created_at") SELECT "id", "space_id", "actor_user_id", "action", "target_user_id", "created_at" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
CREATE INDEX `audit_events_space_idx` ON `audit_events` (`space_id`,`created_at`);