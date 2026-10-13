CREATE TABLE `account_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`wrapped_private_key` text NOT NULL,
	`wrap_nonce` text NOT NULL,
	`kdf_salt` text NOT NULL,
	`kdf_params` text NOT NULL,
	`key_check_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_keys_user_id_unique` ON `account_keys` (`user_id`);