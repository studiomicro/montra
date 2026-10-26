import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { acceptInvite, createInvite } from '#lib/server/spaces/invites';
import { createSharedSpace, listMembers, removeMember } from '#lib/server/spaces/spaces';
import {
	BALANCE_INVALID,
	BALANCE_INVALID_CENTS,
	CURRENCY_INVALID,
	EMONEY_FIELD_ONLY,
	EMONEY_ISSUER_REQUIRED,
	LAST_FOUR_INVALID,
	LOAD_FAILED,
	NAME_REQUIRED,
	WALLET_CHANGED,
	WALLET_NOT_FOUND
} from '#lib/server/wallets/messages';
import { addContribution } from '#lib/server/goals/contributions';
import { createGoal } from '#lib/server/goals/repo';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
// Lets one test make the wallet list fail as if D1 were unavailable.
const failList = { on: false };
vi.mock('#lib/server/wallets/repo', async (original) => {
	const real = await original<typeof import('#lib/server/wallets/repo')>();
	return {
		...real,
		listWallets: (...args: Parameters<typeof real.listWallets>) => {
			if (failList.on) throw new Error('D1_ERROR: no such table');
			return real.listWallets(...args);
		}
	};
});

const page = await import('../../src/routes/(app)/dompet/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const ROUTE = '/(app)/dompet';

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

type Action = (event: never) => unknown;
const act = (name: string) => (page.actions as Record<string, Action>)[name] as Action;

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
	const email = `kekayaan${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		Date.now()
	);
	if (!r.ok) throw new Error('setup failed');
	return { user: { id: r.userId, email, name, createdAt: 0 } };
}
type Person = Awaited<ReturnType<typeof person>>;

/** A /dompet event for `who`, its current space resolved like hooks.server.ts does from `spaceCookie`. */
async function ev(
	who: Person | null,
	opts: {
		path?: string;
		form?: Record<string, string>;
		spaceCookie?: string;
		headers?: Record<string, string>;
		locale?: 'id' | 'en';
	} = {}
) {
	const space = who ? await resolveCurrentSpace(db, who.user.id, opts.spaceCookie) : null;
	return fakeEvent({
		url: `http://localhost${opts.path ?? '/dompet'}`,
		routeId: ROUTE,
		db,
		user: who?.user ?? null,
		space,
		form: opts.form,
		headers: opts.headers,
		locale: opts.locale
	}).event as never;
}

const load = async (who: Person | null, path = '/dompet', spaceCookie?: string) =>
	run(async () => page.load(await ev(who, { path, spaceCookie })));
const post = async (
	who: Person,
	name: string,
	form: Record<string, string>,
	spaceCookie?: string,
	locale?: 'id' | 'en'
) => run(async () => act(name)(await ev(who, { form, spaceCookie, locale })));

const valid = (over: Record<string, string> = {}) => ({
	name: 'BCA',
	type: 'bank',
	currency: 'IDR',
	openingBalance: '25.000',
	lastFour: '',
	...over
});

interface LoadedWallet {
	id: string;
	name: string;
	type: string;
	updatedAt: number;
	isFavourite: boolean;
	balanceMinor: number;
	openingBalanceMinor: number;
	currency: string;
	archived: boolean;
	lastFour: string | null;
	emoneyIssuer: string | null;
}
async function walletsOf(who: Person, path = '/dompet', spaceCookie?: string) {
	const r = await load(who, path, spaceCookie);
	if (r.kind !== 'ok') throw new Error(`load failed: ${JSON.stringify(r)}`);
	return r.value.wallets as LoadedWallet[];
}
const rowCount = async () =>
	(await d1.prepare('select count(*) as n from wallets').first<{ n: number }>())!.n;

