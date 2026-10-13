import { describe, expect, it } from 'vitest';
import { AI_KEY_MAX_LENGTH, AI_KEY_MIN_LENGTH, parseAiKey } from './ai-keys.ts';

const KEY = 'sk-ant-api03-synthetic-test-key-AbCd';

describe('parseAiKey (FN-41: loose format check, owner decision 7)', () => {
	it('accepts a key with the prefix and a length in bounds, trimmed', () => {
		expect(parseAiKey(KEY)).toBe(KEY);
		expect(parseAiKey(`  ${KEY}\n`)).toBe(KEY);
		// Any later format after the prefix (no hard-coded api03).
		expect(parseAiKey('sk-ant-zz99-' + 'x'.repeat(20))).toBe('sk-ant-zz99-' + 'x'.repeat(20));
	});

	it('strips zero-width and control characters before the format check', () => {
		expect(parseAiKey(`\u200b${KEY}\u200d`)).toBe(KEY);
		expect(parseAiKey(`sk-ant-\u0000api03-synthetic-test-key-AbCd`)).toBe(KEY);
	});

	it('enforces the length bounds exactly', () => {
		const at = (n: number) => 'sk-ant-' + 'a'.repeat(n - 7);
		expect(parseAiKey(at(AI_KEY_MIN_LENGTH))).toBe(at(AI_KEY_MIN_LENGTH));
		expect(parseAiKey(at(AI_KEY_MIN_LENGTH - 1))).toBeNull();
		expect(parseAiKey(at(AI_KEY_MAX_LENGTH))).toBe(at(AI_KEY_MAX_LENGTH));
		expect(parseAiKey(at(AI_KEY_MAX_LENGTH + 1))).toBeNull();
		// A huge paste costs nothing and is refused.
		expect(parseAiKey('sk-ant-' + 'a'.repeat(1_000_000))).toBeNull();
	});

	it('refuses obviously wrong pastes', () => {
		for (const bad of [
			'',
			'   ',
			'sk-proj-abcdefghijklmnopqrstuvwxyz',
			'SK-ANT-abcdefghijklmnopqrstuvwxyz',
			'Bearer sk-ant-abcdefghijklmnopqrstuvwxyz',
			'sk-ant-abc defghijklmnopqrstuvwxyz',
			'sk-ant-abcdefghijklmnopqrstuvwxyzé',
			'session=abc123; sk-ant-abcdefghijklmnop',
			'ini kalimat biasa yang panjang sekali'
		])
			expect(parseAiKey(bad), bad).toBeNull();
	});
});
