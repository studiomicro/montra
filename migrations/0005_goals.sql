CREATE TABLE `goal_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`goal_id` text NOT NULL,
	`amount_minor` integer,
	`note` text,
	`created_by_user_id` text,
	`created_at` integer,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "goal_contributions_content_check" CHECK(("goal_contributions"."deleted_at" is null and "goal_contributions"."amount_minor" is not null and "goal_contributions"."amount_minor" > 0
				and "goal_contributions"."created_at" is not null)
			or ("goal_contributions"."deleted_at" is not null and "goal_contributions"."amount_minor" is null and "goal_contributions"."note" is null
				and "goal_contributions"."created_by_user_id" is null and "goal_contributions"."created_at" is null))
);
--> statement-breakpoint
CREATE INDEX `goal_contributions_goal_idx` ON `goal_contributions` (`space_id`,`goal_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`name` text NOT NULL,
	`target_amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "goals_target_check" CHECK("goals"."target_amount_minor" > 0)
);
--> statement-breakpoint
CREATE INDEX `goals_space_idx` ON `goals` (`space_id`,`deleted_at`);