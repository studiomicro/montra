import { describe, expect, it } from 'vitest';
import { appName } from '#lib/shared/sanity';

describe('toolchain', () => {
	it('resolves #lib subpath imports', () => {
		expect(appName()).toBe('Montra');
	});
});
