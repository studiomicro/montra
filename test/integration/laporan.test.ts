import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { berandaSummary } from '#lib/server/budgets/summary';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { laporanReport, type LaporanReport } from '#lib/server/reports/laporan';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	categoryMonthlyTotals,
	largestTransactions,
	MAX_MERCHANTS,
	merchantTotals,
	monthlyTotals,
	type TransactionFilter
} from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import { monthOf, shiftMonth, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const laporan = await import('../../src/routes/(app)/laporan/+page.server');
const riwayat = await import('../../src/routes/(app)/riwayat/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

async function run(fn: () => unknown) {
	try {
		return { kind: 'ok' as const, value: (await fn()) as Record<string, unknown> };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, status: e.status, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status, body: e.body };
		throw e;
	}
}

let n = 0;
async function person(name = 'Uji') {
	const email = `laporan${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = (await resolveCurrentSpace(db, r.userId, undefined))!.id;
	const scope: SpaceScope = { spaceId: personal, userId: r.userId };
	return { user: { id: r.userId, email, name, createdAt: 0 }, scope };
}
type Person = Awaited<ReturnType<typeof person>>;

async function ev(who: Person | null, url: string, space?: string) {
	const current = who ? await resolveCurrentSpace(db, who.user.id, space) : null;
	return fakeEvent({
		url: `http://localhost${url}`,
		routeId: '/(app)/laporan',
		db,
		user: who?.user ?? null,
		space: current
	}).event as never;
}

async function reportOf(who: Person, url = '/laporan', space?: string): Promise<LaporanReport> {
	const r = await run(async () => laporan.load(await ev(who, url, space)));
	if (r.kind !== 'ok' || r.value.loadError) throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.report as LaporanReport;
}

/** Riwayat's header totals for a URL (the list the Laporan figures must equal). */
async function riwayatTotals(who: Person, url: string) {
	const r = await run(async () => riwayat.load(await ev(who, url)));
	if (r.kind !== 'ok') throw new Error('riwayat failed');
	return (
		r.value as unknown as {
			totals: { totals: { currency: string; inMinor: number | null; outMinor: number | null }[] };
		}
	).totals.totals;
}
const idrOf = (totals: { currency: string; inMinor: number | null; outMinor: number | null }[]) =>
	totals.find((t) => t.currency === 'IDR') ?? { currency: 'IDR', inMinor: 0, outMinor: 0 };

/** A ledger in `scope`: presets, two IDR wallets (the first is the favourite) and a USD wallet. */
async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	const cats = await listCategories(db, scope.spaceId);
	const wallet = async (name: string, currency: 'IDR' | 'USD') => {
		const r = await createWallet(
			db,
			scope,
			{ name, type: 'bank', currency, openingBalanceMinor: 0, isFavourite: false, lastFour: null },
			NOW
		);
		if (!r.ok) throw new Error('wallet failed');
		return r.id;
	};
	const bca = await wallet('BCA', 'IDR');
	const gopay = await wallet('GoPay', 'IDR');
	const wise = await wallet('Wise', 'USD');
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	const tx = async (over: Partial<TransactionInput>) => {
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: bca,
				transferToWalletId: null,
				categoryId: cat('kopi'),
				title: 'Kopi',
				note: null,
				occurredOn: wibTodayString(),
				occurredTime: null,
				...over
			},
			NOW
		);
		if (!r.ok) throw new Error(`tx failed: ${JSON.stringify(r)}`);
		return r.id;
	};
	return { bca, gopay, wise, tx, cat };
}

const setRaw = (id: string, column: 'title' | 'amount_minor' | 'is_demo', value: unknown) =>
	d1.prepare(`update transactions set ${column} = ? where id = ?`).bind(value, id).run();

const filter = (from: string, to: string, type: TransactionFilter['type']): TransactionFilter => ({
	from,
	to,
	type,
	categoryId: null,
	walletId: null,
	q: null
});

