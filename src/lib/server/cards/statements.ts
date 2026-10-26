import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { CardStatementFigures } from '#lib/shared/statements/types';
import type { Db } from '../db';
import { cardStatements } from '../db/schema';
import { isLiveMember, type SpaceScope } from '../spaces/access';
import { currentSpaceSeq } from '../sync/seq';
import { newId } from '../util';

/**
 * Stored card statements (FN-55b, `card_statements`): one live row per card wallet and statement date, holding only
 * the printed figures. Written in the same `db.batch` as its import (`insertCardStatement`), tombstoned with it on
 * "Urungkan" (`tombstoneCardStatementsOfBatch`) and moved with it by "Pindahkan" (imports/repo.ts). Every read is
 * scoped to a space the caller admitted through `requireSpaceAccess`/`currentSpaceScope`.
 */

/** Most statements one card keeps live (owner decision 11; the next import is refused) and the card page lists. */
const CARD_STATEMENTS_MAX = 60;

/** One stored statement as the card page and summary read it (wallet convention: owed is negative). */
export interface StoredCardStatement {
	id: string;
	walletId: string;
	importBatchId: string;
	statementDate: string;
	dueDate: string | null;
	periodFrom: string | null;
	periodTo: string | null;
	previousBalanceMinor: number;
	newBalanceMinor: number;
	minimumPaymentMinor: number | null;
	limitMinor: number | null;
	currency: string;
}

const columns = {
	id: cardStatements.id,
	walletId: cardStatements.walletId,
	importBatchId: cardStatements.importBatchId,
	statementDate: cardStatements.statementDate,
	dueDate: cardStatements.dueDate,
	periodFrom: cardStatements.periodFrom,
	periodTo: cardStatements.periodTo,
	previousBalanceMinor: cardStatements.previousBalanceMinor,
	newBalanceMinor: cardStatements.newBalanceMinor,
	minimumPaymentMinor: cardStatements.minimumPaymentMinor,
	limitMinor: cardStatements.limitMinor,
	currency: cardStatements.currency
};

/** A live row's content columns are set (the content CHECK); typed as such for the callers. */
const live = (r: {
	statementDate: string | null;
	previousBalanceMinor: number | null;
	newBalanceMinor: number | null;
	currency: string | null;
}) => r as unknown as StoredCardStatement;

/**
 * Batch item: the statement's row, only while the import batch `batchId` exists in this very batch (it is written
 * just before), the wallet is a live `kartu_kredit` wallet of the space and the user a live member. A second live
 * copy of the same statement date fails the partial unique index, so the whole import batch is refused.
 */
export function insertCardStatement(
	db: Db,
	scope: SpaceScope,
	input: { batchId: string; walletId: string; card: CardStatementFigures; currency: string },
	now: number
) {
	const { spaceId, userId } = scope;
	const c = input.card;
	return db.insert(cardStatements).select(
		sql`select ${newId()}, ${spaceId}, ${input.walletId}, ${input.batchId}, ${c.statementDate}, ${c.dueDate},
			${c.periodFrom}, ${c.periodTo}, ${c.previousBalanceMinor}, ${c.newBalanceMinor}, ${c.minimumPaymentMinor},
			${c.limitMinor}, ${input.currency}, ${now}, ${now}, null, ${currentSpaceSeq(spaceId)}
		where exists (select 1 from import_batches b where b.id = ${input.batchId} and b.space_id = ${spaceId})
			and exists (select 1 from wallets w where w.id = ${input.walletId} and w.space_id = ${spaceId}
				and w.deleted_at is null and w.type = 'kartu_kredit')
			and (select count(*) from card_statements s where s.space_id = ${spaceId}
				and s.wallet_id = ${input.walletId} and s.deleted_at is null) < ${CARD_STATEMENTS_MAX}
			and ${isLiveMember(spaceId, userId)}`
	);
}

/** Whether the card already keeps CARD_STATEMENTS_MAX live statements (a new import is then refused). */
export async function cardStatementsFull(
	db: Db,
	spaceId: string,
	walletId: string
): Promise<boolean> {
	const row = await db.get<{ n: number }>(sql`select count(*) as n from card_statements
		where space_id = ${spaceId} and wallet_id = ${walletId} and deleted_at is null`);
	return (row?.n ?? 0) >= CARD_STATEMENTS_MAX;
}

/** SQL: batch `batchId` holds a live card statement (an import batch assertion). */
export const batchHasCardStatement = (spaceId: string, batchId: string) =>
	sql`exists (select 1 from card_statements s where s.space_id = ${spaceId}
		and s.import_batch_id = ${batchId} and s.deleted_at is null)`;

/** Batch item: tombstones the live card statement of `batchId` (content-free) while `guard` holds. */
export function tombstoneCardStatementsOfBatch(
	db: Db,
	spaceId: string,
	batchId: string,
	now: number,
	guard: SQL
) {
	return db
		.update(cardStatements)
		.set({
			deletedAt: now,
			statementDate: null,
			dueDate: null,
			periodFrom: null,
			periodTo: null,
			previousBalanceMinor: null,
			newBalanceMinor: null,
			minimumPaymentMinor: null,
			limitMinor: null,
			currency: null,
			updatedAt: sql`max(${now}, ${cardStatements.updatedAt} + 1)`,
			seq: currentSpaceSeq(spaceId)
		})
		.where(
			and(
				eq(cardStatements.spaceId, spaceId),
				eq(cardStatements.importBatchId, batchId),
				isNull(cardStatements.deletedAt),
				guard
			)
		);
}

