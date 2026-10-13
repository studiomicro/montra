import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { creditsSpentThisMonth, wibMonthRangeUtcMs } from '#lib/server/billing/ledger';
import { listAllReleaseNotes, listReleaseNotes } from '#lib/server/content/release-notes';
import { CATEGORY_LIST_MAX, MAX_CATEGORIES_PER_SPACE } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, leaveSpace } from '#lib/server/spaces/spaces';
import { createWallet } from '#lib/server/wallets/repo';
import { API_TOKEN_MAX_PER_USER } from '#lib/shared/api-tokens';
import { STARTER_CREDITS } from '#lib/shared/billing/plans';
import { wibInstantUtcMs } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-42 /pengaturan/pemakaian and /pengaturan/tentang against local D1: figures read from stored rows only,
// account figures for the session's user, space figures for the session's re-checked current space.

const binding: { DB?: D1Database; APP_VERSION?: string } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const usagePage = await import('../../src/routes/(app)/pengaturan/pemakaian/+page.server');
const aboutPage = await import('../../src/routes/(app)/pengaturan/tentang/+page.server');
const changelogPage =
	await import('../../src/routes/(app)/pengaturan/tentang/catatan-rilis/+page.server');
const appLayout = await import('../../src/routes/(app)/+layout.server');
const paketPage = await import('../../src/routes/(app)/pengaturan/paket/+page.server');
const health = await import('../../src/routes/api/v1/health/+server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
	binding.APP_VERSION = '0.4.0';
});
afterAll(() => dispose());

let n = 0;
async function person(name = 'Uji') {
	const email = `pakai${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	return { user: { id: r.userId, email, name, createdAt: 0 }, spaceId: space.id };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An event as `who` in the space the cookie names (else their personal one); `space` forges locals.space. */
async function ev(
	who: Person | null,
	opts: { path?: string; spaceCookie?: string; space?: string; locale?: 'id' | 'en' } = {}
) {
	let space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	if (opts.space) space = { id: opts.space, kind: 'shared', name: 'x', role: 'member' };
	const { event, locals } = fakeEvent({
		url: `http://localhost${opts.path ?? '/pengaturan/pemakaian'}`,
		routeId: '/(app)/pengaturan/pemakaian',
		db,
		user: who?.user ?? null,
		space
	});
	if (opts.locale) locals.locale = opts.locale;
	return event as never;
}

interface Usage {
	space: { name: string; kind: string };
	usage: {
		state: { plan: string; storedPlan: string; currentPeriodEnd: number | null };
		balance: number;
		spentThisMonth: number;
		month: string;
		ledger: { id: string; delta: number }[];
		olderCursor: string | null;
		limits: { key: string; used: number; allowed: number }[];
		categories: { used: number; allowed: number };
		connectedApps: { real: number; demo: number };
		members: { used: number; allowed: number } | null;
		gmailLookbackDays: number;
		photos: { belongings: number; collectibles: number; receipts: number };
	} | null;
	aiLink: string | null;
	loadError: string | null;
}
const usage = async (who: Person, opts: Parameters<typeof ev>[1] = {}) =>
	(await usagePage.load(await ev(who, opts))) as unknown as Usage;

async function refusal(run: () => unknown) {
	try {
		await run();
	} catch (e) {
		return e;
	}
	throw new Error('expected a refusal');
}

let row = 0;
const ledger = (userId: string, delta: number, createdAt: number) =>
	d1
		.prepare(
			`insert into credit_ledger (id, user_id, delta, reason, created_at) values (?, ?, ?, ?, ?)`
		)
		.bind(
			`00000000-0000-4000-8000-${String(++row).padStart(12, '0')}`,
			userId,
			delta,
			delta < 0 ? 'ai_capture_spend' : 'admin_adjustment',
			createdAt
		)
		.run();

const thing = (
	table: 'belongings' | 'collectibles',
	spaceId: string,
	opts: { photo?: boolean; deleted?: boolean } = {}
) => {
	const id = crypto.randomUUID();
	const now = Date.now();
	const value = table === 'belongings' ? 'current_value_minor' : 'manual_value_minor';
	if (opts.deleted)
		return d1
			.prepare(
				`insert into ${table} (id, space_id, updated_at, deleted_at, seq) values (?, ?, ?, ?, 1)`
			)
			.bind(id, spaceId, now, now)
			.run();
	return d1
		.prepare(
			`insert into ${table} (id, space_id, name, purchase_price_minor, purchased_on, ${value}, photo_key,
				photo_type, created_at, updated_at, seq) values (?, ?, 'Barang', 100, '2026-10-01', 100, ?, ?, ?, ?, 1)`
		)
		.bind(
			id,
			spaceId,
			opts.photo ? `spaces/${spaceId}/${table}/${id}` : null,
			opts.photo ? 'image/jpeg' : null,
			now,
			now
		)
		.run();
};

