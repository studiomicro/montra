import { isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { getDb, type Db } from '#lib/server/db';
import { countStatements } from '#lib/server/db/statement-count';
import { createSeries, pauseSeries } from '#lib/server/recurring/repo';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import { closeDay } from '#lib/server/streak/repo';
import { createSubscription } from '#lib/server/subscriptions/repo';
import { listTransactionsByDay, PAGE_SIZE } from '#lib/server/transactions/aggregate';
import { createTransaction } from '#lib/server/transactions/repo';
import type { TransactionInput } from '#lib/server/transactions/validation';
import { createWallet } from '#lib/server/wallets/repo';
import type { DueItem } from '#lib/shared/calendar';
import { monthOf, shiftMonth, wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

// Injected read failures (criterion 24): each of the four reads can be made to throw on its own.
const failing = new Set<string>();
vi.mock('#lib/server/calendar/month', async (original) => {
	const m = await original<typeof import('#lib/server/calendar/month')>();
	const wrap =
		<A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
		(...a: A) =>
			failing.has(name) ? Promise.reject(new Error(`injected ${name}`)) : fn(...a);
	return {
		...m,
		calendarSpending: wrap('spending', m.calendarSpending),
		calendarClosures: wrap('closures', m.calendarClosures),
		calendarSchedules: wrap('upcoming', m.calendarSchedules),
		calendarDayRows: wrap('day', m.calendarDayRows)
	};
});

const kalender = await import('../../src/routes/(app)/kalender/+page.server');
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
afterEach(() => {
	failing.clear();
	vi.useRealTimers();
});

let n = 0;
async function person(name = 'Uji') {
	const email = `kalender${++n}@contoh.id`;
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

async function ledger(scope: SpaceScope) {
	await ensurePresetCategories(db, scope.spaceId, NOW);
	const cats = await listCategories(db, scope.spaceId);
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
		NOW
	);
	if (!w.ok) throw new Error('wallet failed');
	const cat = (tile: string) => cats.find((c) => c.tileKey === tile)!.id;
	const tx = async (over: Partial<TransactionInput>) => {
		const r = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				walletId: w.id,
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
		if (!r.ok) throw new Error('tx failed');
		return r.id;
	};
	return { walletId: w.id, cat, tx };
}

type Data = {
	today: string;
	month: string;
	day: string | null;
	neighbours: { prev: string | null; next: string | null };
	spending: {
		currency: string;
		otherCurrencies: boolean;
		days: { date: string; minor: number | null; future: boolean }[];
	} | null;
	closedOn: string[] | null;
	upcoming: DueItem[] | null;
	dayRows: { group: { totals: unknown; rows: { id: string; isDemo: boolean }[] } | null } | null;
};

async function load(who: Person | null, url = '/kalender', space?: string, viaDb = db) {
	const resolved = who ? await resolveCurrentSpace(viaDb, who.user.id, space) : null;
	const { event } = fakeEvent({
		url: `http://localhost${url}`,
		routeId: '/(app)/kalender',
		db: viaDb,
		user: who?.user ?? null,
		space: resolved
	});
	try {
		return { kind: 'ok' as const, data: (await kalender.load(event as never)) as unknown as Data };
	} catch (e) {
		if (isRedirect(e)) return { kind: 'redirect' as const, location: e.location };
		if (isHttpError(e)) return { kind: 'error' as const, status: e.status };
		throw e;
	}
}
const data = async (who: Person, url?: string, space?: string) => {
	const r = await load(who, url, space);
	if (r.kind !== 'ok') throw new Error(JSON.stringify(r));
	return r.data;
};
const cell = (d: Data, date: string) => d.spending!.days.find((x) => x.date === date);

describe('/kalender access (criteria 18, 39)', () => {
	it('signed out goes to /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', location: '/masuk' });
	});

	it('two users, two spaces: each sees only their own rows, bills and closures, whatever bulan/hari say', async () => {
		const a = await person('A');
		const b = await person('B');
		const la = await ledger(a.scope);
		await ledger(b.scope);
		const today = wibTodayString();
		await la.tx({ amountMinor: 7_700_000 });
		await createSubscription(
			db,
			a.scope,
			{
				catalogueId: null,
				name: 'Rahasia A',
				category: 'streaming',
				amountMinor: 5_000_000,
				currency: 'IDR',
				schedule: { cycle: 'monthly', day: 28, month: null },
				walletId: null,
				reminderDaysBefore: 1
			},
			today,
			NOW
		);
		await closeDay(db, a.user.id, today, NOW);

		const asA = await data(a, `/kalender?hari=${today}`);
		expect(cell(asA, today)?.minor).toBe(7_700_000);
		expect(asA.closedOn).toEqual([today]);

		for (const url of [
			'/kalender',
			`/kalender?hari=${today}`,
			`/kalender?bulan=${monthOf(today)}`
		]) {
			const asB = await data(b, url);
			expect(asB.spending!.days.every((x) => x.minor === 0)).toBe(true);
			expect(asB.closedOn).toEqual([]);
			expect(JSON.stringify(asB)).not.toContain('Rahasia A');
			expect(asB.dayRows?.group ?? null).toBeNull();
		}
		// Naming A's space as the current one (a forged cookie) only ever reaches B's own space.
		const forged = await data(b, '/kalender', a.scope.spaceId);
		expect(JSON.stringify(forged)).not.toContain('Rahasia A');
		expect(cell(forged, today)?.minor).toBe(0);
	});

	it('a shared space: members see its rows; closures stay each account’s own; a removed member loses it', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', NOW))!;
		const invite = (await createInvite(db, { spaceId, userId: owner.user.id, replaces: '' }, NOW))!;
		await acceptInvite(db, invite.token, member.user.id, NOW);
		const shared = await ledger({ spaceId, userId: owner.user.id });
		const today = wibTodayString();
		await shared.tx({ amountMinor: 4_200_000 });
		await closeDay(db, owner.user.id, today, NOW);

		const asMember = await data(member, '/kalender', spaceId);
		expect(cell(asMember, today)?.minor).toBe(4_200_000);
		expect(asMember.closedOn).toEqual([]);
		expect((await data(owner, '/kalender', spaceId)).closedOn).toEqual([today]);

		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, NOW);
		const after = await data(member, '/kalender', spaceId);
		expect(cell(after, today)?.minor).toBe(0);
	});
});