describe('/dompet load', () => {
	it('sends a signed-out visitor to /masuk', async () => {
		expect(await load(null)).toMatchObject({ kind: 'redirect', status: 303, location: '/masuk' });
	});

	it('an account without wallets gets an empty list (the page shows the empty state, no figure)', async () => {
		const p = await person();
		expect(await load(p)).toMatchObject({
			kind: 'ok',
			value: { wallets: [], loadError: null, showArchived: false, open: null }
		});
	});

	it('a failing list read becomes the error state, never a 500', async () => {
		const p = await person();
		failList.on = true;
		try {
			expect(await load(p)).toMatchObject({
				kind: 'ok',
				value: { wallets: [], loadError: LOAD_FAILED }
			});
		} finally {
			failList.on = false;
		}
	});

	it('opens the form from the URL for the no-JavaScript path', async () => {
		const p = await person();
		expect(await load(p, '/dompet?tambah=1')).toMatchObject({ value: { open: 'add' } });
		expect(await load(p, '/dompet?ubah=abc')).toMatchObject({ value: { open: 'abc' } });
	});

	it('FN-39: a quick-pick link prefills only a new wallet, only with a known pick', async () => {
		const p = await person();
		expect(await load(p, '/dompet?tambah=1&dompet=gopay')).toMatchObject({
			value: { open: 'add', quickPick: 'gopay' }
		});
		for (const path of [
			'/dompet?tambah=1&dompet=grabpay',
			'/dompet?tambah=1&dompet=__proto__',
			'/dompet?tambah=1&dompet=' + 'x'.repeat(5000),
			'/dompet?ubah=abc&dompet=ovo',
			'/dompet?dompet=dana'
		])
			expect(await load(p, path)).toMatchObject({ value: { quickPick: null } });
		// The prefilled form posts like any other; the name stays what the user finally typed.
		expect(
			await post(p, 'createWallet', valid({ name: 'GoPay Kantor', type: 'e_wallet' }))
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		expect((await walletsOf(p)).map((w) => [w.name, w.type])).toEqual([
			['GoPay Kantor', 'e_wallet']
		]);
	});
});

describe('/dompet Total saldo (wave C)', () => {
	it('sums live wallets per currency with the favourite’s currency first; archived ones never count', async () => {
		const p = await person();
		await post(p, 'createWallet', valid({ name: 'BCA', openingBalance: '1.000.000' }));
		await post(p, 'createWallet', valid({ name: 'Tunai', openingBalance: '250.000' }));
		await post(
			p,
			'createWallet',
			valid({ name: 'Wise', currency: 'USD', openingBalance: '40', favourite: 'on' })
		);
		await post(p, 'createWallet', valid({ name: 'Lama', openingBalance: '999.000' }));
		const lama = (await walletsOf(p)).find((w) => w.name === 'Lama')!;
		await post(p, 'archiveWallet', { walletId: lama.id, updatedAt: String(lama.updatedAt) });
		const r = await load(p);
		expect(r).toMatchObject({
			kind: 'ok',
			value: {
				heroCurrency: 'USD',
				totals: [
					{ currency: 'USD', totalMinor: 4_000 },
					{ currency: 'IDR', totalMinor: 125_000_000 }
				],
				setAside: []
			}
		});
	});

	it('the live goals’ savings are what is set aside; archived goals and other spaces never count', async () => {
		const p = await person();
		const other = await person();
		const scopeOf = async (who: Person) => ({
			spaceId: (await resolveCurrentSpace(db, who.user.id, undefined))!.id,
			userId: who.user.id
		});
		const mine = await scopeOf(p);
		for (const [scope, saved] of [
			[mine, 450_000_000],
			[mine, 120_000_000],
			[await scopeOf(other), 999_00]
		] as const) {
			const g = await createGoal(
				db,
				scope,
				{ name: 'Liburan', targetAmountMinor: 3_000_000_000 },
				1
			);
			if (!g.ok) throw new Error('goal failed');
			await addContribution(db, scope, g.id, { amountMinor: saved, note: null }, 2);
		}
		expect(await load(p)).toMatchObject({
			value: { setAside: [{ currency: 'IDR', savedMinor: 570_000_000 }], goalsError: null }
		});
	});

	it('a member’s totals are the shared space’s only, never their personal wallets', async () => {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await post(owner, 'createWallet', valid({ openingBalance: '10.000' }), spaceId);
		await post(member, 'createWallet', valid({ openingBalance: '7.000' }));
		expect(await load(member, '/dompet', spaceId)).toMatchObject({
			value: { totals: [{ currency: 'IDR', totalMinor: 1_000_000 }] }
		});
		expect(await load(member)).toMatchObject({
			value: { totals: [{ currency: 'IDR', totalMinor: 700_000 }] }
		});
	});
});

describe('createWallet', () => {
	it('saves, survives a reload, and shows the balance equal to the opening balance', async () => {
		const p = await person();
		expect(await post(p, 'createWallet', valid({ lastFour: '1234' }))).toEqual({
			kind: 'ok',
			value: { saved: 'created' }
		});
		const [w] = await walletsOf(p);
		expect(w).toMatchObject({
			name: 'BCA',
			isFavourite: true,
			openingBalanceMinor: 2_500_000,
			balanceMinor: 2_500_000,
			currency: 'IDR',
			lastFour: '1234'
		});
	});

	it('refuses invalid fields with field errors and writes nothing', async () => {
		const p = await person();
		const before = await rowCount();
		const r = await post(
			p,
			'createWallet',
			valid({
				name: '​\u0000',
				lastFour: '4111111111111111',
				currency: 'XAU',
				openingBalance: '1.000,50'
			})
		);
		expect(r).toMatchObject({
			kind: 'fail',
			status: 400,
			data: {
				action: 'create',
				errors: {
					name: NAME_REQUIRED,
					lastFour: LAST_FOUR_INVALID,
					currency: CURRENCY_INVALID,
					openingBalanceMinor: BALANCE_INVALID
				}
			}
		});
		expect(await rowCount()).toBe(before);
	});

	it('never echoes a refused card number and refuses a decimal balance (red team L1, L2)', async () => {
		const p = await person();
		const before = await rowCount();
		const card = await post(p, 'createWallet', valid({ lastFour: '4111111111111111' }));
		expect(card).toMatchObject({ kind: 'fail', status: 400 });
		expect(JSON.stringify(card)).not.toContain('4111111111111111');
		const decimal = await post(
			p,
			'createWallet',
			valid({ currency: 'USD', openingBalance: '12.50' })
		);
		expect(decimal).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { openingBalanceMinor: BALANCE_INVALID_CENTS } }
		});
		expect(await rowCount()).toBe(before);
	});

	it('answers 400 to a 20 KB body and 415 to a non-form body, never 500, writing nothing', async () => {
		const p = await person();
		const before = await rowCount();
		expect(await post(p, 'createWallet', valid({ name: 'x'.repeat(20 * 1024) }))).toMatchObject({
			kind: 'error',
			status: 400
		});
		const plain = await run(async () =>
			act('createWallet')(
				await ev(p, {
					form: valid(),
					headers: { 'content-type': 'text/plain' }
				})
			)
		);
		expect(plain).toMatchObject({ kind: 'error', status: 415 });
		expect(await rowCount()).toBe(before);
	});
});

