import { describe, expect, it } from 'vitest';
import { RETURN_TO_MAX_LENGTH, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
	it.each([
		['/riwayat', '/riwayat'],
		['/riwayat?bulan=2026-10#x', '/riwayat?bulan=2026-10#x'],
		['/pengaturan/akun', '/pengaturan/akun']
	])('keeps the local path %s', (input, want) => expect(safeReturnTo(input)).toBe(want));

	it.each([
		null,
		undefined,
		'',
		'riwayat',
		'//evil.test',
		'https://evil.test/',
		'/\\evil.test',
		'/\t/evil.test',
		'/%2F/evil.test',
		'/%252F%252Fevil.test',
		'/.//evil.test',
		'javascript:alert(1)',
		'/' + 'a'.repeat(RETURN_TO_MAX_LENGTH)
	])('sends %j to /', (input) => expect(safeReturnTo(input)).toBe('/'));
});
