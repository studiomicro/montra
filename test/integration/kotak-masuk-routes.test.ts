import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import {
	CATEGORY_NOT_FOUND,
	DRAFT_CHANGED,
	DRAFT_NOT_FOUND,
	MIXED_KIND,
	NONE_COMPLETE,
	NOTHING_SELECTED,
	SELECTION_CHANGED,
	SELECTION_GONE,
	WALLET_NOT_FOUND
} from '#lib/server/drafts/messages';
import { FORM_BODY_MAX_BYTES } from '#lib/server/forms';
import { writeCache } from '#lib/server/merchants/repo';
import { cleanDescriptor } from '#lib/shared/merchants/clean';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { createWallet } from '#lib/server/wallets/repo';
import { DRAFT_BATCH_MAX, draftToken } from '#lib/shared/drafts';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database; DEV_ROUTES?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// A deployed build: `vite dev` is off, so only DEV_ROUTES=1 opens the dev seed actions.
vi.mock('$app/env', () => ({ dev: false }));

const inboxRoute = await import('../../src/routes/(app)/kotak-masuk/+page.server');
const reviewRoute = await import('../../src/routes/(app)/kotak-masuk/periksa/+page.server');

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
	const email = `kotak${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(
	who: Person | null,
	opts: {
		url: string;
		form?: Record<string, string> | [string, string][];
		space?: string;
		cookies?: Record<string, string>;
		headers?: Record<string, string>;
	}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.space) : null;
	return fakeEvent({
		url: `http://localhost${opts.url}`,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		cookies: opts.cookies,
		headers: opts.headers
	});
}

const loadInbox = async (who: Person | null, space?: string, cookies?: Record<string, string>) =>
	run(async () =>
		inboxRoute.load((await ev(who, { url: '/kotak-masuk', space, cookies })).event as never)
	);
const loadReview = async (who: Person | null, space?: string) =>
	run(async () =>
		reviewRoute.load((await ev(who, { url: '/kotak-masuk/periksa', space })).event as never)
	);
const inboxAction = async (
	who: Person | null,
	name: string,
	form: Record<string, string> = {},
	space?: string
) =>
	run(async () =>
		(inboxRoute.actions as Record<string, Handler>)[name]!(
			(await ev(who, { url: `/kotak-masuk?/${name}`, form, space })).event as never
		)
	);
async function reviewAction(
	who: Person | null,
	name: 'setCategory' | 'setWallet' | 'save',
	form: [string, string][],
	space?: string
) {
	const { event, written } = await ev(who, { url: `/kotak-masuk/periksa?/${name}`, form, space });
	const result = await run(async () =>
		(reviewRoute.actions as Record<string, Handler>)[name]!(event as never)
	);
	return { ...result, written };
}

