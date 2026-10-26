import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	errorText,
	isReadOnly,
	maskLongDigitRuns,
	PROBES,
	READ_ONLY_FELICA,
	READ_ONLY_INS,
	recordExchange,
	type CardTech,
	type Exchange
} from './commands';
import { byteHex, felicaFrame, hexBytes, normaliseHex } from './hex';

const JAVA = 'native/android-app/android/app/src/main/java/id/montra/app/MontraNfcPlugin.java';
const VECTORS = 'src/lib/shared/emoney/read-only-vectors.txt';

/** `<tech> <hex> <allow|refuse> <note>` lines; the Android unit test reads the same file. */
const vectors = readFileSync(VECTORS, 'utf8')
	.split('\n')
	.map((line) => line.trim())
	.filter((line) => line !== '' && !line.startsWith('#'))
	.map((line) => {
		const [tech, hex, verdict, ...note] = line.split(/\s+/);
		return { tech: tech!, hex: hex!, allow: verdict === 'allow', verdict, note: note.join(' ') };
	});

describe('read-only guard', () => {
	it('reads well-formed vectors', () => {
		expect(vectors.length).toBeGreaterThan(30);
		for (const v of vectors) expect(['allow', 'refuse'], v.hex).toContain(v.verdict);
	});
	it.each(vectors)('$tech $hex: $verdict ($note)', ({ tech, hex, allow }) => {
		expect(isReadOnly(tech as CardTech, hex)).toBe(allow);
	});
	it('every probe is read-only', () => {
		for (const p of PROBES) expect(isReadOnly(p.tech, p.hex), p.name).toBe(true);
	});
	it('matches the native lists in MontraNfcPlugin.java', () => {
		const java = readFileSync(JAVA, 'utf8');
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

describe('hex', () => {
	it('normalises whole bytes and refuses anything else', () => {
		expect(normaliseHex(' 00 a4 ')).toBe('00A4');
		expect(normaliseHex('0 0a')).toBeNull();
		expect(normaliseHex('')).toBeNull();
		expect(hexBytes('00ff')).toEqual([0, 255]);
		expect(hexBytes('0g')).toBeNull();
		expect(byteHex(10)).toBe('0A');
		expect(felicaFrame('00FFFF0100')).toBe('0600FFFF0100');
	});
});

describe('responses', () => {
	it('masks long digit runs to the last 4', () => {
		expect(maskLongDigitRuns('5A086032987654321234')).toBe('5A' + '•'.repeat(14) + '1234');
		expect(maskLongDigitRuns('6A82')).toBe('6A82');
	});
	it('records an answer, or the failure without throwing', async () => {
		const log: Exchange[] = [];
		expect(await recordExchange(log, 'ok', '00B00000', async () => '9000')).toBe('9000');
		expect(
			await recordExchange(log, 'lost', '00B00000', async () => {
				throw new Error('The card moved away');
			})
		).toBeNull();
		expect(log).toEqual([
			{ name: 'ok', command: '00B00000', response: '9000' },
			{ name: 'lost', command: '00B00000', response: 'The card moved away' }
		]);
		expect(errorText('x')).toBe('error');
	});
});
