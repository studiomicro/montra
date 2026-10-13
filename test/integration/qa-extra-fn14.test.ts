import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { signUp } from '#lib/server/auth/accounts';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { sql } from 'drizzle-orm';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const route = await import('../../src/routes/(app)/riwayat/suara/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value: value as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const };
		if (isHttpError(e)) return { kind: 'error' as const };
		throw e;
	}
}

let n = 0;
async function person() {
	const email = `qax${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 } };
}

async function setup() {
	const p = await person();
	const spaceId = (await resolveCurrentSpace(db, p.user.id, undefined))!.id;
	await ensurePresetCategories(db, spaceId);
	const scope = { spaceId, userId: p.user.id };
	const w = await createWallet(
		db,
		scope,
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
	if (!w.ok) throw new Error('wallet failed');
	const cats = await listCategories(db, spaceId);
	const kopi = cats.find((c) => c.tileKey === 'kopi')!.id;
	return { p, spaceId, bca: w.id, kopi };
}

function rowsForm(
	key: string,
	rows: { amount: string; walletId: string; categoryId: string; title: string }[]
) {
	const out: [string, string][] = [
		['key', key],
		['count', String(rows.length)]
	];
	rows.forEach((r, i) => {
		out.push([`type.${i}`, 'expense']);
		out.push([`amount.${i}`, r.amount]);
		out.push([`walletId.${i}`, r.walletId]);
		out.push([`categoryId.${i}`, r.categoryId]);
		out.push([`title.${i}`, r.title]);
	});
	return out;
}

async function act(who: { user: { id: string } }, form: [string, string][]) {
	const space = await resolveCurrentSpace(db, who.user.id, undefined);
	const event = (
		await fakeEvent({
			url: 'http://localhost/riwayat/suara?/save',
			db,
			user: who.user as never,
			space,
			form
		})
	).event;
	return run(async () => (route.actions.save as (e: never) => unknown)(event as never));
}

describe('QA: two genuinely separate identical submissions', () => {
	it('each with its own key both save, giving two rows', async () => {
		const s = await setup();
		const row = [{ amount: '25.000', walletId: s.bca, categoryId: s.kopi, title: 'kopi' }];
		const first = await act(s.p, rowsForm(crypto.randomUUID(), row));
		expect(first.kind).toBe('ok');
		const second = await act(s.p, rowsForm(crypto.randomUUID(), row));
		expect(second.kind).toBe('ok');
		const rows = await db.all<{ id: string }>(
			sql`select id from transactions where space_id = ${s.spaceId} and deleted_at is null`
		);
		expect(rows).toHaveLength(2);
	});
});
