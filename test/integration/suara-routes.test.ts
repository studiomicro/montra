import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import {
	ensurePresetCategories,
	listCategories,
	setCategoryHidden
} from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { frequentManualTransactions } from '#lib/server/transactions/aggregate';
import {
	CATEGORY_NOT_FOUND,
	CATEGORY_REQUIRED,
	TRANSACTION_NOT_FOUND,
	TYPE_INVALID,
	VOICE_DUPLICATE,
	VOICE_NOTHING,
	VOICE_ROWS_INVALID,
	WALLET_NOT_FOUND
} from '#lib/server/transactions/messages';
import { createTransaction, getTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { VOICE_FORM_MAX_BYTES } from '#lib/server/transactions/voice';
import { archiveWallet, createWallet, getWallet } from '#lib/server/wallets/repo';
import { addDays, wibTodayString } from '#lib/shared/dates';
import { parseVoiceSentence, VOICE_BATCH_MAX } from '#lib/shared/voice-parse';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const route = await import('../../src/routes/(app)/riwayat/suara/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Handler = (event: never) => unknown;

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
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `suara${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event for `who`; `space` picks the current space; `forgedSpace` sets locals.space verbatim. */
async function ev(
	who: Person | null,
	opts: {
		url: string;
		form?: Record<string, string> | [string, string][];
		space?: string;
		forgedSpace?: { id: string; kind: 'personal' | 'shared'; name: string; role: 'owner' };
		headers?: Record<string, string>;
	}
) {
	const space =
		opts.forgedSpace ?? (who ? await resolveCurrentSpace(db, who.user.id, opts.space) : null);
	return fakeEvent({
		url: `http://localhost${opts.url}`,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		headers: opts.headers
	});
}

const load = async (who: Person | null, space?: string) =>
	run(async () => route.load((await ev(who, { url: '/riwayat/suara', space })).event as never));
const act = async (
	who: Person | null,
	name: 'parse' | 'save' | 'catatLagi' | 'urungkan',
	form: Record<string, string> | [string, string][],
	opts: { space?: string; forgedSpace?: Parameters<typeof ev>[1]['forgedSpace'] } = {}
) =>
	run(async () =>
		(route.actions as Record<string, Handler>)[name]!(
			(await ev(who, { url: `/riwayat/suara?/${name}`, form, ...opts })).event as never
		)
	);

async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	const spaceId = (await resolveCurrentSpace(db, p.user.id, space))!.id;
	await ensurePresetCategories(db, spaceId);
	const scope = { spaceId, userId: p.user.id };
	const wallet = async (name: string, type: 'bank' | 'e_wallet' | 'tunai', fav = false) => {
		const w = await createWallet(
			db,
			scope,
			{
				name,
				type,
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: fav,
				lastFour: null
			},
			Date.now()
		);
		if (!w.ok) throw new Error('wallet failed');
		return w.id;
	};
	const bca = await wallet('BCA', 'bank', true);
	const gopay = await wallet('GoPay', 'e_wallet');
	const cats = await listCategories(db, spaceId);
	const cat = (key: string) => cats.find((c) => c.tileKey === key)!.id;
	return {
		p,
		spaceId,
		scope,
		bca,
		gopay,
		kopi: cat('kopi'),
		transportasi: cat('transportasi'),
		gaji: cat('gaji'),
		belanja: cat('belanja')
	};
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The review form exactly as the page posts it (`type.i`, `amount.i`, …). */
function rowsForm(
	key: string,
	rows: { type?: string; amount: string; walletId: string; categoryId: string; title: string }[],
	count = rows.length
): [string, string][] {
	const out: [string, string][] = [
		['key', key],
		['count', String(count)]
	];
	rows.forEach((r, i) => {
		out.push([`type.${i}`, r.type ?? 'expense']);
		out.push([`amount.${i}`, r.amount]);
		out.push([`walletId.${i}`, r.walletId]);
		out.push([`categoryId.${i}`, r.categoryId]);
		out.push([`title.${i}`, r.title]);
	});
	return out;
}