describe('FN-58 pass 1: "Kartu e-money"', () => {
	it('an e-money pick link prefills only a new wallet, only with a known issuer', async () => {
		const p = await person();
		expect(await load(p, '/dompet?tambah=1&kartu=bca_flazz')).toMatchObject({
			value: { open: 'add', emoneyPick: 'bca_flazz' }
		});
		for (const path of [
			'/dompet?tambah=1&kartu=gopay',
			'/dompet?tambah=1&kartu=__proto__',
			'/dompet?ubah=abc&kartu=kmt',
			'/dompet?kartu=kmt'
		])
			expect(await load(p, path)).toMatchObject({ value: { emoneyPick: null } });
	});

	it('saves an e_wallet with its issuer and last 4; refuses the choice without an issuer, writing nothing', async () => {
		const p = await person();
		const before = await rowCount();
		expect(
			await post(p, 'createWallet', valid({ name: 'Flazz', type: 'e_money', emoneyIssuer: '' }))
		).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { emoneyIssuer: EMONEY_ISSUER_REQUIRED }, values: { type: 'e_money' } }
		});
		expect(await rowCount()).toBe(before);
		expect(
			await post(
				p,
				'createWallet',
				valid({
					name: 'Flazz',
					type: 'e_money',
					emoneyIssuer: 'bca_flazz',
					lastFour: '0042',
					openingBalance: '150.000'
				})
			)
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		const [w] = await walletsOf(p);
		expect(w).toMatchObject({
			name: 'Flazz',
			type: 'e_wallet',
			emoneyIssuer: 'bca_flazz',
			lastFour: '0042',
			balanceMinor: 15_000_000
		});
		// The edit form posts the same choice back; another type clears the issuer.
		expect(
			await post(
				p,
				'updateWallet',
				valid({
					walletId: w!.id,
					updatedAt: String(w!.updatedAt),
					name: 'Flazz',
					type: 'e_wallet',
					emoneyIssuer: 'bca_flazz'
				})
			)
		).toMatchObject({
			kind: 'fail',
			status: 400,
			data: { errors: { emoneyIssuer: EMONEY_FIELD_ONLY } }
		});
		expect(
			await post(
				p,
				'updateWallet',
				valid({ walletId: w!.id, updatedAt: String(w!.updatedAt), name: 'Flazz', type: 'e_wallet' })
			)
		).toEqual({ kind: 'ok', value: { saved: 'updated' } });
		expect((await walletsOf(p))[0]).toMatchObject({ type: 'e_wallet', emoneyIssuer: null });
	});
});

