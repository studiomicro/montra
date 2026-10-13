import { describe, expect, it } from 'vitest';
import {
	AMOUNTS_HIDDEN_KEY,
	amountsHiddenCookie,
	HIDDEN_AMOUNT,
	maskAmount,
	readAmountsHidden,
	writeAmountsHidden
} from './amount-visibility';

function memory(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		}
	};
}

const blocked = {
	getItem: () => {
		throw new Error('SecurityError');
	},
	setItem: () => {
		throw new Error('QuotaExceededError');
	},
	removeItem: () => {
		throw new Error('SecurityError');
	}
};

describe('amount visibility', () => {
	it('round-trips the choice through storage', () => {
		const s = memory();
		expect(readAmountsHidden(s)).toBe(false);
		expect(writeAmountsHidden(s, true)).toBe(true);
		expect(s.getItem(AMOUNTS_HIDDEN_KEY)).toBe('1');
		expect(readAmountsHidden(s)).toBe(true);
		expect(writeAmountsHidden(s, false)).toBe(true);
		expect(s.getItem(AMOUNTS_HIDDEN_KEY)).toBeNull();
		expect(readAmountsHidden(s)).toBe(false);
	});

	it('treats blocked or missing storage as "shown" and never throws', () => {
		expect(readAmountsHidden(blocked)).toBe(false);
		expect(writeAmountsHidden(blocked, true)).toBe(false);
		expect(readAmountsHidden(undefined)).toBe(false);
		expect(writeAmountsHidden(undefined, true)).toBe(false);
	});

	it('ignores any stored value other than "1"', () => {
		const s = memory();
		s.setItem(AMOUNTS_HIDDEN_KEY, 'true');
		expect(readAmountsHidden(s)).toBe(false);
	});

	it('masks text only while hidden', () => {
		expect(maskAmount('Rp 25.000', false)).toBe('Rp 25.000');
		expect(maskAmount('Rp 25.000', true)).toBe(HIDDEN_AMOUNT);
	});
});

describe('amountsHiddenCookie (FN-25b red team 1)', () => {
	it('sets a site-wide, lax, one-year cookie when hidden and clears it when shown', () => {
		expect(amountsHiddenCookie(true, true)).toBe(
			'montra-amounts-hidden=1; Path=/; SameSite=Lax; Secure; Max-Age=31536000'
		);
		expect(amountsHiddenCookie(false, false)).toBe(
			'montra-amounts-hidden=; Path=/; SameSite=Lax; Max-Age=0'
		);
	});
});
