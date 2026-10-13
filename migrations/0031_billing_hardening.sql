-- FN-30 hardening before a real payment provider: refund obligations for verified payments that granted nothing
-- (`billing_refunds`, one per `paid_not_applied` billing event) and re-claim markers for deleted accounts
-- (`claim_markers`, an HMAC of the canonical e-mail address, never the address). No existing table changes.
-- The `claim_markers_uq` expression index is hand-corrected: drizzle-kit 0.31 quotes the expression as a column.
CREATE TABLE `billing_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`billing_event_id` text NOT NULL,
	`user_id` text,
	`provider` text NOT NULL,
	`reference` text,
	`amount_minor` integer,
	`currency` text,
	`reason` text NOT NULL,
	`status` text NOT NULL,
	`provider_refund_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`billing_event_id`) REFERENCES `billing_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "billing_refunds_check" CHECK("billing_refunds"."provider" in ('mock', 'xendit', 'midtrans')
				and "billing_refunds"."reason" in ('checkout_expired', 'plan_higher', 'unknown')
				and "billing_refunds"."status" in ('pending', 'refunded', 'cancelled')
				and ("billing_refunds"."amount_minor" is null or "billing_refunds"."amount_minor" between 0 and 9007199254740991)
				and (("billing_refunds"."status" = 'pending') = ("billing_refunds"."resolved_at" is null))
				and ("billing_refunds"."provider_refund_id" is null or (length("billing_refunds"."provider_refund_id") between 1 and 100
					and "billing_refunds"."provider_refund_id" not glob '*[^A-Za-z0-9_.:-]*')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_refunds_billing_event_id_unique` ON `billing_refunds` (`billing_event_id`);--> statement-breakpoint
CREATE INDEX `billing_refunds_status_idx` ON `billing_refunds` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_refunds_user_idx` ON `billing_refunds` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `claim_markers` (
	`email_hmac` text NOT NULL,
	`kind` text NOT NULL,
	`voucher_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "claim_markers_check" CHECK(length("claim_markers"."email_hmac") = 43
				and "claim_markers"."kind" in ('starter_grant', 'voucher')
				and (("claim_markers"."kind" = 'voucher') = ("claim_markers"."voucher_id" is not null)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_markers_uq` ON `claim_markers` (`email_hmac`,`kind`,ifnull("voucher_id", ''));--> statement-breakpoint
CREATE INDEX `claim_markers_created_idx` ON `claim_markers` (`created_at`);--> statement-breakpoint
-- Hand-written (drizzle-kit does not model triggers), in the 0018 style. `billing_refunds` keeps every obligation:
-- every DELETE is refused. An UPDATE is allowed only (a) when it sets `user_id` to null, changes nothing else, and no
-- `users` row with the old id exists any more (the FK `on delete set null`), or (b) for the one move from `pending`
-- to `refunded` or `cancelled` that sets `resolved_at` and `updated_at` and, optionally, `provider_refund_id`, and
-- changes nothing else (billing/refunds.ts recordRefundOutcome). A resolved row never changes again.
CREATE TRIGGER `billing_refunds_no_update` BEFORE UPDATE ON `billing_refunds` WHEN NOT (NEW.`id` = OLD.`id` AND NEW.`billing_event_id` = OLD.`billing_event_id` AND NEW.`provider` = OLD.`provider` AND NEW.`reference` IS OLD.`reference` AND NEW.`amount_minor` IS OLD.`amount_minor` AND NEW.`currency` IS OLD.`currency` AND NEW.`reason` = OLD.`reason` AND NEW.`created_at` = OLD.`created_at` AND ((NEW.`user_id` IS NULL AND NOT EXISTS (SELECT 1 FROM `users` WHERE `id` = OLD.`user_id`) AND NEW.`status` = OLD.`status` AND NEW.`provider_refund_id` IS OLD.`provider_refund_id` AND NEW.`updated_at` = OLD.`updated_at` AND NEW.`resolved_at` IS OLD.`resolved_at`) OR (NEW.`user_id` IS OLD.`user_id` AND OLD.`status` = 'pending' AND NEW.`status` IN ('refunded', 'cancelled') AND OLD.`resolved_at` IS NULL AND NEW.`resolved_at` IS NOT NULL AND (OLD.`provider_refund_id` IS NULL OR NEW.`provider_refund_id` IS OLD.`provider_refund_id`)))) BEGIN SELECT RAISE(ABORT, 'billing_refunds is append-only'); END;--> statement-breakpoint
CREATE TRIGGER `billing_refunds_no_delete` BEFORE DELETE ON `billing_refunds` BEGIN SELECT RAISE(ABORT, 'billing_refunds is append-only'); END;--> statement-breakpoint
-- Backfill: every `paid_not_applied` event stored before this migration gets its pending obligation, reason
-- `unknown` (which branch fired was not recorded). Re-runnable: an event that already has a row is skipped.
INSERT INTO `billing_refunds` (`id`, `billing_event_id`, `user_id`, `provider`, `reference`, `amount_minor`, `currency`, `reason`, `status`, `provider_refund_id`, `created_at`, `updated_at`, `resolved_at`) SELECT lower(hex(randomblob(16))), e.`id`, e.`user_id`, e.`provider`, e.`reference`, e.`amount_minor`, e.`currency`, 'unknown', 'pending', NULL, e.`created_at`, e.`created_at`, NULL FROM `billing_events` e WHERE e.`kind` = 'paid_not_applied' AND NOT EXISTS (SELECT 1 FROM `billing_refunds` r WHERE r.`billing_event_id` = e.`id`);
