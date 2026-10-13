-- db-normalize F3: belongings and net_worth_items get the `is_demo` flag every other space-scoped content table has
-- (`Data demo` rows: badged, read-only, never in a total). Pure ADD COLUMN with a literal default: no rebuild,
-- existing rows read 0. Numbered 0025 because 0024 (day_closures.closed_on format) lands from hardening-2.
ALTER TABLE `belongings` ADD `is_demo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `net_worth_items` ADD `is_demo` integer DEFAULT false NOT NULL;