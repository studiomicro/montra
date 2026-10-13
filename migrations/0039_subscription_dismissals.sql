-- FN-26b subscription check: one new table, no change to any existing one. `subscription_dismissals` remembers the
-- candidates a member answered "Bukan langganan" for (one live row per space and match key; the key is a cleaned
-- merchant key or `cat:<catalogue id>`, never raw bank text, amounts or dates). Numbered 0039, after 0037 (FN-48A)
-- and 0038 (FN-34b); journal idx 39. Hand-edited to IF NOT EXISTS so a re-run is harmless. Remote apply only
-- through `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `subscription_dismissals` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`match_key` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "subscription_dismissals_key_check" CHECK(length("subscription_dismissals"."match_key") between 1 and 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `subscription_dismissals_live_uq` ON `subscription_dismissals` (`space_id`,`match_key`) WHERE deleted_at is null;