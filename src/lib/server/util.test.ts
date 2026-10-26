import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorLabel, sectionOr } from './util';

afterEach(() => vi.restoreAllMocks());

describe('sectionOr', () => {
	it('returns the section when it loads', async () => {
		expect(await sectionOr('x: failed', Promise.resolve([1, 2]), null)).toEqual([1, 2]);
	});

	it('returns the fallback and logs the error class only, never its message', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const failure = new TypeError('Failed query: select … params: secret-row');
		expect(await sectionOr('x: failed', Promise.reject(failure), { failed: true })).toEqual({
			failed: true
		});
		expect(log).toHaveBeenCalledWith('x: failed', errorLabel(failure));
		expect(JSON.stringify(log.mock.calls)).not.toContain('secret-row');
	});
});