describe('Laporan load', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await run(async () => laporan.load(await ev(null, '/laporan')))).toMatchObject({
			kind: 'redirect',
			status: 303,
			location: '/masuk'
		});
	});

	it('defaults to this WIB month and money out; unknown parameters fall back to the defaults', async () => {
		const p = await person();
		const today = wibTodayString();
		for (const url of ['/laporan', '/laporan?period=semua&arah=x', '/laporan?p=2026-13&y=x']) {
			const r = await reportOf(p, url);
			expect(r.view).toEqual({ mode: 'bulan', month: monthOf(today), direction: 'keluar' });
			expect(r.from).toBe(`${monthOf(today)}-01`);
			expect(r.to.slice(0, 7)).toBe(monthOf(today));
		}
	});

	it('an empty month and an empty year: honest zeros, empty lists, a blank calendar and flat lines', async () => {
		const p = await person();
		const r = await reportOf(p);
		expect(r.stats).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 0, netMinor: 0 }]);
		expect(r.categories).toEqual([]);
		expect(r.merchants).toEqual([]);
		expect(r.largest).toEqual([]);
		expect(r.otherCurrencies).toEqual([]);
		if (r.detail.mode !== 'bulan') throw new Error('month expected');
		expect(r.detail.heatmap.every((d) => d.minor === 0 && d.level === 0)).toBe(true);
		expect(r.detail.lines.current.every((v) => v === 0)).toBe(true);
		expect(r.detail.lines.diffMinor).toBe(0);
		const y = await reportOf(p, `/laporan?y=${wibTodayString().slice(0, 4)}`);
		if (y.detail.mode !== 'tahun') throw new Error('year expected');
		expect(y.detail.months.length).toBe(Number(wibTodayString().slice(5, 7)));
		expect(y.detail.stack.every((m) => m.total === 0 && m.segments.length === 0)).toBe(true);
		expect(y.detail.grid).toEqual([]);
		expect(y.detail.averageMinor).toBe(0);
	});
});

