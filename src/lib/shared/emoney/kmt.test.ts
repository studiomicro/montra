import { describe, expect, it } from 'vitest';
import { isReadOnly } from './commands';
import { idmFromPolling, kmtBalanceFrame, kmtPollingFrame, parseKmtBalance } from './kmt';

// Fictional frames built from the FeliCa manual's layout, not from a real card (a real-card log is still owed).
const IDM = '0123456789ABCDEF';
const PMM = '0000000000000000';
const block = (balance: number) =>
	[0, 8, 16, 24]
		.map((s) => ((balance >>> s) & 0xff).toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase() + '00'.repeat(12);
const readResponse = (status: string, blockHex: string) => {
	const body = '07' + IDM + status + '01' + blockHex;
	return (body.length / 2 + 1).toString(16).padStart(2, '0').toUpperCase() + body;
};

describe('KMT frames', () => {
	it('polls the KMT system code', () => {
		expect(kmtPollingFrame()).toBe('060090B70000');
		expect(isReadOnly('nfcf', kmtPollingFrame())).toBe(true);
	});
	it('reads the IDm from a polling answer', () => {
		expect(idmFromPolling('1201' + IDM + PMM)).toBe(IDM);
		expect(idmFromPolling('1202' + IDM + PMM)).toBeNull();
		expect(idmFromPolling('0101')).toBeNull();
	});
	it('builds a read-only balance read for block 0 of service 0x1017', () => {
		const frame = kmtBalanceFrame(IDM);
		expect(frame).toBe('1006' + IDM + '01171001' + '8000');
		expect(isReadOnly('nfcf', frame)).toBe(true);
	});
});

describe('KMT balance', () => {
	it('reads bytes 0..3 little-endian as rupiah', () => {
		expect(parseKmtBalance(readResponse('0000', block(52_500)))).toEqual({
			ok: true,
			balance: 52_500
		});
		expect(parseKmtBalance(readResponse('0000', block(1_000_000)))).toEqual({
			ok: true,
			balance: 1_000_000
		});
	});
	it('reports a card error status and malformed answers', () => {
		expect(parseKmtBalance(readResponse('01A6', block(10)))).toEqual({
			ok: false,
			reason: 'card_error'
		});
		expect(parseKmtBalance('0A07' + IDM)).toEqual({ ok: false, reason: 'bad_response' });
		expect(parseKmtBalance('')).toEqual({ ok: false, reason: 'bad_response' });
	});
});
