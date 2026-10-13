-- FN-50 passkeys and bot check: four new tables, no change to an existing one. `passkeys` holds WebAuthn
-- credentials (COSE public key, counter, transports, AAGUID; no attestation statement), soft-deleted and unique per
-- live credential id; `passkey_challenges` holds issued challenges, consumed once by a guarded UPDATE that also names
-- the row the consuming request wrote (`used_by`); `passkey_sessions` links a session to the passkey that opened it
-- (ids only), so removing a passkey revokes exactly its sessions; `auth_events` is the content-free 90-day record of
-- passkey events (no IP, user agent or key material). Every statement is IF NOT EXISTS: re-runnable.
CREATE TABLE IF NOT EXISTS `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`passkey_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_events_kind_check" CHECK("auth_events"."kind" in ('passkey_added', 'passkey_removed', 'passkey_sign_in', 'passkey_refused', 'passkey_counter_rollback'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_events_user_idx` ON `auth_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `passkey_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`used_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "passkey_challenges_kind_check" CHECK("passkey_challenges"."kind" in ('register', 'sign_in')),
	CONSTRAINT "passkey_challenges_content_check" CHECK(length("passkey_challenges"."challenge") between 32 and 64 and "passkey_challenges"."expires_at" > "passkey_challenges"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `passkey_challenges_challenge_unique` ON `passkey_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `passkey_challenges_expires_idx` ON `passkey_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `passkey_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`passkey_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `passkey_sessions_passkey_idx` ON `passkey_sessions` (`passkey_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`algorithm` integer NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`aaguid` text NOT NULL,
	`name` text NOT NULL,
	`rp_id` text NOT NULL,
	`backed_up` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "passkeys_algorithm_check" CHECK("passkeys"."algorithm" in (-7, -257)),
	CONSTRAINT "passkeys_backed_up_check" CHECK("passkeys"."backed_up" in (0, 1)),
	CONSTRAINT "passkeys_content_check" CHECK(length("passkeys"."credential_id") between 16 and 1400 and length("passkeys"."public_key") between 32 and 1400
				and length("passkeys"."name") between 1 and 160 and length("passkeys"."aaguid") = 36 and "passkeys"."counter" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `passkeys_credential_live_uq` ON `passkeys` (`credential_id`) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `passkeys_user_idx` ON `passkeys` (`user_id`,`created_at`);