describe('?bulan= and ?hari= (criterion 19)', () => {
	it('missing, malformed or out-of-window months show this WIB month; in-window months show; next stops at the end', async () => {
		const p = await person();
		const thisMonth = monthOf(wibTodayString());
		for (const bad of [
			'',
			'2026-13',
			'abc',
			'x'.repeat(200),
			shiftMonth(thisMonth, -24),
			shiftMonth(thisMonth, 3)
		])
			expect((await data(p, `/kalender?bulan=${encodeURIComponent(bad)}`)).month).toBe(thisMonth);
		const last = shiftMonth(thisMonth, 2);
		const d = await data(p, `/kalender?bulan=${last}`);
		expect(d.month).toBe(last);
		expect(d.neighbours.next).toBeNull();
		expect(
			(await data(p, `/kalender?bulan=${shiftMonth(thisMonth, -23)}`)).neighbours.prev
		).toBeNull();
	});

	it('hari outside the shown month or invalid is ignored; this month defaults to today, others to none', async () => {
		const p = await person();
		const today = wibTodayString();
		const thisMonth = monthOf(today);
		const prev = shiftMonth(thisMonth, -1);
		expect((await data(p, '/kalender')).day).toBe(today);
		expect((await data(p, `/kalender?bulan=${prev}`)).day).toBeNull();
		expect((await data(p, `/kalender?bulan=${prev}&hari=${today}`)).day).toBeNull();
		expect((await data(p, `/kalender?hari=2026-02-30`)).day).toBe(today);
		expect((await data(p, `/kalender?bulan=${prev}&hari=${prev}-15`)).day).toBe(`${prev}-15`);
	});
});

