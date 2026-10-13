import { describe, expect, it } from 'vitest';
import { securityHeaders } from '#lib/server/security-headers';

describe('securityHeaders', () => {
	it('returns the hardening headers from the spec', () => {
		expect(securityHeaders()).toEqual({
			'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'strict-origin-when-cross-origin',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=()'
		});
	});
});