describe('updateWallet, archive, restore, favourite', () => {
	it('a second tab’s stale edit gets "changed meanwhile"; the first edit stays', async () => {
		const p = await person();
		await post(p, 'createWallet', valid());
		const [w] = await walletsOf(p);
		const form = (name: string) => ({
			...valid({ name }),
			walletId: w!.id,
			updatedAt: String(w!.updatedAt)
		});
		expect(await post(p, 'updateWallet', form('Tab satu'))).toEqual({
			kind: 'ok',
			value: { saved: 'updated' }
		});
		expect(await post(p, 'updateWallet', form('Tab dua'))).toEqual({
			kind: 'fail',
			status: 409,
			data: { error: WALLET_CHANGED }
		});
		const [after] = await walletsOf(p);
		expect(after!.name).toBe('Tab satu');
		expect(after!.updatedAt).toBeGreaterThan(w!.updatedAt);
	});

	it('an edited opening balance is the balance on the next load', async () => {
		const p = await person();
		await post(p, 'createWallet', valid());
		const [w] = await walletsOf(p);
		await post(p, 'updateWallet', {
			...valid({ openingBalance: '1.250.000', negative: 'on', type: 'kartu_kredit' }),
			walletId: w!.id,
			updatedAt: String(w!.updatedAt)
		});
		expect((await walletsOf(p))[0]).toMatchObject({
			openingBalanceMinor: -125_000_000,
			balanceMinor: -125_000_000
		});
	});

	it('a malformed updatedAt is treated as stale, never as a match', async () => {
		const p = await person();
		await post(p, 'createWallet', valid());
		const [w] = await walletsOf(p);
		for (const updatedAt of ['', 'abc', '1e3', '-1', '9'.repeat(40)])
			expect(
				await post(p, 'updateWallet', { ...valid({ name: 'X' }), walletId: w!.id, updatedAt })
			).toMatchObject({ kind: 'fail', status: 409 });
	});

	it('archive hides the wallet and moves the favourite; the archive view restores it', async () => {
		const p = await person();
		await post(p, 'createWallet', valid({ name: 'A' }));
		await post(p, 'createWallet', valid({ name: 'B' }));
		const [a] = await walletsOf(p);
		expect(a!.name).toBe('A');
		expect(
			await post(p, 'archiveWallet', { walletId: a!.id, updatedAt: String(a!.updatedAt) })
		).toEqual({ kind: 'ok', value: { saved: 'archived' } });
		const live = await walletsOf(p);
		expect(live.map((w) => [w.name, w.isFavourite])).toEqual([['B', true]]);
		const all = await walletsOf(p, '/dompet?arsip=1');
		const archived = all.find((w) => w.archived)!;
		expect(archived.name).toBe('A');
		expect(
			await post(p, 'restoreWallet', {
				walletId: archived.id,
				updatedAt: String(archived.updatedAt)
			})
		).toEqual({ kind: 'ok', value: { saved: 'restored' } });
		expect((await walletsOf(p)).map((w) => w.name)).toEqual(['B', 'A']);
	});

	it('20 concurrent favourite submissions across two wallets leave exactly one favourite', async () => {
		const p = await person();
		await post(p, 'createWallet', valid({ name: 'A' }));
		await post(p, 'createWallet', valid({ name: 'B' }));
		const [a, b] = await walletsOf(p);
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				post(p, 'setFavourite', { walletId: (i % 2 ? a : b)!.id })
			)
		);
		expect(results.every((r) => r.kind === 'ok')).toBe(true);
		expect((await walletsOf(p)).filter((w) => w.isFavourite)).toHaveLength(1);
	});
});

