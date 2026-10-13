import { describe, expect, it } from 'vitest';
import { fakeCookies } from '../../../../test/helpers/event';
import {
	setSavedNotice,
	setSeriesSavedNotice,
	takeSavedNotice,
	takeSeriesSavedNotice
} from './saved-notice';

describe('the one-shot transaction saved notice (FN-44 L1)', () => {
	it('round-trips once for the matching redirect, then is gone', () => {
		const { cookies, written } = fakeCookies();
		setSavedNotice(cookies, true, 'created');
		expect(written.get('__Host-tx_saved')?.options).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			maxAge: 60
		});
		expect(takeSavedNotice(cookies, true, 'created')).toBe('created');
		// A reload of the same URL shows nothing.
		expect(takeSavedNotice(cookies, true, 'created')).toBeNull();
	});

	it('a crafted ?saved= without a confirmed write shows nothing', () => {
		const { cookies } = fakeCookies();
		expect(takeSavedNotice(cookies, false, 'created')).toBeNull();
	});

	it('a mismatched, unknown or param-less notice shows nothing and is cleared', () => {
		const cases: [string, string | null][] = [
			['updated', 'created'],
			['created', null],
			['bogus', 'bogus'],
			['', '']
		];
		for (const [value, param] of cases) {
			const { cookies, jar } = fakeCookies({ tx_saved: value });
			expect(takeSavedNotice(cookies, false, param)).toBeNull();
			expect(jar.has('tx_saved')).toBe(false);
		}
	});
});

describe('the one-shot recurring-series saved notice', () => {
	it('round-trips once for each kind, in its own cookie', () => {
		for (const kind of ['created', 'updated', 'paused', 'resumed', 'stopped', 'deleted'] as const) {
			const { cookies, written } = fakeCookies();
			setSeriesSavedNotice(cookies, true, kind);
			expect(written.get('__Host-series_saved')?.options).toMatchObject({
				path: '/',
				httpOnly: true,
				secure: true,
				maxAge: 60
			});
			expect(takeSeriesSavedNotice(cookies, true, kind)).toBe(kind);
			expect(takeSeriesSavedNotice(cookies, true, kind)).toBeNull();
		}
	});

	it('a crafted, mismatched or unknown notice shows nothing', () => {
		expect(takeSeriesSavedNotice(fakeCookies().cookies, false, 'paused')).toBeNull();
		for (const [value, param] of [
			['paused', 'resumed'],
			['adjusted', 'adjusted'],
			['', '']
		] as const) {
			const { cookies, jar } = fakeCookies({ series_saved: value });
			expect(takeSeriesSavedNotice(cookies, false, param)).toBeNull();
			expect(jar.has('series_saved')).toBe(false);
		}
	});

	it('does not touch, and is not touched by, the transaction notice', () => {
		const { cookies, jar } = fakeCookies();
		setSavedNotice(cookies, false, 'created');
		expect(takeSeriesSavedNotice(cookies, false, 'created')).toBeNull();
		expect(jar.get('tx_saved')).toBe('created');
		setSeriesSavedNotice(cookies, false, 'updated');
		expect(takeSavedNotice(cookies, false, 'updated')).toBeNull();
		expect(jar.get('series_saved')).toBe('updated');
	});
});
