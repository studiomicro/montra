import { isRedirect } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, type Db } from '#lib/server/db';
import { STORY_OFF_COOKIE, STORY_SEEN_COOKIE } from '#lib/shared/daily-story';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';

// FN-54 D3: the daily greeting's off switch (Pengaturan › Tampilan, and "Matikan sapaan harian" in the sheet). A
// device cookie written by the server, never a D1 row (owner decision 3).

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));
const tampilan = await import('../../src/routes/(app)/pengaturan/tampilan/+page.server');

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
	binding.DB = d1;
});
afterAll(() => dispose());

const user = { id: 'u-sapaan', email: 'sapaan@contoh.id', name: 'Uji', createdAt: 0 };
type Action = (event: never) => unknown;

function post(form: Record<string, string>, cookies: Record<string, string> = {}, signedIn = true) {
	return fakeEvent({
		url: 'http://localhost/pengaturan/tampilan?/sapaan',
		routeId: '/(app)/pengaturan/tampilan',
		db,
		user: signedIn ? user : null,
		form,
		cookies
	});
}

describe('sapaan action (criteria 33, 45)', () => {
	it('off: sets montra-sapaan-off=1 for a year, HttpOnly, Lax, on / — and answers only after the write', async () => {
		const { event, written } = post({});
		const result = await (tampilan.actions.sapaan as Action)(event as never);
		expect(result).toEqual({ sapaan: 'off' });
		expect(written.get(STORY_OFF_COOKIE)).toEqual({
			value: '1',
			options: { path: '/', maxAge: 31_536_000, sameSite: 'lax', secure: false, httpOnly: true }
		});
	});

	it('on: clears the off switch and today’s "seen", so the sheet is due again today', async () => {
		const { event, written, jar } = post(
			{ enabled: 'on' },
			{ [STORY_OFF_COOKIE]: '1', [STORY_SEEN_COOKIE]: '2026-10-13' }
		);
		expect(await (tampilan.actions.sapaan as Action)(event as never)).toEqual({ sapaan: 'on' });
		expect(written.get(STORY_OFF_COOKIE)?.value).toBe('');
		expect(written.get(STORY_SEEN_COOKIE)?.value).toBe('');
		expect(jar.has(STORY_OFF_COOKIE)).toBe(false);
	});

	it('the page reads the switch from the cookie (survives a reload)', async () => {
		const load = tampilan.load as unknown as (e: never) => { sapaanOn: boolean };
		expect(load(post({}, { [STORY_OFF_COOKIE]: '1' }).event as never)).toEqual({ sapaanOn: false });
		expect(load(post({}).event as never)).toEqual({ sapaanOn: true });
		expect(load(post({}, { [STORY_OFF_COOKIE]: 'yes' }).event as never)).toEqual({
			sapaanOn: true
		});
	});

	it('signed out: sent to /masuk, nothing written', async () => {
		const { event, written } = post({}, {}, false);
		try {
			await (tampilan.actions.sapaan as Action)(event as never);
			expect.unreachable();
		} catch (e) {
			expect(isRedirect(e) && e.location).toBe('/masuk?next=%2Fpengaturan%2Ftampilan');
		}
		expect(written.size).toBe(0);
	});

	it('the theme action keeps its own name and behaviour', async () => {
		const { event, written } = fakeEvent({
			url: 'http://localhost/pengaturan/tampilan?/theme',
			routeId: '/(app)/pengaturan/tampilan',
			db,
			user,
			form: { theme: 'neon' }
		});
		const r = (await (tampilan.actions.theme as Action)(event as never)) as { status: number };
		expect(r.status).toBe(400);
		expect(written.size).toBe(0);
	});
});
