CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "audit_events_action_check" CHECK("audit_events"."action" in ('space_created', 'invite_created', 'invite_revoked', 'member_joined', 'member_removed', 'member_left', 'ownership_transferred'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_space_idx` ON `audit_events` (`space_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `space_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_invites_token_hash_unique` ON `space_invites` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `space_invites_live_uq` ON `space_invites` (`space_id`) WHERE deleted_at is null;