describe('Laporan total = Riwayat total = Beranda total for the same filter (pre-handoff probe)', () => {
	async function seeded() {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		const prev = `${shiftMonth(monthOf(today), -1)}-15`;
		await l.tx({ amountMinor: 2_500_000, title: 'Kopi Kenangan' });
		await l.tx({ amountMinor: 7_300_000, categoryId: l.cat('makan'), title: 'Warteg' });
		await l.tx({
			type: 'income',
			amountMinor: 900_000_000,
			categoryId: l.cat('gaji'),
			title: 'Gaji'
		});
		await l.tx({
			type: 'transfer',
			amountMinor: 50_000_000,
			categoryId: null,
			transferToWalletId: l.gopay
		});
		await l.tx({ walletId: l.wise, currency: 'USD', amountMinor: 999, title: 'Netflix' });
		await l.tx({ occurredOn: prev, amountMinor: 4_000_000, title: 'kopi kenangan' });
		await l.tx({
			occurredOn: prev,
			type: 'income',
			amountMinor: 1_000_000,
			categoryId: l.cat('bonus')
		});
		const demo = await l.tx({ amountMinor: 123_000_000, title: 'Demo' });
		await setRaw(demo, 'is_demo', 1);
		return { p, l, today, prev };
	}

	it('bulan-ini: stat lines equal Riwayat’s month totals and Beranda’s hero; lists add up', async () => {
		const { p } = await seeded();
		const r = await reportOf(p);
		const out = idrOf(await riwayatTotals(p, '/riwayat?type=expense')).outMinor;
		const inc = idrOf(await riwayatTotals(p, '/riwayat?type=income')).inMinor;
		const beranda = await berandaSummary(db, p.scope.spaceId, wibTodayString());
		expect(r.stats[0]).toEqual({
			currency: 'IDR',
			inMinor: inc,
			outMinor: out,
			netMinor: inc! - out!
		});
		expect(r.stats[0]!.outMinor).toBe(beranda.spentMinor);
		expect(r.stats[0]!.outMinor).toBe(9_800_000); // transfer and demo never count
		expect(r.stats[1]).toEqual({ currency: 'USD', inMinor: 0, outMinor: 999, netMinor: -999 });
		// The category list adds up to the direction total exactly; percentages are floored.
		expect(r.categories.reduce((s, c) => s + c.minor!, 0)).toBe(r.directionMinor);
		expect(r.categories.map((c) => c.percent)).toEqual([
			Math.floor((7_300_000 * 100) / 9_800_000),
			Math.floor((2_500_000 * 100) / 9_800_000)
		]);
		expect(r.merchants.reduce((s, m) => s + m.amountMinor!, 0)).toBeLessThanOrEqual(out!);
		expect(r.otherCurrencies).toEqual(['USD']);
	});

	it('last month: equals Riwayat’s list for last month', async () => {
		const { p, today } = await seeded();
		const month = shiftMonth(monthOf(today), -1);
		const r = await reportOf(p, `/laporan?p=${month}`);
		const t = idrOf(await riwayatTotals(p, `/riwayat?month=${month}`));
		expect(r.from).toBe(`${month}-01`);
		expect({ inMinor: r.stats[0]!.inMinor, outMinor: r.stats[0]!.outMinor }).toEqual({
			inMinor: t.inMinor,
			outMinor: t.outMinor
		});
		expect(r.stats[0]).toMatchObject({
			inMinor: 1_000_000,
			outMinor: 4_000_000,
			netMinor: -3_000_000
		});
	});

	it('this year: equals Riwayat’s range from 1 January through today; stacked bars and grid add up', async () => {
		const { p, today } = await seeded();
		const r = await reportOf(p, `/laporan?y=${today.slice(0, 4)}`);
		const from = `${today.slice(0, 4)}-01-01`;
		const t = idrOf(await riwayatTotals(p, `/riwayat?period=range&from=${from}&to=${today}`));
		expect(r.from).toBe(from);
		expect(r.to).toBe(today);
		expect({ inMinor: r.stats[0]!.inMinor, outMinor: r.stats[0]!.outMinor }).toEqual({
			inMinor: t.inMinor,
			outMinor: t.outMinor
		});
		if (r.detail.mode !== 'tahun') throw new Error('year expected');
		const d = r.detail;
		expect(d.stack.length).toBeLessThanOrEqual(12);
		expect(d.stack.reduce((s, m) => s + m.total!, 0)).toBe(r.stats[0]!.outMinor);
		for (const m of d.stack) expect(m.segments.reduce((s, x) => s + x.minor!, 0)).toBe(m.total);
		expect(d.grid.reduce((s, g) => s + g.total!, 0)).toBe(r.stats[0]!.outMinor);
		expect(d.lines.current.at(-1)).toBe(r.stats[0]!.outMinor);
		expect(r.categories.reduce((s, c) => s + c.minor!, 0)).toBe(r.stats[0]!.outMinor);
		// The year view has no top places or biggest rows (month view only).
		expect(r.merchants).toEqual([]);
		expect(r.largest).toEqual([]);
	});

	it('Pemasukan: the direction switches the lists, never the stat lines', async () => {
		const { p } = await seeded();
		const out = await reportOf(p);
		const inc = await reportOf(p, '/laporan?arah=masuk');
		expect(inc.stats).toEqual(out.stats);
		expect(inc.directionMinor).toBe(900_000_000);
		expect(inc.categories.map((c) => [c.tileKey, c.minor, c.percent])).toEqual([
			['gaji', 900_000_000, 100]
		]);
		expect(inc.merchants).toEqual([{ title: 'Gaji', count: 1, amountMinor: 900_000_000 }]);
	});
});

