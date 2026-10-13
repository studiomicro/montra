import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { getDb, type Db } from '#lib/server/db';
import {
	ACCOUNT_EXPORT_MAX_PER_WINDOW,
	exportAccount,
	spaceFolder
} from '#lib/server/export/account-export';
import { ACCOUNT_JSON_TABLES, SPACE_JSON_TABLES } from '#lib/server/export/tables';
import { TRACK_MAX_PER_WINDOW } from '#lib/server/analytics/track';
import { setBudget } from '#lib/server/budgets/repo';
import { createVoucher, redeemVoucher } from '#lib/server/billing/vouchers';
import { seedDemoConnectedApp } from '#lib/server/connected-apps/repo';
import { addContribution } from '#lib/server/goals/contributions';
import { createGoal } from '#lib/server/goals/repo';
import { createNetWorthItem } from '#lib/server/net-worth/repo';
import { createBalanceAdjustment } from '#lib/server/transactions/adjustment';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet, listWallets } from '#lib/server/wallets/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { wibIsoString } from '#lib/shared/dates';
import { importCsv } from '#lib/server/imports/csv-import';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	listMembers,
	listSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
import { TEMPLATE_COLUMNS } from '#lib/shared/csv';
import { CONSENT_VERSIONS } from '#lib/shared/privacy';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { readZip, textOf } from '../helpers/zip';

const writeDataPoint = vi.fn();
const binding: {
	DB?: D1Database;
	FILES?: R2Bucket;
	STATS?: { writeDataPoint: typeof writeDataPoint };
	CONNECTED_APPS_ENCRYPTION_KEY?: string;
} = {
	STATS: { writeDataPoint }
};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const { handle } = await import('../../src/hooks.server');
const daftar = await import('../../src/routes/(auth)/daftar/+page.server');
const masuk = await import('../../src/routes/(auth)/masuk/+page.server');
const privasi = await import('../../src/routes/(app)/pengaturan/privasi/+page.server');
const privasiEkspor = await import('../../src/routes/(app)/pengaturan/privasi/ekspor/+server');
const ekspor = await import('../../src/routes/(app)/impor/ekspor/+server');
const track = await import('../../src/routes/api/v1/track/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
let files: R2Bucket;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;
const CF = { country: 'ID', city: 'Jakarta', latitude: '-6.2', asn: 7713, colo: 'CGK' };
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/126 Mobile';

beforeAll(async () => {
	let env: { FILES: R2Bucket };
	({ db: d1, dispose, env } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	files = env.FILES;
	binding.FILES = files;
});
afterAll(() => dispose());
beforeEach(() => writeDataPoint.mockClear());

type Handler = (event: never) => unknown;
const action = (actions: unknown, name: string) =>
	(actions as Record<string, Handler>)[name] as Handler;

async function run(fn: () => unknown) {
	try {
		const value = await fn();
		if (isActionFailure(value))
			return {
				kind: 'fail' as const,
				status: value.status,
				data: value.data as unknown as Record<string, unknown>
			};
		return { kind: 'ok' as const, value };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}

let n = 0;
let ip = 0;
const client = () => ({ 'cf-connecting-ip': `198.51.100.${++ip % 250}`, 'user-agent': ANDROID });

async function account(name = 'Uji') {
	const email = `privasi${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: NOW }, scope, token: r.token };
}
type Account = Awaited<ReturnType<typeof account>>;

const HEADER = TEMPLATE_COLUMNS.join(',');
type Row = Partial<Record<(typeof TEMPLATE_COLUMNS)[number], string>>;
const line = (r: Row) => TEMPLATE_COLUMNS.map((c) => r[c] ?? '').join(',');
const templateFile = (rows: Row[]) => [HEADER, ...rows.map(line)].join('\n') + '\n';

async function seed(scope: SpaceScope, rows: Row[]) {
	const r = await importCsv(
		db,
		scope,
		{
			fileText: templateFile(rows.map((row) => ({ wallet_source: 'Tunai', ...row }))),
			filename: 'uji.csv',
			format: null,
			defaultWalletId: null,
			skipPossibleDuplicates: false
		},
		NOW
	);
	expect(r).toMatchObject({ ok: true });
}

const count = async (sql: string, ...binds: unknown[]) =>
	(
		await d1
			.prepare(sql)
			.bind(...binds)
			.first<{ n: number }>()
	)?.n ?? -1;

/** POST /api/v1/track as `who` (or signed out), with or without Cloudflare's `request.cf`. */
async function postTrack(
	who: Account | null,
	form: Record<string, string>,
	opts: { cf?: boolean; headers?: Record<string, string> } = {}
) {
	const { event } = fakeEvent({
		url: 'http://localhost/api/v1/track',
		routeId: '/api/v1/track',
		db,
		user: who?.user ?? null,
		headers: { 'user-agent': ANDROID, ...opts.headers },
		form,
		cf: opts.cf === false ? undefined : CF
	});
	return run(() => track.POST(event as never));
}

/** The account export of `who`, as the route answers it (Response, or a redirect/refusal). */
async function exportVia(who: Account) {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/privasi/ekspor',
		routeId: '/(app)/pengaturan/privasi/ekspor',
		db,
		user: who.user,
		form: {},
		cf: CF
	});
	return run(() => privasiEkspor.POST(event as never));
}

async function exportZip(who: Account) {
	const r = await exportVia(who);
	if (r.kind !== 'ok') throw new Error(`export refused: ${JSON.stringify(r)}`);
	const response = r.value as Response;
	expect(response.headers.get('content-type')).toBe('application/zip');
	expect(response.headers.get('content-disposition')).toMatch(
		/^attachment; filename="montra-ekspor-\d{4}-\d{2}-\d{2}\.zip"$/
	);
	return new Uint8Array(await response.arrayBuffer());
}

/** FN-18's own per-space export endpoint for `who` in `spaceId`, from..to, as bytes. */
async function fn18(who: Account, spaceId: string, from: string, to: string) {
	const { event } = fakeEvent({
		url: `http://localhost/impor/ekspor?from=${from}&to=${to}`,
		routeId: '/(app)/impor/ekspor',
		db,
		user: who.user,
		space: await resolveCurrentSpace(db, who.user.id, spaceId)
	});
	const res = (await ekspor.GET(event as never)) as Response;
	return new Uint8Array(await res.arrayBuffer());
}

const BOM_HEADER = new TextEncoder().encode('﻿' + HEADER + '\r\n');
const withoutHeader = (bytes: Uint8Array) => {
	expect(bytes.subarray(0, BOM_HEADER.length)).toEqual(BOM_HEADER);
	return bytes.subarray(BOM_HEADER.length);
};
const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

async function sharedSpaceWith(owner: Account, member: Account, name = 'Keluarga') {
	const spaceId = (await createSharedSpace(db, owner.user.id, name, NOW))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
	await acceptInvite(db, invite.token, member.user.id, NOW);
	return spaceId;
}

async function removeFrom(owner: Account, spaceId: string) {
	const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
	await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
}

// ---- Consent records -------------------------------------------------------------------------------

describe('consent records (FN-31 criterion 4, 9)', () => {
	it('sign-up writes exactly three rows, one per kind, with the current version, in the account batch', async () => {
		const a = await account();
		const { results } = await d1
			.prepare(
				'select kind, version, accepted_at from consent_records where user_id = ? order by kind'
			)
			.bind(a.user.id)
			.all<{ kind: string; version: string; accepted_at: number }>();
		expect(results).toEqual([
			{
				kind: 'cross_border_notice',
				version: CONSENT_VERSIONS.cross_border_notice,
				accepted_at: NOW
			},
			{ kind: 'privacy_policy', version: CONSENT_VERSIONS.privacy_policy, accepted_at: NOW },
			{ kind: 'terms', version: CONSENT_VERSIONS.terms, accepted_at: NOW }
		]);
		// A failing batch (the e-mail is taken) leaves no consent row behind.
		const before = await count('select count(*) as n from consent_records');
		const again = await signUp(
			db,
			{
				name: 'X',
				email: a.user.email,
				password: PASSWORD,
				adultConfirmed: true,
				consentAccepted: true
			},
			NOW
		);
		expect(again.ok).toBe(false);
		expect(await count('select count(*) as n from consent_records')).toBe(before);
	});

	it('/daftar without the consent box is refused like the 18+ box, and writes nothing', async () => {
		const users = await count('select count(*) as n from users');
		const consents = await count('select count(*) as n from consent_records');
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: { name: 'Budi', email: 'tanpa-setuju@contoh.id', password: PASSWORD, adult: 'on' }
		});
		const r = await run(() => action(daftar.actions, 'default')(event as never));
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				errors: {
					consent: 'Centang persetujuan ketentuan dan kebijakan privasi untuk melanjutkan.'
				},
				values: { consent: false, adult: true }
			}
		});
		expect(await count('select count(*) as n from users')).toBe(users);
		expect(await count('select count(*) as n from consent_records')).toBe(consents);
	});

	it('is append-only: an UPDATE is refused by the database, a newer version is a new row', async () => {
		const a = await account();
		await expect(
			d1
				.prepare(`update consent_records set version = '2099-01-01' where user_id = ?`)
				.bind(a.user.id)
				.run()
		).rejects.toThrow(/append-only/);
		await expect(
			d1
				.prepare(`update consent_records set accepted_at = 0 where user_id = ?`)
				.bind(a.user.id)
				.run()
		).rejects.toThrow(/append-only/);
		expect(
			await count(
				`select count(*) as n from consent_records where user_id = ? and accepted_at = ?`,
				a.user.id,
				NOW
			)
		).toBe(3);
	});

	it('account deletion removes the consent records and the statistics switch with the account', async () => {
		const a = await account();
		const b = await account();
		await privasiSetStats(a, false);
		await privasiSetStats(b, false);
		const hash = (await d1
			.prepare('select hash from user_passwords where user_id = ?')
			.bind(a.user.id)
			.first<{ hash: string }>())!.hash;
		expect(await deleteAccount(db, a.user.id, hash, NOW)).toBe(true);
		expect(
			await count('select count(*) as n from consent_records where user_id = ?', a.user.id)
		).toBe(0);
		expect(
			await count('select count(*) as n from usage_stats_prefs where user_id = ?', a.user.id)
		).toBe(0);
		// The other account keeps its own.
		expect(
			await count('select count(*) as n from consent_records where user_id = ?', b.user.id)
		).toBe(3);
		expect(
			await count('select count(*) as n from usage_stats_prefs where user_id = ?', b.user.id)
		).toBe(1);
	});
});

