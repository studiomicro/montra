import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Static assets are served by Workers Assets without passing the Worker, so hooks.server.ts never adds the
 * security headers to them. The root `_headers` file (copied into the build by adapter-cloudflare) does.
 */
function rulesFor(path: string): string[] {
	const text = readFileSync('_headers', 'utf8')
		.split('\n')
		.filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
		.join('\n');
	const blocks = text.split(/\n(?=\S)/);
	return blocks
		.filter((b) => {
			const pattern = b.split('\n')[0]!.trim();
			const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
			return re.test(path);
		})
		.flatMap((b) =>
			b
				.split('\n')
				.slice(1)
				.map((l) => l.trim().toLowerCase())
				.filter(Boolean)
		);
}

describe('_headers for static assets (FN-13 L4)', () => {
	it('exists at the project root (not in static/, which the adapter refuses)', () => {
		expect(existsSync('_headers')).toBe(true);
		expect(existsSync('static/_headers')).toBe(false);
	});

	it('the offline page gets a script-free CSP that forbids framing, plus nosniff and a referrer policy', () => {
		const rules = rulesFor('/offline.html');
		const csp = rules.find((r) => r.startsWith('content-security-policy:')) ?? '';
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("script-src 'none'");
		expect(csp).toContain("default-src 'self'");
		expect(csp).not.toContain('unsafe-inline');
		expect(rules).toContain('x-content-type-options: nosniff');
		expect(rules.some((r) => r.startsWith('referrer-policy:'))).toBe(true);
	});

	it.each(['/manifest.webmanifest', '/icons/icon-192.png', '/service-worker.js', '/offline.css'])(
		'%s gets nosniff and a referrer policy',
		(path) => {
			const rules = rulesFor(path);
			expect(rules).toContain('x-content-type-options: nosniff');
			expect(rules.some((r) => r.startsWith('referrer-policy:'))).toBe(true);
		}
	);

	it('the account key scrypt worker gets its own CSP that allows nothing (FN-21 L4)', () => {
		const rules = rulesFor('/_app/immutable/workers/derive.worker-abc123.js');
		const csp = rules.find((r) => r.startsWith('content-security-policy:')) ?? '';
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain('unsafe');
		expect(rules).toContain('x-content-type-options: nosniff');
	});
});