async function categoryCount(spaceId: string) {
	const r = await d1
		.prepare('select count(*) as n from categories where space_id = ? and deleted_at is null')
		.bind(spaceId)
		.first<{ n: number }>();
	return r?.n ?? 0;
}
async function addCategories(spaceId: string, count: number, hidden: boolean) {
	const now = Date.now();
	const statements = Array.from({ length: count }, (_, i) =>
		d1
			.prepare(
				`insert into categories (id, space_id, kind, name, tile_key, is_hidden, sort_order, created_at, updated_at, seq)
				values (?, ?, 'expense', ?, 'lain', ?, ?, ?, ?, 1)`
			)
			.bind(crypto.randomUUID(), spaceId, `Kategori ${i}`, hidden ? 1 : 0, 1000 + i, now, now)
	);
	if (statements.length) await d1.batch(statements);
}

describe('who may see it', () => {
	it('redirects a signed-out visitor to /masuk, both pages (AC1)', async () => {
		for (const page of [usagePage, aboutPage]) {
			const event = await ev(null);
			const e = await refusal(() => page.load(event));
			expect(isRedirect(e) && e.location).toBe('/masuk');
		}
	});

	it('a forged current space the user is not a member of is the shared 404, no figure rendered (AC2, AC3)', async () => {
		const a = await person();
		const b = await person();
		const e = await refusal(() => usage(a, { space: b.spaceId }));
		expect(isHttpError(e) && e.status).toBe(404);
		expect(isHttpError(e) && e.body.message).toBe('Not found');
	});

	it('a space cookie naming another space falls back to the own personal space: only own figures', async () => {
		const a = await person();
		const b = await person();
		await thing('belongings', b.spaceId, { photo: true });
		await thing('collectibles', b.spaceId, { photo: true });
		const l = await usage(a, { spaceCookie: b.spaceId });
		expect(l.space.kind).toBe('personal');
		expect(l.usage?.photos).toEqual({ belongings: 0, collectibles: 0, receipts: 0 });
		expect(l.usage?.members).toBeNull();
	});
});

describe('a removed member (cross-space probe)', () => {
	it('after leaving, a cookie naming the space shows the own personal space; a forged one is the 404', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await thing('belongings', spaceId, { photo: true });
		expect((await usage(member, { spaceCookie: spaceId })).usage?.photos.belongings).toBe(1);
		await leaveSpace(db, { spaceId, userId: member.user.id }, Date.now());
		const after = await usage(member, { spaceCookie: spaceId });
		expect(after.space.kind).toBe('personal');
		expect(after.usage?.photos).toEqual({ belongings: 0, collectibles: 0, receipts: 0 });
		expect(after.usage?.limits.find((l) => l.key === 'spaces')?.used).toBe(1);
		const e = await refusal(() => usage(member, { space: spaceId }));
		expect(isHttpError(e) && e.status).toBe(404);
	});
});

