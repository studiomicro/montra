import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAdminAccount } from './admin';

const env = (ADMIN_ACCOUNT_IDS?: string) => ({ ADMIN_ACCOUNT_IDS });
const A = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const B = '1c7a3d2f-4e5b-4a6c-9d7e-8f9a0b1c2d3e';
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('isAdminAccount (FN-30 hardening criterion 23)', () => {
	it('admits a listed id, also with surrounding spaces or upper-case, on either side', async () => {
		const list = env(` ${A.toUpperCase()} , ${B} `);
		expect(await isAdminAccount(list, A)).toBe(true);
		expect(await isAdminAccount(list, B)).toBe(true);
		expect(await isAdminAccount(list, ` ${B.toUpperCase()}`)).toBe(true);
	});

	it('refuses an unlisted id, near misses, the empty string and non-UUID entries', async () => {
		const list = env(A);
		for (const id of [B, A.slice(1), `${A}0`, A.replace(/d$/, 'e'), ''])
			expect(await isAdminAccount(list, id), id).toBe(false);
		// A non-UUID entry is dropped, so even an exact match of it admits nobody.
		expect(await isAdminAccount(env('owner@contoh.id'), 'owner@contoh.id')).toBe(false);
		expect(await isAdminAccount(env('admin'), 'admin')).toBe(false);
	});

	it('refuses everyone while ADMIN_ACCOUNT_IDS is unset, empty or only commas', async () => {
		for (const value of [undefined, '', ' ', ',', ',,', ' , '])
			expect(await isAdminAccount(env(value), A)).toBe(false);
		expect(await isAdminAccount(undefined, A)).toBe(false);
		expect(await isAdminAccount(env(','), '')).toBe(false);
	});

	it('reads only the first 20 entries', async () => {
		const list = env(Array.from({ length: 21 }, (_, i) => uuid(i + 1)).join(','));
		expect(await isAdminAccount(list, uuid(20))).toBe(true);
		expect(await isAdminAccount(list, uuid(21))).toBe(false);
	});
});

describe('ADMIN_EMAILS is gone (criterion 26)', () => {
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? files(path) : [path];
		});

	it('no file under src/ or workers/ reads ADMIN_EMAILS', () => {
		const offenders = [...files('src'), ...files('workers')]
			.filter((f) => /\.(ts|js|svelte)$/.test(f) && !f.endsWith('admin.test.ts'))
			.filter((f) => readFileSync(f, 'utf8').includes('ADMIN_EMAILS'));
		expect(offenders).toEqual([]);
	});
});