describe('merchant grouping', () => {
	it('case and surrounding whitespace collapse to one merchant; blank titles form one "Tanpa judul" group', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		await l.tx({ title: 'Kopi Kenangan', amountMinor: 100 });
		const spaced = await l.tx({ title: 'x', amountMinor: 200 });
		await setRaw(spaced, 'title', '  kopi kenangan \t');
		await l.tx({ title: null, amountMinor: 50 });
		const blank = await l.tx({ title: 'y', amountMinor: 60 });
		await setRaw(blank, 'title', '   ');
		const r = await merchantTotals(
			db,
			p.scope.spaceId,
			filter(`${monthOf(today)}-01`, today, 'expense'),
			'IDR'
		);
		expect(r).toEqual([
			{ title: 'Kopi Kenangan', count: 2, amountMinor: 300 },
			{ title: null, count: 2, amountMinor: 110 }
		]);
	});

	it('a 60+ character title groups by equality (no LIKE pattern cap); at most 10 merchants, largest first', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const long = 'Toko Serba Ada Sejahtera Makmur Abadi Cabang Kelapa Gading Jakarta Utara';
		expect(long.length).toBeGreaterThan(60);
		await l.tx({ title: long, amountMinor: 5_000 });
		await l.tx({ title: long.toUpperCase(), amountMinor: 5_000 });
		for (let i = 1; i <= 12; i++) await l.tx({ title: `Toko ${i}`, amountMinor: i * 100 });
		const today = wibTodayString();
		const f = filter(`${monthOf(today)}-01`, today, 'expense');
		const r = await merchantTotals(db, p.scope.spaceId, f, 'IDR', 50);
		expect(r).toHaveLength(MAX_MERCHANTS);
		expect(r[0]).toEqual({ title: long.toUpperCase(), count: 2, amountMinor: 10_000 });
		expect(r.slice(1).map((m) => m.title)).toEqual(
			[12, 11, 10, 9, 8, 7, 6, 5, 4].map((i) => `Toko ${i}`)
		);
		const page = await reportOf(p);
		expect(page.merchants).toEqual(r.slice(0, 5)); // Laporan shows the top 5 places
	});

	it('refuses a filter without a direction (a programming error, never user input)', async () => {
		const p = await person();
		const today = wibTodayString();
		await expect(
			merchantTotals(db, p.scope.spaceId, filter(today, today, null), 'IDR')
		).rejects.toThrow(RangeError);
	});
});