// ---- Usage statistics ----------------------------------------------------------------------------

async function privasiSetStats(who: Account, enabled: boolean) {
	const { event } = fakeEvent({
		url: 'http://localhost/pengaturan/privasi?/setStats',
		routeId: '/(app)/pengaturan/privasi',
		db,
		user: who.user,
		form: enabled ? { enabled: 'on' } : {}
	});
	return run(() => action(privasi.actions, 'setStats')(event as never));
}

async function privasiLoad(who: Account, query = '') {
	const { event } = fakeEvent({
		url: `http://localhost/pengaturan/privasi${query}`,
		routeId: '/(app)/pengaturan/privasi',
		db,
		user: who.user
	});
	const r = await run(() => (privasi.load as Handler)(event as never));
	if (r.kind !== 'ok') throw new Error('load failed');
	return r.value as {
		statsEnabled: boolean;
		consent: { kind: string; version: string; acceptedAt: number }[];
		exportError: string | null;
		siteOrigin: string | null;
		loadError: string | null;
	};
}

const writtenBlobs = () =>
	writeDataPoint.mock.calls.map((c) => (c[0] as AnalyticsEngineDataPoint).blobs);

describe('usage statistics (FN-31 criteria 1-3; ACCEPTANCE "Usage statistics hold no account id …")', () => {
	it('a tracked navigation writes exactly one data point with only the five blobs', async () => {
		const a = await account();
		const r = await postTrack(a, { screen: 'riwayat', action: 'view' });
		expect(r.kind).toBe('ok');
		expect((r.value as Response).status).toBe(200);
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
		const [point] = writeDataPoint.mock.calls[0] as [AnalyticsEngineDataPoint];
		expect(point).toEqual({ blobs: ['riwayat', 'view', 'android', 'id', 'ID'] });
		// None of the banned values is anywhere in what was written.
		const text = JSON.stringify(writeDataPoint.mock.calls);
		for (const banned of [
			a.user.id,
			a.user.email,
			a.scope.spaceId,
			a.token,
			'Jakarta',
			'7713',
			'CGK'
		])
			expect(text).not.toContain(banned);
	});

	it('per-user rate limit: past the window budget the beacon still answers 200 and writes nothing (FN-31 red team L3)', async () => {
		const now = vi.spyOn(Date, 'now').mockReturnValue(NOW + 3 * 60 * 1000);
		try {
			const a = await account();
			const b = await account();
			for (let i = 0; i < TRACK_MAX_PER_WINDOW; i++)
				await postTrack(a, { screen: 'beranda', action: 'view' });
			expect(writeDataPoint).toHaveBeenCalledTimes(TRACK_MAX_PER_WINDOW);
			const over = await postTrack(a, { screen: 'beranda', action: 'view' });
			expect(over.kind).toBe('ok');
			expect((over.value as Response).status).toBe(200);
			expect(writeDataPoint).toHaveBeenCalledTimes(TRACK_MAX_PER_WINDOW);
			// Per user: another account still counts.
			await postTrack(b, { screen: 'beranda', action: 'view' });
			expect(writeDataPoint).toHaveBeenCalledTimes(TRACK_MAX_PER_WINDOW + 1);
		} finally {
			now.mockRestore();
		}
	});

	it('opted out: the switch persists, /api/v1/track answers 200 and writes nothing; back on, it counts again', async () => {
		const a = await account();
		expect((await privasiLoad(a)).statsEnabled).toBe(true);
		expect(await privasiSetStats(a, false)).toMatchObject({
			kind: 'ok',
			value: { savedStats: true, enabled: false }
		});
		// A reload reads the stored value.
		expect((await privasiLoad(a)).statsEnabled).toBe(false);
		for (const screen of [
			'beranda',
			'riwayat',
			'laporan',
			'kekayaan',
			'dompet',
			'anggaran',
			'tambah',
			'privasi'
		]) {
			const r = await postTrack(a, { screen, action: screen === 'tambah' ? 'open' : 'view' });
			expect((r.value as Response).status).toBe(200);
		}
		expect(writeDataPoint).not.toHaveBeenCalled();
		// The opt-out holds on every server-side call site too: sign-in and the export.
		const { event } = fakeEvent({
			url: 'http://localhost/masuk',
			routeId: '/(auth)/masuk',
			db,
			headers: client(),
			form: { email: a.user.email, password: PASSWORD },
			cf: CF
		});
		expect((await run(() => action(masuk.actions, 'password')(event as never))).kind).toBe(
			'redirect'
		);
		await exportZip(a);
		expect(writeDataPoint).not.toHaveBeenCalled();

		await privasiSetStats(a, true);
		await postTrack(a, { screen: 'beranda', action: 'view' });
		expect(writeDataPoint).toHaveBeenCalledTimes(1);
	});

	it('counts sign-up, sign-in and the export for an account that keeps statistics on', async () => {
		const email = `daftar-stat${++n}@contoh.id`;
		const { event } = fakeEvent({
			url: 'http://localhost/daftar',
			routeId: '/(auth)/daftar',
			db,
			headers: client(),
			form: { name: 'Budi', email, password: PASSWORD, adult: 'on', consent: 'on' },
			cf: CF
		});
		expect((await run(() => action(daftar.actions, 'default')(event as never))).kind).toBe(
			'redirect'
		);
		const { event: signIn } = fakeEvent({
			url: 'http://localhost/masuk',
			routeId: '/(auth)/masuk',
			db,
			headers: client(),
			form: { email, password: PASSWORD },
			cf: CF
		});
		expect((await run(() => action(masuk.actions, 'password')(signIn as never))).kind).toBe(
			'redirect'
		);
		expect(writtenBlobs()).toEqual([
			['daftar', 'sign_up', 'android', 'id', 'ID'],
			['masuk', 'sign_in', 'android', 'id', 'ID']
		]);
		expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain(email);
	});

	it('writes nothing signed out, without request.cf (local dev) or without the STATS binding', async () => {
		const a = await account();
		expect(
			((await postTrack(null, { screen: 'beranda', action: 'view' })).value as Response).status
		).toBe(200);
		expect(
			((await postTrack(a, { screen: 'beranda', action: 'view' }, { cf: false })).value as Response)
				.status
		).toBe(200);
		const stats = binding.STATS;
		delete binding.STATS;
		try {
			expect(
				((await postTrack(a, { screen: 'beranda', action: 'view' })).value as Response).status
			).toBe(200);
		} finally {
			binding.STATS = stats;
		}
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it('refuses names outside the vocabulary, oversized and non-form bodies, before any write', async () => {
		const a = await account();
		for (const form of [
			{ screen: 'Kopi Kenangan Rp 28.000', action: 'view' },
			{ screen: 'beranda', action: 'budi@contoh.id' },
			{ screen: 'beranda' },
			{ screen: 'constructor', action: 'view' },
			{ screen: 'beranda', action: 'view', note: 'x'.repeat(400) }
		])
			expect(await postTrack(a, form as Record<string, string>)).toMatchObject({
				kind: 'error',
				status: 400
			});
		const { event } = fakeEvent({
			url: 'http://localhost/api/v1/track',
			routeId: '/api/v1/track',
			db,
			user: a.user,
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			cf: CF
		});
		expect(await run(() => track.POST(event as never))).toMatchObject({
			kind: 'error',
			status: 415
		});
		expect(writeDataPoint).not.toHaveBeenCalled();
	});
});

// ---- /pengaturan/privasi -------------------------------------------------------------------------

describe('/pengaturan/privasi', () => {
	it('shows the stored consent; an account from before FN-31 shows the empty state', async () => {
		const a = await account();
		const page = await privasiLoad(a);
		expect(page.loadError).toBeNull();
		expect(page.consent.map((c) => [c.kind, c.version, c.acceptedAt]).sort()).toEqual(
			[
				['cross_border_notice', CONSENT_VERSIONS.cross_border_notice, NOW],
				['privacy_policy', CONSENT_VERSIONS.privacy_policy, NOW],
				['terms', CONSENT_VERSIONS.terms, NOW]
			].sort()
		);
		expect(page.siteOrigin).toBe('http://site.localhost');
		// An older account: no consent rows (deleting is what account deletion does; used here to model it).
		await d1.prepare('delete from consent_records where user_id = ?').bind(a.user.id).run();
		expect((await privasiLoad(a)).consent).toEqual([]);
	});

	it('reads only the signed-in account: another account’s switch and consent never show', async () => {
		const a = await account();
		const b = await account();
		await privasiSetStats(b, false);
		expect((await privasiLoad(a)).statsEnabled).toBe(true);
		await d1.prepare('delete from consent_records where user_id = ?').bind(a.user.id).run();
		expect((await privasiLoad(a)).consent).toEqual([]);
		expect((await privasiLoad(b)).consent).toHaveLength(3);
	});

	it('maps only known export refusal codes to a message', async () => {
		const a = await account();
		expect((await privasiLoad(a, '?ekspor=terlalu-sering')).exportError).toBe(
			'Ekspor sudah diminta beberapa kali barusan. Tunggu 10 menit, lalu coba lagi.'
		);
		expect((await privasiLoad(a, '?ekspor=%3Cscript%3E')).exportError).toBeNull();
	});

	it('the export refuses a signed-out request (route protection)', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/pengaturan/privasi/ekspor',
			routeId: '/(app)/pengaturan/privasi/ekspor',
			db,
			headers: { origin: 'http://localhost' },
			form: {}
		});
		const res = await handle({ event, resolve: () => new Response('leaked') } as never);
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain('leaked');
	});
});

