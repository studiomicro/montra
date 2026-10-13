-- Low findings before the repo goes public (2026-10-13). Built as 0044; renumbered 0045 after 0044_passkeys.
-- FN-19 Gmail red team L6: `gmail_mail.reason` gains 'ai_limit' (a mail over the connection's daily AI-read cap),
-- and `gmail_connections` gains the 24-hour AI-read window (`ai_window_start`, `ai_reads`). SQLite cannot alter a
-- CHECK, so `gmail_mail` is rebuilt as in 0042_import_batch_moved.sql with every row and index kept. D1 always
-- enforces foreign keys (`PRAGMA foreign_keys` is ignored); no table references gmail_mail.
-- FN-23 red team S2: `agent_runs.deleted_at` marks a "Hapus" tombstone that the daily caps keep counting.
-- The rebuild is re-runnable (a leftover copy is dropped); the ALTERs (last) cannot be repeated, so a re-run stops
-- there harmlessly. Remote apply only through `wrangler d1 migrations apply` after a Time Travel bookmark
-- (docs/RUNBOOK.md).
DROP TABLE IF EXISTS `__new_gmail_mail`;--> statement-breakpoint
CREATE TABLE `__new_gmail_mail` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`gmail_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`trust` text,
	`parser` text,
	`sender_domain` text,
	`subject` text,
	`draft_id` text,
	`scan_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `gmail_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "gmail_mail_status_check" CHECK("__new_gmail_mail"."status" in ('listed', 'draft_created', 'not_payment', 'unreadable')),
	CONSTRAINT "gmail_mail_reason_check" CHECK(("__new_gmail_mail"."reason" is null or "__new_gmail_mail"."reason" in ('malformed', 'too_large', 'gone', 'fetch_failed', 'no_ai_key', 'ai_unconfigured', 'ai_failed', 'ai_invalid', 'expired', 'inbox_full', 'currency', 'unparsed', 'key', 'ai_limit'))
				and (("__new_gmail_mail"."status" = 'unreadable') = ("__new_gmail_mail"."reason" is not null))),
	CONSTRAINT "gmail_mail_trust_check" CHECK("__new_gmail_mail"."trust" is null or "__new_gmail_mail"."trust" in ('verified', 'unverified')),
	CONSTRAINT "gmail_mail_parser_check" CHECK("__new_gmail_mail"."parser" is null or "__new_gmail_mail"."parser" in ('bank-qris', 'ewallet-payment', 'bank-transfer-in', 'bank-transfer-out', 'ai')),
	CONSTRAINT "gmail_mail_content_check" CHECK(length("__new_gmail_mail"."gmail_id") between 1 and 64
				and ("__new_gmail_mail"."subject" is null or length("__new_gmail_mail"."subject") <= 200)
				and ("__new_gmail_mail"."sender_domain" is null or length("__new_gmail_mail"."sender_domain") <= 80)
				and ("__new_gmail_mail"."draft_id" is null or "__new_gmail_mail"."status" = 'draft_created')),
	CONSTRAINT "gmail_mail_id_only_check" CHECK("__new_gmail_mail"."status" not in ('listed', 'not_payment') or ("__new_gmail_mail"."subject" is null and "__new_gmail_mail"."sender_domain" is null
				and "__new_gmail_mail"."parser" is null and "__new_gmail_mail"."trust" is null and "__new_gmail_mail"."draft_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_gmail_mail`("id", "connection_id", "user_id", "space_id", "gmail_id", "received_at", "status", "reason", "trust", "parser", "sender_domain", "subject", "draft_id", "scan_id", "updated_at") SELECT "id", "connection_id", "user_id", "space_id", "gmail_id", "received_at", "status", "reason", "trust", "parser", "sender_domain", "subject", "draft_id", "scan_id", "updated_at" FROM `gmail_mail`;--> statement-breakpoint
DROP TABLE `gmail_mail`;--> statement-breakpoint
ALTER TABLE `__new_gmail_mail` RENAME TO `gmail_mail`;--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_mail_message_uq` ON `gmail_mail` (`connection_id`,`gmail_id`);--> statement-breakpoint
CREATE INDEX `gmail_mail_status_idx` ON `gmail_mail` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `gmail_mail_user_idx` ON `gmail_mail` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `gmail_mail_scan_idx` ON `gmail_mail` (`scan_id`);--> statement-breakpoint
CREATE INDEX `gmail_mail_space_idx` ON `gmail_mail` (`space_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `ai_window_start` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `gmail_connections` ADD `ai_reads` integer DEFAULT 0 NOT NULL;