-- FN-19 Gmail auto-capture through Montra's own Google OAuth app: four new tables, no change to any existing one
-- (like 0028/0030). `gmail_connections` holds one connection per user (the refresh token sealed, never an access
-- token); `gmail_scans` the hourly and look-back listing passes; `gmail_mail` the per-mail ledger (ids, dates,
-- status and reason codes; no column can hold mail text); `oauth_states` the unfinished authorizations (state
-- hash, session hash, sealed PKCE verifier; 10 minutes). Every statement is IF NOT EXISTS, so running the file
-- again changes nothing. Chained after 0032 (journal idx 33). Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md › Migrations).
CREATE TABLE IF NOT EXISTS `gmail_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`status` text NOT NULL,
	`reconnect_reason` text,
	`paused_reason` text,
	`google_address` text,
	`encrypted_token` text NOT NULL,
	`token_nonce` text NOT NULL,
	`token_key_id` text NOT NULL,
	`scope` text NOT NULL,
	`auto_check` integer DEFAULT 1 NOT NULL,
	`checked_through` integer NOT NULL,
	`check_after` integer DEFAULT 0 NOT NULL,
	`quota_window_start` integer DEFAULT 0 NOT NULL,
	`quota_units` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "gmail_connections_status_check" CHECK("gmail_connections"."status" in ('connected', 'needs_reconnect')),
	CONSTRAINT "gmail_connections_reconnect_check" CHECK(("gmail_connections"."reconnect_reason" is null or "gmail_connections"."reconnect_reason" in ('revoked', 'key'))
				and (("gmail_connections"."status" = 'needs_reconnect') = ("gmail_connections"."reconnect_reason" is not null))),
	CONSTRAINT "gmail_connections_paused_check" CHECK("gmail_connections"."paused_reason" is null or ("gmail_connections"."paused_reason" in ('space_lost') and "gmail_connections"."auto_check" = 0)),
	CONSTRAINT "gmail_connections_content_check" CHECK(length("gmail_connections"."encrypted_token") between 1 and 12000 and length("gmail_connections"."token_nonce") = 16
				and length("gmail_connections"."token_key_id") = 11 and length("gmail_connections"."scope") between 1 and 2000
				and ("gmail_connections"."google_address" is null or length("gmail_connections"."google_address") <= 320)
				and "gmail_connections"."auto_check" in (0, 1) and "gmail_connections"."quota_units" >= 0 and "gmail_connections"."checked_through" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `gmail_connections_user_uq` ON `gmail_connections` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_connections_due_idx` ON `gmail_connections` (`status`,`auto_check`,`id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_connections_space_idx` ON `gmail_connections` (`space_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gmail_mail` (
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
	CONSTRAINT "gmail_mail_status_check" CHECK("gmail_mail"."status" in ('listed', 'draft_created', 'not_payment', 'unreadable')),
	CONSTRAINT "gmail_mail_reason_check" CHECK(("gmail_mail"."reason" is null or "gmail_mail"."reason" in ('malformed', 'too_large', 'gone', 'fetch_failed', 'no_ai_key', 'ai_unconfigured', 'ai_failed', 'ai_invalid', 'expired', 'inbox_full', 'currency', 'unparsed', 'key'))
				and (("gmail_mail"."status" = 'unreadable') = ("gmail_mail"."reason" is not null))),
	CONSTRAINT "gmail_mail_trust_check" CHECK("gmail_mail"."trust" is null or "gmail_mail"."trust" in ('verified', 'unverified')),
	CONSTRAINT "gmail_mail_parser_check" CHECK("gmail_mail"."parser" is null or "gmail_mail"."parser" in ('bank-qris', 'ewallet-payment', 'bank-transfer-in', 'bank-transfer-out', 'ai')),
	CONSTRAINT "gmail_mail_content_check" CHECK(length("gmail_mail"."gmail_id") between 1 and 64
				and ("gmail_mail"."subject" is null or length("gmail_mail"."subject") <= 200)
				and ("gmail_mail"."sender_domain" is null or length("gmail_mail"."sender_domain") <= 80)
				and ("gmail_mail"."draft_id" is null or "gmail_mail"."status" = 'draft_created')),
	CONSTRAINT "gmail_mail_id_only_check" CHECK("gmail_mail"."status" not in ('listed', 'not_payment') or ("gmail_mail"."subject" is null and "gmail_mail"."sender_domain" is null
				and "gmail_mail"."parser" is null and "gmail_mail"."trust" is null and "gmail_mail"."draft_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `gmail_mail_message_uq` ON `gmail_mail` (`connection_id`,`gmail_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_mail_status_idx` ON `gmail_mail` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_mail_user_idx` ON `gmail_mail` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_mail_scan_idx` ON `gmail_mail` (`scan_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_mail_space_idx` ON `gmail_mail` (`space_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gmail_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`scan_window` text NOT NULL,
	`days` integer,
	`after_s` integer NOT NULL,
	`status` text NOT NULL,
	`page_token` text,
	`pages` integer DEFAULT 0 NOT NULL,
	`listed` integer DEFAULT 0 NOT NULL,
	`read` integer DEFAULT 0 NOT NULL,
	`drafted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `gmail_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "gmail_scans_kind_check" CHECK("gmail_scans"."kind" in ('hourly', 'lookback')),
	CONSTRAINT "gmail_scans_status_check" CHECK("gmail_scans"."status" in ('running', 'done', 'cancelled', 'failed')),
	CONSTRAINT "gmail_scans_content_check" CHECK(length("gmail_scans"."scan_window") between 1 and 40 and "gmail_scans"."pages" between 0 and 20
				and "gmail_scans"."listed" >= 0 and "gmail_scans"."read" >= 0 and "gmail_scans"."drafted" >= 0 and "gmail_scans"."after_s" >= 0
				and ("gmail_scans"."page_token" is null or length("gmail_scans"."page_token") <= 512)
				and (("gmail_scans"."kind" = 'lookback') = ("gmail_scans"."days" is not null))
				and ("gmail_scans"."days" is null or "gmail_scans"."days" between 1 and 365))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `gmail_scans_window_uq` ON `gmail_scans` (`connection_id`,`kind`,`scan_window`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `gmail_scans_lookback_running_uq` ON `gmail_scans` (`connection_id`) WHERE kind = 'lookback' and status = 'running';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `gmail_scans_status_idx` ON `gmail_scans` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_hash` text NOT NULL,
	`space_id` text NOT NULL,
	`purpose` text NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`key_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "oauth_states_purpose_check" CHECK("oauth_states"."purpose" in ('gmail')),
	CONSTRAINT "oauth_states_content_check" CHECK(length("oauth_states"."state_hash") = 64 and length("oauth_states"."session_hash") = 64
				and length("oauth_states"."ciphertext") between 1 and 400 and length("oauth_states"."nonce") = 16
				and length("oauth_states"."key_id") = 11 and "oauth_states"."expires_at" > "oauth_states"."created_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_states_user_idx` ON `oauth_states` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `oauth_states_expiry_idx` ON `oauth_states` (`expires_at`);