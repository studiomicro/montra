-- FN-55a/b credit cards (after FN-53's 0046_net_worth_snapshot_classes on main).
-- 1. `card_statements` (FN-55b): one live row per imported card statement, the printed figures in the wallet's
--    convention (owed is negative), written with its import batch and tombstoned with it. The partial unique index
--    (space, wallet, statement date) for live rows refuses a second copy of the same statement. No text, no file, no
--    card number. A plain CREATE TABLE plus indexes, every step IF NOT EXISTS.
-- 2. `wallets` gains `credit_limit_minor`, `statement_day` and `due_day` (FN-55a), nullable, each with a column CHECK
--    (positive and at most 10^13; 1-31; null unless `type = 'kartu_kredit'`), added with `ALTER TABLE … ADD` (no
--    rebuild; the Drizzle schema states the same checks at table level, 0037's and 0046's pattern). These are the
--    column names FN-25b's PRD reserved for FN-25c.
-- Re-running: step 1 repeats cleanly; the ALTERs come last and cannot be repeated (SQLite has no ADD COLUMN IF NOT
-- EXISTS), so a re-run stops at the first one harmlessly with "duplicate column". Remote apply only through
-- `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE TABLE IF NOT EXISTS `card_statements` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`wallet_id` text NOT NULL,
	`import_batch_id` text NOT NULL,
	`statement_date` text,
	`due_date` text,
	`period_from` text,
	`period_to` text,
	`previous_balance_minor` integer,
	`new_balance_minor` integer,
	`minimum_payment_minor` integer,
	`limit_minor` integer,
	`currency` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`seq` integer NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "card_statements_content_check" CHECK(("card_statements"."deleted_at" is null and "card_statements"."statement_date" is not null and length("card_statements"."statement_date") = 10 and date("card_statements"."statement_date") is "card_statements"."statement_date"
				and ("card_statements"."due_date" is null or (length("card_statements"."due_date") = 10 and date("card_statements"."due_date") is "card_statements"."due_date"))
				and ("card_statements"."period_from" is null or (length("card_statements"."period_from") = 10 and date("card_statements"."period_from") is "card_statements"."period_from"))
				and ("card_statements"."period_to" is null or (length("card_statements"."period_to") = 10 and date("card_statements"."period_to") is "card_statements"."period_to"))
				and "card_statements"."previous_balance_minor" is not null and abs("card_statements"."previous_balance_minor") <= 9007199254740991
				and "card_statements"."new_balance_minor" is not null and abs("card_statements"."new_balance_minor") <= 9007199254740991
				and ("card_statements"."minimum_payment_minor" is null or "card_statements"."minimum_payment_minor" between 0 and 10000000000000)
				and ("card_statements"."limit_minor" is null or "card_statements"."limit_minor" between 1 and 10000000000000)
				and "card_statements"."currency" is not null and length("card_statements"."currency") = 3)
			or ("card_statements"."deleted_at" is not null and "card_statements"."statement_date" is null and "card_statements"."due_date" is null
				and "card_statements"."period_from" is null and "card_statements"."period_to" is null and "card_statements"."previous_balance_minor" is null
				and "card_statements"."new_balance_minor" is null and "card_statements"."minimum_payment_minor" is null and "card_statements"."limit_minor" is null
				and "card_statements"."currency" is null))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `card_statements_wallet_idx` ON `card_statements` (`space_id`,`wallet_id`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `card_statements_live_uq` ON `card_statements` (`space_id`,`wallet_id`,`statement_date`) WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE `wallets` ADD `credit_limit_minor` integer CONSTRAINT "wallets_credit_limit_check" CHECK("credit_limit_minor" is null or ("type" = 'kartu_kredit' and "credit_limit_minor" between 1 and 10000000000000));--> statement-breakpoint
ALTER TABLE `wallets` ADD `statement_day` integer CONSTRAINT "wallets_statement_day_check" CHECK("statement_day" is null or ("type" = 'kartu_kredit' and "statement_day" between 1 and 31));--> statement-breakpoint
ALTER TABLE `wallets` ADD `due_day` integer CONSTRAINT "wallets_due_day_check" CHECK("due_day" is null or ("type" = 'kartu_kredit' and "due_day" between 1 and 31));