describe('bounded work (AC20)', () => {
	it('one load is a small fixed number of statements, however many rows the account has', async () => {
		const a = await person();
		for (let i = 0; i < 30; i++) await ledger(a.user.id, -1, Date.now() - i * 1000);
		let statements = 0;
		const counting = new Proxy(d1, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (key === 'prepare')
					return (query: string) => {
						statements++;
						return target.prepare(query);
					};
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
		const event = await ev(a);
		(event as unknown as { locals: App.Locals }).locals.db = getDb(counting);
		const l = (await usagePage.load(event)) as unknown as Usage;
		expect(l.loadError).toBeNull();
		expect(l.usage?.ledger).toHaveLength(20);
		expect(l.usage?.olderCursor).not.toBeNull();
		// The membership check plus nine bounded reads (lists capped, aggregates in SQL); a personal space has
		// no member list to read.
		expect(statements).toBe(10);
	});
});

describe('the figures (AC13–AC20)', () => {
	it('a brand-new account: the starter credits, nothing spent, every count from its rows', async () => {
		const a = await person();
		const l = await usage(a);
		expect(l.loadError).toBeNull();
		const u = l.usage!;
		expect(u.balance).toBe(STARTER_CREDITS);
		expect(u.spentThisMonth).toBe(0);
		expect(u.state.plan).toBe('gratis');
		expect(u.ledger).toHaveLength(1);
		expect(u.olderCursor).toBeNull();
		expect(u.limits).toEqual([
			{ key: 'spaces', used: 1, allowed: 1 },
			{ key: 'tokens', used: 0, allowed: API_TOKEN_MAX_PER_USER }
		]);
		expect(u.categories).toEqual({
			used: await categoryCount(a.spaceId),
			allowed: MAX_CATEGORIES_PER_SPACE
		});
		expect(u.connectedApps).toEqual({ real: 0, demo: 0 });
		expect(u.gmailLookbackDays).toBe(7);
		expect(u.photos).toEqual({ belongings: 0, collectibles: 0, receipts: 0 });
		// FN-41's page ships in this build, so the AI row links there (plain text in a build without it).
		expect(l.aiLink).toBe('/pengaturan/integrasi');
	});

	it('the balance equals what /pengaturan/paket shows for the same account (AC13)', async () => {
		const a = await person();
		await ledger(a.user.id, -42, Date.now() - 1000);
		const paket = (await paketPage.load(
			fakeEvent({ url: 'http://localhost/pengaturan/paket', db, user: a.user }).event as never
		)) as unknown as { balance: number };
		const l = await usage(a);
		expect(l.usage?.balance).toBe(STARTER_CREDITS - 42);
		expect(l.usage?.balance).toBe(paket.balance);
	});

	it('this month is the WIB month of created_at, never the UTC month (AC14)', async () => {
		const a = await person();
		const now = wibInstantUtcMs('2026-10-15', '12:00');
		await ledger(a.user.id, -5, wibInstantUtcMs('2026-09-30', '23:30'));
		await ledger(a.user.id, -10, wibInstantUtcMs('2026-10-01', '00:30'));
		await ledger(a.user.id, -20, wibInstantUtcMs('2026-10-31', '23:30'));
		await ledger(a.user.id, -40, wibInstantUtcMs('2026-11-01', '00:30'));
		await ledger(a.user.id, 500, wibInstantUtcMs('2026-10-10', '09:00'));
		// The UTC dates of the two boundary pairs fall in the neighbouring month: a UTC bucket would be wrong.
		expect(new Date(wibInstantUtcMs('2026-10-01', '00:30')).toISOString().slice(0, 7)).toBe(
			'2026-09'
		);
		expect(new Date(wibInstantUtcMs('2026-11-01', '00:30')).toISOString().slice(0, 7)).toBe(
			'2026-10'
		);
		expect(await creditsSpentThisMonth(db, a.user.id, now)).toBe(30);
		expect(await creditsSpentThisMonth(db, a.user.id, wibInstantUtcMs('2026-09-30', '23:59'))).toBe(
			5
		);
		expect(await creditsSpentThisMonth(db, a.user.id, wibInstantUtcMs('2026-11-01', '00:00'))).toBe(
			40
		);
		// Another user's spending never counts.
		const b = await person();
		await ledger(b.user.id, -7, wibInstantUtcMs('2026-10-02', '10:00'));
		expect(await creditsSpentThisMonth(db, a.user.id, now)).toBe(30);
		expect(wibMonthRangeUtcMs(now)).toEqual({
			startMs: Date.UTC(2026, 8, 30, 17),
			endMs: Date.UTC(2026, 9, 31, 17)
		});
	});

	it('categories count hidden ones and a top-up past the cap is shown as it is, never capped (AC15)', async () => {
		const a = await person();
		const before = await categoryCount(a.spaceId);
		await addCategories(a.spaceId, MAX_CATEGORIES_PER_SPACE - before - 3, false);
		await addCategories(a.spaceId, 3, true);
		expect((await usage(a)).usage?.categories).toEqual({ used: 100, allowed: 100 });
		await addCategories(a.spaceId, CATEGORY_LIST_MAX - MAX_CATEGORIES_PER_SPACE, false);
		expect((await usage(a)).usage?.categories).toEqual({ used: CATEGORY_LIST_MAX, allowed: 100 });
	});

	it('connected apps: a count with no ceiling; demo connections are shown apart, not counted (AC16)', async () => {
		const a = await person();
		const now = Date.now();
		await d1
			.prepare(
				`insert into connected_apps (id, space_id, provider, status, is_demo, created_by_user_id, created_at, updated_at, seq)
				values (?, ?, 'notion', 'connected', 1, ?, ?, ?, 1)`
			)
			.bind(crypto.randomUUID(), a.spaceId, a.user.id, now, now)
			.run();
		expect((await usage(a)).usage?.connectedApps).toEqual({ real: 0, demo: 1 });
	});

	it('a personal space has no member ratio; a shared one counts its live members (AC17)', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		expect((await usage(owner)).usage?.members).toBeNull();
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		const l = await usage(member, { spaceCookie: spaceId });
		expect(l.space).toEqual({ name: 'Keluarga', kind: 'shared' });
		expect(l.usage?.members).toEqual({ used: 2, allowed: 5 });
	});

	it('stored photos: live rows with a photo key only, per kind, this space only (AC19)', async () => {
		const a = await person();
		const b = await person();
		await thing('belongings', a.spaceId, { photo: true });
		await thing('belongings', a.spaceId, { photo: true });
		await thing('belongings', a.spaceId);
		await thing('belongings', a.spaceId, { deleted: true });
		await thing('collectibles', a.spaceId, { photo: true });
		await thing('collectibles', a.spaceId);
		await thing('collectibles', b.spaceId, { photo: true });
		await thing('belongings', b.spaceId, { photo: true });
		// FN-15: a kept receipt photo on a live transaction counts; a tombstone and a row without one do not.
		const wallet = await createWallet(
			db,
			{ spaceId: a.spaceId, userId: a.user.id },
			{
				name: 'Tunai',
				type: 'tunai',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: true,
				lastFour: null
			},
			Date.now()
		);
		if (!wallet.ok) throw new Error('wallet');
		const receipt = (photo: boolean) =>
			d1
				.prepare(
					`insert into transactions (id, space_id, type, amount_minor, currency, wallet_id, occurred_on,
						occurred_at, source, created_at, updated_at, seq, photo_key, photo_type)
					values (?, ?, 'expense', 100, 'IDR', ?, '2026-10-01', 1, 'receipt', 1, 1, 1, ?, ?)`
				)
				.bind(
					crypto.randomUUID(),
					a.spaceId,
					wallet.id,
					photo ? `spaces/${a.spaceId}/receipts/${crypto.randomUUID()}` : null,
					photo ? 'image/jpeg' : null
				)
				.run();
		await receipt(true);
		await receipt(false);
		await d1
			.prepare(
				`insert into transactions (id, space_id, type, source, created_at, updated_at, deleted_at, seq)
				values (?, ?, 'expense', 'receipt', 1, 1, 1, 1)`
			)
			.bind(crypto.randomUUID(), a.spaceId)
			.run();
		expect((await usage(a)).usage?.photos).toEqual({ belongings: 2, collectibles: 1, receipts: 1 });
		expect((await usage(b)).usage?.photos).toEqual({ belongings: 1, collectibles: 1, receipts: 0 });
	});

	it('a failing query is the page error state, never a zero presented as real (AC24)', async () => {
		const a = await person();
		const event = await ev(a);
		// The membership check still answers; every aggregate after it fails.
		const broken = new Proxy(db, {
			get: (target, key, receiver) =>
				key === 'all'
					? () => Promise.reject(new Error('D1 down'))
					: Reflect.get(target, key, receiver)
		});
		(event as unknown as { locals: App.Locals }).locals.db = broken;
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const l = (await usagePage.load(event)) as unknown as Usage;
		spy.mockRestore();
		expect(l.usage).toBeNull();
		expect(l.loadError).toBe('Pemakaian tidak bisa dimuat. Coba lagi sebentar lagi.');
	});
});