describe('WIB days and leap years (criterion 20)', () => {
	it('23:30 WIB on 31 Oct is the 31st; 00:30 WIB on 1 Nov is the 1st of November', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-05T05:00:00Z'));
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ occurredOn: '2026-10-31', occurredTime: '23:30', amountMinor: 1_000_000 });
		await l.tx({ occurredOn: '2026-11-01', occurredTime: '00:30', amountMinor: 3_000_000 });
		const oct = await data(p, '/kalender?bulan=2026-10');
		expect(cell(oct, '2026-10-31')?.minor).toBe(1_000_000);
		expect(oct.spending!.days).toHaveLength(31);
		const nov = await data(p, '/kalender');
		expect(nov.month).toBe('2026-11');
		expect(cell(nov, '2026-11-01')?.minor).toBe(3_000_000);
		expect(cell(nov, '2026-11-06')?.future).toBe(true);
	});

	it('February 2028 has 29 cells', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2028-03-10T05:00:00Z'));
		const p = await person();
		const feb = await data(p, '/kalender?bulan=2028-02');
		expect(feb.spending!.days).toHaveLength(29);
		expect(feb.spending!.days.at(-1)?.date).toBe('2028-02-29');
	});
});

describe('reconciliation with Riwayat (criterion 21)', () => {
	it('a day’s figure and rows equal Riwayat’s one-day view; demo rows listed, never counted', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const day = wibTodayString();
		await l.tx({ amountMinor: 2_500_000, occurredOn: day });
		await l.tx({ amountMinor: 7_300_000, occurredOn: day, categoryId: l.cat('makan') });
		await l.tx({
			type: 'income',
			amountMinor: 9_000_000,
			occurredOn: day,
			categoryId: l.cat('gaji')
		});
		const demo = await l.tx({ amountMinor: 1_000_000, occurredOn: day });
		await d1.prepare('update transactions set is_demo = 1 where id = ?').bind(demo).run();

		const k = await data(p, `/kalender?bulan=${monthOf(day)}&hari=${day}`);
		const { event } = fakeEvent({
			url: `http://localhost/riwayat?period=range&from=${day}&to=${day}`,
			routeId: '/(app)/riwayat',
			db,
			user: p.user,
			space: await resolveCurrentSpace(db, p.user.id, undefined)
		});
		const r = (await riwayat.load(event as never)) as unknown as {
			page: {
				days: { totals: { currency: string; outMinor: number }[]; rows: { id: string }[] }[];
			};
		};
		const riwayatDay = r.page.days[0]!;
		const riwayatOut = riwayatDay.totals.find((t) => t.currency === 'IDR')!.outMinor;
		expect(cell(k, day)?.minor).toBe(riwayatOut);
		expect(riwayatOut).toBe(9_800_000);
		expect(k.dayRows!.group!.rows.map((x) => x.id)).toEqual(riwayatDay.rows.map((x) => x.id));
		expect(k.dayRows!.group!.rows.find((x) => x.id === demo)?.isDemo).toBe(true);
		// The same aggregate the calendar's day list uses.
		const page = await listTransactionsByDay(
			db,
			p.scope.spaceId,
			{ from: day, to: day, type: null, categoryId: null, walletId: null, q: null },
			{ limit: PAGE_SIZE }
		);
		expect(page.days[0]!.totals).toEqual(riwayatDay.totals);
	});

	it('money in another currency is left out of the cells and flagged once', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const usd = await createWallet(
			db,
			p.scope,
			{
				name: 'Wise',
				type: 'bank',
				currency: 'USD',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!usd.ok) throw new Error('wallet failed');
		const today = wibTodayString();
		await l.tx({ amountMinor: 1_000_000 });
		expect((await data(p)).spending!.otherCurrencies).toBe(false);
		await l.tx({ walletId: usd.id, currency: 'USD', amountMinor: 999 });
		const d = await data(p);
		expect(d.spending!.otherCurrencies).toBe(true);
		expect(cell(d, today)?.minor).toBe(1_000_000);
	});
});

