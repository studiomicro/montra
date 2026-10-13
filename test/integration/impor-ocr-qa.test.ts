import { isActionFailure, isHttpError, isRedirect } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { resolveCurrentSpace, type SpaceScope } from '#lib/server/spaces/access';
import { createWallet } from '#lib/server/wallets/repo';
import type { OcrDocument } from '#lib/shared/ocr/lines';
import { wibTodayString } from '#lib/shared/dates';
import { openLocalD1 } from '../helpers/d1';
import { fakeEvent } from '../helpers/event';
import { ocrDoc, type ConfOf } from '../helpers/ocr';

/*
 * FN-16g on-device OCR actions (PRD criteria 31–37) on a local D1. The fixtures are fictional e-wallet
 * screenshots described as OCR words; no engine runs here. Dates are relative to the real WIB today because the
 * actions read the clock (rows dated in the future are refused).
 */

const binding: { DB?: D1Database } = {};
vi.mock('#lib/server/env', () => ({ getEnv: () => binding }));

const impor = await import('../../src/routes/(app)/impor/+page.server');

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

let n = 0;
async function account() {
	const email = `ocr${++n}@contoh.id`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	const scope: SpaceScope = { spaceId: space.id, userId: r.userId };
	return { user: { id: r.userId, email, name: 'Uji', createdAt: 0 }, scope };
}
type Account = Awaited<ReturnType<typeof account>>;

async function wallet(scope: SpaceScope, name = 'GoPay Fiktif') {
	const r = await createWallet(
		db,
		scope,
		{
			name,
			type: 'bank',
			currency: 'IDR',
			openingBalanceMinor: 0,
			isFavourite: true,
			lastFour: null
		},
		NOW
	);
	if (!r.ok) throw new Error('wallet failed');
	return r.id;
}

/** `08 Okt 2026`-style header for a past day (the screen prints day, month and year). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const TODAY = wibTodayString();
const dayHeader = (date: string) =>
	`${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
const DAY = (() => {
	const d = new Date(`${TODAY}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() - 3);
	return d.toISOString().slice(0, 10);
})();

/** A fictional GoPay history: two ready rows (one twice, same time), one without a sign (review). */
function screen(
	titles: [string, string, string] = ['Kopi Senja Fiktif', 'Roti Contoh', 'Top Up Fiktif']
): string[] {
	return [
		'09:41',
		'GoPay',
		'Riwayat transaksi',
		dayHeader(DAY),
		`${titles[0]} 4111 1111 1111 1111   -Rp25.000`,
		'14:30',
		`${titles[1]}   -Rp15.000`,
		'15:00',
		`${titles[1]}   -Rp15.000`,
		'15:00',
		`${titles[2]}   Rp100.000`,
		'16:00'
	];
}
const doc = (lines = screen(), conf: ConfOf = 96) => ocrDoc([lines], conf);

type Handler = (event: never) => unknown;
const act = (name: string) => (impor.actions as Record<string, Handler>)[name]!;

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

async function ocrEvent(
	who: Account,
	action: string,
	fields: Record<string, string>,
	space?: string,
	body?: BodyInit,
	type?: string
) {
	const current = await resolveCurrentSpace(db, who.user.id, space);
	const { event } = fakeEvent({
		url: `http://localhost/impor?/${action}`,
		routeId: '/(app)/impor',
		db,
		user: who.user,
		space: current
	});
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	const encoded = new Request('http://localhost/', { method: 'POST', body: form });
	(event as unknown as { request: Request }).request = new Request(
		`http://localhost/impor?/${action}`,
		{
			method: 'POST',
			headers: { 'content-type': type ?? encoded.headers.get('content-type')! },
			body: body ?? (await encoded.arrayBuffer())
		}
	);
	return event as never;
}

const call = async (who: Account, action: string, fields: Record<string, string>, space?: string) =>
	run(async () => act(action)(await ocrEvent(who, action, fields, space)));

const fieldsOf = (d: OcrDocument, extra: Record<string, string> = {}) => ({
	ocr: JSON.stringify(d),
	...extra
});

async function liveRows(spaceId: string) {
	const { results } = await d1
		.prepare(
			`select type, amount_minor, title, occurred_on, source, dedupe_key, import_batch_id, deleted_at
			from transactions where space_id = ? order by occurred_on, amount_minor, dedupe_key`
		)
		.bind(spaceId)
		.all<Record<string, string | number | null>>();
	return results;
}

