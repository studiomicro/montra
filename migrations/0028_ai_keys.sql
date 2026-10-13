-- FN-41 personal AI keys (BYOK): two new tables, no change to any existing one. `ai_keys` holds one sealed
-- Anthropic key per user (an account credential like `api_tokens`; no deleted_at/seq), `ai_key_audit` its
-- content-free history. Chained after 0027 (journal idx 28). Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE `ai_key_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_key_audit_action_check" CHECK("ai_key_audit"."action" in ('created', 'replaced', 'removed', 'test_ok', 'test_failed'))
);
--> statement-breakpoint
CREATE INDEX `ai_key_audit_user_idx` ON `ai_key_audit` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_key` text NOT NULL,
	`key_nonce` text NOT NULL,
	`key_key_id` text NOT NULL,
	`last_four` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_tested_at` integer,
	`last_test_result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_keys_provider_check" CHECK("ai_keys"."provider" in ('anthropic')),
	CONSTRAINT "ai_keys_status_check" CHECK("ai_keys"."status" in ('active')),
	CONSTRAINT "ai_keys_test_result_check" CHECK("ai_keys"."last_test_result" is null or "ai_keys"."last_test_result" in ('ok', 'invalid', 'quota', 'network')),
	CONSTRAINT "ai_keys_content_check" CHECK(length("ai_keys"."encrypted_key") between 1 and 1000 and length("ai_keys"."key_nonce") = 16
				and length("ai_keys"."key_key_id") = 11 and length("ai_keys"."last_four") = 4
				and ("ai_keys"."last_tested_at" is null) = ("ai_keys"."last_test_result" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_keys_user_provider_uq` ON `ai_keys` (`user_id`,`provider`);