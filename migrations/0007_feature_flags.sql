CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`module` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feature_flags_module_check" CHECK("feature_flags"."module" in ('kekayaan', 'langganan', 'barang', 'koleksi', 'ruang'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feature_flags_user_module_uq` ON `feature_flags` (`user_id`,`module`);