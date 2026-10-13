CREATE TABLE `connected_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`external_label` text,
	`encrypted_token` text,
	`token_nonce` text,
	`token_key_id` text,
	`scope` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "connected_apps_provider_check" CHECK("connected_apps"."provider" in ('gmail', 'google_sheets', 'google_calendar', 'notion', 'slack')),
	CONSTRAINT "connected_apps_content_check" CHECK(("connected_apps"."deleted_at" is null and "connected_apps"."status" = 'connected'
				and ("connected_apps"."external_label" is null or length("connected_apps"."external_label") between 1 and 80)
				and ("connected_apps"."scope" is null or length("connected_apps"."scope") between 1 and 500)
				and (("connected_apps"."encrypted_token" is null and "connected_apps"."token_nonce" is null and "connected_apps"."token_key_id" is null)
					or ("connected_apps"."encrypted_token" is not null and length("connected_apps"."encrypted_token") <= 12000
						and "connected_apps"."token_nonce" is not null and length("connected_apps"."token_nonce") = 16
						and "connected_apps"."token_key_id" is not null and length("connected_apps"."token_key_id") = 11)))
			or ("connected_apps"."deleted_at" is not null and "connected_apps"."status" = 'disconnected' and "connected_apps"."external_label" is null
				and "connected_apps"."encrypted_token" is null and "connected_apps"."token_nonce" is null and "connected_apps"."token_key_id" is null
				and "connected_apps"."scope" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connected_apps_live_uq` ON `connected_apps` (`space_id`,`provider`) WHERE deleted_at is null;--> statement-breakpoint
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
	CONSTRAINT "audit_events_action_check" CHECK("__new_audit_events"."action" in ('space_created', 'invite_created', 'invite_revoked', 'member_joined', 'member_removed', 'member_left', 'ownership_transferred', 'app_connected', 'app_disconnected', 'app_auto_disconnected'))
);
--> statement-breakpoint
INSERT INTO `__new_audit_events`("id", "space_id", "actor_user_id", "action", "target_user_id", "created_at") SELECT "id", "space_id", "actor_user_id", "action", "target_user_id", "created_at" FROM `audit_events`;--> statement-breakpoint
DROP TABLE `audit_events`;--> statement-breakpoint
ALTER TABLE `__new_audit_events` RENAME TO `audit_events`;--> statement-breakpoint
CREATE INDEX `audit_events_space_idx` ON `audit_events` (`space_id`,`created_at`);