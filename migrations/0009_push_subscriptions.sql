CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "push_subscriptions_tombstone_check" CHECK("push_subscriptions"."deleted_at" is null or ("push_subscriptions"."p256dh" = '' and "push_subscriptions"."auth" = '' and "push_subscriptions"."user_agent" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session_idx` ON `push_subscriptions` (`session_id`);