describe('/dompet: one access rule', () => {
	async function sharedWithWallet() {
		const owner = await person('Pemilik');
		const member = await person('Anggota');
		const spaceId = (await createSharedSpace(db, owner.user.id, 'Keluarga', Date.now()))!;
		const invite = (await createInvite(
			db,
			{ spaceId, userId: owner.user.id, replaces: '' },
			Date.now()
		))!;
		await acceptInvite(db, invite.token, member.user.id, Date.now());
		await post(owner, 'createWallet', valid({ name: 'Dompet Keluarga' }), spaceId);
		const [w] = await walletsOf(owner, '/dompet', spaceId);
		return { owner, member, spaceId, wallet: w! };
	}

	it('a member works on the shared space’s wallets', async () => {
		const { member, spaceId, wallet } = await sharedWithWallet();
		expect((await walletsOf(member, '/dompet', spaceId)).map((w) => w.id)).toEqual([wallet.id]);
		expect(
			await post(
				member,
				'updateWallet',
				{
					...valid({ name: 'Belanja rumah' }),
					walletId: wallet.id,
					updatedAt: String(wallet.updatedAt)
				},
				spaceId
			)
		).toMatchObject({ kind: 'ok' });
	});

	it('a non-member and a removed member see nothing and get the unknown-id answer on every action', async () => {
		const { owner, member, spaceId, wallet } = await sharedWithWallet();
		const stranger = await person();
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		const snapshot = async () =>
			JSON.stringify(
				(await d1.prepare('select * from wallets where space_id = ?').bind(spaceId).all()).results
			);
		const before = await snapshot();
		const forms = (id: string) => ({
			updateWallet: {
				...valid({ name: 'Diambil' }),
				walletId: id,
				updatedAt: String(wallet.updatedAt)
			},
			archiveWallet: { walletId: id, updatedAt: String(wallet.updatedAt) },
			restoreWallet: { walletId: id, updatedAt: String(wallet.updatedAt) },
			setFavourite: { walletId: id }
		});
		const unknown = crypto.randomUUID();
		for (const who of [stranger, member]) {
			// Even naming the shared space in the cookie: it is re-validated and falls back to their own space.
			const listed = await walletsOf(who, '/dompet?arsip=1', spaceId);
			expect(listed.map((w) => w.id)).not.toContain(wallet.id);
			for (const [name, form] of Object.entries(forms(wallet.id))) {
				const theirs = await post(who, name, form, spaceId);
				const missing = await post(who, name, forms(unknown)[name as 'setFavourite'], spaceId);
				expect(theirs).toEqual({ kind: 'fail', status: 404, data: { error: WALLET_NOT_FOUND } });
				expect(missing).toEqual(theirs);
			}
		}
		expect(await snapshot()).toBe(before);
	});

	it('a stale current space (membership removed after the request resolved it) gets the helper’s 404', async () => {
		const { owner, member, spaceId, wallet } = await sharedWithWallet();
		const stale = await resolveCurrentSpace(db, member.user.id, spaceId);
		expect(stale?.id).toBe(spaceId);
		const row = (await listMembers(db, spaceId, owner.user.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.user.id, memberId: row.id }, Date.now());
		const event = (form?: Record<string, string>) =>
			fakeEvent({
				url: 'http://localhost/dompet',
				routeId: ROUTE,
				db,
				user: member.user,
				space: stale,
				form
			}).event as never;
		expect(await run(() => page.load(event()))).toEqual({
			kind: 'error',
			status: 404,
			body: { message: 'Not found', status: 404 }
		});
		expect(await run(() => act('setFavourite')(event({ walletId: wallet.id })))).toMatchObject({
			kind: 'error',
			status: 404
		});
	});

	it('user-facing answers never carry an id', async () => {
		const { member, wallet } = await sharedWithWallet();
		const r = await post(member, 'setFavourite', { walletId: wallet.id });
		expect(JSON.stringify(r)).not.toContain(wallet.id);
	});
});

