-- FN-34: `day_closures.closed_on` must be a real WIB calendar date written `YYYY-MM-DD` (the streak and the
-- "Tutup hari" check compare it as text). SQLite cannot add a CHECK to an existing table without rebuilding it,
-- so two triggers refuse any other value on insert and on update instead. `date(x) IS x` holds only for a valid
-- date already in that exact form: `2026-10-8`, `2026-02-30`, `2026-10-08 00:00` and `08/10/2026` are refused.
-- Rows already stored are not re-checked (every write path validated the date before this migration).
CREATE TRIGGER IF NOT EXISTS `day_closures_closed_on_format_insert` BEFORE INSERT ON `day_closures`
WHEN date(NEW.`closed_on`) IS NOT NEW.`closed_on`
BEGIN
	SELECT RAISE(ABORT, 'day_closures.closed_on must be YYYY-MM-DD');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `day_closures_closed_on_format_update` BEFORE UPDATE OF `closed_on` ON `day_closures`
WHEN date(NEW.`closed_on`) IS NOT NEW.`closed_on`
BEGIN
	SELECT RAISE(ABORT, 'day_closures.closed_on must be YYYY-MM-DD');
END;
