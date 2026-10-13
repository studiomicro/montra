import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Db } from '../db';
import {
	countryOf,
	statsDataPoint,
	trackEvent,
	type StatsFields,
	type TrackContext
} from './track';

vi.mock('#lib/server/env', () => ({ getEnv: () => ({}) }));

const fields: StatsFields = {
	screen: 'beranda',
	action: 'view',
	deviceType: 'android',
	language: 'id',
	country: 'ID'
};

describe('statsDataPoint', () => {
	it('writes exactly the five blobs, in order, and nothing else', () => {
		const point = statsDataPoint(fields);
		expect(point).toEqual({ blobs: ['beranda', 'view', 'android', 'id', 'ID'] });
		expect(Object.keys(point)).toEqual(['blobs']);
	});

	it('refuses any extra field at runtime (the type already refuses it at compile time)', () => {
		for (const extra of ['userId', 'email', 'amountMinor', 'ip', 'text', 'sessionId']) {
			const widened = { ...fields, [extra]: 'x' } as unknown as StatsFields;
			expect(() => statsDataPoint(widened), extra).toThrow(TypeError);
		}
		// @ts-expect-error an account id is not a field of a data point
		expect(() => statsDataPoint({ ...fields, userId: 'u1' })).toThrow(TypeError);
	});

	it('refuses values outside the vocabulary (no typed text can reach a blob)', () => {
		const bad = (over: Record<string, string>) => ({ ...fields, ...over }) as StatsFields;
		expect(() => statsDataPoint(bad({ screen: 'Kopi Kenangan Rp 28.000' }))).toThrow(TypeError);
		expect(() => statsDataPoint(bad({ action: 'budi@contoh.id' }))).toThrow(TypeError);
		expect(() => statsDataPoint(bad({ deviceType: 'Mozilla/5.0' }))).toThrow(TypeError);
		expect(() => statsDataPoint(bad({ language: 'fr' }))).toThrow(TypeError);
		expect(() => statsDataPoint(bad({ country: '203.0.113.7' }))).toThrow(TypeError);
	});
});

describe('countryOf', () => {
	it('reads only a two-letter country, else XX', () => {
		expect(countryOf({ country: 'ID', city: 'Jakarta', latitude: '-6.2', asn: 7713 })).toBe('ID');
		expect(countryOf({ country: 'T1' })).toBe('XX');
		expect(countryOf({ country: '203.0.113.7' })).toBe('XX');
		expect(countryOf({})).toBe('XX');
		expect(countryOf(undefined)).toBe('XX');
	});
});

describe('trackEvent without a database round trip', () => {
	const stats = () => ({ writeDataPoint: vi.fn() });
	const withCf = (cf?: object) => {
		const request = new Request('https://app.test/api/v1/track', { method: 'POST' });
		if (cf) Object.defineProperty(request, 'cf', { value: cf });
		return request;
	};
	// A database that must not be read: these paths decide before the opt-out lookup.
	const db = new Proxy(
		{},
		{
			get: () => {
				throw new Error('db read');
			}
		}
	) as unknown as Db;
	const ctx = (over: Partial<TrackContext>): TrackContext => ({
		db,
		stats: stats() as unknown as AnalyticsEngineDataset,
		userId: 'u1',
		request: withCf({ country: 'ID' }),
		locale: 'id',
		...over
	});

	it('writes nothing without the STATS binding (local dev), without an account or without request.cf', async () => {
		for (const over of [
			{ stats: undefined },
			{ userId: null },
			{ request: withCf() }
		] satisfies Partial<TrackContext>[]) {
			const c = ctx(over);
			expect(await trackEvent(c, { screen: 'beranda', action: 'view' })).toBe(false);
			if (c.stats)
				expect(
					(c.stats as unknown as { writeDataPoint: ReturnType<typeof vi.fn> }).writeDataPoint
				).not.toHaveBeenCalled();
		}
	});

	it('never throws: a failing opt-out lookup writes nothing', async () => {
		const c = ctx({});
		expect(await trackEvent(c, { screen: 'beranda', action: 'view' })).toBe(false);
		expect(
			(c.stats as unknown as { writeDataPoint: ReturnType<typeof vi.fn> }).writeDataPoint
		).not.toHaveBeenCalled();
	});
});

/** Every .ts/.svelte file under src (tests excluded). */
function sources(dir = 'src'): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(d) => d.isFile() && /\.(ts|svelte)$/.test(d.name) && !/\.(test|spec|d)\.ts$/.test(d.name)
		)
		.map((d) => join(d.parentPath, d.name));
}

describe('call sites (ACCEPTANCE: usage statistics hold no account id, amount, typed text or IP)', () => {
	const files = sources();

	it('only track.ts writes to Analytics Engine', () => {
		const writers = files.filter((f) => readFileSync(f, 'utf8').includes('writeDataPoint'));
		expect(writers).toEqual([join('src', 'lib', 'server', 'analytics', 'track.ts')]);
	});

	it('every trackEvent call passes only a screen and an action from the vocabulary', () => {
		const calls: string[] = [];
		for (const f of files) {
			if (f.endsWith(join('analytics', 'track.ts'))) continue;
			const text = readFileSync(f, 'utf8');
			for (const m of text.matchAll(/trackEvent\(([\s\S]*?)\);/g)) calls.push(`${f}: ${m[1]}`);
		}
		expect(calls.length).toBeGreaterThanOrEqual(4);
		const EVENT = /,\s*\{\s*screen(?::\s*'[a-z_]+')?,\s*action(?::\s*'[a-z_]+')?\s*\}\s*$/;
		for (const call of calls) expect(call, call).toMatch(EVENT);
		// The context is always built by trackContext (db, STATS, locale, request, user id for the opt-out only).
		for (const call of calls) expect(call, call).toMatch(/:\s*trackContext\(/);
	});

	it('every client track() call passes only names from the vocabulary', () => {
		const calls: string[] = [];
		for (const f of files) {
			const text = readFileSync(f, 'utf8');
			if (!text.includes("from '#lib/ui/track'")) continue;
			for (const m of text.matchAll(/\btrack\(([^)]*)\)/g)) calls.push(`${f}: ${m[1]}`);
		}
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const call of calls) expect(call, call).toMatch(/:\s*(?:'[a-z_]+'|screen),\s*'[a-z_]+'$/);
	});
});