const rowsOf = (s: Setup) =>
	db.all<{
		id: string;
		amount_minor: number;
		title: string | null;
		source: string;
		occurred_on: string;
		category_id: string;
		wallet_id: string;
		dedupe_key: string | null;
	}>(
		sql`select id, amount_minor, title, source, occurred_on, category_id, wallet_id, dedupe_key
			from transactions where space_id = ${s.spaceId} and deleted_at is null order by amount_minor desc`
	);

const input = (s: Setup, o: Partial<TransactionInput> = {}): TransactionInput => ({
	type: 'expense',
	amountMinor: 2_500_000,
	currency: 'IDR',
	walletId: s.bca,
	transferToWalletId: null,
	categoryId: s.kopi,
	title: 'Kopi susu',
	note: null,
	occurredOn: wibTodayString(),
	occurredTime: null,
	...o
});

describe('the acceptance journey (signed-in half)', () => {
	it('"kopi 25rb dan parkir goceng" → 2 candidates → Simpan → both stored as voice rows today', async () => {
		const s = await setup();
		const candidates = parseVoiceSentence('kopi 25rb dan parkir goceng', { wallets: [] });
		expect(candidates).toHaveLength(2);
		const key = crypto.randomUUID();
		const res = await act(
			s.p,
			'save',
			rowsForm(key, [
				{ amount: '25.000', walletId: s.bca, categoryId: s.kopi, title: 'kopi' },
				{ amount: '5.000', walletId: s.bca, categoryId: s.transportasi, title: 'parkir' }
			])
		);
		expect(res).toMatchObject({ kind: 'ok', value: { saved: 2, remaining: 0 } });
		const rows = await rowsOf(s);
		expect(rows.map((r) => [r.title, r.amount_minor, r.source, r.occurred_on])).toEqual([
			['kopi', 2_500_000, 'voice', wibTodayString()],
			['parkir', 500_000, 'voice', wibTodayString()]
		]);
		expect(rows.map((r) => r.dedupe_key).sort()).toEqual([`${key}:0`, `${key}:1`]);
	});

	it('the no-JavaScript parse action returns exactly what the browser parser returns', async () => {
		const s = await setup();
		const sentence = 'bayar kopi pakai gopay 25rb dan parkir goceng';
		const res = await act(s.p, 'parse', { sentence });
		expect(res.kind).toBe('ok');
		const value = (res as unknown as { value: Record<string, unknown> }).value;
		const wallets = [
			{ id: s.bca, name: 'BCA', type: 'bank' as const },
			{ id: s.gopay, name: 'GoPay', type: 'e_wallet' as const }
		];
		expect(JSON.stringify(value.candidates)).toBe(
			JSON.stringify(parseVoiceSentence(sentence, { wallets }))
		);
		expect((value.candidates as { walletHint?: string }[])[0]?.walletHint).toBe(s.gopay);
		expect(value.remaining).toBe(0);
		expect(String(value.key)).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('the parse action echoes hostile text cleaned, never as markup it builds', async () => {
		const s = await setup();
		const res = await act(s.p, 'parse', {
			sentence: '<img src=x onerror=alert(1)>\u200b 25rb\u0007'
		});
		const value = (res as unknown as { value: Record<string, unknown> }).value;
		expect(value.sentence).toBe('<img src=x onerror=alert(1)> 25rb');
		expect((value.candidates as { title: string }[])[0]?.title).toBe(
			'<img src=x onerror=alert(1)>'
		);
	});

	it('a parse with more than VOICE_BATCH_MAX amounts returns 20 and says how many remain', async () => {
		const s = await setup();
		const res = await act(s.p, 'parse', { sentence: 'kopi 1rb '.repeat(25) });
		const value = (res as unknown as { value: Record<string, unknown> }).value;
		expect((value.candidates as unknown[]).length).toBe(VOICE_BATCH_MAX);
		expect(value.remaining).toBe(5);
	});
});

describe('save', () => {
	it('a resent submission (same key) writes nothing more', async () => {
		const s = await setup();
		const form = rowsForm(crypto.randomUUID(), [
			{ amount: '25.000', walletId: s.bca, categoryId: s.kopi, title: 'kopi' }
		]);
		expect((await act(s.p, 'save', form)).kind).toBe('ok');
		expect(await act(s.p, 'save', form)).toMatchObject({
			status: 409,
			data: { error: VOICE_DUPLICATE }
		});
		expect(await rowsOf(s)).toHaveLength(1);
	});

	it('one bad row refuses all of them, each row with its own error, and echoes the edits', async () => {
		const s = await setup();
		const key = crypto.randomUUID();
		const res = await act(
			s.p,
			'save',
			rowsForm(key, [
				{ amount: '25.000', walletId: s.bca, categoryId: s.kopi, title: 'kopi' },
				{ amount: '5.000', walletId: s.bca, categoryId: '', title: 'parkir' },
				{ amount: '0', walletId: s.bca, categoryId: s.kopi, title: 'nol' },
				{ type: 'transfer', amount: '1.000', walletId: s.bca, categoryId: s.kopi, title: 'x' }
			])
		);
		expect(res).toMatchObject({ status: 400, data: { error: VOICE_ROWS_INVALID, key } });
		const data = (res as unknown as { data: Record<string, unknown> }).data;
		const errors = data.rowErrors as Record<string, string>[];
		expect(errors[0]).toEqual({});
		expect(errors[1]).toMatchObject({ categoryId: CATEGORY_REQUIRED });
		expect(errors[2]).toHaveProperty('amountMinor');
		expect(errors[3]).toEqual({ type: TYPE_INVALID });
		expect((data.rows as { title: string }[]).map((r) => r.title)).toEqual([
			'kopi',
			'parkir',
			'nol',
			'x'
		]);
		expect(await rowsOf(s)).toHaveLength(0);
	});

	it('an income row needs an income category (FN-05 kind rule holds)', async () => {
		const s = await setup();
		const bad = await act(
			s.p,
			'save',
			rowsForm(crypto.randomUUID(), [
				{ type: 'income', amount: '5.000.000', walletId: s.bca, categoryId: s.kopi, title: 'gaji' }
			])
		);
		expect(bad).toMatchObject({ status: 400 });
		const ok = await act(
			s.p,
			'save',
			rowsForm(crypto.randomUUID(), [
				{ type: 'income', amount: '5.000.000', walletId: s.bca, categoryId: s.gaji, title: 'gaji' }
			])
		);
		expect(ok).toMatchObject({ kind: 'ok', value: { saved: 1 } });
	});

	it('the FN-05 amount cap holds', async () => {
		const s = await setup();
		const res = await act(
			s.p,
			'save',
			rowsForm(crypto.randomUUID(), [
				{ amount: '9999999999999', walletId: s.bca, categoryId: s.kopi, title: 'besar' }
			])
		);
		expect(res).toMatchObject({ status: 400 });
		expect(await rowsOf(s)).toHaveLength(0);
	});

	it('at most VOICE_BATCH_MAX rows are written per submission; the rest are reported', async () => {
		const s = await setup();
		const rows = Array.from({ length: 21 }, (_, i) => ({
			amount: String(1000 + i),
			walletId: s.bca,
			categoryId: s.kopi,
			title: `kopi ${i}`
		}));
		const res = await act(s.p, 'save', rowsForm(crypto.randomUUID(), rows));
		expect(res).toMatchObject({ kind: 'ok', value: { saved: 20, remaining: 1 } });
		expect(await rowsOf(s)).toHaveLength(20);
	});

	it('a huge count reads only 20 rows and never errors', async () => {
		const s = await setup();
		const res = await act(
			s.p,
			'save',
			rowsForm(
				crypto.randomUUID(),
				[{ amount: '1.000', walletId: s.bca, categoryId: s.kopi, title: 'a' }],
				9999
			)
		);
		expect(res).toMatchObject({
			status: 400,
			data: { error: VOICE_ROWS_INVALID, remaining: 9979 }
		});
	});

	it('no key, no rows → refused with the "nothing to save" message', async () => {
		const s = await setup();
		expect(await act(s.p, 'save', { count: '0' })).toMatchObject({
			status: 400,
			data: { error: VOICE_NOTHING }
		});
		expect(await act(s.p, 'save', rowsForm(crypto.randomUUID(), []))).toMatchObject({
			status: 400,
			data: { error: VOICE_NOTHING }
		});
		expect(
			await act(
				s.p,
				'save',
				rowsForm('not-a-key', [
					{ amount: '1.000', walletId: s.bca, categoryId: s.kopi, title: 'a' }
				])
			)
		).toMatchObject({ status: 400, data: { error: VOICE_NOTHING } });
	});

	it('an archived wallet is refused like an unknown one', async () => {
		const s = await setup();
		const w = (await getWallet(db, s.spaceId, s.gopay))!;
		expect(await archiveWallet(db, s.scope, s.gopay, w.updatedAt, Date.now())).toBe('ok');
		const res = await act(
			s.p,
			'save',
			rowsForm(crypto.randomUUID(), [
				{ amount: '1.000', walletId: s.gopay, categoryId: s.kopi, title: 'a' }
			])
		);
		expect(res).toMatchObject({ status: 400 });
		expect((res as unknown as { data: { rowErrors: unknown[] } }).data.rowErrors[0]).toEqual({
			walletId: WALLET_NOT_FOUND
		});
	});

	it('a body over the voice cap is refused with 400, a non-form body with 415', async () => {
		const s = await setup();
		const big = await run(async () =>
			(route.actions as Record<string, Handler>).save!(
				(
					await ev(s.p, {
						url: '/riwayat/suara?/save',
						form: { key: crypto.randomUUID(), pad: 'x'.repeat(VOICE_FORM_MAX_BYTES) }
					})
				).event as never
			)
		);
		expect(big).toMatchObject({ kind: 'error', status: 400 });
		const json = await run(async () =>
			(route.actions as Record<string, Handler>).save!(
				(
					await ev(s.p, {
						url: '/riwayat/suara?/save',
						form: { a: 'b' },
						headers: { 'content-type': 'application/json' }
					})
				).event as never
			)
		);
		expect(json).toMatchObject({ kind: 'error', status: 415 });
	});

	it('20 rows with 80-character multi-byte titles fit under the cap', async () => {
		const s = await setup();
		const title = 'é'.repeat(80);
		const rows = Array.from({ length: 20 }, () => ({
			amount: '1.000.000.000',
			walletId: s.bca,
			categoryId: s.kopi,
			title
		}));
		const res = await act(s.p, 'save', rowsForm(crypto.randomUUID(), rows));
		expect(res).toMatchObject({ kind: 'ok', value: { saved: 20 } });
	});
});

describe('cross-space', () => {
	it("another space's wallet or category id is refused as not found; nothing is written anywhere", async () => {
		const a = await setup();
		const b = await setup();
		const res = await act(
			a.p,
			'save',
			rowsForm(crypto.randomUUID(), [
				{ amount: '25.000', walletId: b.bca, categoryId: a.kopi, title: 'kopi' },
				{ amount: '25.000', walletId: a.bca, categoryId: b.kopi, title: 'kopi' }
			])
		);
		expect(res).toMatchObject({ status: 400 });
		const errors = (res as unknown as { data: { rowErrors: Record<string, string>[] } }).data
			.rowErrors;
		expect(errors[0]).toEqual({ walletId: WALLET_NOT_FOUND });
		expect(errors[1]).toEqual({ categoryId: CATEGORY_NOT_FOUND });
		expect(await rowsOf(a)).toHaveLength(0);
		expect(await rowsOf(b)).toHaveLength(0);
	});

	it("catatLagi and urungkan on another space's transaction answer not found", async () => {
		const a = await setup();
		const b = await setup();
		const tx = await createTransaction(db, b.scope, input(b), Date.now());
		if (!tx.ok) throw new Error('setup');
		expect(await act(a.p, 'catatLagi', { id: tx.id, key: crypto.randomUUID() })).toMatchObject({
			status: 404,
			data: { error: TRANSACTION_NOT_FOUND }
		});
		const stored = (await getTransaction(db, b.spaceId, tx.id))!;
		expect(
			await act(a.p, 'urungkan', { id: tx.id, updatedAt: String(stored.updatedAt) })
		).toMatchObject({ status: 404, data: { error: TRANSACTION_NOT_FOUND } });
		expect(await getTransaction(db, b.spaceId, tx.id)).not.toBeNull();
		expect(await rowsOf(b)).toHaveLength(1);
	});

	it('a removed member reads and writes nothing of the shared space; a forged space is a 404', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const s = await setup(owner, spaceId);
		const tx = await createTransaction(db, s.scope, input(s), Date.now());
		if (!tx.ok) throw new Error('setup');
		// While a member, the shared space's frequent rows are visible.
		const before = await load(member, spaceId);
		expect(
			(before as unknown as { value: { frequent: { id: string }[] } }).value.frequent[0]?.id
		).toBe(tx.id);

		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());

		// The space cookie no longer resolves: the member lands in their own personal space.
		const after = await load(member, spaceId);
		const value = (after as unknown as { value: Record<string, unknown> }).value;
		expect(value.frequent).toEqual([]);
		expect((value.wallets as { id: string }[]).map((w) => w.id)).not.toContain(s.bca);
		const key = crypto.randomUUID();
		const save = await act(
			member,
			'save',
			rowsForm(key, [{ amount: '1.000', walletId: s.bca, categoryId: s.kopi, title: 'x' }]),
			{ space: spaceId }
		);
		expect(save).toMatchObject({ status: 400 });
		expect(await act(member, 'catatLagi', { id: tx.id, key }, { space: spaceId })).toMatchObject({
			status: 404
		});

		// Even with locals.space forged to the shared space, requireSpaceAccess refuses every entry point.
		const forgedSpace = {
			id: spaceId,
			kind: 'shared' as const,
			name: 'Keluarga',
			role: 'owner' as const
		};
		const forgedLoad = await run(async () =>
			route.load((await ev(member, { url: '/riwayat/suara', forgedSpace })).event as never)
		);
		expect(forgedLoad).toMatchObject({ kind: 'error', status: 404 });
		for (const [name, form] of [
			['parse', { sentence: 'kopi 25rb' }],
			[
				'save',
				rowsForm(key, [{ amount: '1.000', walletId: s.bca, categoryId: s.kopi, title: 'x' }])
			],
			['catatLagi', { id: tx.id, key }],
			['urungkan', { id: tx.id, updatedAt: '1' }]
		] as const) {
			expect(await act(member, name, form as never, { forgedSpace })).toMatchObject({
				kind: 'error',
				status: 404
			});
		}
		expect(await rowsOf(s)).toHaveLength(1);
	});

	it('signed out → redirected to /masuk, never a 200', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', location: '/masuk' });
		expect(await act(null, 'save', { key: crypto.randomUUID(), count: '0' })).toMatchObject({
			kind: 'redirect',
			location: '/masuk'
		});
	});
});