describe('/pengaturan/tentang', () => {
	it('shows the Worker version, the same value /api/v1/health reports (AC4)', async () => {
		const a = await person();
		const l = (await aboutPage.load(await ev(a, { path: '/pengaturan/tentang' }))) as unknown as {
			version: string;
			releasedOn: string | null;
		};
		const h = (await (await health.GET({} as never)).json()) as { version: string };
		expect(l.version).toBe('0.4.0');
		expect(h.version).toBe(l.version);
		expect(l.releasedOn).toBe('2026-10-09');
	});

	it('lists the three newest notes in the reader’s language (AC5, AC7)', async () => {
		const a = await person();
		type About = { notes: { version: string; html: string }[] };
		const id = (await aboutPage.load(
			await ev(a, { path: '/pengaturan/tentang' })
		)) as unknown as About;
		const en = (await aboutPage.load(
			await ev(a, { path: '/pengaturan/tentang', locale: 'en' })
		)) as unknown as About;
		// The three newest bundled releases (every release adds a pair, so they come from the bundle itself).
		const newest = listReleaseNotes('id').map((n) => n.version);
		expect(newest).toHaveLength(3);
		expect(id.notes.map((x) => x.version)).toEqual(newest);
		expect(en.notes.map((x) => x.version)).toEqual(newest);
		// Each in the reader's language (not tied to one version, so a new release never breaks this).
		expect(id.notes.map((n) => n.html)).toEqual(listReleaseNotes('id').map((n) => n.html));
		expect(en.notes.map((n) => n.html)).toEqual(listReleaseNotes('en').map((n) => n.html));
		expect(id.notes[0]?.html).not.toEqual(en.notes[0]?.html);
		for (const note of [...id.notes, ...en.notes])
			expect(note.html).not.toMatch(/behind the scenes/i);
	});

	it('a version without a note has no release date, and the page still loads', async () => {
		binding.APP_VERSION = '0.4.1';
		try {
			const a = await person();
			const l = (await aboutPage.load(await ev(a, { path: '/pengaturan/tentang' }))) as unknown as {
				version: string;
				releasedOn: string | null;
			};
			expect(l).toMatchObject({ version: '0.4.1', releasedOn: null });
		} finally {
			binding.APP_VERSION = '0.4.0';
		}
	});
});

