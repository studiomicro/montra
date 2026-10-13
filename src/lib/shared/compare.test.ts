import { describe, expect, it } from 'vitest';
import { compareState } from './compare';

describe('compareState', () => {
	it('shows the pill when the compared period had spending', () => {
		expect(compareState(50_000_000, 12_000_000)).toBe('pill');
		expect(compareState(50_000_000, -8_000_000)).toBe('pill');
		expect(compareState(50_000_000, 0)).toBe('pill');
	});
	it('says there is no data when the compared period spent nothing', () => {
		expect(compareState(34_750_000, 34_750_000)).toBe('no-previous');
	});
	it('says nothing when both periods are empty', () => {
		expect(compareState(0, 0)).toBe('none');
	});
	it('says nothing without a difference', () => {
		expect(compareState(1_000, null)).toBe('none');
	});
	it('keeps the pill for a total too large to show', () => {
		expect(compareState(null, 5)).toBe('pill');
	});
	it('shows the pill when only the compared period had spending', () => {
		expect(compareState(0, -2_500_000)).toBe('pill');
	});
});