describe('Catat lagi', () => {
	it('no qualifying row → no buttons', async () => {
		const s = await setup();
		const res = await load(s.p);
		expect((res as unknown as { value: { frequent: unknown[] } }).value.frequent).toEqual([]);
	});

	it('groups identical rows, most frequent first then most recent; skips demo, transfer, captured, old, hidden and archived', async () => {
		const s = await setup();
		const today = wibTodayString();
		const add = async (
			o: Partial<TransactionInput>,
			origin?: Parameters<typeof createTransaction>[4],
			at = Date.now()
		) => {
			const r = await createTransaction(db, s.scope, input(s, o), at, origin);
			if (!r.ok) throw new Error('setup');
			return r.id;
		};
		await add({ title: 'Kopi susu' }, undefined, 1_000);
		await add({ title: 'Kopi susu' }, undefined, 2_000);
		const latestKopi = await add(
			{ title: 'Kopi susu' },
			{ source: 'voice', dedupeKey: 'v1' },
			3_000
		);
		await add(
			{ title: 'Parkir', amountMinor: 500_000, categoryId: s.transportasi },
			undefined,
			4_000
		);
		await add(
			{ title: 'Parkir', amountMinor: 500_000, categoryId: s.transportasi },
			undefined,
			5_000
		);
		const bensin = await add(
			{ title: 'Bensin', amountMinor: 5_000_000, categoryId: s.transportasi },
			undefined,
			6_000
		);
		// Never counted:
		for (let i = 0; i < 5; i++) {
			await add({ title: 'Demo' }, { source: 'manual', dedupeKey: null, isDemo: true });
			await add({ title: 'Gmail' }, { source: 'gmail', dedupeKey: `g${i}` });
			await add({ title: 'Lama', occurredOn: addDays(today, -90) });
			await add({ title: 'Belanja', categoryId: s.belanja });
			await add({ title: 'Dompet arsip', walletId: s.gopay });
			await add({
				type: 'transfer',
				title: 'Pindah',
				categoryId: null,
				transferToWalletId: s.gopay
			});
		}
		await setCategoryHidden(db, s.scope, s.belanja, true, Date.now());
		const w = (await getWallet(db, s.spaceId, s.gopay))!;
		// gopay holds transactions: archive (not delete) it.
		expect(await archiveWallet(db, s.scope, s.gopay, w.updatedAt, Date.now())).toBe('ok');
		const edge = await add({ title: 'Tepi', occurredOn: addDays(today, -89) });

		const frequent = await frequentManualTransactions(db, s.spaceId, { limit: 5, today });
		expect(frequent.map((f) => [f.title, f.count])).toEqual([
			['Kopi susu', 3],
			['Parkir', 2],
			['Tepi', 1],
			['Bensin', 1]
		]);
		expect(frequent[0]?.id).toBe(latestKopi);
		expect(frequent.find((f) => f.title === 'Bensin')?.id).toBe(bensin);
		expect(frequent.find((f) => f.title === 'Tepi')?.id).toBe(edge);
		expect(frequent[0]).toMatchObject({
			type: 'expense',
			amountMinor: 2_500_000,
			currency: 'IDR',
			walletName: 'BCA',
			category: { tileKey: 'kopi', isPreset: true }
		});
		expect(await frequentManualTransactions(db, s.spaceId, { limit: 2, today })).toHaveLength(2);
		expect(await frequentManualTransactions(db, s.spaceId, { limit: 99, today })).toHaveLength(4);
	});

	it('one tap records a voice copy today; a resent tap does nothing; Urungkan deletes exactly that row', async () => {
		const s = await setup();
		const old = await createTransaction(
			db,
			s.scope,
			input(s, { occurredOn: addDays(wibTodayString(), -3), note: 'catatan pribadi' }),
			Date.now()
		);
		if (!old.ok) throw new Error('setup');
		const key = crypto.randomUUID();
		const res = await act(s.p, 'catatLagi', { id: old.id, key });
		expect(res.kind).toBe('ok');
		const recorded = (res as unknown as { value: { recorded: { id: string; updatedAt: number } } })
			.value.recorded;
		const copy = (await getTransaction(db, s.spaceId, recorded.id))!;
		expect(copy).toMatchObject({
			source: 'voice',
			occurredOn: wibTodayString(),
			amountMinor: 2_500_000,
			title: 'Kopi susu',
			note: null,
			walletId: s.bca,
			categoryId: s.kopi,
			updatedAt: recorded.updatedAt
		});
		expect(await act(s.p, 'catatLagi', { id: old.id, key })).toMatchObject({
			status: 409,
			data: { error: VOICE_DUPLICATE }
		});
		expect(await rowsOf(s)).toHaveLength(2);

		expect(await act(s.p, 'urungkan', { id: recorded.id, updatedAt: '1' })).toMatchObject({
			status: 409
		});
		expect(
			await act(s.p, 'urungkan', { id: recorded.id, updatedAt: String(recorded.updatedAt) })
		).toMatchObject({ kind: 'ok', value: { undone: true } });
		const left = await rowsOf(s);
		expect(left.map((r) => r.id)).toEqual([old.id]);
		expect(
			await act(s.p, 'urungkan', { id: recorded.id, updatedAt: String(recorded.updatedAt) })
		).toMatchObject({ status: 404 });
	});

	it('a "Data demo" row is not found: never copied into a real row (red team L1)', async () => {
		const s = await setup();
		const demo = await createTransaction(db, s.scope, input(s), Date.now(), {
			source: 'manual',
			dedupeKey: null,
			isDemo: true
		});
		if (!demo.ok) throw new Error('setup');
		expect(await act(s.p, 'catatLagi', { id: demo.id, key: crypto.randomUUID() })).toMatchObject({
			status: 404,
			data: { error: TRANSACTION_NOT_FOUND }
		});
		expect(await rowsOf(s)).toHaveLength(1);
	});

	it('a transfer, a captured row or a malformed request is not found', async () => {
		const s = await setup();
		const transfer = await createTransaction(
			db,
			s.scope,
			input(s, { type: 'transfer', categoryId: null, transferToWalletId: s.gopay }),
			Date.now()
		);
		const gmail = await createTransaction(db, s.scope, input(s), Date.now(), {
			source: 'gmail',
			dedupeKey: 'm1'
		});
		if (!transfer.ok || !gmail.ok) throw new Error('setup');
		for (const id of [transfer.id, gmail.id, 'x'.repeat(65), '']) {
			expect(await act(s.p, 'catatLagi', { id, key: crypto.randomUUID() })).toMatchObject({
				status: 404,
				data: { error: TRANSACTION_NOT_FOUND }
			});
		}
		expect(await act(s.p, 'catatLagi', { id: gmail.id, key: 'bad' })).toMatchObject({
			status: 404
		});
	});

	it('a row whose category was hidden meanwhile is refused, nothing written', async () => {
		const s = await setup();
		const tx = await createTransaction(db, s.scope, input(s), Date.now());
		if (!tx.ok) throw new Error('setup');
		await setCategoryHidden(db, s.scope, s.kopi, true, Date.now());
		expect(await act(s.p, 'catatLagi', { id: tx.id, key: crypto.randomUUID() })).toMatchObject({
			status: 409
		});
		expect(await rowsOf(s)).toHaveLength(1);
	});
});

describe('load', () => {
	it('lists wallets favourite first with an IDR default, presets, and a fresh tap key', async () => {
		const s = await setup();
		const res = await load(s.p);
		const value = (res as unknown as { value: Record<string, unknown> }).value;
		expect(value.loadError).toBeNull();
		expect(value.defaultWalletId).toBe(s.bca);
		expect((value.wallets as { name: string; type: string }[]).map((w) => w.name)).toEqual([
			'BCA',
			'GoPay'
		]);
		expect((value.categories as unknown[]).length).toBe(24);
		expect(String(value.tapKey)).toMatch(/^[0-9a-f-]{36}$/);
		expect(JSON.stringify(value)).not.toMatch(/password|hash|token/i);
	});
});
