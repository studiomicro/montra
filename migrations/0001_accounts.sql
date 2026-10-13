CREATE TABLE `auth_attempts` (
	`client_hash` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_window_idx` ON `auth_attempts` (`window_start`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "space_members_role_check" CHECK("space_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `space_members_space_user_uq` ON `space_members` (`space_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `space_members_user_idx` ON `space_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'personal' NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "spaces_kind_check" CHECK("spaces"."kind" in ('personal', 'shared'))
);
--> statement-breakpoint
CREATE TABLE `user_passwords` (
	`user_id` text PRIMARY KEY NOT NULL,
	`algo` text NOT NULL,
	`hash` text NOT NULL,
	`salt` text NOT NULL,
	`iterations` integer NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`adult_confirmed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	CONSTRAINT "users_status_check" CHECK("users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);