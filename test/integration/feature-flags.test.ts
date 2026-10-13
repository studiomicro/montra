import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import { FLAGS_LOAD_FAILED, MODULE_INVALID } from '#lib/server/feature-flags/messages';
import { getFeatureFlags, setFeatureFlag } from '#lib/server/feature-flags/repo';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// Lets one test make the flag read fail as if D1 were unavailable.
const failRead = { on: false };
vi.mock('#lib/server/feature-flags/repo', async (original) => {
	const real = await original<typeof import('#lib/server/feature-flags/repo')>();
	return {
		...real,
		getFeatureFlags: (...args: Parameters<typeof real.getFeatureFlags>) => {
			if (failRead.on) throw new Error('D1_ERROR: no such table: feature_flags');
			return real.getFeatureFlags(...args);
		}
	};
});

const { handle } = await import('../../src/hooks.server');
const fitur = await import('../../src/routes/(app)/pengaturan/fitur/+page.server');
const layout = await import('../../src/routes/(app)/+layout.server');
const kekayaan = await import('../../src/routes/(app)/kekayaan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const ROUTE = '/(app)/pengaturan/fitur';

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
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `fitur${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { id: r.userId, email, name, createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof person>>;

const ev = (
	who: Person | null,
	opts: { form?: Record<string, string>; headers?: Record<string, string>; body?: string } = {}
) =>
	fakeEvent({
		url: 'http://localhost/pengaturan/fitur',
		routeId: ROUTE,
		db,
		user: who,
		form: opts.form,
		headers: opts.headers
	}).event as never;

const load = (who: Person | null) => run(() => fitur.load(ev(who)));
const setFlag = (who: Person, form: Record<string, string>) =>
	run(() => (fitur.actions.setFlag as (e: never) => unknown)(ev(who, { form })));
const hiddenFor = async (who: Person) =>
	(
		(await layout.load(
			fakeEvent({ url: 'http://localhost/', routeId: '/(app)', db, user: who }).event as never
		)) as { hiddenModules: string[] }
	).hiddenModules;
const rowsOf = async (userId: string) =>
	(
		await d1
			.prepare('select module, enabled from feature_flags where user_id = ? order by module')
			.bind(userId)
			.all<{ module: string; enabled: number }>()
	).results;

describe('feature flags repo', () => {
	it('defaults every module to enabled with no rows (criterion 1)', async () => {
		const p = await person();
		expect(await getFeatureFlags(db, p.id)).toEqual({
			kekayaan: true,
			langganan: true,
			barang: true,
			koleksi: true,
			ruang: true,
			patungan: true
		});
		expect(await rowsOf(p.id)).toEqual([]);
	});

	it('20 concurrent writes for one (user, module) leave exactly one row, no error (criterion 8)', async () => {
		const p = await person();
		const results = await Promise.allSettled(
			Array.from({ length: 20 }, (_, i) => setFeatureFlag(db, p.id, 'kekayaan', i % 2 === 0, i))
		);
		expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
		const rows = await rowsOf(p.id);
		expect(rows).toHaveLength(1);
		const stored = await d1
			.prepare('select enabled, updated_at from feature_flags where user_id = ?')
			.bind(p.id)
			.first<{ enabled: number; updated_at: number }>();
		// The last applied write wins, consistently: its own enabled value and timestamp.
		expect(stored!.enabled).toBe(stored!.updated_at % 2 === 0 ? 1 : 0);
	});

	it('the module check constraint refuses an unknown module', async () => {
		const p = await person();
		await expect(
			d1
				.prepare(
					"insert into feature_flags (id, user_id, module, enabled, created_at, updated_at) values ('x', ?, 'tanya', 1, 0, 0)"
				)
				.bind(p.id)
				.run()
		).rejects.toThrow(/CHECK constraint/);
	});
});

describe('/pengaturan/fitur', () => {
	it('loads the six modules enabled for a new user', async () => {
		const p = await person();
		expect(await load(p)).toMatchObject({
			kind: 'ok',
			value: {
				flags: {
					kekayaan: true,
					langganan: true,
					barang: true,
					koleksi: true,
					ruang: true,
					patungan: true
				},
				loadError: null
			}
		});
	});

	it('switching Kekayaan off writes one row for this user only and survives a reload (criteria 2, 3)', async () => {
		const p = await person();
		expect(await setFlag(p, { module: 'kekayaan' })).toMatchObject({
			kind: 'ok',
			value: { saved: 'kekayaan', enabled: false }
		});
		expect(await rowsOf(p.id)).toEqual([{ module: 'kekayaan', enabled: 0 }]);
		const cols = await d1
			.prepare('select name from pragma_table_info(?)')
			.bind('feature_flags')
			.all();
		expect(cols.results.map((c) => c.name)).not.toContain('space_id');
		expect(await load(p)).toMatchObject({ kind: 'ok', value: { flags: { kekayaan: false } } });
		expect(await hiddenFor(p)).toEqual(['kekayaan']);

		expect(await setFlag(p, { module: 'kekayaan', enabled: 'on' })).toMatchObject({
			kind: 'ok',
			value: { saved: 'kekayaan', enabled: true }
		});
		expect(await rowsOf(p.id)).toEqual([{ module: 'kekayaan', enabled: 1 }]);
		expect(await hiddenFor(p)).toEqual([]);
	});

	it('a shared-space member is unaffected by the other member hiding a module (criterion 2)', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.id, 'Rumah', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.id, replaces: '' },
			Date.now()
		))!;
		expect(await acceptInvite(db, invite.token, member.id, Date.now())).toMatchObject({
			status: 'joined'
		});

		await setFlag(owner, { module: 'kekayaan' });
		expect(await hiddenFor(owner)).toEqual(['kekayaan']);
		expect(await hiddenFor(member)).toEqual([]);
		expect(await getFeatureFlags(db, member.id)).toMatchObject({ kekayaan: true });
	});

	it('the four modules without a nav entry persist too (criterion 7)', async () => {
		const p = await person();
		for (const module of ['langganan', 'barang', 'koleksi', 'ruang'])
			expect((await setFlag(p, { module })).kind).toBe('ok');
		expect(await load(p)).toMatchObject({
			kind: 'ok',
			value: {
				flags: { kekayaan: true, langganan: false, barang: false, koleksi: false, ruang: false }
			}
		});
		expect(await hiddenFor(p)).toEqual(['langganan', 'barang', 'koleksi', 'ruang']);
	});

	it('refuses an unknown or missing module with 400 and writes nothing', async () => {
		const p = await person();
		for (const module of ['tanya', '__proto__', 'Kekayaan', ''])
			expect(await setFlag(p, { module, enabled: 'on' })).toEqual({
				kind: 'fail',
				status: 400,
				data: { error: MODULE_INVALID }
			});
		expect(await rowsOf(p.id)).toEqual([]);
	});

	it('ignores any user id in the form: only the session user is changed (criterion 13)', async () => {
		const a = await person();
		const b = await person();
		await setFlag(a, { module: 'kekayaan', userId: b.id, user_id: b.id });
		expect(await rowsOf(a.id)).toHaveLength(1);
		expect(await rowsOf(b.id)).toEqual([]);
	});

	it('answers a malformed or oversized body with 415/400, never 500 (criterion 14)', async () => {
		const p = await person();
		const send = (body: string, type: string) => runRaw(body, type, p);
		expect(await send('{"module":"kekayaan"}', 'application/json')).toMatchObject({
			kind: 'error',
			status: 415
		});
		expect(
			await send(`module=kekayaan&x=${'a'.repeat(9000)}`, 'application/x-www-form-urlencoded')
		).toMatchObject({ kind: 'error', status: 400 });
		expect(await rowsOf(p.id)).toEqual([]);
	});

	it('shows a retry state, never a 500, when the flags cannot be read', async () => {
		const p = await person();
		failRead.on = true;
		try {
			expect(await load(p)).toMatchObject({
				kind: 'ok',
				value: { loadError: FLAGS_LOAD_FAILED }
			});
			// The shell degrades to showing every entry rather than breaking every page.
			expect(await hiddenFor(p)).toEqual([]);
		} finally {
			failRead.on = false;
		}
	});

	it('redirects a signed-out visitor to sign in (criterion 10)', async () => {
		for (const [path, routeId] of [
			['/pengaturan/fitur', ROUTE],
			['/pengaturan', '/(app)/pengaturan']
		] as const) {
			const { event } = fakeEvent({ url: `http://localhost${path}`, routeId, db });
			const res = await handle({ event, resolve: async () => new Response('ok') });
			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe(`/masuk?next=${encodeURIComponent(path)}`);
		}
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303 });
	});
});

