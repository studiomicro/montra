import { describe, expect, it } from 'vitest';
import { flagsFrom, hiddenModules, isModule, MODULES } from './feature-flags';

describe('feature flags', () => {
	it('defaults every module to enabled when no row is stored', () => {
		expect(flagsFrom([])).toEqual({
			kekayaan: true,
			langganan: true,
			barang: true,
			koleksi: true,
			ruang: true,
			patungan: true
		});
		expect(hiddenModules(flagsFrom([]))).toEqual([]);
	});

	it('applies stored rows and ignores unknown module names', () => {
		const flags = flagsFrom([
			{ module: 'kekayaan', enabled: false },
			{ module: 'koleksi', enabled: true },
			{ module: '__proto__', enabled: false },
			{ module: 'tanya', enabled: false }
		]);
		expect(hiddenModules(flags)).toEqual(['kekayaan']);
		expect(Object.keys(flags)).toEqual([...MODULES]);
	});

	it('recognises exactly the six modules (FN-49 adds patungan)', () => {
		expect(MODULES.filter(isModule)).toHaveLength(6);
		expect(isModule('Kekayaan')).toBe(false);
		expect(isModule('constructor')).toBe(false);
		expect(isModule('')).toBe(false);
	});
});
