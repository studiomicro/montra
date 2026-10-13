import { describe, expect, it } from 'vitest';
import { assertLocalBaseUrl, assertLocalOnly } from './local-guard';

describe('assertLocalOnly', () => {
	it('allows plain local runs', () => {
		expect(() => assertLocalOnly([])).not.toThrow();
		expect(() => assertLocalOnly(['--verbose'])).not.toThrow();
	});
	it.each([
		['--remote'],
		['--env', 'staging'],
		['--env=production'],
		['-e', 'staging'],
		['-e=staging'],
		['--preview']
	])('refuses %s', (...args) => {
		expect(() => assertLocalOnly(args)).toThrow(/Refusing/);
	});
});

describe('assertLocalBaseUrl', () => {
	it.each([
		'http://localhost:8787',
		'http://127.0.0.1:5173/',
		'http://[::1]:8787',
		'https://localhost'
	])('allows %s', (url) => {
		expect(assertLocalBaseUrl(url).hostname).toMatch(/^(localhost|127\.0\.0\.1|\[::1\])$/);
	});
	it.each([
		'https://montra.example',
		'http://site.localhost:8787',
		'http://localhost.evil.test',
		'http://evil.test/localhost',
		'http://localhost@evil.test',
		'http://user:pass@localhost:8787',
		'http://192.168.1.10:8787',
		'http://0.0.0.0:8787',
		'ftp://localhost',
		'localhost:8787',
		'',
		'not a url'
	])('refuses %s', (url) => {
		expect(() => assertLocalBaseUrl(url)).toThrow(/Refusing/);
	});
});