// ---- Full-account export -------------------------------------------------------------------------

describe('full-account export (FN-31 criteria 6-8, ruling R21)', () => {
	const csvNames = (files: Map<string, Uint8Array>) =>
		[...files.keys()].filter((k) => k.startsWith('transactions-'));
	const folderOf = async (who: Account, spaceId: string) =>
		spaceFolder((await listSpaces(db, who.user.id)).find((s) => s.id === spaceId)!);
	const jsonOf = (files: Map<string, Uint8Array>, name: string) => {
		const bytes = files.get(name);
		if (!bytes) throw new Error(`missing ${name}`);
		return JSON.parse(textOf(bytes));
	};

	it('one CSV per live space, byte-identical to FN-18’s own export, plus account.json', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota');
		await seed(owner.scope, [
			{
				date: '2026-10-01',
				type: 'expense',
				merchant: 'Kopi',
				amount: '28000',
				reference: '1234567890123'
			},
			{ date: '2026-02-14', type: 'income', merchant: 'Gaji', amount: '1250000' },
			{ date: '2025-12-31', type: 'expense', merchant: 'Tahun lalu', amount: '5000' }
		]);
		const shared = await sharedSpaceWith(owner, member, 'Rumah 1234567890');
		await seed({ spaceId: shared, userId: owner.user.id }, [
			{ date: '2026-03-03', type: 'expense', merchant: 'Listrik', amount: '350000' }
		]);
		await seed(member.scope, [
			{ date: '2026-05-05', type: 'expense', merchant: 'Pribadi anggota', amount: '1000' }
		]);

		const files = readZip(await exportZip(owner));
		expect(csvNames(files)).toEqual([
			'transactions-01-pribadi.csv',
			'transactions-02-rumah-1234567890.csv'
		]);
		// One year of data: exactly FN-18's bytes for that year.
		expect(files.get('transactions-02-rumah-1234567890.csv')).toEqual(
			await fn18(owner, shared, '2026-01-01', '2026-12-31')
		);
		// Several years: FN-18's header, then each year's rows, newest year first.
		const y2026 = await fn18(owner, owner.scope.spaceId, '2026-01-01', '2026-12-31');
		const y2025 = await fn18(owner, owner.scope.spaceId, '2025-01-01', '2025-12-31');
		expect(files.get('transactions-01-pribadi.csv')).toEqual(concat(y2026, withoutHeader(y2025)));
		const personal = textOf(files.get('transactions-01-pribadi.csv'));
		expect(personal).toContain('Tahun lalu');
		expect(personal).not.toContain('Pribadi anggota');
		// Account and card numbers stay masked to the last 4 digits.
		expect(personal).not.toContain('1234567890123');
		expect(personal).toContain('0123');

		const json = jsonOf(files, 'account.json');
		expect(json.account).toMatchObject({ name: 'Pemilik', email: owner.user.email });
		expect(json.account.createdAt).toMatch(/\+07:00$/);
		expect(jsonOf(files, 'account/consent_records.json')).toHaveLength(3);
		expect(
			json.spaces.map((s: { transactionsFile: string; role: string }) => [
				s.transactionsFile,
				s.role
			])
		).toEqual([
			['transactions-01-pribadi.csv', 'owner'],
			['transactions-02-rumah-1234567890.csv', 'owner']
		]);
		expect(json.spaces[1].name).toBe('Rumah ••••7890');
		const space = jsonOf(files, `${await folderOf(owner, shared)}/space.json`);
		expect(space).toEqual({
			kind: 'shared',
			name: 'Rumah ••••7890',
			role: 'owner',
			members: [
				{ name: 'Pemilik', role: 'owner', isYou: true },
				{ name: 'Anggota', role: 'member', isYou: false }
			]
		});
	});

	it('every table with an export decision has its file; rows are the app’s view (WIB, minor units, masked)', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota');
		const shared = await sharedSpaceWith(owner, member);
		await seed(owner.scope, [
			{ date: '2026-10-01', type: 'expense', merchant: 'Kopi', amount: '28000' }
		]);
		const goal = await createGoal(
			db,
			owner.scope,
			{ name: 'Dana darurat', targetAmountMinor: 10_000_000 },
			NOW
		);
		if (!goal.ok) throw new Error('goal');
		await addContribution(
			db,
			owner.scope,
			goal.id,
			{ amountMinor: 250_000, note: 'Gaji 1234567890' },
			NOW
		);
		await setBudget(db, owner.scope, { amountMinor: 5_000_000, currency: 'IDR' }, null, NOW);
		const item = await createNetWorthItem(
			db,
			owner.scope,
			{
				kind: 'property',
				name: 'Rumah',
				currency: 'IDR',
				priceSource: 'manual',
				priceSymbol: null,
				quantityScaled: null,
				quantityScale: null,
				manualValueMinor: 500_000_000_00,
				acquiredOn: '2020-01-15',
				note: null
			},
			NOW
		);
		expect(item.ok).toBe(true);
		await d1
			.prepare(
				`insert into space_notifications (id, space_id, user_id, kind, data_key, params, created_at, updated_at, seq)
				values ('n-own-' || ?2, ?1, ?2, 'budget_80', 'budget:x:2026-10:80', '{"pct":80}', ?3, ?3, 0),
					('n-other-' || ?2, ?1, ?4, 'budget_80', 'budget:y:2026-10:80', '{"pct":81}', ?3, ?3, 0)`
			)
			.bind(shared, owner.user.id, NOW, member.user.id)
			.run();

		const files = readZip(await exportZip(owner));
		for (const folder of [
			await folderOf(owner, owner.scope.spaceId),
			await folderOf(owner, shared)
		]) {
			expect(files.has(`${folder}/space.json`)).toBe(true);
			for (const p of SPACE_JSON_TABLES)
				expect(files.has(`${folder}/${p.table}.json`), p.table).toBe(true);
		}
		for (const p of ACCOUNT_JSON_TABLES)
			expect(files.has(`account/${p.table}.json`), p.table).toBe(true);

		const personal = await folderOf(owner, owner.scope.spaceId);
		const goals = jsonOf(files, `${personal}/goals.json`);
		expect(goals).toEqual([
			expect.objectContaining({
				name: 'Dana darurat',
				targetAmountMinor: 10_000_000,
				currency: 'IDR'
			})
		]);
		expect(goals[0].createdAt).toBe(wibIsoString(NOW));
		const contributions = jsonOf(files, `${personal}/goal_contributions.json`);
		expect(contributions[0]).toMatchObject({ amountMinor: 250_000, note: 'Gaji ••••7890' });
		expect(contributions[0]).not.toHaveProperty('createdByUserId');
		expect(jsonOf(files, `${personal}/budgets.json`)).toEqual([
			expect.objectContaining({ amountMinor: 5_000_000, currency: 'IDR' })
		]);
		expect(jsonOf(files, `${personal}/net_worth_items.json`)).toHaveLength(1);
		expect(jsonOf(files, `${personal}/wallets.json`)[0]).toMatchObject({
			name: 'Tunai',
			isFavourite: expect.any(Boolean)
		});
		expect(jsonOf(files, `${personal}/categories.json`).length).toBeGreaterThan(0);
		expect(jsonOf(files, `${personal}/import_batches.json`)).toHaveLength(1);
		// Notifications: only the ones addressed to the exporting member.
		const notes = jsonOf(files, `${await folderOf(owner, shared)}/space_notifications.json`);
		expect(notes).toEqual([expect.objectContaining({ kind: 'budget_80', params: '{"pct":80}' })]);
		expect(notes[0]).not.toHaveProperty('userId');
		expect(notes[0]).not.toHaveProperty('dataKey');
		// No row ever carries its space id or sync bookkeeping.
		for (const [name, bytes] of files)
			if (name.endsWith('.json') && name.startsWith('spaces/'))
				for (const row of [JSON.parse(textOf(bytes))].flat())
					for (const k of ['spaceId', 'seq', 'deletedAt', 'photoKey'])
						expect(row, `${name}`).not.toHaveProperty(k);
	});

	it('no token, hash, salt, nonce, key or push-endpoint material anywhere in the archive', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota Rahasia');
		const shared = await sharedSpaceWith(owner, member);
		// The live invite link (its token hash must not leave), an account key, a push subscription and a
		// connected app with a sealed token.
		await d1
			.prepare(
				`insert into account_keys (id, user_id, public_key, wrapped_private_key, wrap_nonce, kdf_salt,
					kdf_params, key_check_hash, created_at, updated_at)
				values ('k-' || ?1, ?1, 'PUBKEYVALUE', 'WRAPPEDVALUE', 'NONCEVALUE', 'SALTVALUE', 'PARAMS',
					'KEYCHECKVALUE', 0, 0)`
			)
			.bind(owner.user.id)
			.run();
		const session = (await d1
			.prepare('select id, token_hash from sessions where user_id = ?')
			.bind(owner.user.id)
			.first<{ id: string; token_hash: string }>())!;
		await d1
			.prepare(
				`insert into push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, user_agent,
					created_at, updated_at)
				values ('p-' || ?1, ?1, ?2, 'https://fcm.googleapis.com/fcm/send/ENDPOINTSECRET', 'P256DHSECRET',
					'AUTHSECRET', 'Pixel 7', ?3, ?3)`
			)
			.bind(owner.user.id, session.id, NOW)
			.run();
		binding.CONNECTED_APPS_ENCRYPTION_KEY = base64urlEncode(new Uint8Array(32).fill(7));
		expect(await seedDemoConnectedApp(db, owner.scope, binding, 'slack', NOW)).not.toBe(
			'not_configured'
		);
		const app = (await d1
			.prepare(
				'select encrypted_token, token_nonce, token_key_id from connected_apps where space_id = ?'
			)
			.bind(owner.scope.spaceId)
			.first<{ encrypted_token: string; token_nonce: string; token_key_id: string }>())!;
		const secrets = (await d1
			.prepare('select hash, salt from user_passwords where user_id = ?')
			.bind(owner.user.id)
			.first<{ hash: string; salt: string }>())!;
		const inviteHash = (await d1
			.prepare('select token_hash from space_invites where space_id = ?')
			.bind(shared)
			.first<{ token_hash: string }>())!.token_hash;

		const files = readZip(await exportZip(owner));
		const all = [...files.values()].map(textOf).join('\n');
		for (const value of [
			secrets.hash,
			secrets.salt,
			session.token_hash,
			owner.token,
			inviteHash,
			'PUBKEYVALUE',
			'WRAPPEDVALUE',
			'NONCEVALUE',
			'SALTVALUE',
			'KEYCHECKVALUE',
			'ENDPOINTSECRET',
			'P256DHSECRET',
			'AUTHSECRET',
			app.encrypted_token,
			app.token_nonce,
			app.token_key_id,
			PASSWORD,
			member.user.email
		])
			expect(all, value).not.toContain(value);
		const keys = new Set<string>();
		const walk = (v: unknown) => {
			if (v && typeof v === 'object')
				for (const [k, child] of Object.entries(v)) {
					keys.add(k);
					walk(child);
				}
		};
		for (const [name, bytes] of files) if (name.endsWith('.json')) walk(JSON.parse(textOf(bytes)));
		for (const k of keys)
			expect(k, k).not.toMatch(
				/hash|salt|token|password|wrapped|kdf|nonce|secret|endpoint|p256dh|^auth$|keyId|dedupe|dataKey/i
			);
		// What is there: the connected app (label only), the device, the session without its hash.
		expect(
			jsonOf(files, `${await folderOf(owner, owner.scope.spaceId)}/connected_apps.json`)
		).toEqual([expect.objectContaining({ provider: 'slack', status: 'connected' })]);
		expect(jsonOf(files, 'account/push_subscriptions.json')).toEqual([
			expect.objectContaining({ userAgent: 'Pixel 7' })
		]);
		expect(jsonOf(files, 'account/sessions.json')).toHaveLength(1);
		expect(jsonOf(files, 'account.json').accountKey).toEqual({ present: true });
		expect(
			jsonOf(files, 'account.json').notIncluded.map((n: { table: string }) => n.table)
		).toEqual(expect.arrayContaining(['user_passwords', 'space_invites', 'audit_events']));
	});

	it('transactions.json holds every row the user owns: transfers and balance adjustments too (FN-37)', async () => {
		const owner = await account('Pemilik');
		await seed(owner.scope, [
			{ date: '2026-10-01', type: 'expense', merchant: 'Kopi', amount: '28000' },
			{ date: '2026-10-01', type: 'income', merchant: 'Gaji', amount: '5000000' }
		]);
		const [tunai] = await listWallets(db, owner.scope.spaceId);
		const other = await createWallet(
			db,
			owner.scope,
			{
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!other.ok) throw new Error('wallet failed');
		const moved = await createTransaction(
			db,
			owner.scope,
			{
				type: 'transfer',
				amountMinor: 500_000,
				currency: 'IDR',
				walletId: tunai!.id,
				transferToWalletId: other.id,
				categoryId: null,
				title: 'Setor ke rek 1234567890123',
				note: null,
				occurredOn: '2026-10-02',
				occurredTime: null
			},
			NOW
		);
		expect(moved.ok).toBe(true);
		const adjusted = await createBalanceAdjustment(
			db,
			owner.scope,
			{
				walletId: other.id,
				balance: '7.000',
				negative: false,
				locale: 'id' as const,
				title: 'Cocokkan saldo',
				note: null,
				occurredOn: '2026-10-03',
				occurredTime: null
			},
			NOW
		);
		expect(adjusted.ok).toBe(true);

		const files = readZip(await exportZip(owner));
		const all = jsonOf(files, `${await folderOf(owner, owner.scope.spaceId)}/transactions.json`);
		expect(all.map((r: { type: string }) => r.type).sort()).toEqual([
			'adjustment',
			'expense',
			'income',
			'transfer'
		]);
		const income = all.find((r: { type: string }) => r.type === 'income');
		expect(income).toMatchObject({ amountMinor: 500_000_000, currency: 'IDR' });
		const transfer = all.find((r: { type: string }) => r.type === 'transfer');
		expect(transfer).toMatchObject({ amountMinor: 500_000, transferToWalletId: other.id });
		expect(transfer.title).not.toContain('1234567890123');
		expect(transfer.title).toContain('0123');
		expect(all.find((r: { type: string }) => r.type === 'adjustment')).toMatchObject({
			amountMinor: 200_000,
			adjustmentDirection: 'increase',
			title: 'Cocokkan saldo',
			occurredOn: '2026-10-03'
		});
		for (const row of all) expect(Object.keys(row)).not.toContain('dedupeKey');
		// The FN-18 CSV beside it stays expense/income only, as its import template defines.
		const csv = textOf(files.get('transactions-01-pribadi.csv'));
		expect(csv).toContain('Kopi');
		expect(csv).toContain('Gaji');
		expect(csv).not.toContain('Cocokkan saldo');
		expect(csv).not.toContain('Setor ke rek');
		expect(
			jsonOf(files, 'account.json').notIncluded.map((n: { table: string }) => n.table)
		).not.toContain('transactions');
	});

	it('transactions.json leaves out "Data demo" rows, like the CSV beside it (FN-37 red team low)', async () => {
		const owner = await account('Pemilik');
		await seed(owner.scope, [
			{ date: '2026-10-01', type: 'expense', merchant: 'Kopi asli', amount: '28000' },
			{ date: '2026-10-01', type: 'expense', merchant: 'Kopi demo', amount: '15000' }
		]);
		await d1
			.prepare(`update transactions set is_demo = 1 where space_id = ? and title = 'Kopi demo'`)
			.bind(owner.scope.spaceId)
			.run();
		const files = readZip(await exportZip(owner));
		const all = jsonOf(files, `${await folderOf(owner, owner.scope.spaceId)}/transactions.json`);
		expect(all.map((r: { title: string }) => r.title)).toEqual(['Kopi asli']);
		expect(textOf(files.get('transactions-01-pribadi.csv'))).not.toContain('Kopi demo');
	});

	it('photos are files in the ZIP (streamed from R2), refused over the byte cap, listed with a note without R2', async () => {
		const owner = await account('Pemilik');
		const photo = new Uint8Array(70_000).map((_, i) => (i * 31) % 251);
		const belongingKey = `p/${owner.scope.spaceId}/belongings/b1`;
		const collectibleKey = `p/${owner.scope.spaceId}/collectibles/c1`;
		await files.put(belongingKey, photo);
		await files.put(collectibleKey, photo.subarray(0, 1000));
		await d1
			.prepare(
				`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
					photo_key, photo_type, created_at, updated_at, seq)
				values ('b1-' || ?1, ?1, 'Laptop', 15000000, 'IDR', '2025-01-02', ?2, 'image/jpeg', ?3, ?3, 0),
					('b2-' || ?1, ?1, 'Tanpa foto', 1000, 'IDR', '2025-01-02', null, null, ?3, ?3, 0),
					('b3-' || ?1, ?1, 'Foto hilang', 1000, 'IDR', '2025-01-02', ?4, 'image/png', ?3, ?3, 0)`
			)
			.bind(owner.scope.spaceId, belongingKey, NOW, `p/${owner.scope.spaceId}/belongings/gone`)
			.run();
		await d1
			.prepare(
				`insert into collectibles (id, space_id, name, purchase_price_minor, currency, purchased_on,
					manual_value_minor, photo_key, photo_type, created_at, updated_at, seq)
				values ('c1-' || ?1, ?1, 'Kartu', 50000, 'IDR', '2024-05-06', 90000, ?2, 'image/webp', ?3, ?3, 0)`
			)
			.bind(owner.scope.spaceId, collectibleKey, NOW)
			.run();

		const zip = readZip(await exportZip(owner));
		const folder = await folderOf(owner, owner.scope.spaceId);
		const b1 = `photos/belongings/b1-${owner.scope.spaceId}.jpg`;
		const c1 = `photos/collectibles/c1-${owner.scope.spaceId}.webp`;
		expect(zip.get(b1)).toEqual(photo);
		expect(zip.get(c1)).toEqual(photo.subarray(0, 1000));
		const rows = jsonOf(zip, `${folder}/belongings.json`);
		expect(rows.find((r: { name: string }) => r.name === 'Laptop')).toMatchObject({ photo: b1 });
		expect(rows.find((r: { name: string }) => r.name === 'Tanpa foto')).toMatchObject({
			photo: null
		});
		expect(rows.find((r: { name: string }) => r.name === 'Foto hilang')).toMatchObject({
			photo: null,
			photoNote: expect.stringContaining('not found')
		});
		expect(jsonOf(zip, `${folder}/collectibles.json`)[0]).toMatchObject({ photo: c1 });
		expect(jsonOf(zip, 'account.json').photos).toEqual({ included: 2, notIncluded: 1 });

		// Over the cap: refused before anything streams, never a cut archive.
		expect(await exportAccount(db, owner.user.id, { files, maxPhotoBytes: 70_999 })).toEqual({
			ok: false,
			reason: 'photos_too_large'
		});
		expect((await exportAccount(db, owner.user.id, { files, maxPhotoBytes: 71_000 })).ok).toBe(
			true
		);
		// Without R2: the rows list each photo with a note, no photo file is written.
		const without = await exportAccount(db, owner.user.id);
		if (!without.ok) throw new Error('refused');
		const listed = readZip(new Uint8Array(await new Response(without.stream).arrayBuffer()));
		expect([...listed.keys()].filter((k) => k.startsWith('photos/'))).toEqual([]);
		expect(jsonOf(listed, `${folder}/belongings.json`)[0]).toMatchObject({
			photo: null,
			photoNote: expect.stringContaining('not available')
		});
	});

	it('memory stays bounded with photos: R2 is read at most one chunk ahead of the download (4 × 64 MiB)', async () => {
		const owner = await account('Pemilik');
		const MiB = 1024 * 1024;
		const CHUNK = 256 * 1024;
		const SIZE = 64 * MiB;
		const keys = Array.from({ length: 4 }, (_, i) => `p/${owner.scope.spaceId}/belongings/big${i}`);
		for (const [i, key] of keys.entries())
			await d1
				.prepare(
					`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
						photo_key, photo_type, created_at, updated_at, seq)
					values (?1, ?2, 'Besar', 1000, 'IDR', '2025-01-02', ?3, 'image/png', ?4, ?4, 0)`
				)
				.bind(`big${i}-${owner.scope.spaceId}`, owner.scope.spaceId, key, NOW)
				.run();
		// A stand-in bucket whose objects are produced chunk by chunk as they are read, never held whole:
		// `produced - consumed` is exactly what the export holds of the photos at any moment.
		let produced = 0;
		const bucket = {
			head: async (key: string) => (keys.includes(key) ? { size: SIZE } : null),
			get: async (key: string) => {
				if (!keys.includes(key)) return null;
				let sent = 0;
				return {
					size: SIZE,
					body: new ReadableStream<Uint8Array>(
						{
							pull(c) {
								if (sent === SIZE) return c.close();
								sent += CHUNK;
								produced += CHUNK;
								c.enqueue(new Uint8Array(CHUNK).fill(65));
							}
						},
						{ highWaterMark: 0 }
					)
				};
			}
		} as unknown as R2Bucket;
		const result = await exportAccount(db, owner.user.id, { files: bucket });
		if (!result.ok) throw new Error('refused');
		let consumed = 0;
		let ahead = 0;
		const reader = result.stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.length === CHUNK && value[0] === 65) consumed += CHUNK;
			ahead = Math.max(ahead, produced - consumed);
		}
		expect(produced).toBe(4 * SIZE);
		expect(consumed).toBe(4 * SIZE);
		// 256 MiB of photos passed through; never more than one chunk was read ahead of the download.
		expect(ahead).toBeLessThanOrEqual(CHUNK);
	}, 120_000);

	it('carries the user’s plan, credit history and redeemed vouchers (FN-30), never the code hash or another account’s rows', async () => {
		const owner = await account('Pemilik');
		const other = await account('Lain');
		const voucher = await createVoucher(
			db,
			{ kind: 'credits', creditsAmount: 500, maxRedemptions: 5 },
			NOW
		);
		expect((await redeemVoucher(db, owner.user.id, voucher.code, NOW + 1000)).ok).toBe(true);
		expect((await redeemVoucher(db, other.user.id, voucher.code, NOW + 2000)).ok).toBe(true);

		const files = readZip(await exportZip(owner));
		expect(jsonOf(files, 'account/user_plan_state.json')).toMatchObject([{ plan: 'gratis' }]);
		const ledger = jsonOf(files, 'account/credit_ledger.json') as {
			delta: number;
			reason: string;
		}[];
		expect(ledger.map((r) => [r.reason, r.delta]).sort()).toEqual([
			['starter_grant', 300],
			['voucher_redeemed', 500]
		]);
		expect(jsonOf(files, 'account/voucher_redemptions.json')).toHaveLength(1);
		expect(jsonOf(files, 'account/billing_events.json')).toEqual([]);
		expect(jsonOf(files, 'account/plan_changes.json')).toEqual([]);
		expect(files.has('account/vouchers.json')).toBe(false);
		const codeHash = (await d1
			.prepare('select code_hash from vouchers where id = ?')
			.bind(voucher.id)
			.first<{ code_hash: string }>())!.code_hash;
		for (const [name, bytes] of files) {
			const text = textOf(bytes);
			expect(text, name).not.toContain(codeHash);
			expect(text, name).not.toContain(voucher.code);
			expect(text, name).not.toContain(other.user.id);
		}
	});

	it('never a space the user left or was removed from, never another account’s space', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota');
		await seed(owner.scope, [
			{ date: '2026-10-01', type: 'expense', merchant: 'Milik pemilik', amount: '1000' }
		]);
		const shared = await sharedSpaceWith(owner, member);
		await seed({ spaceId: shared, userId: owner.user.id }, [
			{ date: '2026-10-02', type: 'expense', merchant: 'Bersama', amount: '2000' }
		]);
		const sharedFolder = await folderOf(member, shared);
		// While a member: the shared space is in, as FN-18 shows it to the member.
		const before = readZip(await exportZip(member));
		expect(csvNames(before)).toEqual([
			'transactions-01-pribadi.csv',
			'transactions-02-keluarga.csv'
		]);
		expect(before.get('transactions-02-keluarga.csv')).toEqual(
			await fn18(member, shared, '2026-01-01', '2026-12-31')
		);
		expect(jsonOf(before, `${sharedFolder}/wallets.json`)).toHaveLength(1);
		// Removed: the former space is gone from the export, files and all.
		await removeFrom(owner, shared);
		const after = readZip(await exportZip(member));
		expect(csvNames(after)).toEqual(['transactions-01-pribadi.csv']);
		expect([...after.keys()].filter((k) => k.startsWith(sharedFolder))).toEqual([]);
		const all = [...after.values()].map(textOf).join('\n');
		expect(all).not.toContain('Bersama');
		expect(all).not.toContain('Milik pemilik');
		expect(all).not.toContain(shared);
	});

	it('a removal while the download runs ends that space’s rows (membership re-checked per page)', async () => {
		const owner = await account('Pemilik');
		const member = await account('Anggota');
		const shared = await sharedSpaceWith(owner, member);
		await seed({ spaceId: shared, userId: owner.user.id }, [
			{ date: '2026-10-02', type: 'expense', merchant: 'Bersama', amount: '2000' }
		]);
		const folder = await folderOf(member, shared);
		const result = await exportAccount(db, member.user.id);
		if (!result.ok) throw new Error('refused');
		await removeFrom(owner, shared);
		const files = readZip(new Uint8Array(await new Response(result.stream).arrayBuffer()));
		expect(textOf(files.get('transactions-02-keluarga.csv'))).toBe('﻿' + HEADER + '\r\n');
		expect(jsonOf(files, `${folder}/wallets.json`)).toEqual([]);
	});

	it('a removal while the download runs ends that space’s photos and member names (FN-31 red team L1)', async () => {
		const owner = await account('Pemilik Foto');
		const member = await account('Anggota Foto');
		const shared = await sharedSpaceWith(owner, member);
		const key = `p/${shared}/belongings/bersama`;
		const photo = new Uint8Array(5_000).fill(7);
		await files.put(key, photo);
		await d1
			.prepare(
				`insert into belongings (id, space_id, name, purchase_price_minor, currency, purchased_on,
					photo_key, photo_type, created_at, updated_at, seq)
				values ('bf-' || ?1, ?1, 'Kulkas', 1000, 'IDR', '2025-01-02', ?2, 'image/jpeg', ?3, ?3, 0)`
			)
			.bind(shared, key, NOW)
			.run();
		const folder = await folderOf(member, shared);
		const result = await exportAccount(db, member.user.id, { files });
		if (!result.ok) throw new Error('refused');
		await removeFrom(owner, shared);
		const zip = readZip(new Uint8Array(await new Response(result.stream).arrayBuffer()));
		// The photo was listed at the start; after the removal its bytes are never fetched.
		const photoFile = zip.get(`photos/belongings/bf-${shared}.jpg`);
		expect(photoFile?.length ?? 0).toBe(0);
		const space = jsonOf(zip, `${folder}/space.json`);
		expect(space.members).toEqual([]);
		const all = [...zip.values()].map(textOf).join('\n');
		expect(all).not.toContain('Pemilik Foto');
	});

	it('two exports in a row both succeed and are byte-identical; the sixth in 10 minutes is refused', async () => {
		const a = await account();
		const other = await account();
		await seed(a.scope, [
			{ date: '2026-10-01', type: 'expense', merchant: 'Kopi', amount: '28000' }
		]);
		const first = await exportZip(a);
		const second = await exportZip(a);
		expect(second).toEqual(first);
		await exportZip(a);
		await exportZip(a);
		await exportZip(a);
		expect(await exportVia(a)).toMatchObject({
			kind: 'redirect',
			status: 303,
			location: '/pengaturan/privasi?ekspor=terlalu-sering#ekspor'
		});
		// Per account: another account still exports.
		expect((await exportVia(other)).kind).toBe('ok');
	});

	it('20 concurrent export requests: exactly the window’s 5 are answered, the rest refused', async () => {
		const a = await account();
		const results = await Promise.all(Array.from({ length: 20 }, () => exportVia(a)));
		const answered = results.filter((r) => r.kind === 'ok');
		expect(answered).toHaveLength(ACCOUNT_EXPORT_MAX_PER_WINDOW);
		expect(results.filter((r) => r.kind === 'redirect')).toHaveLength(
			20 - ACCOUNT_EXPORT_MAX_PER_WINDOW
		);
		for (const r of answered) await (r.value as Response).body?.cancel();
	});

	it('a large account streams page by page across years; past the row cap it is refused, not truncated', async () => {
		const a = await account();
		const rows: Row[] = Array.from({ length: 2600 }, (_, i) => ({
			date: `${2024 + (i % 3)}-0${(i % 9) + 1}-1${i % 10}`,
			type: i % 5 ? 'expense' : 'income',
			merchant: `T${i}`,
			amount: String(1000 + i)
		}));
		await seed(a.scope, rows.slice(0, 1300));
		await seed(a.scope, rows.slice(1300));
		const zip = await exportZip(a);
		const csv = textOf(readZip(zip).get('transactions-01-pribadi.csv'));
		const records = csv.split('\r\n').filter(Boolean).slice(1);
		expect(records).toHaveLength(2600);
		// Newest first across the year boundaries, like one FN-18 export.
		const dates = records.map((r) => r.slice(0, 10));
		expect([...dates].sort().reverse()).toEqual(dates);
		// The cap counts every exported row (transactions, categories, wallets, sessions, consent …).
		expect(await exportAccount(db, a.user.id, { maxRows: 2600 })).toEqual({
			ok: false,
			reason: 'too_large'
		});
		expect((await exportAccount(db, a.user.id, { maxRows: 5000 })).ok).toBe(true);
	}, 120_000);
});
