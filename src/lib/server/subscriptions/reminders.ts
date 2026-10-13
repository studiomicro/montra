import { sql } from 'drizzle-orm';
import {
	billReminderDataKey,
	effectiveNextCharge,
	isBillReminderDue,
	type BillingCycle
} from '#lib/shared/subscriptions';
import type { Db } from '../db';
import { MAX_SUBSCRIPTIONS_PER_SPACE } from './repo';

/**
 * FN-26 → FN-24: the subscriptions of one space whose bill reminder is due. The jobs Worker's `bill_check`
 * (notifications/triggers.ts `evaluateBills`) turns each into a `bill_reminder` per live member through
 * `createIfAbsent`, keyed per subscription and charge date, so a repeated tick or a retried message never
 * reminds twice, and the next cycle reminds again only after `next_charge_on` advanced. Read-only.
 */

export interface DueBillReminder {
	subscriptionId: string;
	name: string;
	amountMinor: number;
	currency: string;
	/** The charge date (WIB) the reminder is about. */
	nextChargeOn: string;
	dataKey: string;
}

/**
 * The live, real (never `Data demo`) subscriptions of the live space `spaceId` whose reminder window
 * (`isBillReminderDue` on the never-stale next charge) covers the WIB date `today`. Bounded by the per-space
 * cap.
 */
export async function dueBillReminders(
	db: Db,
	spaceId: string,
	today: string
): Promise<DueBillReminder[]> {
	const rows = await db.all<{
		id: string;
		name: string;
		amountMinor: number;
		currency: string;
		cycle: BillingCycle;
		day: number;
		month: number | null;
		stored: string;
		daysBefore: number;
	}>(sql`select s.id as id, s.name as name, s.amount_minor as amountMinor, s.currency as currency,
			s.billing_cycle as cycle, s.billing_day as day, s.billing_month as month,
			s.next_charge_on as stored, s.reminder_days_before as daysBefore
		from subscriptions s join spaces sp on sp.id = s.space_id and sp.deleted_at is null
		where s.space_id = ${spaceId} and s.deleted_at is null and s.is_demo = 0
		order by s.id limit ${MAX_SUBSCRIPTIONS_PER_SPACE}`);
	const due: DueBillReminder[] = [];
	for (const r of rows) {
		const next = effectiveNextCharge(
			{ cycle: r.cycle, day: r.day, month: r.month },
			r.stored,
			today
		);
		if (!isBillReminderDue(next, r.daysBefore, today)) continue;
		due.push({
			subscriptionId: r.id,
			name: r.name,
			amountMinor: r.amountMinor,
			currency: r.currency,
			nextChargeOn: next,
			dataKey: billReminderDataKey(r.id, next)
		});
	}
	return due;
}
