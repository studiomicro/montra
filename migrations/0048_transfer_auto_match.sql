-- FN-48d auto-match: `transfer_links.source`, who merged a pair — the user ('manual', every row written before this
-- migration, so the default backfills them truthfully) or the statement import's auto-match pass ('auto'). An 'auto'
-- row, live or undone, keeps that pass from ever merging either of its rows again. Added with `ALTER TABLE … ADD`
-- and a same-column CHECK (0046's pattern), so the table is not rebuilt; the Drizzle schema states the same check at
-- table level. Plus `transactions_space_amount_idx`, a partial index over live rows by amount, so the pass looks up
-- a batch's own amounts without scanning the space. The index is IF NOT EXISTS and comes first; a re-run then stops
-- at the ALTER with "duplicate column", harmlessly. Deploy the app after this apply; old code ignores the column.
-- Remote apply only through `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
CREATE INDEX IF NOT EXISTS `transactions_space_amount_idx` ON `transactions` (`space_id`,`amount_minor`,`currency`) WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE `transfer_links` ADD `source` text DEFAULT 'manual' NOT NULL CONSTRAINT "transfer_links_source_check" CHECK("source" in ('manual', 'auto'));
