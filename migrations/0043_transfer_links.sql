-- FN-48 Part C "Cocokkan transfer": `transfer_links`, one row per confirmed merge of an own-transfer pair into one
-- FN-05 transfer row, holding both rows' previous content as JSON for the one-step undo. Append-only (`undone_at`,
-- no tombstone column); ids only, no foreign key to `transactions`. A plain CREATE TABLE plus its indexes, every
-- step IF NOT EXISTS, so a re-run against a half-applied state changes nothing. Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `transfer_links` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`debit_transaction_id` text NOT NULL,
	`credit_transaction_id` text NOT NULL,
	`debit_snapshot` text NOT NULL,
	`credit_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`undone_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `transfer_links_space_idx` ON `transfer_links` (`space_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `transfer_links_debit_live_uq` ON `transfer_links` (`debit_transaction_id`) WHERE undone_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `transfer_links_credit_live_uq` ON `transfer_links` (`credit_transaction_id`) WHERE undone_at is null;