describe('WIB boundaries (pre-handoff probe)', () => {
	it('23:30 WIB on 31 December and 00:30 WIB on 1 January fall in their own year, month and report', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		// 23:30 WIB 31 Dec = 16:30 UTC; 00:30 WIB 1 Jan = 17:30 UTC on 31 Dec (same UTC date).
		await l.tx({
			occurredOn: '2026-12-31',
			occurredTime: '23:30',
			amountMinor: 1_000,
			title: 'Malam'
		});
		await l.tx({
			occurredOn: '2027-01-01',
			occurredTime: '00:30',
			amountMinor: 7_000,
			title: 'Pagi'
		});
		const today = wibTodayString(Date.parse('2026-12-31T17:30:00Z'));
		expect(today).toBe('2027-01-01');

		const year = await laporanReport(db, p.scope.spaceId, today, {
			mode: 'tahun',
			year: '2027',
			direction: 'keluar'
		});
		expect(year).toMatchObject({ from: '2027-01-01', to: '2027-01-01' });
		expect(year.stats[0]!.outMinor).toBe(7_000);
		if (year.detail.mode !== 'tahun') throw new Error('year expected');
		expect(year.detail.months).toEqual(['2027-01']);
		expect(year.detail.stack.map((m) => m.total)).toEqual([7_000]);
		// Last year's line holds 31 December's 23:30 row, never this year's.
		expect(year.detail.lines.current).toEqual([7_000]);
		expect(year.detail.lines.previous.at(-1)).toBe(1_000);
		expect(year.detail.lines.previous.slice(0, 11).every((v) => v === 0)).toBe(true);

		const last = await laporanReport(db, p.scope.spaceId, today, {
			mode: 'bulan',
			month: '2026-12',
			direction: 'keluar'
		});
		expect(last).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
		expect(last.stats[0]!.outMinor).toBe(1_000);
		expect(last.merchants.map((m) => m.title)).toEqual(['Malam']);
		if (last.detail.mode !== 'bulan') throw new Error('month expected');
		expect(last.detail.heatmap.at(-1)).toMatchObject({
			date: '2026-12-31',
			minor: 1_000,
			level: 4
		});
		expect(last.detail.heatmap.filter((d) => d.minor !== 0)).toHaveLength(1);

		const jan = await laporanReport(db, p.scope.spaceId, today, {
			mode: 'bulan',
			month: '2027-01',
			direction: 'keluar'
		});
		if (jan.detail.mode !== 'bulan') throw new Error('month expected');
		expect(jan.detail.elapsed).toBe(1);
		expect(jan.detail.heatmap[0]).toMatchObject({
			date: '2027-01-01',
			minor: 7_000,
			future: false
		});
		expect(jan.detail.heatmap[1]!.future).toBe(true);
		expect(jan.detail.lines.current).toEqual([7_000]);
		expect(jan.detail.lines.previous[0]).toBe(0);
		expect(jan.detail.lines.diffMinor).toBe(7_000);
		expect(jan.largest.map((t) => t.title)).toEqual(['Pagi']);

		const months = await monthlyTotals(
			db,
			p.scope.spaceId,
			filter('2026-12-01', '2027-01-31', 'expense')
		);
		expect(months.map((m) => [m.month, m.totals[0]!.outMinor])).toEqual([
			['2026-12', 1_000],
			['2027-01', 7_000]
		]);
	});

	it('23:30 WIB on 31 October and 00:30 WIB on 1 November land on their own calendar day', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2026-10-31', occurredTime: '23:30', amountMinor: 300 });
		await l.tx({ occurredOn: '2026-11-01', occurredTime: '00:30', amountMinor: 500 });
		const oct = await laporanReport(db, p.scope.spaceId, '2026-11-01', {
			mode: 'bulan',
			month: '2026-10',
			direction: 'keluar'
		});
		if (oct.detail.mode !== 'bulan') throw new Error('month expected');
		expect(oct.detail.heatmap.map((d) => d.minor).filter((v) => v !== 0)).toEqual([300]);
		expect(oct.detail.heatmap.at(-1)!.date).toBe('2026-10-31');
		const nov = await laporanReport(db, p.scope.spaceId, '2026-11-01', {
			mode: 'bulan',
			month: '2026-11',
			direction: 'keluar'
		});
		if (nov.detail.mode !== 'bulan') throw new Error('month expected');
		expect(nov.detail.heatmap[0]).toMatchObject({ date: '2026-11-01', minor: 500 });
		expect(nov.detail.lines.current).toEqual([500]);
		expect(nov.detail.lines.previous).toHaveLength(30);
		// October is cut at November's 30 days (Beranda's same-days rule): the 31st's row is left out.
		expect(nov.detail.lines.previous.at(-1)).toBe(0);
	});

	it('the month lines: a past month against the month before, cut and carried by day', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2027-02-28', amountMinor: 300 });
		await l.tx({ occurredOn: '2027-03-01', amountMinor: 100 });
		await l.tx({ occurredOn: '2027-03-31', amountMinor: 200 });
		const march = await laporanReport(db, p.scope.spaceId, '2027-04-02', {
			mode: 'bulan',
			month: '2027-03',
			direction: 'keluar'
		});
		if (march.detail.mode !== 'bulan') throw new Error('month expected');
		expect(march.detail).toMatchObject({ month: '2027-03', previousMonth: '2027-02', elapsed: 31 });
		expect(march.detail.lines.current).toHaveLength(31);
		expect(march.detail.lines.previous).toHaveLength(31);
		expect(march.detail.lines.current.at(-1)).toBe(300);
		expect(march.detail.lines.previous.slice(27)).toEqual([300, 300, 300, 300]);
		const now = await laporanReport(db, p.scope.spaceId, '2027-03-02', {
			mode: 'bulan',
			month: '2027-03',
			direction: 'keluar'
		});
		if (now.detail.mode !== 'bulan') throw new Error('month expected');
		expect(now.detail.lines.current).toEqual([100, 100]);
		expect(now.detail.lines.previous.slice(0, 2)).toEqual([0, 0]);
		expect(now.detail.lines.diffMinor).toBe(100);
	});
});

