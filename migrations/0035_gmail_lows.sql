-- FN-19 Gmail red team L2–L4 (docs/features/fn-19-gmail/SECURITY_REPORT.md). `gmail_revocations` holds sealed
-- refresh tokens the jobs Worker must still revoke at Google: a connection deleted by a space purge or account
-- deletion, or a grant a second authorization for another Google account replaced. No foreign keys: the seal is bound
-- to (connection id, user id) and the row must outlive both; rows are tried a bounded number of times, then dropped.
-- `inbound_mail.draft_id` links a forwarded mail to the draft it inserted, so account deletion can discard the
-- account's pending forwarded drafts in a shared space that stays (rows written before 0035 stay unlinked).
-- The CREATE statements are IF NOT EXISTS; the ALTER (last) cannot be repeated, so a re-run stops there harmlessly.
-- Remote apply only through `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `gmail_revocations` (
	`connection_id` text NOT NULL,
	`token_nonce` text NOT NULL,
	`user_id` text NOT NULL,
	`google_address` text,
	`encrypted_token` text NOT NULL,
	`token_key_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `token_nonce`),
	CONSTRAINT "gmail_revocations_content_check" CHECK(length("gmail_revocations"."encrypted_token") between 1 and 12000 and length("gmail_revocations"."token_nonce") = 16
				and length("gmail_revocations"."token_key_id") = 11
				and ("gmail_revocations"."google_address" is null or length("gmail_revocations"."google_address") <= 320) and "gmail_revocations"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_revocations_created_idx` ON `gmail_revocations` (`created_at`);--> statement-breakpoint
ALTER TABLE `inbound_mail` ADD `draft_id` text;