describe('/pengaturan/tentang/catatan-rilis (FN-42b AC1, AC24)', () => {
	type Changelog = { version: string; notes: { version: string; date: string; html: string }[] };

	it('lists every release newest first in the reader’s language, with the running version', async () => {
		const a = await person();
		const id = (await changelogPage.load(
			await ev(a, { path: '/pengaturan/tentang/catatan-rilis' })
		)) as unknown as Changelog;
		const en = (await changelogPage.load(
			await ev(a, { path: '/pengaturan/tentang/catatan-rilis', locale: 'en' })
		)) as unknown as Changelog;
		const all = listAllReleaseNotes('id').map((n) => n.version);
		expect(all.length).toBeGreaterThanOrEqual(6);
		expect(id.notes.map((n) => n.version)).toEqual(all);
		expect(id.notes.at(-1)?.version).toBe('0.1.0');
		expect(en.notes.map((n) => n.version)).toEqual(all);
		expect(id.version).toBe('0.4.0');
		const pick = (l: Changelog) => l.notes.find((n) => n.version === '0.4.0')?.html ?? '';
		expect(pick(id)).toContain('Tema baru Hitam-putih');
		expect(pick(en)).toContain('A new Hitam-putih (black and white) theme');
		// Bundled content only: nothing from any account or space in the payload.
		expect(Object.keys(id).sort()).toEqual(['notes', 'version']);
		expect(JSON.stringify(id)).not.toContain(a.user.email);
		expect(JSON.stringify(id)).not.toContain(a.spaceId);
	});

	it('a signed-out request is sent to /masuk', async () => {
		try {
			await changelogPage.load(await ev(null, { path: '/pengaturan/tentang/catatan-rilis' }));
			expect.unreachable('should redirect');
		} catch (e) {
			expect(isRedirect(e)).toBe(true);
			expect(e).toMatchObject({ status: 303, location: '/masuk' });
		}
	});
});

describe('the (app) layout’s "what\'s new" data (FN-42b AC16, AC24)', () => {
	type Layout = {
		appVersion: string | null;
		whatsNew: { version: string; date: string; html: string } | null;
	};
	const layout = async (who: Person | null, locale?: 'id' | 'en') =>
		(await appLayout.load(await ev(who, { path: '/', locale }))) as unknown as Layout;

	it('carries the running version’s note in the user’s language', async () => {
		const a = await person();
		const id = await layout(a);
		const en = await layout(a, 'en');
		expect(id.appVersion).toBe('0.4.0');
		expect(id.whatsNew).toMatchObject({ version: '0.4.0', date: '2026-10-09' });
		expect(id.whatsNew?.html).toContain('Tema baru Hitam-putih');
		expect(en.whatsNew?.html).toContain('A new Hitam-putih (black and white) theme');
		expect(Object.keys(id.whatsNew ?? {}).sort()).toEqual(['date', 'html', 'version']);
	});

	it('is null signed out, and null for a version without a note', async () => {
		expect(await layout(null)).toMatchObject({ appVersion: null, whatsNew: null });
		binding.APP_VERSION = '9.9.9';
		try {
			const l = await layout(await person());
			expect(l).toMatchObject({ appVersion: '9.9.9', whatsNew: null });
		} finally {
			binding.APP_VERSION = '0.4.0';
		}
	});
});