describe('QA cycle 1: extra probes (criteria 21, 29, 31, 36)', () => {
	it('planted formula, markup, control and zero-width text is cleaned before storage; amounts unaffected', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const planted = `=cmd|'/C calc'!A0 <script>alert(1)</script> a${String.fromCharCode(0x200b)}b${String.fromCharCode(7)}c ${'Z'.repeat(64)}`;
		const lines = screen([planted, 'Roti Contoh', 'Top Up Fiktif']);
		const r = await call(a, 'importOcr', fieldsOf(doc(lines), { defaultWalletId: w }));
		expect(r).toMatchObject({ kind: 'ok', value: { counts: { imported: 3 } } });
		const stored = await liveRows(a.scope.spaceId);
		expect(stored.reduce((s, x) => s + Number(x.amount_minor), 0)).toBe(5_500_000);
		for (const row of stored) {
			const title = String(row.title);
			expect([...title].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 0x200b)).toBe(
				false
			);
			expect(title.length).toBeLessThanOrEqual(200);
		}
	}, 60_000);

	it('server boundaries: 69 on an amount refuses the whole reading, 70 and 89 review (left out unless ticked), 90 is clean', async () => {
		const a = await account();
		const w = await wallet(a.scope);
		const at =
			(c: number): ConfOf =>
			(t) =>
				t === '-Rp25.000' ? c : 96;
		expect(await call(a, 'previewOcr', fieldsOf(doc(screen(), at(69))))).toMatchObject({
			kind: 'fail',
			status: 400
		});
		for (const [c, review] of [
			[70, 'low_confidence'],
			[89, 'low_confidence'],
			[90, null]
		] as const) {
			const p = await call(a, 'previewOcr', fieldsOf(doc(screen(), at(c)), { defaultWalletId: w }));
			expect(p.kind).toBe('ok');
			const rows = (
				p as unknown as { value: { rows: { review: string | null; included: boolean }[] } }
			).value.rows;
			expect([rows[0]!.review, rows[0]!.included]).toEqual([review, review === null]);
		}
		// A review row not ticked in is never written; the same row ticked in is.
		const left = await call(
			a,
			'importOcr',
			fieldsOf(doc(screen(), at(80)), { defaultWalletId: w })
		);
		expect(left).toMatchObject({ kind: 'ok', value: { counts: { imported: 2 } } });
		const ticked = await call(
			a,
			'importOcr',
			fieldsOf(doc(screen(), at(80)), { defaultWalletId: w, include: '[0]' })
		);
		expect(ticked).toMatchObject({ kind: 'ok', value: { counts: { imported: 1, already: 2 } } });
	}, 120_000);

	it('the same reading imported by two spaces writes to both; a space never sees the other’s rows', async () => {
		const a = await account();
		const b = await account();
		const wa = await wallet(a.scope);
		const wb = await wallet(b.scope);
		expect(await call(a, 'importOcr', fieldsOf(doc(), { defaultWalletId: wa }))).toMatchObject({
			kind: 'ok',
			value: { counts: { imported: 3 } }
		});
		expect(await call(b, 'importOcr', fieldsOf(doc(), { defaultWalletId: wb }))).toMatchObject({
			kind: 'ok',
			value: { counts: { imported: 3, already: 0 } }
		});
		expect((await liveRows(a.scope.spaceId)).length).toBe(3);
		expect((await liveRows(b.scope.spaceId)).length).toBe(3);
	}, 60_000);

	it('an unauthenticated call (no session) is refused, not served', async () => {
		const { event } = fakeEvent({
			url: 'http://localhost/impor?/previewOcr',
			routeId: '/(app)/impor',
			db
		});
		const r = await run(() => act('previewOcr')(event as never));
		expect(['redirect', 'error']).toContain(r.kind);
	});
});

describe('QA cycle 1: static guards (criteria 1, 36)', () => {
	it('pins the three engine packages exactly', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
			dependencies: Record<string, string>;
		};
		expect(pkg.dependencies['tesseract.js']).toBe('7.0.0');
		expect(pkg.dependencies['tesseract.js-core']).toBe('7.0.0');
		expect(pkg.dependencies['pdfjs-dist']).toBe('6.4.299');
	});

	it('the server OCR modules never log, store, or hand the words to a storage binding', () => {
		for (const f of [
			'src/lib/server/statements/ocr-import.ts',
			'src/lib/server/statements/ocr-validation.ts'
		]) {
			const code = readFileSync(f, 'utf8');
			expect(code, f).not.toMatch(/console\.|logger|\.put\(|R2|KV|auditLog|insert into/i);
		}
		const page = readFileSync('src/routes/(app)/impor/+page.server.ts', 'utf8');
		const ocrPart = page.slice(
			page.indexOf('async function ocrUpload'),
			page.indexOf('export const actions')
		);
		expect(ocrPart).not.toMatch(/console\.|logger|\.put\(|audit/i);
	});

	it('the client never persists words or images', () => {
		for (const f of ['OcrImport.svelte', 'pipeline.ts', 'engine.ts', 'image.ts', 'pdf.ts']) {
			const code = readFileSync(`src/lib/ocr/${f}`, 'utf8');
			expect(code, f).not.toMatch(
				/localStorage|sessionStorage|indexedDB|caches\.|createObjectURL|\{@html/
			);
		}
	});
});
