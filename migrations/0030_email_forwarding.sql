-- FN-19 e-mail forwarding fallback: two new tables, no change to any existing one (like 0028). `inbound_addresses`
-- holds one secret forwarding address per user pointing at one space (an account credential like `ai_keys`: no
-- deleted_at/seq); `inbound_mail` is the per-mail ledger (status and reason codes only; mail text exists only while
-- an AI read is queued, at most 24 h). Chained after 0029 (journal idx 30). Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE `inbound_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`local_part` text NOT NULL,
	`status` text NOT NULL,
	`window_start` integer NOT NULL,
	`window_count` integer DEFAULT 0 NOT NULL,
	`last_received_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbound_addresses_status_check" CHECK("inbound_addresses"."status" in ('active', 'revoked')),
	CONSTRAINT "inbound_addresses_revoked_check" CHECK(("inbound_addresses"."status" = 'revoked') = ("inbound_addresses"."revoked_at" is not null)),
	CONSTRAINT "inbound_addresses_content_check" CHECK(length("inbound_addresses"."local_part") = 28 and substr("inbound_addresses"."local_part", 1, 2) = 'm-' and "inbound_addresses"."window_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_addresses_local_uq` ON `inbound_addresses` (`local_part`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_addresses_active_uq` ON `inbound_addresses` (`user_id`) WHERE status = 'active';--> statement-breakpoint
CREATE INDEX `inbound_addresses_space_idx` ON `inbound_addresses` (`space_id`);--> statement-breakpoint
CREATE TABLE `inbound_mail` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`address_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_key` text NOT NULL,
	`received_at` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`trust` text,
	`parser` text,
	`sender_domain` text,
	`subject` text,
	`pending_text` text,
	`confirmation_code` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`address_id`) REFERENCES `inbound_addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbound_mail_status_check" CHECK("inbound_mail"."status" in ('queued', 'draft_created', 'not_payment', 'unreadable', 'confirmation')),
	CONSTRAINT "inbound_mail_reason_check" CHECK(("inbound_mail"."reason" is null or "inbound_mail"."reason" in ('malformed', 'no_ai_key', 'ai_unconfigured', 'ai_failed', 'ai_invalid', 'expired', 'inbox_full', 'currency', 'unparsed'))
				and (("inbound_mail"."status" = 'unreadable') = ("inbound_mail"."reason" is not null))),
	CONSTRAINT "inbound_mail_trust_check" CHECK("inbound_mail"."trust" is null or "inbound_mail"."trust" in ('verified', 'forwarded', 'unverified')),
	CONSTRAINT "inbound_mail_parser_check" CHECK("inbound_mail"."parser" is null or "inbound_mail"."parser" in ('bank-qris', 'ewallet-payment', 'bank-transfer-in', 'bank-transfer-out', 'ai')),
	CONSTRAINT "inbound_mail_content_check" CHECK(length("inbound_mail"."message_key") = 32
				and ("inbound_mail"."subject" is null or length("inbound_mail"."subject") <= 200)
				and ("inbound_mail"."sender_domain" is null or length("inbound_mail"."sender_domain") <= 80)
				and ("inbound_mail"."pending_text" is null or ("inbound_mail"."status" = 'queued' and length("inbound_mail"."pending_text") <= 6000))
				and ("inbound_mail"."confirmation_code" is null or ("inbound_mail"."status" = 'confirmation'
					and length("inbound_mail"."confirmation_code") between 1 and 12 and "inbound_mail"."confirmation_code" not glob '*[^0-9]*'))),
	CONSTRAINT "inbound_mail_not_payment_check" CHECK("inbound_mail"."status" <> 'not_payment' or ("inbound_mail"."subject" is null and "inbound_mail"."sender_domain" is null
				and "inbound_mail"."parser" is null and "inbound_mail"."trust" is null and "inbound_mail"."pending_text" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_mail_message_uq` ON `inbound_mail` (`address_id`,`message_key`);--> statement-breakpoint
CREATE INDEX `inbound_mail_status_idx` ON `inbound_mail` (`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbound_mail_user_idx` ON `inbound_mail` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbound_mail_space_idx` ON `inbound_mail` (`space_id`);