describe('new aggregates: categories by month and the largest rows', () => {
	it('two spaces never mix; demo rows and transfers never count; uncategorised rows are their own group', async () => {
		const a = await person();
		const b = await person();
		const la = await ledger(a.scope);
		const lb = await ledger(b.scope);
		await la.tx({ occurredOn: '2026-01-15', amountMinor: 100, title: 'A1' });
		await la.tx({
			occurredOn: '2026-02-15',
			amountMinor: 200,
			categoryId: la.cat('makan'),
			title: 'A2'
		});
		const a3 = await la.tx({ occurredOn: '2026-02-16', amountMinor: 50, title: 'A3' });
		// A row whose category is gone (no category): only reachable in the table itself.
		await d1.prepare('update transactions set category_id = null where id = ?').bind(a3).run();
		await la.tx({
			occurredOn: '2026-02-16',
			type: 'transfer',
			amountMinor: 9_999,
			categoryId: null,
			transferToWalletId: la.gopay
		});
		const demo = await la.tx({ occurredOn: '2026-02-17', amountMinor: 1_000_000, title: 'Demo' });
		await setRaw(demo, 'is_demo', 1);
		await lb.tx({ occurredOn: '2026-02-15', amountMinor: 777_777, title: 'B1' });

		const rows = await categoryMonthlyTotals(
			db,
			a.scope.spaceId,
			filter('2026-01-01', '2026-12-31', 'expense')
		);
		expect(rows.map((r) => [r.month, r.category?.tileKey ?? null, r.totals[0]!.outMinor])).toEqual(
			expect.arrayContaining([
				['2026-01', 'kopi', 100],
				['2026-02', 'makan', 200],
				['2026-02', null, 50]
			])
		);
		expect(rows).toHaveLength(3);

		const largest = await largestTransactions(
			db,
			a.scope.spaceId,
			filter('2026-02-01', '2026-02-28', 'expense'),
			'IDR',
			50
		);
		expect(largest.map((t) => [t.title, t.amountMinor])).toEqual([
			['A2', 200],
			['A3', 50]
		]);

		const year = await laporanReport(db, a.scope.spaceId, '2026-10-08', {
			mode: 'tahun',
			year: '2026',
			direction: 'keluar'
		});
		if (year.detail.mode !== 'tahun') throw new Error('year expected');
		expect(year.stats[0]!.outMinor).toBe(350);
		expect(year.detail.stack.slice(0, 3).map((m) => m.total)).toEqual([100, 250, 0]);
		expect(year.detail.averageMinor).toBe(35); // floor(350 / 10 months)
		expect(year.categories.map((c) => [c.tileKey, c.perUnitMinor])).toEqual([
			['makan', 20],
			['kopi', 10],
			['lain', 5]
		]);
	});

	it('at most 5 largest rows, largest first then newest; refuses a filter without a direction', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		for (let i = 1; i <= 7; i++)
			await l.tx({
				occurredOn: '2026-05-0' + i,
				amountMinor: i === 7 ? 600 : i * 100,
				title: `T${i}`
			});
		const f = filter('2026-05-01', '2026-05-31', 'expense');
		const r = await largestTransactions(db, p.scope.spaceId, f, 'IDR', 99);
		expect(r.map((t) => t.title)).toEqual(['T7', 'T6', 'T5', 'T4', 'T3']);
		await expect(
			largestTransactions(db, p.scope.spaceId, filter('2026-05-01', '2026-05-31', null), 'IDR')
		).rejects.toThrow(RangeError);
	});
});

describe('totals past 2^53 (pre-handoff probe: "Total terlalu besar untuk ditampilkan")', () => {
	it('every figure built on a too-large sum is null, never rounded; the page still loads', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		// 2 × 500 rows of 10^13 (the per-row cap) sum to 10^16, past 2^53 ≈ 9.007·10^15; one statement each.
		for (const title of ['Besar', 'besar ']) {
			await d1
				.prepare(
					`with recursive n(i) as (select 1 union all select i + 1 from n where i < 500)
					insert into transactions (id, space_id, type, amount_minor, currency, category_id, wallet_id,
						title, occurred_on, occurred_at, created_at, updated_at, seq)
					select lower(hex(randomblob(16))), ?, 'expense', 10000000000000, 'IDR', ?, ?, ?, ?, 0, 0, 0, 1
					from n`
				)
				.bind(p.scope.spaceId, l.cat('kopi'), l.bca, title, wibTodayString())
				.run();
		}
		const r = await run(async () => laporan.load(await ev(p, '/laporan')));
		expect(r).toMatchObject({ kind: 'ok', value: { loadError: null } });
		const report = (r as unknown as { value: { report: LaporanReport } }).value.report;
		expect(report.stats[0]).toEqual({
			currency: 'IDR',
			inMinor: 0,
			outMinor: null,
			netMinor: null
		});
		expect(report.directionMinor).toBeNull();
		expect(report.categories).toEqual([expect.objectContaining({ minor: null, percent: null })]);
		expect(report.merchants).toEqual([{ title: 'Besar', count: 1000, amountMinor: null }]);
		if (report.detail.mode !== 'bulan') throw new Error('month expected');
		expect(report.detail.lines.current.at(-1)).toBeNull();
		expect(report.detail.heatmap.some((d) => d.minor === null && d.level === 4)).toBe(true);
		expect(report.categories[0]!.perUnitMinor).toBeNull();
		const year = await reportOf(p, `/laporan?y=${wibTodayString().slice(0, 4)}`);
		if (year.detail.mode !== 'tahun') throw new Error('year expected');
		expect(year.detail.stack.at(-1)!.total).toBeNull();
		expect(year.detail.averageMinor).toBeNull();
		expect(year.detail.grid[0]!.total).toBeNull();
	});
});

