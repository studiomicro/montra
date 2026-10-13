import { describe, expect, it } from 'vitest';
import { fakeCookies } from '../../../../test/helpers/event';
import { setSavedNotice, takeSavedNotice } from './notice';

describe('the one-shot save summary', () => {
	it('round-trips once, then is gone', () => {
		const { cookies, written } = fakeCookies();
		const notice = { saved: 3, total: 4, incomplete: 1, remaining: 0 };
		setSavedNotice(cookies, true, notice);
		const set = written.get('__Host-drafts_saved');
		expect(set?.options).toMatchObject({ path: '/', httpOnly: true, secure: true, maxAge: 60 });
		expect(takeSavedNotice(cookies, true)).toEqual(notice);
		expect(takeSavedNotice(cookies, true)).toBeNull();
	});

	it('ignores a malformed or oversized value (and clears it)', () => {
		for (const value of ['1.2.3', 'a.b.c.d', '1.2.3.4.5', '99999.1.1.1', '-1.1.1.1', '']) {
			const { cookies, jar } = fakeCookies({ drafts_saved: value });
			expect(takeSavedNotice(cookies, false)).toBeNull();
			expect(jar.has('drafts_saved')).toBe(false);
		}
	});
});
