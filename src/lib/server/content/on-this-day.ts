import { onThisDay, validEntries, type OnThisDayEntry } from '#lib/shared/on-this-day';

/**
 * FN-54 D4: the reviewed "Pada hari ini" entries bundled with the build (never fetched at runtime). Only entries
 * that pass the validator are ever shown; the file ships empty until the owner approves entries.
 */
const FILES = import.meta.glob<unknown>('../../content/on-this-day/entries.json', {
	eager: true,
	import: 'default'
});
const ENTRIES: readonly OnThisDayEntry[] = validEntries(Object.values(FILES)[0] ?? []);

/** The reviewed entry for the WIB date `today`, or null (the card is then absent). */
export function onThisDayEntry(today: string): OnThisDayEntry | null {
	return onThisDay(ENTRIES, today);
}
