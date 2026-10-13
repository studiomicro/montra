/** Headers set on every response. The CSP itself comes from SvelteKit (`csp` in vite.config.ts). */
export function securityHeaders(): Record<string, string> {
	return {
		'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'strict-origin-when-cross-origin',
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Permissions-Policy': 'microphone=(self), camera=(self), geolocation=()'
	};
}
