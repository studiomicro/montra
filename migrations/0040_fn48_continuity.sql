-- FN-48 Part B (statement continuity per wallet): a statement batch records the wallet its rows went to, the WIB
-- dates of the statement's first and last row and the opening and closing balances the statement printed, so each
-- month's Saldo Awal can be checked against the previous month's Saldo Akhir (or the wallet's own balance before
-- it). Every new column is nullable: existing batches (and CSV, spreadsheet and look-back batches) keep null and
-- are never part of a continuity claim. Plain ALTER ADD COLUMN: SQLite has no `ADD COLUMN IF NOT EXISTS`, so a
-- second run of these five statements refuses with "duplicate column name" and changes nothing (the same
-- limitation red team L2 noted on 0037); the index is re-runnable.
ALTER TABLE `import_batches` ADD `wallet_id` text REFERENCES wallets(id);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `period_from` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `period_to` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `opening_balance_minor` integer;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `closing_balance_minor` integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `import_batches_wallet_period_idx` ON `import_batches` (`space_id`,`wallet_id`,`period_from`);
