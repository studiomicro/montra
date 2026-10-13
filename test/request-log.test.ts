import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redactedPath } from '#lib/server/spaces/invites';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';

/** wrangler.jsonc without its whole-line `//` comments (the file has no other JSONC syntax). */
const config = JSON.parse(
	readFileSync('wrangler.jsonc', 'utf8')
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n')
) as {
	observability?: { logs?: { invocation_logs?: boolean } };
	env: Record<string, { observability?: { logs?: { invocation_logs?: boolean } } }>;
};

describe('request logs never carry an invite token (FN-03 red team L3)', () => {
	it('masks the token in an invite path, also percent-encoded, and drops every query string', () => {
		expect(redactedPath(new URL(`http://x/ruang/undangan/${TOKEN}`))).toBe(
			'/ruang/undangan/[token]'
		);
		expect(redactedPath(new URL(`http://x/ruang/undangan/${TOKEN}/__data.json?x-sveltekit`))).toBe(
			'/ruang/undangan/[token]/__data.json'
		);
		expect(redactedPath(new URL(`http://x/ruang/%75ndangan/${TOKEN}`))).toBe(
			'/ruang/undangan/[token]'
		);
		expect(
			redactedPath(new URL(`http://x/masuk?next=${encodeURIComponent(`/ruang/undangan/${TOKEN}`)}`))
		).toBe('/masuk');
		expect(redactedPath(new URL('http://x/riwayat'))).toBe('/riwayat');
	});

	it('Workers invocation logs (full URLs) are off for the app Worker, locally and on staging', () => {
		expect(config.observability?.logs?.invocation_logs).toBe(false);
		expect(config.env.staging?.observability?.logs?.invocation_logs).toBe(false);
	});
});
