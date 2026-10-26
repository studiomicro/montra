import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { listImportBatches, undoImportBatch } from '#lib/server/imports/repo';
import { summarizeNetWorth } from '#lib/server/net-worth/summary';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	importStatement,
	type ImportStatementInput
} from '#lib/server/statements/statement-import';
import { createWallet } from '#lib/server/wallets/repo';
import type { StatementParser } from '#lib/shared/statements/types';
import { FICTIONAL_CARD, fictionalCardPdf } from '../fixtures/statements/fictional-card';
import { openLocalD1 } from '../helpers/d1';

/** QA additions for FN-55 (cycle 1): gaps found while checking the acceptance criteria. */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-10-26T03:00:00Z');
const PARSERS: StatementParser[] = [FICTIONAL_CARD];

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function account() {
	const email = `qa55-${++n}@contoh.id`;
	const r = await signUp(
		db,
		{
			name: 'Uji',
			email,
			password: 'kopi-pagi-2026',
			adultConfirmed: true,
			consentAccepted: true
		},
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return { userId: r.userId, scope: { spaceId: space.id, userId: r.userId } as SpaceScope };
}

async function cardWallet(scope: SpaceScope) {
	const r = await createWallet(
		db,
		scope,
		{
			name: 'Kartu Fiktif',
			type: 'kartu_kredit',
			currency: 'IDR',
			openingBalanceMinor: -200000000,
			isFavourite: false,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

const input = (walletId: string): ImportStatementInput => ({
	bytes: fictionalCardPdf().slice(),
	password: null,
	institution: null,
	filename: 'tagihan-fiktif.pdf',
	defaultWalletId: walletId,
	skipPossibleDuplicates: true
});

const counts = async (spaceId: string) => {
	const one = async (table: string) =>
		(
			await d1
				.prepare(`select count(*) as n from ${table} where space_id = ?`)
				.bind(spaceId)
				.first<{ n: number }>()
		)?.n;
	return {
		tx: await one('transactions'),
		batches: await one('import_batches'),
		statements: await one('card_statements')
	};
};

describe('FN-55 QA: a removed member cannot import a card statement (AC 9, 36)', () => {
	it('writes no row, batch or card statement once the member is out of the shared space', async () => {
		const owner = await account();
		const member = await account();
		const spaceId = (await createSharedSpace(db, owner.userId, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.userId, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.userId, NOW);
		const ownerScope = { spaceId, userId: owner.userId };
		const memberScope = { spaceId, userId: member.userId };
		const cardId = await cardWallet(ownerScope);
		const row = (await listMembers(db, spaceId, owner.userId)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.userId, memberId: row.id }, NOW);
		const before = await counts(spaceId);
		const result = await importStatement(db, memberScope, input(cardId), NOW, PARSERS);
		expect(result.ok && result.batchId !== null).toBe(false);
		expect(await counts(spaceId)).toEqual(before);
		// The owner still can.
		const ok = await importStatement(db, ownerScope, input(cardId), NOW, PARSERS);
		expect(ok).toMatchObject({ ok: true });
		expect((await counts(spaceId)).statements).toBe(1);
	});
});

describe('FN-55 QA: the very same file after undo (AC 26, engineer decision)', () => {
	it('reports what happens: rows stay tombstoned, no second card statement is created', async () => {
		const a = await account();
		const cardId = await cardWallet(a.scope);
		expect(await importStatement(db, a.scope, input(cardId), NOW, PARSERS)).toMatchObject({
			ok: true
		});
		const [batch] = await listImportBatches(db, a.scope.spaceId);
		expect(await undoImportBatch(db, a.scope, batch!.id, batch!.updatedAt, NOW + 1)).toBe('ok');
		const again = await importStatement(db, a.scope, input(cardId), NOW + 2, PARSERS);
		// Same bytes: the tombstoned rows keep their dedupe keys, so nothing is recreated and no new statement is stored.
		expect(again).toMatchObject({ ok: true, batchId: null });
		expect((await counts(a.scope.spaceId)).statements).toBe(1);
		const live = await d1
			.prepare(
				'select count(*) as n from card_statements where space_id = ? and deleted_at is null'
			)
			.bind(a.scope.spaceId)
			.first<{ n: number }>();
		expect(live?.n).toBe(0);
	});
});

describe('FN-55 QA: card debt never mixes currencies (A4)', () => {
	it('a USD card without a cached rate stays apart from the rupiah total, total unchanged', () => {
		const book = { coins: new Map(), fx: new Map(), gold: null } as unknown as Parameters<
			typeof summarizeNetWorth
		>[2];
		const wallets = [
			{ currency: 'IDR', balanceMinor: 500000000, type: 'bank' as const },
			{ currency: 'USD', balanceMinor: -125050, type: 'kartu_kredit' as const }
		];
		const withCards = summarizeNetWorth(wallets, [], book, NOW);
		const legacy = summarizeNetWorth(
			wallets.map(({ currency, balanceMinor }) => ({ currency, balanceMinor })),
			[],
			book,
			NOW
		);
		expect(withCards.totalMinor).toBe(legacy.totalMinor);
		expect(withCards.totalMinor).toBe(500000000);
		expect(withCards.unconverted).toEqual(legacy.unconverted);
		expect(withCards.unconverted).toEqual([{ currency: 'USD', minor: -125050 }]);
	});
});
