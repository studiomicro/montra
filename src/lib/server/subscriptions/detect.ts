import { sql } from 'drizzle-orm';
import { addDays } from '#lib/shared/dates';
import {
	buildCandidates,
	DETECT_ROWS_MAX,
	DETECT_WINDOW_DAYS,
	exclusionKeys,
	groupByMerchantKey,
	type ExpenseRow,
	type SubscriptionCandidate
} from '#lib/shared/subscriptions-detect';
import type { Db } from '../db';
import { subscriptionDismissals } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { bumpSpaceSeq, currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';
import { MAX_SUBSCRIPTIONS_PER_SPACE } from './repo';

// FN-26b subscription check. Runs only after `requireSpaceAccess` admitted the caller to `spaceId`; every read is
// bounded and scoped to the space, and the one write repeats the membership check inside its own statement.

/**
 * The space's subscription candidates as of the WIB date `today`: its most recent DETECT_ROWS_MAX live, real
 * (`Data demo` excluded) expenses within the last DETECT_WINDOW_DAYS days, minus what its live subscriptions
 * already cover and what it dismissed. Transfers and income are never read.
 */
export async function findCandidates(
	db: Db,
	spaceId: string,
	today: string
): Promise<SubscriptionCandidate[]> {
	const [rows, subs] = await Promise.all([
		db.all<ExpenseRow>(sql`select id, title, amount_minor as amountMinor, currency,
				occurred_on as occurredOn
			from transactions
			where space_id = ${spaceId} and deleted_at is null and type = 'expense' and is_demo = 0
				and occurred_on >= ${addDays(today, -(DETECT_WINDOW_DAYS - 1))} and occurred_on <= ${today}
			order by occurred_on desc, occurred_at desc, id desc
			limit ${DETECT_ROWS_MAX}`),
		db.all<{
			name: string;
			catalogueId: string | null;
		}>(sql`select name, catalogue_id as catalogueId
			from subscriptions where space_id = ${spaceId} and deleted_at is null
			limit ${MAX_SUBSCRIPTIONS_PER_SPACE}`)
	]);
	const keys = [...groupByMerchantKey(rows).keys()];
	if (keys.length === 0) return [];
	// Only the dismissals of the keys in this window: bounded by the rows read, one JSON parameter.
	const dismissed = await db.all<{ matchKey: string }>(sql`select match_key as matchKey
		from subscription_dismissals
		where space_id = ${spaceId} and deleted_at is null
			and match_key in (select value from json_each(${JSON.stringify(keys)}))`);
	const exclude = exclusionKeys(subs);
	for (const d of dismissed) exclude.add(d.matchKey);
	return buildCandidates(rows, exclude);
}

/**
 * "Bukan langganan": remembers `matchKey` as dismissed in this space. Idempotent: an already dismissed key is
 * `ok` again (a retried or concurrent request adds no second row: the partial unique index and `do nothing`).
 * `missing` when the key is neither dismissed nor a current candidate, so no arbitrary key is ever stored.
 */
export async function dismissCandidate(
	db: Db,
	scope: SpaceScope,
	matchKey: string,
	today: string,
	now: number
): Promise<'ok' | 'missing'> {
	const { spaceId, userId } = scope;
	const already = sql`exists (select 1 from subscription_dismissals d where d.space_id = ${spaceId}
		and d.match_key = ${matchKey} and d.deleted_at is null)`;
	const [known] = await db.all<{ ok: number }>(sql`select ${already} as ok`);
	if (!known?.ok) {
		const candidates = await findCandidates(db, spaceId, today);
		if (!candidates.some((c) => c.matchKey === matchKey)) return 'missing';
	}
	const [, inserted] = await db.batch([
		bumpSpaceSeq(db, spaceId),
		db
			.insert(subscriptionDismissals)
			.select(
				sql`select ${newId()}, ${spaceId}, ${matchKey}, ${userId}, ${now}, ${now}, null,
					${currentSpaceSeq(spaceId)}
				where ${isLiveMember(spaceId, userId)}`
			)
			// Any conflict is the live (space, key) row (the partial unique index; drizzle puts a target's `where`
			// after `do nothing`, which SQLite refuses, so no target is named).
			.onConflictDoNothing()
			.returning({ id: subscriptionDismissals.id })
	]);
	if (inserted.length === 1) return 'ok';
	// Nothing written: dismissed meanwhile (ok), or no longer a live member (the same answer as an unknown key).
	const [after] = await db.all<{ ok: number }>(sql`select ${already} as ok`);
	return after?.ok ? 'ok' : 'missing';
}
