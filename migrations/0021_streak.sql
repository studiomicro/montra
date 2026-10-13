-- FN-34: "Tutup hari" closures, one per user and WIB date (account-scoped, no money, never edited).
CREATE TABLE `day_closures` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`closed_on` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `day_closures_user_day_idx` ON `day_closures` (`user_id`,`closed_on`);
