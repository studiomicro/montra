-- FN-53 period reports: `net_worth_snapshots.classes`, the run's per-class net worth (`summary.classes`) as a JSON
-- object `{ "<NetWorthClass>": <IDR sen> }`, so /kekayaan/laporan can show the change per group between two
-- snapshots. Nullable, no default, no backfill: rows written before this migration stay null (a value would have to
-- be invented) and the page says the group split starts later. Added with `ALTER TABLE … ADD` and a column CHECK
-- (valid JSON object, never on a tombstone), so the table is not rebuilt; the Drizzle schema states the same check
-- at table level (0037's pattern). The jobs Worker writes the column, so it must be redeployed after this apply;
-- old code ignores the column. A re-run stops at the ALTER with "duplicate column", harmlessly. Remote apply only
-- through `wrangler d1 migrations apply` after a Time Travel bookmark (docs/RUNBOOK.md).
ALTER TABLE `net_worth_snapshots` ADD `classes` text CONSTRAINT "net_worth_snapshots_classes_check" CHECK("classes" is null or ("deleted_at" is null and json_valid("classes") and json_type("classes") = 'object'));