describe('one access rule across spaces (pre-handoff cross-space probe)', () => {
	async function shared() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const l = await ledger({ spaceId, userId: owner.user.id });
		await l.tx({ amountMinor: 4_200_000, title: 'Belanja keluarga' });
		return { owner, member, spaceId };
	}

	it('a member sees the shared space’s figures', async () => {
		const { member, spaceId } = await shared();
		const r = await reportOf(member, '/laporan', spaceId);
		expect(r.stats[0]!.outMinor).toBe(4_200_000);
		expect(r.merchants.map((m) => m.title)).toEqual(['Belanja keluarga']);
	});

	it('a non-member naming the space (cookie or query) only ever sees their own personal space', async () => {
		const { spaceId } = await shared();
		const stranger = await person('Orang lain');
		for (const url of ['/laporan', `/laporan?space=${spaceId}&spaceId=${spaceId}`]) {
			const r = await reportOf(stranger, url, spaceId);
			expect(r.stats).toEqual([{ currency: 'IDR', inMinor: 0, outMinor: 0, netMinor: 0 }]);
			expect(r.merchants).toEqual([]);
		}
	});

	it('a removed member loses the shared figures at once', async () => {
		const { owner, member, spaceId } = await shared();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const r = await reportOf(member, '/laporan', spaceId);
		expect(r.stats[0]!.outMinor).toBe(0);
		expect(r.merchants).toEqual([]);
	});

	it('a stale locals.space (membership gone between hooks and load) is 404, never the figures', async () => {
		const { owner, member, spaceId } = await shared();
		const space = await resolveCurrentSpace(db, member.user.id, spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const event = fakeEvent({
			url: 'http://localhost/laporan',
			routeId: '/(app)/laporan',
			db,
			user: member.user,
			space
		}).event as never;
		expect(await run(async () => laporan.load(event))).toMatchObject({
			kind: 'error',
			status: 404
		});
	});
});

describe('load failure', () => {
	it('a failing query shows the error state with a fixed message, never a 500', async () => {
		const p = await person();
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const space = await resolveCurrentSpace(db, p.user.id, undefined);
		// The access check (a query builder call) passes; every aggregate (raw `db.all`) then fails.
		const failing = new Proxy(db, {
			get: (target, prop) =>
				prop === 'all'
					? () => Promise.reject(new Error('D1_ERROR: boom at /src/lib/server/x.ts'))
					: Reflect.get(target, prop)
		});
		const event = fakeEvent({ url: 'http://localhost/laporan', db: failing, user: p.user, space })
			.event as never;
		const r = await run(async () => laporan.load(event));
		expect(r).toMatchObject({
			kind: 'ok',
			value: { report: null, loadError: 'Laporan tidak bisa dimuat. Coba lagi sebentar lagi.' }
		});
		// The log carries a fixed message plus the error's name only: never the D1 message (SQL text) or object.
		expect(spy).toHaveBeenCalledWith('laporan: report failed', 'Error', '');
		expect(JSON.stringify(spy.mock.calls)).not.toContain('D1_ERROR');
		spy.mockRestore();
	});
});