describe('hidden module routes', () => {
	it('/kekayaan still loads normally when Kekayaan is hidden (criterion 6)', async () => {
		const p = await person();
		await setFlag(p, { module: 'kekayaan' });
		const space = await resolveCurrentSpace(db, p.id, undefined);
		const result = await run(() =>
			kekayaan.load(
				fakeEvent({
					url: 'http://localhost/kekayaan',
					routeId: '/(app)/kekayaan',
					db,
					user: p,
					space
				}).event as never
			)
		);
		expect(result).toMatchObject({
			kind: 'ok',
			value: { belongings: { failed: false }, collectibles: { failed: false } }
		});
	});
});

describe('account deletion', () => {
	it('deletes the user’s feature flags with the account, and only theirs', async () => {
		const a = await person();
		const b = await person();
		await setFeatureFlag(db, a.id, 'kekayaan', false, 1);
		await setFeatureFlag(db, a.id, 'koleksi', false, 1);
		await setFeatureFlag(db, b.id, 'kekayaan', false, 1);
		const proof = await signInWithPassword(db, a.email, PASSWORD, 2);
		if (!proof.ok) throw new Error('proof failed');
		expect(await deleteAccount(db, a.id, proof.hash)).toBe(true);
		expect(await rowsOf(a.id)).toEqual([]);
		expect(await rowsOf(b.id)).toEqual([{ module: 'kekayaan', enabled: 0 }]);
	});
});

/** Calls setFlag with a raw body and content type (bypassing the form helper's encoding). */
async function runRaw(body: string, type: string, who: Person) {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/fitur',
		routeId: ROUTE,
		db,
		user: who,
		method: 'POST'
	});
	const raw = Object.assign(event as object, {
		request: new Request('http://localhost/pengaturan/fitur', {
			method: 'POST',
			headers: { 'content-type': type },
			body
		})
	});
	return run(() => (fitur.actions.setFlag as (e: never) => unknown)(raw as never));
}
