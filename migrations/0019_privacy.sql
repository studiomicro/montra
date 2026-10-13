CREATE TABLE `consent_records` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "consent_records_kind_check" CHECK("consent_records"."kind" in ('terms', 'privacy_policy', 'cross_border_notice'))
);
--> statement-breakpoint
CREATE INDEX `consent_records_user_idx` ON `consent_records` (`user_id`,`accepted_at`);--> statement-breakpoint
CREATE TABLE `usage_stats_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- FN-31: consent records are append-only. Rows go only with the account (DELETE stays allowed); a change of
-- an accepted record is refused, so a newer version is always a new row.
CREATE TRIGGER `consent_records_no_update` BEFORE UPDATE ON `consent_records`
BEGIN
	SELECT RAISE(ABORT, 'consent_records is append-only');
END;
