import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { calendarSpending } from '#lib/server/calendar/month';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { createTransaction, MANUAL } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { openLocalD1 } from '../helpers/d1';

/** QA, FN-55 cycle 2: a card wallet on FN-54's /kalender month heat map (WIB days, transfers never spending). */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = Date.parse('2026-11-02T03:00:00Z');

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

describe('FN-55 QA: a card on the calendar', () => {
	it('a 23:30 WIB purchase on 31 Oct counts on 31 Oct; the bill payment (a transfer) counts on no day', async () => {
		const r = await signUp(
			db,
			{
				name: 'Uji',
				email: 'kalender55@contoh.id',
				password: 'kopi-pagi-2026',
				adultConfirmed: true,
				consentAccepted: true
			},
			NOW
		);
		if (!r.ok) throw new Error('setup failed');
		const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
		const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
		const mk = async (
			name: string,
			type: 'bank' | 'kartu_kredit',
			opening: number,
			fav: boolean
		) => {
			const w = await createWallet(
				db,
				scope,
				{
					name,
					type,
					currency: 'IDR',
					openingBalanceMinor: opening,
					isFavourite: fav,
					lastFour: null
				},
				NOW
			);
			if (!w.ok) throw new Error('wallet failed');
			return w.id;
		};
		const bank = await mk('Bank', 'bank', 100000000, false);
		const card = await mk('Kartu', 'kartu_kredit', 0, true);
		await ensurePresetCategories(db, scope.spaceId, NOW);
		const cat = (await listCategories(db, scope.spaceId)).find(
			(c) => c.isPreset && c.tileKey === 'belanja' && c.kind === 'expense'
		)!;
		const add = async (over: Record<string, unknown>) => {
			const c = await createTransaction(
				db,
				scope,
				{
					type: 'expense',
					amountMinor: 2500000,
					currency: 'IDR',
					walletId: card,
					transferToWalletId: null,
					categoryId: cat.id,
					title: 'Fiktif',
					note: null,
					occurredOn: '2026-10-31',
					occurredTime: '23:30',
					...over
				} as never,
				NOW,
				MANUAL
			);
			if (!c.ok) throw new Error(`row failed: ${c.reason}`);
		};
		await add({});
		await add({ occurredOn: '2026-11-01', occurredTime: '00:30', amountMinor: 1100000 });
		await add({
			type: 'transfer',
			walletId: bank,
			transferToWalletId: card,
			categoryId: null,
			occurredOn: '2026-11-01',
			occurredTime: '09:00',
			amountMinor: 2500000
		});
		const oct = await calendarSpending(db, scope.spaceId, '2026-10', '2026-11-02');
		const nov = await calendarSpending(db, scope.spaceId, '2026-11', '2026-11-02');
		expect(oct.currency).toBe('IDR');
		expect(oct.days.find((d) => d.date === '2026-10-31')?.minor).toBe(2500000);
		expect(nov.days.find((d) => d.date === '2026-11-01')?.minor).toBe(1100000);
		expect(nov.days.reduce((s, d) => s + (d.minor ?? 0), 0)).toBe(1100000);
	});
});
