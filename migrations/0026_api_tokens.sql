-- FN-38 public API tokens: one new table, `api_tokens` (a user-level credential like `sessions`; no deleted_at/seq).
-- Chained after 0025 (journal idx 26). Remote apply only through `wrangler d1 migrations apply` after a Time Travel
-- bookmark (docs/RUNBOOK.md).
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`last_four` text NOT NULL,
	`scope` text NOT NULL,
	`restricted_space_id` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`restricted_space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "api_tokens_scope_check" CHECK("api_tokens"."scope" in ('read', 'read_write')),
	CONSTRAINT "api_tokens_content_check" CHECK(length("api_tokens"."name") between 1 and 60 and length("api_tokens"."last_four") = 4
				and "api_tokens"."expires_at" > "api_tokens"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`,`expires_at`);