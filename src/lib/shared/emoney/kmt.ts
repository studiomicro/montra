/**
 * FN-58 KMT (Kartu Multi Trip, KAI Commuter) reader: a FeliCa card read with the two standard FeliCa commands only
 * (Polling 0x00, Read Without Encryption 0x06; Sony's public FeliCa Card User's Manual). The system and service codes
 * and the balance layout follow Metrodroid's KMT decoder (GPL-3.0-or-later, Bondan Sumbodo 2018), used as a
 * reference only: this is our own code. Confirm on a real card before trusting it (owner decision 2026-10-26).
 *
 * - System code 0x90B7.
 * - Service 0x1017 (purse, read-only without a key), block 0: balance = bytes 0..3 little-endian, in rupiah.
 */

export const KMT_SYSTEM_CODE = '90B7';
const BALANCE_SERVICE_LE = '1710'; // service code 0x1017, little-endian on the wire

const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
const bytes = (hex: string) => (hex.match(/../g) ?? []).map((b) => parseInt(b, 16));

/** Polling for the KMT system, no request data: `06 00 90B7 00 00` (length byte first, as NfcF.transceive takes it). */
export function kmtPollingFrame(): string {
	return '0600' + KMT_SYSTEM_CODE + '0000';
}

/** The IDm (8 bytes, hex) from a Polling response `[len] 01 [IDm 8] [PMm 8]`, or null when it is not one. */
export function idmFromPolling(responseHex: string): string | null {
	const b = bytes(responseHex.toUpperCase());
	if (b.length < 18 || b[0] !== b.length || b[1] !== 0x01) return null;
	return responseHex.toUpperCase().slice(4, 20);
}

/** Read Without Encryption of block 0 of the balance service: `10 06 [IDm] 01 1710 01 8000`. */
export function kmtBalanceFrame(idm: string): string {
	const body = '06' + idm.toUpperCase() + '01' + BALANCE_SERVICE_LE + '01' + '8000';
	return hex2(body.length / 2 + 1) + body;
}

export type KmtBalance =
	{ ok: true; balance: number } | { ok: false; reason: 'bad_response' | 'card_error' };

/**
 * The balance from a Read Without Encryption response `[len] 07 [IDm 8] [status1] [status2] [n] [16 bytes × n]`:
 * status flags 00 00, one block, bytes 0..3 of the block little-endian (whole rupiah).
 */
export function parseKmtBalance(responseHex: string): KmtBalance {
	const b = bytes(responseHex.toUpperCase());
	if (b.length < 12 || b[0] !== b.length || b[1] !== 0x07)
		return { ok: false, reason: 'bad_response' };
	if (b[10] !== 0x00 || b[11] !== 0x00) return { ok: false, reason: 'card_error' };
	if (b[12] !== 1 || b.length < 13 + 16) return { ok: false, reason: 'bad_response' };
	const block = b.slice(13, 29);
	const balance = block[0]! | (block[1]! << 8) | (block[2]! << 16) | (block[3]! * 0x1000000);
	return { ok: true, balance };
}
