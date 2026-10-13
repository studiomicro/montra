import { describe, expect, it } from 'vitest';
import { PRIVACY } from './content';

// FN-30 hardening red team L3 and L6: the deletion section describes the claim marker and the kept billing rows
// as they are.
describe('privacy copy: deleting the account', () => {
	const text = PRIVACY.find((s) => s.id === 'privasi-hapus')!.paragraphs.join(' ');

	it('L3: calls the marker a keyed one-way fingerprint (HMAC), never random, and names vouchers', () => {
		expect(text).not.toContain('sidik acak');
		expect(text).toContain('sidik satu arah berkunci (HMAC)');
		expect(text).toContain('setiap voucher yang pernah kamu tukarkan');
	});

	it('L6: says payment and refund records are kept after deletion', () => {
		expect(text).toContain('Catatan pembayaran dan pengembalian dana');
	});
});
