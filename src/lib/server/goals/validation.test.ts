import { describe, expect, it } from 'vitest';
import { AMOUNT_INVALID, GOAL_NAME_INVALID, NOTE_INVALID, TARGET_INVALID } from './messages';
import { goalProgressPercent } from './progress';
import { parseContributionForm, parseGoalForm } from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

describe('parseGoalForm', () => {
	it('reads a valid form into integer minor units (IDR)', () => {
		expect(parseGoalForm(form({ name: 'Liburan Bali', target: '1.250.000' }))).toEqual({
			ok: true,
			value: { name: 'Liburan Bali', targetAmountMinor: 125_000_000 }
		});
		expect(parseGoalForm(form({ name: 'HP', target: '2500000' }))).toMatchObject({
			ok: true,
			value: { targetAmountMinor: 250_000_000 }
		});
	});

	it('strips control and zero-width characters; a name of only those is refused', () => {
		expect(parseGoalForm(form({ name: 'Dana​ darurat\u0007', target: '1' }))).toMatchObject({
			ok: true,
			value: { name: 'Dana darurat' }
		});
		expect(parseGoalForm(form({ name: '​\u0000‮', target: '1' }))).toMatchObject({
			ok: false,
			errors: { name: GOAL_NAME_INVALID }
		});
	});

	it('accepts 60 characters (emoji count as one) and refuses 61, never truncating', () => {
		expect(parseGoalForm(form({ name: '🏖'.repeat(60), target: '1' }))).toMatchObject({ ok: true });
		const long = parseGoalForm(form({ name: 'a'.repeat(61), target: '1' }));
		expect(long).toMatchObject({ ok: false, errors: { name: GOAL_NAME_INVALID } });
		if (!long.ok) expect(long.values.name).toBe('a'.repeat(61));
	});

	it.each([
		['blank', ''],
		['zero', '0'],
		['zero grouped', '0.000'],
		['negative', '-5000'],
		['decimal comma', '1.000,50'],
		['decimal point', '12.50'],
		['exponent', '1e6'],
		['words', 'sejuta'],
		['spaces', '1 250 000'],
		['14 digits', '12345678901234']
	])('refuses a %s target and echoes what was typed', (_label, target) => {
		const r = parseGoalForm(form({ name: 'Mobil', target }));
		expect(r).toMatchObject({ ok: false, errors: { targetAmountMinor: TARGET_INVALID } });
		if (!r.ok) expect(r.values).toEqual({ name: 'Mobil', target });
	});

	it('accepts the largest 13-digit target as a safe integer', () => {
		const r = parseGoalForm(form({ name: 'Besar', target: '9.999.999.999.999' }));
		expect(r).toMatchObject({ ok: true, value: { targetAmountMinor: 999_999_999_999_900 } });
	});
});

describe('parseContributionForm', () => {
	it('reads an amount and an optional note', () => {
		expect(parseContributionForm(form({ amount: '50.000', note: ' gaji Oktober ' }))).toEqual({
			ok: true,
			value: { amountMinor: 5_000_000, note: 'gaji Oktober' }
		});
		expect(parseContributionForm(form({ amount: '50000' }))).toEqual({
			ok: true,
			value: { amountMinor: 5_000_000, note: null }
		});
		expect(parseContributionForm(form({ amount: '1', note: '​' }))).toMatchObject({
			ok: true,
			value: { note: null }
		});
	});

	it.each(['', '0', '-25000', '25.000,00', '2,5', 'abc', '1e3'])(
		'refuses the amount %j (never negative, never a decimal)',
		(amount) => {
			expect(parseContributionForm(form({ amount }))).toMatchObject({
				ok: false,
				errors: { amountMinor: AMOUNT_INVALID }
			});
		}
	);

	it('refuses a note over 200 characters', () => {
		expect(parseContributionForm(form({ amount: '1', note: 'x'.repeat(200) }))).toMatchObject({
			ok: true
		});
		expect(parseContributionForm(form({ amount: '1', note: 'x'.repeat(201) }))).toMatchObject({
			ok: false,
			errors: { note: NOTE_INVALID }
		});
	});
});

describe('goalProgressPercent', () => {
	it('floors, never rounding up', () => {
		expect(goalProgressPercent(0, 100)).toBe(0);
		expect(goalProgressPercent(999, 1000)).toBe(99);
		expect(goalProgressPercent(1, 3)).toBe(33);
		expect(goalProgressPercent(2, 3)).toBe(66);
		expect(goalProgressPercent(125_000_000, 125_000_000)).toBe(100);
	});

	it('is not capped at 100', () => {
		expect(goalProgressPercent(135_000_000, 125_000_000)).toBe(108);
	});

	it('is exact where saved × 100 passes 2^53', () => {
		expect(goalProgressPercent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(100);
		expect(goalProgressPercent(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER)).toBe(99);
	});

	it('refuses a non-positive target or a non-integer amount', () => {
		expect(() => goalProgressPercent(1, 0)).toThrow(RangeError);
		expect(() => goalProgressPercent(1.5, 100)).toThrow(RangeError);
	});
});