describe('FN-47: TWD, HKD, CNY and amounts with cents (no-JS form posts)', () => {
	it('a USD opening balance of 12,50 (id) is stored as 1250 minor units and shows on reload', async () => {
		const p = await person();
		expect(
			await post(p, 'createWallet', valid({ currency: 'USD', openingBalance: '12,50' }))
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		expect(await walletsOf(p)).toMatchObject([
			{ currency: 'USD', openingBalanceMinor: 1250, balanceMinor: 1250 }
		]);
	});

	it('reads the English separators in an English session: 1,250.50 → 125050', async () => {
		const p = await person();
		expect(
			await post(
				p,
				'createWallet',
				valid({ currency: 'EUR', openingBalance: '1,250.50' }),
				undefined,
				'en'
			)
		).toEqual({ kind: 'ok', value: { saved: 'created' } });
		expect((await walletsOf(p))[0]).toMatchObject({
			currency: 'EUR',
			openingBalanceMinor: 125_050
		});
	});

	it('refuses a third fraction digit (USD) and any fraction for IDR: nothing is created or rounded', async () => {
		const p = await person();
		const before = await rowCount();
		// QA FN-47 #2: a currency with cents is told its two-digit rule; IDR and JPY keep "tanpa sen".
		for (const [form, refusal] of [
			[valid({ currency: 'USD', openingBalance: '12,345' }), BALANCE_INVALID_CENTS],
			[valid({ currency: 'IDR', openingBalance: '25,50' }), BALANCE_INVALID],
			[valid({ currency: 'JPY', openingBalance: '25,50' }), BALANCE_INVALID]
		] as const)
			expect(await post(p, 'createWallet', form)).toMatchObject({
				kind: 'fail',
				status: 400,
				data: { errors: { openingBalanceMinor: refusal } }
			});
		expect(await rowCount()).toBe(before);
	});

	it('TWD, HKD and CNY wallets keep their currency and balance across a reload', async () => {
		const p = await person();
		for (const [currency, openingBalance] of [
			['TWD', '1.000,25'],
			['HKD', '500'],
			['CNY', '88,80']
		] as const)
			expect(
				await post(p, 'createWallet', valid({ name: currency, currency, openingBalance }))
			).toEqual({ kind: 'ok', value: { saved: 'created' } });
		const byName = Object.fromEntries((await walletsOf(p)).map((w) => [w.name, w]));
		expect(byName.TWD).toMatchObject({ currency: 'TWD', openingBalanceMinor: 100_025 });
		expect(byName.HKD).toMatchObject({ currency: 'HKD', openingBalanceMinor: 50_000 });
		expect(byName.CNY).toMatchObject({ currency: 'CNY', openingBalanceMinor: 8_880 });
	});
});
