import { describe, expect, it } from 'vitest';
import { devRoutesEnabled } from '#lib/server/dev';

describe('devRoutesEnabled', () => {
	it('is on in vite dev', () => {
		expect(devRoutesEnabled(undefined, true)).toBe(true);
	});
	it('is on only when DEV_ROUTES is exactly "1"', () => {
		expect(devRoutesEnabled({ DEV_ROUTES: '1' }, false)).toBe(true);
		expect(devRoutesEnabled({ DEV_ROUTES: 'true' }, false)).toBe(false);
		expect(devRoutesEnabled({}, false)).toBe(false);
		expect(devRoutesEnabled(undefined, false)).toBe(false);
	});
});