/** Batch item: the live card statement of `batchId` follows its rows to `walletId` while `guard` holds. */
export function moveCardStatementsOfBatch(
	db: Db,
	spaceId: string,
	batchId: string,
	walletId: string,
	now: number,
	guard: SQL
) {
	return db
		.update(cardStatements)
		.set({
			walletId,
			updatedAt: sql`max(${now}, ${cardStatements.updatedAt} + 1)`,
			seq: currentSpaceSeq(spaceId)
		})
		.where(
			and(
				eq(cardStatements.spaceId, spaceId),
				eq(cardStatements.importBatchId, batchId),
				isNull(cardStatements.deletedAt),
				guard
			)
		);
}

/** The live card statement of a batch (its date), or null. */
export async function cardStatementOfBatch(
	db: Db,
	spaceId: string,
	batchId: string
): Promise<{ statementDate: string } | null> {
	const row = await db
		.select({ statementDate: cardStatements.statementDate })
		.from(cardStatements)
		.where(
			and(
				eq(cardStatements.spaceId, spaceId),
				eq(cardStatements.importBatchId, batchId),
				isNull(cardStatements.deletedAt)
			)
		)
		.get();
	return row?.statementDate ? { statementDate: row.statementDate } : null;
}

/** Whether the card wallet already holds a live statement of `statementDate` ("Tagihan ini sudah diimpor"). */
export async function cardStatementExists(
	db: Db,
	spaceId: string,
	walletId: string,
	statementDate: string
): Promise<boolean> {
	const row = await db
		.select({ id: cardStatements.id })
		.from(cardStatements)
		.where(
			and(
				eq(cardStatements.spaceId, spaceId),
				eq(cardStatements.walletId, walletId),
				eq(cardStatements.statementDate, statementDate),
				isNull(cardStatements.deletedAt)
			)
		)
		.get();
	return row !== undefined;
}

/** The latest live statement of the card dated before `before` (its date), or null: a span fallback (B7). */
export async function previousCardStatementDate(
	db: Db,
	spaceId: string,
	walletId: string,
	before: string
): Promise<string | null> {
	const row = await db.get<{
		d: string | null;
	}>(sql`select max(statement_date) as d from card_statements
		where space_id = ${spaceId} and wallet_id = ${walletId} and deleted_at is null
			and statement_date < ${before}`);
	return row?.d ?? null;
}

/** The card's live statements, newest first, at most CARD_STATEMENTS_MAX. */
export async function listCardStatements(
	db: Db,
	spaceId: string,
	walletId: string
): Promise<StoredCardStatement[]> {
	const rows = await db
		.select(columns)
		.from(cardStatements)
		.where(
			and(
				eq(cardStatements.spaceId, spaceId),
				eq(cardStatements.walletId, walletId),
				isNull(cardStatements.deletedAt)
			)
		)
		.orderBy(desc(cardStatements.statementDate))
		.limit(CARD_STATEMENTS_MAX);
	return rows.map(live);
}

/** The newest live statement of each of `walletIds` (ids bound once as JSON). */
export async function latestCardStatements(
	db: Db,
	spaceId: string,
	walletIds: readonly string[]
): Promise<Map<string, StoredCardStatement>> {
	const out = new Map<string, StoredCardStatement>();
	if (walletIds.length === 0) return out;
	const rows = await db.all<{
		id: string;
		wallet_id: string;
		import_batch_id: string;
		statement_date: string;
		due_date: string | null;
		period_from: string | null;
		period_to: string | null;
		previous_balance_minor: number;
		new_balance_minor: number;
		minimum_payment_minor: number | null;
		limit_minor: number | null;
		currency: string;
	}>(sql`select s.id, s.wallet_id, s.import_batch_id, s.statement_date, s.due_date, s.period_from,
			s.period_to, s.previous_balance_minor, s.new_balance_minor, s.minimum_payment_minor, s.limit_minor,
			s.currency
		from card_statements s
		where s.space_id = ${spaceId} and s.deleted_at is null
			and s.wallet_id in (select value from json_each(${JSON.stringify(walletIds)}))
			and s.statement_date = (select max(x.statement_date) from card_statements x
				where x.space_id = s.space_id and x.wallet_id = s.wallet_id and x.deleted_at is null)`);
	for (const r of rows)
		out.set(r.wallet_id, {
			id: r.id,
			walletId: r.wallet_id,
			importBatchId: r.import_batch_id,
			statementDate: r.statement_date,
			dueDate: r.due_date,
			periodFrom: r.period_from,
			periodTo: r.period_to,
			previousBalanceMinor: r.previous_balance_minor,
			newBalanceMinor: r.new_balance_minor,
			minimumPaymentMinor: r.minimum_payment_minor,
			limitMinor: r.limit_minor,
			currency: r.currency
		});
	return out;
}
