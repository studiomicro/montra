import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	isReadOnly,
	maskLongDigitRuns,
	normaliseHex,
	PROBES,
	READ_ONLY_FELICA,
	READ_ONLY_INS,
	statusWord
} from './commands';

describe('read-only guard', () => {
	it('lets standard reads through', () => {
		expect(isReadOnly('isodep', '00A40000023F00')).toBe(true);
		expect(isReadOnly('isodep', '00b0000010')).toBe(true);
		expect(isReadOnly('nfcf', '0600FFFF0100')).toBe(true);
	});
	it('refuses writes, debits and anything not on the list', () => {
		expect(isReadOnly('isodep', '00D6000002AABB')).toBe(false); // UPDATE BINARY
		expect(isReadOnly('isodep', '00DC010402AABB')).toBe(false); // UPDATE RECORD
		expect(isReadOnly('isodep', '8054000000')).toBe(false); // a proprietary instruction
		expect(isReadOnly('nfcf', '0A08' + '00'.repeat(8))).toBe(false); // FeliCa Write Without Encryption
	});
	it('refuses malformed commands', () => {
		expect(isReadOnly('isodep', '00A4')).toBe(false);
		expect(isReadOnly('isodep', 'zz')).toBe(false);
		expect(isReadOnly('nfcf', '0700FFFF0100')).toBe(false); // wrong length byte
		expect(normaliseHex('0 0a')).toBeNull();
	});
	it('every probe is read-only', () => {
		for (const p of PROBES) expect(isReadOnly(p.tech, p.hex), p.name).toBe(true);
	});
	it('matches the native lists in MontraNfcPlugin.java', () => {
		const java = readFileSync(
			'native/android-app/android/app/src/main/java/id/montra/app/MontraNfcPlugin.java',
			'utf8'
		);
		const list = (name: string) =>
			[
				...(
					new RegExp(`${name} = new HashSet<>\\(Arrays\\.asList\\(([^)]*)\\)`).exec(java)?.[1] ?? ''
				).matchAll(/0x([0-9A-F]{2})/gi)
			].map((m) => parseInt(m[1]!, 16));
		expect(list('READ_ONLY_INS')).toEqual([...READ_ONLY_INS]);
		expect(list('READ_ONLY_FELICA')).toEqual([...READ_ONLY_FELICA]);
	});
});

describe('responses', () => {
	it('reads the status word', () => {
		expect(statusWord('6F10849000')).toBe('9000');
		expect(statusWord('90')).toBeNull();
	});
	it('masks long digit runs to the last 4', () => {
		expect(maskLongDigitRuns('5A086032987654321234')).toBe('5A' + '•'.repeat(14) + '1234');
		expect(maskLongDigitRuns('6A82')).toBe('6A82');
	});
});
