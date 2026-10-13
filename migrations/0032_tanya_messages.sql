-- FN-22 Tanya: one new table, no change to any existing one. `tanya_messages` holds the question and answer rows
-- of each user's one running conversation per space. Not a synced table (no deleted_at/seq, like `ai_keys`): rows
-- are never edited, and "Percakapan baru", "Hapus semua percakapan" and the 30-day `expires_at` delete them
-- outright. Chained after 0029 (journal idx 30). Remote apply only through `wrangler d1 migrations apply` after a
-- Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE `tanya_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`role` text NOT NULL,
	`body` text NOT NULL,
	`cards_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`tool_calls` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tanya_messages_role_check" CHECK("tanya_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "tanya_messages_content_check" CHECK(length("tanya_messages"."body") between 1 and 4000
				and ("tanya_messages"."cards_json" is null or length("tanya_messages"."cards_json") <= 32768)
				and ("tanya_messages"."role" = 'assistant' or ("tanya_messages"."cards_json" is null and "tanya_messages"."input_tokens" is null
					and "tanya_messages"."output_tokens" is null and "tanya_messages"."tool_calls" is null))
				and "tanya_messages"."expires_at" > "tanya_messages"."created_at")
);
--> statement-breakpoint
CREATE INDEX `tanya_messages_user_space_idx` ON `tanya_messages` (`user_id`,`space_id`,`created_at`);