/** A person whose current space has presets, an IDR wallet and (seeded through the dev action) drafts. */
async function setup(who?: Person, space?: string) {
	const p = who ?? (await person());
	const spaceId = (await resolveCurrentSpace(db, p.user.id, space))!.id;
	await ensurePresetCategories(db, spaceId);
	const w = await createWallet(
		db,
		{ spaceId, userId: p.user.id },
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
	return {
		p,
		spaceId,
		bca: w.id,
		kopi: cats.find((c) => c.tileKey === 'kopi')!.id,
		gaji: cats.find((c) => c.tileKey === 'gaji')!.id
	};
}

interface Row {
	id: string;
	type: 'expense' | 'income';
	updatedAt: number;
	walletId: string | null;
	categoryId: string | null;
	flag: string | null;
	isDemo: boolean;
}
async function drafts(who: Person, space?: string): Promise<Row[]> {
	const r = await loadReview(who, space);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.drafts as Row[];
}
const tokens = (rows: Row[]): [string, string][] => rows.map((r) => ['d', draftToken(r)]);
async function seed(who: Person, space?: string) {
	binding.DEV_ROUTES = '1';
	try {
		const r = await inboxAction(who, 'seedDemoDrafts', {}, space);
		expect(r).toMatchObject({ kind: 'ok', value: { done: 'seeded', count: 4 } });
	} finally {
		delete binding.DEV_ROUTES;
	}
}
const txCount = async (spaceId: string) =>
	(await d1
		.prepare('select count(*) as n from transactions where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>())!.n;

describe('/kotak-masuk', () => {
	it('needs a session', async () => {
		expect(await loadInbox(null)).toMatchObject({ kind: 'redirect', location: '/masuk' });
		expect(await inboxAction(null, 'discard', { id: 'x', updatedAt: '1' })).toMatchObject({
			kind: 'redirect'
		});
	});

	it('is empty at first, then lists the seeded drafts with their count', async () => {
		const s = await setup();
		expect(await loadInbox(s.p)).toMatchObject({
			kind: 'ok',
			value: { drafts: [], total: 0, devTools: false, loadError: null, notice: null }
		});
		await seed(s.p);
		const r = await loadInbox(s.p);
		expect(r).toMatchObject({ kind: 'ok', value: { total: 4 } });
		const rows = (r as unknown as { value: { drafts: Row[] } }).value.drafts;
		expect(rows).toHaveLength(4);
		expect(rows.every((d) => d.isDemo)).toBe(true);
		expect(JSON.stringify(rows)).not.toContain('dedupeKey');
		expect(JSON.stringify(rows)).not.toContain('demo:');
	});

	it('criterion 4: without DEV_ROUTES the seed and clear actions answer 404 and the tools are absent', async () => {
		const s = await setup();
		delete binding.DEV_ROUTES;
		for (const name of ['seedDemoDrafts', 'clearDemoDrafts'])
			expect(await inboxAction(s.p, name)).toMatchObject({ kind: 'error', status: 404 });
		// Also for a signed-out caller: the gate answers first.
		expect(await inboxAction(null, 'seedDemoDrafts')).toMatchObject({ kind: 'error', status: 404 });
		expect(await loadInbox(s.p)).toMatchObject({ kind: 'ok', value: { devTools: false } });
		expect(await txCount(s.spaceId)).toBe(0);
		binding.DEV_ROUTES = '1';
		expect(await loadInbox(s.p)).toMatchObject({ kind: 'ok', value: { devTools: true } });
		expect(await inboxAction(s.p, 'clearDemoDrafts')).toMatchObject({
			kind: 'ok',
			value: { done: 'cleared', count: 0 }
		});
		delete binding.DEV_ROUTES;
	});

	it('discard: confirm-form post tombstones the draft; stale 409; replay 404', async () => {
		const s = await setup();
		await seed(s.p);
		const [d] = await drafts(s.p);
		expect(
			await inboxAction(s.p, 'discard', { id: d!.id, updatedAt: String(d!.updatedAt - 1) })
		).toMatchObject({ kind: 'fail', status: 409, data: { error: DRAFT_CHANGED } });
		expect(
			await inboxAction(s.p, 'discard', { id: d!.id, updatedAt: String(d!.updatedAt) })
		).toMatchObject({ kind: 'ok', value: { done: 'discarded' } });
		expect((await drafts(s.p)).map((r) => r.id)).not.toContain(d!.id);
		expect(
			await inboxAction(s.p, 'discard', { id: d!.id, updatedAt: String(d!.updatedAt) })
		).toMatchObject({ kind: 'fail', status: 404, data: { error: DRAFT_NOT_FOUND } });
		for (const form of <Record<string, string>[]>[
			{ id: 'x'.repeat(500), updatedAt: '1' },
			{ id: d!.id, updatedAt: 'abc' },
			{}
		])
			expect((await inboxAction(s.p, 'discard', form)).kind).toBe('fail');
	});
});

describe('/kotak-masuk/periksa', () => {
	it('criterion 8: a mixed expense/income selection gets no category', async () => {
		const s = await setup();
		await seed(s.p);
		const rows = await drafts(s.p);
		const r = await reviewAction(s.p, 'setCategory', [...tokens(rows), ['categoryId', s.kopi]]);
		expect(r).toMatchObject({ kind: 'fail', status: 400, data: { error: MIXED_KIND } });
	});

	it('criteria 9, 10: category for one kind, wallet for any, then "Simpan" saves and returns to the inbox', async () => {
		const s = await setup();
		await seed(s.p);
		let rows = await drafts(s.p);
		const expenses = rows.filter((r) => r.type === 'expense');
		expect(
			await reviewAction(s.p, 'setCategory', [...tokens(expenses), ['categoryId', s.kopi]])
		).toMatchObject({ kind: 'ok', value: { done: 'category', updated: expenses.length } });
		rows = await drafts(s.p);
		const income = rows.filter((r) => r.type === 'income');
		await reviewAction(s.p, 'setCategory', [...tokens(income), ['categoryId', s.gaji]]);
		rows = await drafts(s.p);
		expect(
			await reviewAction(s.p, 'setWallet', [...tokens(rows), ['walletId', s.bca]])
		).toMatchObject({ kind: 'ok', value: { done: 'wallet', updated: 4, skipped: 0 } });
		rows = await drafts(s.p);
		expect(rows.every((r) => r.walletId === s.bca && r.categoryId)).toBe(true);
		const saved = await reviewAction(s.p, 'save', tokens(rows));
		expect(saved).toMatchObject({ kind: 'redirect', status: 303, location: '/kotak-masuk' });
		expect(await txCount(s.spaceId)).toBe(4);
		// The summary shows once, only after the confirmed write.
		const cookie = saved.written.get('drafts_saved')!.value;
		expect(await loadInbox(s.p, undefined, { drafts_saved: cookie })).toMatchObject({
			value: { notice: { saved: 4, total: 4, incomplete: 0, remaining: 0 }, total: 0 }
		});
	});

	it('criterion 13: incomplete drafts stay; summary counts them; all incomplete → nothing written', async () => {
		const s = await setup();
		await seed(s.p);
		const rows = await drafts(s.p);
		const incomplete = rows.filter((r) => !r.walletId || !r.categoryId);
		expect(await reviewAction(s.p, 'save', tokens(incomplete))).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { error: NONE_COMPLETE }
		});
		const saved = await reviewAction(s.p, 'save', tokens(rows));
		expect(saved).toMatchObject({ kind: 'redirect' });
		expect(saved.written.get('drafts_saved')?.value).toBe(`1.4.3.0`);
		expect((await drafts(s.p)).map((r) => r.id).sort()).toEqual(incomplete.map((r) => r.id).sort());
	});

	it('criteria 14, 15: at most 50 per request, a duplicated id processed once', async () => {
		const s = await setup();
		for (let i = 0; i < 14; i++) await seed(s.p); // 56 drafts, 14 of them ready
		let rows = await drafts(s.p);
		const expenses = rows.filter((r) => r.type === 'expense');
		await reviewAction(s.p, 'setCategory', [...tokens(expenses), ['categoryId', s.kopi]]);
		rows = await drafts(s.p);
		const income = rows.filter((r) => r.type === 'income');
		await reviewAction(s.p, 'setCategory', [...tokens(income), ['categoryId', s.gaji]]);
		rows = await drafts(s.p);
		await reviewAction(s.p, 'setWallet', [...tokens(rows.slice(0, 50)), ['walletId', s.bca]]);
		await reviewAction(s.p, 'setWallet', [...tokens(rows.slice(50)), ['walletId', s.bca]]);
		rows = await drafts(s.p);
		expect(rows).toHaveLength(56);
		const doubled = tokens(rows);
		doubled.splice(1, 0, doubled[0]!);
		const saved = await reviewAction(s.p, 'save', doubled);
		expect(saved).toMatchObject({ kind: 'redirect' });
		expect(saved.written.get('drafts_saved')?.value).toBe(`${DRAFT_BATCH_MAX}.50.0.6`);
		expect(await txCount(s.spaceId)).toBe(50);
		expect(await drafts(s.p)).toHaveLength(6);
	});

	it('a stale selection: 409 and nothing saved; an empty or vanished selection is refused', async () => {
		const s = await setup();
		await seed(s.p);
		const rows = await drafts(s.p);
		const stale = tokens(rows);
		stale[0] = ['d', `${rows[0]!.id}:1`];
		expect(await reviewAction(s.p, 'save', stale)).toMatchObject({
			kind: 'fail',
			status: 409,
			data: { error: SELECTION_CHANGED }
		});
		expect(await txCount(s.spaceId)).toBe(0);
		expect(await reviewAction(s.p, 'save', [])).toMatchObject({
			status: 400,
			data: { error: NOTHING_SELECTED }
		});
		expect(await reviewAction(s.p, 'save', [['d', `${crypto.randomUUID()}:1`]])).toMatchObject({
			status: 409,
			data: { error: SELECTION_GONE }
		});
	});

	it('criterion 23: oversized or non-form bodies answer 400/415, never 500', async () => {
		const s = await setup();
		const big = Array.from({ length: 400 }, (_, i): [string, string] => [
			'd',
			`${crypto.randomUUID()}:${i}`
		]);
		expect(JSON.stringify(big).length).toBeGreaterThan(FORM_BODY_MAX_BYTES);
		expect(await reviewAction(s.p, 'save', big)).toMatchObject({ kind: 'error', status: 400 });
		const json = await run(async () =>
			(reviewRoute.actions as Record<string, Handler>).save!(
				(
					await ev(s.p, {
						url: '/kotak-masuk/periksa?/save',
						headers: { 'content-type': 'application/json' }
					})
				).event as never
			)
		);
		expect(json).toMatchObject({ kind: 'error', status: 415 });
	});
});

describe('one access rule across spaces (pre-handoff cross-space probe)', () => {
	async function shared() {
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
		await seed(owner, spaceId);
		return { owner, member, spaceId, s, rows: await drafts(owner, spaceId) };
	}

	it('a member reviews the shared space’s drafts', async () => {
		const { member, spaceId, rows } = await shared();
		expect((await drafts(member, spaceId)).map((r) => r.id).sort()).toEqual(
			rows.map((r) => r.id).sort()
		);
	});

	it('a non-member sees nothing and every action finds nothing', async () => {
		const { s, spaceId, rows } = await shared();
		const stranger = await person('Orang lain');
		await setup(stranger);
		// The cookie names a space they are not in: it falls back to their own (empty) inbox.
		expect(await drafts(stranger, spaceId)).toEqual([]);
		expect(await loadInbox(stranger, spaceId)).toMatchObject({ value: { total: 0 } });
		const d = rows[0]!;
		expect(
			await inboxAction(stranger, 'discard', { id: d.id, updatedAt: String(d.updatedAt) }, spaceId)
		).toMatchObject({ status: 404, data: { error: DRAFT_NOT_FOUND } });
		const form: [string, string][] = [...tokens(rows), ['walletId', s.bca], ['categoryId', s.kopi]];
		expect(await reviewAction(stranger, 'save', form, spaceId)).toMatchObject({
			status: 409,
			data: { error: SELECTION_GONE }
		});
		// The shared space's wallet and category read exactly like unknown ids.
		expect(await reviewAction(stranger, 'setWallet', form, spaceId)).toMatchObject({
			status: 400,
			data: { error: WALLET_NOT_FOUND }
		});
		expect(await reviewAction(stranger, 'setCategory', form, spaceId)).toMatchObject({
			status: 400,
			data: { error: CATEGORY_NOT_FOUND }
		});
		// With the stranger's own wallet, the shared space's drafts are simply not there.
		const own = await setup(stranger);
		expect(
			await reviewAction(stranger, 'setWallet', [...tokens(rows), ['walletId', own.bca]], spaceId)
		).toMatchObject({ status: 409, data: { error: SELECTION_GONE } });
		expect(await drafts(s.p, spaceId)).toHaveLength(4);
		expect(await txCount(spaceId)).toBe(0);
	});

	it('a removed member loses the inbox and every action at once', async () => {
		const { owner, member, spaceId, s, rows } = await shared();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		expect(await drafts(member, spaceId)).toEqual([]);
		const d = rows[0]!;
		expect(
			await inboxAction(member, 'discard', { id: d.id, updatedAt: String(d.updatedAt) }, spaceId)
		).toMatchObject({ status: 404 });
		expect(await reviewAction(member, 'save', tokens(rows), spaceId)).toMatchObject({
			status: 409,
			data: { error: SELECTION_GONE }
		});
		binding.DEV_ROUTES = '1';
		const seeded = await inboxAction(member, 'seedDemoDrafts', {}, spaceId);
		delete binding.DEV_ROUTES;
		// The seed lands in the member's own personal space, never the shared one.
		expect(seeded).toMatchObject({ kind: 'ok' });
		expect(await drafts(s.p, spaceId)).toHaveLength(4);
		expect(await txCount(spaceId)).toBe(0);
	});
});

// FN-20 red team L2, owner decision 2026-10-13 ("suggestion only"): an AI-recognised name is offered, never set.
describe('/kotak-masuk "Pakai nama …"', () => {
	it('offers the cached AI name without changing the title; only a tap applies it, re-resolved on the server', async () => {
		const s = await setup();
		await seed(s.p);
		const title = 'Toko Serba Ada';
		const key = cleanDescriptor(title).key!;
		await writeCache(
			db,
			{ spaceId: s.spaceId, userId: s.p.user.id },
			[{ key, kind: 'expense', merchantName: 'Gaji Kantor', categoryId: s.kopi }],
			Date.now()
		);
		const before = await loadInbox(s.p);
		if (before.kind !== 'ok') throw new Error('load failed');
		const list = before.value.drafts as { id: string; title: string; updatedAt: number }[];
		const draft = list.find((d) => d.title === title)!;
		// Offered, and the stored title is still the mail text.
		expect((before.value.names as Record<string, string>)[draft.id]).toBe('Gaji Kantor');
		// A stale version and a foreign user change nothing.
		expect(
			await inboxAction(s.p, 'useName', { id: draft.id, updatedAt: String(draft.updatedAt - 1) })
		).toMatchObject({ kind: 'fail', status: 409 });
		const other = await setup();
		expect(
			await inboxAction(other.p, 'useName', { id: draft.id, updatedAt: String(draft.updatedAt) })
		).toMatchObject({ kind: 'fail', status: 404 });
		// The form names no title: a posted one is ignored.
		expect(
			await inboxAction(s.p, 'useName', {
				id: draft.id,
				updatedAt: String(draft.updatedAt),
				title: 'Sesuatu yang lain'
			})
		).toMatchObject({ kind: 'ok', value: { done: 'renamed' } });
		const after = await loadInbox(s.p);
		if (after.kind !== 'ok') throw new Error('load failed');
		const renamed = (after.value.drafts as { id: string; title: string }[]).find(
			(d) => d.id === draft.id
		)!;
		expect(renamed.title).toBe('Gaji Kantor');
		expect((after.value.names as Record<string, string>)[draft.id]).toBeUndefined();
	});
});
