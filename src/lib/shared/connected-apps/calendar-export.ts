import { addDays, isDateString, wibDateString } from '../dates.ts';
import { NOTE_MAX_LENGTH, TITLE_MAX_LENGTH } from '../transactions.ts';
import { cleanText } from '../text.ts';

/**
 * Google Calendar events for FN-29 (no network call here): one all-day event per reminder (a bill from FN-26, a
 * reminder from FN-24), in the Events resource shape `{ summary, start: { date }, end: { date }, description }`
 * (all-day: `end` is the next day, exclusive). The day is always the WIB calendar date: a reminder carries
 * either its WIB `date` (`next_charge_on`) or the UTC instant `at` it is due, which is bucketed in WIB, never by
 * its UTC date. A reminder without a real date, or with nothing left of its title, gives no event. Titles and
 * notes are untrusted text: invisible characters stripped and capped.
 */

export type CalendarReminder = { title: string; note?: string } & (
	{ date: string } | { at: number }
);

export interface CalendarEvent {
	summary: string;
	start: { date: string };
	end: { date: string };
	description?: string;
}

function reminderDate(reminder: CalendarReminder): string | null {
	if ('date' in reminder) return isDateString(reminder.date) ? reminder.date : null;
	if (!Number.isSafeInteger(reminder.at)) return null;
	const date = wibDateString(reminder.at);
	return isDateString(date) ? date : null;
}

export function buildCalendarEvents(reminders: readonly CalendarReminder[]): CalendarEvent[] {
	const events: CalendarEvent[] = [];
	for (const reminder of reminders) {
		const date = reminderDate(reminder);
		const summary = cleanText(String(reminder.title ?? ''), TITLE_MAX_LENGTH);
		if (!date || summary === '') continue;
		const event: CalendarEvent = { summary, start: { date }, end: { date: addDays(date, 1) } };
		const description = cleanText(String(reminder.note ?? ''), NOTE_MAX_LENGTH);
		if (description !== '') event.description = description;
		events.push(event);
	}
	return events;
}
