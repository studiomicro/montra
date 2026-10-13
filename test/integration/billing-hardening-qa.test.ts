import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimHashes } from '#lib/server/billing/claims';
import { createVoucher, redeemVoucher } from '#lib/server/billing/vouchers';
import { getDb, type Db } from '#lib/server/db';
import { base64urlEncode } from '#lib/shared/base64url';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// QA cycle 1 for FN-30 hardening (docs/features/fn-30-pro-hardening/QA_REPORT.md): gaps left by the engineer's
// tests. (17) the voucher marker guard inside the insert decides on its own, even when the pre-read that names
// the reason misses the marker (a marker written between the read and the batch); (24) the admin page answers
// `cache-control: no-store`; (8) refunds are reachable only through the signed-in user's own id.

const K1 = base64urlEncode(new Uint8Array(32).fill(51));
const env: Record<string, unknown> = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => env }));

const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const akun = await import('../../src/routes/(app)/pengaturan/akun/+page.server');
const admin = await import('../../src/routes/pengaturan/integrasi/admin/+page.server');

let d1: D1Database;
let db: Db;
let bindings: { DB: D1Database; FILES: R2Bucket };
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-sore-2026';

beforeAll(async () => {
	({ db: d1, env: bindings, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

function configure(extra: Record<string, unknown> = {}) {
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, bindings, {
		JOBS_QUEUE: { send: async () => {}, sendBatch: async () => {} },
		CLAIM_HASH_KEY: K1,
		...extra
	});
}
beforeEach(() => configure());

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value)) return { kind: 'fail' as const, status: value.status };
		return { kind: 'ok' as const, value };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function signUpVia(email: string) {
	const { event } = fakeEvent({
		url: 'http://localhost/daftar',
		routeId: '/(auth)/daftar',
		db,
		headers: { 'cf-connecting-ip': `198.18.${++n}.${Math.floor(Math.random() * 250)}` },
		form: { name: 'Uji', email, password: PASSWORD, adult: 'on', consent: 'on' }
	});
	expect(await run(() => daftar.actions.default!(event as never))).toMatchObject({
		kind: 'redirect',
		status: 303
	});
	const row = await d1
		.prepare('select id from users where email = ?')
		.bind(email.toLowerCase())
		.first<{ id: string }>();
	return { id: row!.id, email: email.toLowerCase(), name: 'Uji', createdAt: 0 };
}
type Person = Awaited<ReturnType<typeof signUpVia>>;

async function deleteVia(who: Person) {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/akun?/deleteAccount',
		routeId: '/(app)/pengaturan/akun',
		db,
		user: who,
		form: { password: PASSWORD, confirm: 'on' }
	});
	expect(await run(() => akun.actions.deleteAccount!(event as never))).toMatchObject({
		kind: 'redirect',
		location: '/akun-dihapus'
	});
}

const count = async (table: string, where = sql`1`) =>
	(await db.all<{ n: number }>(sql`select count(*) as n from ${sql.raw(table)} where ${where}`))[0]
		?.n ?? 0;

describe('QA: the voucher marker guard decides, not the pre-read (criterion 17)', () => {
	it('20 concurrent redeems with a stale "not marked" pre-read still redeem nothing', async () => {
		const { code } = await createVoucher(
			db,
			{ code: 'JAGA-PENANDA-2026', kind: 'credits', creditsAmount: 40, maxRedemptions: 100 },
			1
		);
		const a = await signUpVia('qa17guard@contoh.id');
		const hashesA = await claimHashes({ CLAIM_HASH_KEY: K1 }, a.email);
		expect(await redeemVoucher(db, a.id, code, Date.now(), hashesA)).toMatchObject({ ok: true });
		await deleteVia(a);
		const again = await signUpVia('qa17guard+lagi@contoh.id');
		const hashes = await claimHashes({ CLAIM_HASH_KEY: K1 }, again.email);
		expect(hashes!.current).toBe(hashesA!.current);

		// Every marker read reports "not marked", as if the marker landed after the read: only the guard remains.
		const original = db.all.bind(db);
		const spy = vi.spyOn(db, 'all').mockImplementation((async (query: never) => {
			const rows = (await original(query)) as Record<string, unknown>[];
			return rows[0] && 'marked' in rows[0] ? [{ marked: 0 }] : rows;
		}) as never);
		try {
			const results = await Promise.all(
				Array.from({ length: 20 }, () => redeemVoucher(db, again.id, code, Date.now(), hashes))
			);
			expect(results.filter((r) => r.ok)).toHaveLength(0);
			// The masked pre-read no longer names the reason, so the refusal came from the guard in the insert.
			expect(results.some((r) => !r.ok && r.reason === 'already_redeemed')).toBe(false);
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect(await count('voucher_redemptions', sql`user_id = ${again.id}`)).toBe(0);
		expect(await count('credit_ledger', sql`user_id = ${again.id}`)).toBe(0);
	});
});

describe('QA: admin page cache control (criterion 24)', () => {
	it('a listed account gets 200 data with cache-control: no-store', async () => {
		const owner = await signUpVia('qa24admin@contoh.id');
		configure({ ADMIN_ACCOUNT_IDS: owner.id });
		const headers: Record<string, string> = {};
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/integrasi/admin',
			routeId: '/pengaturan/integrasi/admin',
			db,
			user: owner
		});
		(event as unknown as { setHeaders: (h: Record<string, string>) => void }).setHeaders = (h) =>
			Object.assign(headers, h);
		const r = await run(() => admin.load(event as never));
		expect(r.kind).toBe('ok');
		expect(headers['cache-control']).toBe('no-store');
	});
});

describe('QA: refunds are reachable only by the signed-in account (criterion 8)', () => {
	const files = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
			d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]
		);

	it('only the paket and admin loads use refunds.ts, and the paket load passes locals.user.id only', () => {
		const users = files('src/routes').filter((f) =>
			readFileSync(f, 'utf8').includes('#lib/server/billing/refunds')
		);
		expect(users.sort()).toEqual(
			[
				'src/routes/(app)/pengaturan/paket/+page.server.ts',
				'src/routes/pengaturan/integrasi/admin/+page.server.ts'
			].sort()
		);
		const paket = readFileSync(
			users.find((f) => f.includes('paket'))!,
			'utf8'
		);
		expect(paket.match(/refundsForUser\([^)]*\)/g)).toEqual(['refundsForUser(locals.db, user.id)']);
		expect(paket).toMatch(/const user = locals\.user;/);
		expect(paket).not.toMatch(/recordRefundOutcome/);
		// No route segment names a refund: nothing takes a refund id.
		expect(files('src/routes').filter((f) => /\[[^\]]*refund/i.test(f))).toEqual([]);
	});
});
