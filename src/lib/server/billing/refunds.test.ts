import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('refunds.ts never reaches a payment provider (FN-30 hardening criterion 12)', () => {
	it('does not reference fetch, PaymentProvider or activeProvider', () => {
		const source = readFileSync('src/lib/server/billing/refunds.ts', 'utf8');
		for (const name of ['fetch', 'PaymentProvider', 'activeProvider'])
			expect(source, name).not.toContain(name);
	});
});