describe('bills and recurring items still to come (criterion 22)', () => {
	it('future dates only, active series only, demo badged; a fixed read count however many subscriptions', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		const today = wibTodayString();
		const thisMonth = monthOf(today);
		const sub = (name: string, day: number) =>
			createSubscription(
				db,
				p.scope,
				{
					catalogueId: null,
					name,
					category: 'streaming',
					amountMinor: 5_499_000,
					currency: 'IDR',
					schedule: { cycle: 'monthly', day, month: null },
					walletId: l.walletId,
					reminderDaysBefore: 1
				},
				today,
				NOW
			);
		await sub('Streaming 31', 31);
		const active = await createSeries(
			db,
			p.scope,
			{
				type: 'expense',
				amountMinor: 150_000_00,
				currency: 'IDR',
				walletId: l.walletId,
				categoryId: l.cat('tempat-tinggal'),
				title: 'Kos',
				note: null,
				schedule: { frequency: 'weekly', day: 1 },
				startOn: today,
				endOn: null
			},
			today,
			NOW
		);
		const paused = await createSeries(
			db,
			p.scope,
			{
				type: 'expense',
				amountMinor: 1_00,
				currency: 'IDR',
				walletId: l.walletId,
				categoryId: l.cat('tempat-tinggal'),
				title: 'Dijeda',
				note: null,
				schedule: { frequency: 'weekly', day: 2 },
				startOn: today,
				endOn: null
			},
			today,
			NOW
		);
		if (!active.ok || !paused.ok) throw new Error('series failed');
		const pausedRow = await d1
			.prepare('select updated_at as u from recurring_transactions where id = ?')
			.bind(paused.id)
			.first<{ u: number }>();
		await pauseSeries(db, p.scope, paused.id, pausedRow!.u, NOW);
		await d1
			.prepare("update subscriptions set is_demo = 1 where name = 'Streaming 31' and space_id = ?")
			.bind(p.scope.spaceId)
			.run();

		const next = shiftMonth(thisMonth, 1);
		const d = await data(p, `/kalender?bulan=${next}`);
		const items = d.upcoming!;
		expect(items.some((i) => i.title === 'Dijeda')).toBe(false);
		const kos = items.filter((i) => i.title === 'Kos');
		expect(kos.length).toBeGreaterThanOrEqual(4);
		expect(kos.every((i) => i.date >= `${next}-01`)).toBe(true);
		const streaming = items.find((i) => i.title === 'Streaming 31');
		expect(streaming?.isDemo).toBe(true);
		expect(streaming?.walletName).toBe('BCA');
		expect(items.every((i) => i.date >= today)).toBe(true);
		// A past month never projects anything.
		expect((await data(p, `/kalender?bulan=${shiftMonth(thisMonth, -1)}`)).upcoming).toEqual([]);

		// Reads: the same number with 1 or 100 subscriptions (no per-item query).
		const reads = async () => {
			const counted = countStatements(d1);
			await load(p, `/kalender?bulan=${next}`, undefined, getDb(counted.d1));
			return counted.statements();
		};
		const before = await reads();
		for (let i = 0; i < 99; i++) await sub(`Langganan ${i}`, (i % 28) + 1);
		const after = await reads();
		expect(after).toBe(before);
		const many = await data(p, `/kalender?bulan=${next}`);
		expect(many.upcoming!.filter((i) => i.kind === 'subscription').length).toBeGreaterThanOrEqual(
			100
		);
	});
});

describe('states (criterion 24)', () => {
	it('one read failing never blanks the others', async () => {
		const p = await person();
		const l = await ledger(p.scope);
		await l.tx({ amountMinor: 1_200_000 });
		failing.add('closures');
		const d = await data(p);
		expect(d.closedOn).toBeNull();
		expect(cell(d, wibTodayString())?.minor).toBe(1_200_000);
		expect(d.upcoming).toEqual([]);
		expect(d.dayRows).not.toBeNull();
	});

	it('every read failing: all four null (the page shows one error with retry), never a thrown 500', async () => {
		const p = await person();
		for (const name of ['spending', 'closures', 'upcoming', 'day']) failing.add(name);
		const d = await data(p);
		expect([d.spending, d.closedOn, d.upcoming, d.dayRows]).toEqual([null, null, null, null]);
	});
});
