import { describe, expect, it, vi } from 'vitest';
import { getDb } from '../db';
import {
	clientKey,
	ipv6Prefix,
	overAttemptLimit,
	overUserAttemptLimit,
	THROTTLE_SCOPES
} from './throttle';

describe('ipv6Prefix', () => {
	it.each([
		['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
		['2001:DB8:1:2::1', '2001:db8:1:2::/64'],
		['::ffff:203.0.113.9', '203.0.113.9'],
		['fe80::1%eth0', 'fe80:0:0:0::/64']
	])('%s → %s', (ip, want) => expect(ipv6Prefix(ip)).toBe(want));

	it.each(['203.0.113.9', 'unknown', '1:2:3:4:5:6:7:8:9', '1::2::3', 'zz::1'])(
		'%s is not IPv6',
		(ip) => expect(ipv6Prefix(ip)).toBeNull()
	);
});

describe('clientKey', () => {
	const req = (h: Record<string, string>) => new Request('http://localhost/', { headers: h });
	it('prefers CF-Connecting-IP over the spoofable fallbacks', () => {
		expect(
			clientKey(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }))
		).toBe('203.0.113.9');
	});
	it('keys IPv6 clients by /64', () => {
		expect(clientKey(req({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }))).toBe(
			clientKey(req({ 'cf-connecting-ip': '2001:db8:1:2:bbbb::9' }))
		);
	});
	it('falls back to the first X-Forwarded-For entry, then "unknown"', () => {
		expect(clientKey(req({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))).toBe('198.51.100.1');
		expect(clientKey(req({}))).toBe('unknown');
	});
});

describe('throttle on a database error (FN-31 red team L2)', () => {
	const broken = getDb({
		prepare: () => {
			throw new Error('D1_ERROR: unavailable');
		},
		batch: () => Promise.reject(new Error('D1_ERROR: unavailable'))
	} as unknown as D1Database);
	const request = new Request('http://localhost/', {
		headers: { 'cf-connecting-ip': '203.0.113.9' }
	});

	it.each(THROTTLE_SCOPES)(
		'%s fails closed: the attempt counts as over the limit',
		async (scope) => {
			const log = vi.spyOn(console, 'error').mockImplementation(() => {});
			expect(await overAttemptLimit(broken, request, 1_800_000_000_000, scope)).toBe(true);
			expect(await overUserAttemptLimit(broken, 'u1', 1_800_000_000_000, scope)).toBe(true);
			expect(log).toHaveBeenCalled();
			log.mockRestore();
		}
	);
});
