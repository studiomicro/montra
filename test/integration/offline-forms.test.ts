import { isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { getTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

/** FN-02 task 10: riwayat/baru's create action with and without the enhanced form's clientId. */
const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const baru = await import('../../src/routes/(app)/riwayat/baru/+page.server');
const layout = await import('../../src/routes/(app)/+layout.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

let n = 0;
async function setup() {
	const email = `formulir${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const user = { id: r.userId, email, name: 'Uji', createdAt: 0 };
	const space = (await resolveCurrentSpace(db, user.id, undefined))!;
	await ensurePresetCategories(db, space.id);
	const w = await createWallet(
		db,
		{ spaceId: space.id, userId: user.id },
		{
			name: 'BCA',
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		Date.now()
	);
	if (!w.ok) throw new Error('wallet');
	const kopi = (await listCategories(db, space.id)).find((c) => c.tileKey === 'kopi')!.id;
	return { user, space, bca: w.id, kopi };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function create(s: Setup, extra: Record<string, string> = {}) {
	const { event } = fakeEvent({
		url: 'http://localhost/riwayat/baru?/create',
		db,
		user: s.user,
		space: s.space,
		form: {
			type: 'expense',
			amount: '25.000',
			walletId: s.bca,
			transferToWalletId: '',
			categoryId: s.kopi,
			title: 'Kopi',
			note: '',
			occurredOn: wibTodayString(),
			occurredTime: '',
			...extra
		}
	});
	try {
		return await (baru.actions.create as (e: never) => Promise<unknown>)(event as never);
	} catch (e) {
		if (isRedirect(e)) return { redirect: e.location };
		throw e;
	}
}

const count = async (spaceId: string) =>
	(
		await db.all<{ n: number }>(
			sql`select count(*) as n from transactions where space_id = ${spaceId}`
		)
	)[0]!.n;

describe('riwayat/baru create with a clientId (task 10)', () => {
	it('the same submission sent twice (the answer to the first was lost): one row, both succeed', async () => {
		const s = await setup();
		const clientId = crypto.randomUUID();
		expect(await create(s, { clientId })).toEqual({ redirect: '/riwayat?saved=created' });
		expect(await create(s, { clientId })).toEqual({ redirect: '/riwayat?saved=created' });
		expect(await count(s.space.id)).toBe(1);
		expect((await getTransaction(db, s.space.id, clientId))?.title).toBe('Kopi');
	});

	it('without JavaScript (no clientId) every submission is its own row, exactly as before', async () => {
		const s = await setup();
		await create(s);
		await create(s);
		expect(await count(s.space.id)).toBe(2);
	});

	it('a malformed clientId is ignored (fresh id), never used as a row id', async () => {
		const s = await setup();
		await create(s, { clientId: 'x'.repeat(36) });
		await create(s, { clientId: "1' or '1'='1" });
		expect(await count(s.space.id)).toBe(2);
	});

	it('the form action and the queue share the id: a queued resend after the form wrote it is a no-op', async () => {
		const s = await setup();
		const clientId = crypto.randomUUID();
		await create(s, { clientId });
		const route = await import('../../src/routes/api/v1/sync/push/+server');
		const { event } = fakeEvent({ url: 'http://localhost/api/v1/sync/push', db, user: s.user });
		Object.assign(event, {
			request: new Request('http://localhost/api/v1/sync/push', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'http://localhost' },
				body: JSON.stringify({
					clientId,
					accountId: s.user.id,
					spaceId: s.space.id,
					kind: 'transaction.create',
					payload: [
						['type', 'expense'],
						['amount', '25.000'],
						['walletId', s.bca],
						['categoryId', s.kopi],
						['title', 'Kopi'],
						['occurredOn', wibTodayString()]
					]
				})
			})
		});
		const res = await route.POST(event as never);
		expect(res.status).toBe(200);
		expect(await count(s.space.id)).toBe(1);
	});
});

describe('(app) layout queue scope', () => {
	it('names the signed-in account and the current space (display and stamping only)', async () => {
		const s = await setup();
		const { event } = fakeEvent({ url: 'http://localhost/', db, user: s.user, space: s.space });
		const data = (await layout.load(event as never)) as { queue: unknown };
		expect(data.queue).toEqual({
			accountId: s.user.id,
			spaceId: s.space.id,
			spaceName: s.space.name
		});
	});
	it('signed out: no queue', async () => {
		const { event } = fakeEvent({ url: 'http://localhost/', db });
		expect(((await layout.load(event as never)) as { queue: unknown }).queue).toBeNull();
	});
});
