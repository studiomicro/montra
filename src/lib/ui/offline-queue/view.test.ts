import { describe, expect, it } from 'vitest';
import { QUEUE_AMOUNT_MISSING, QUEUE_AMOUNT_MISSING_CENTS, queueAmountMissing } from './view';

// FN-47 follow-up: a queued create without an amount is told the rule of its wallet's currency.
describe('queueAmountMissing', () => {
	it('says whole numbers for IDR and JPY, at most two decimals for a currency with cents', () => {
		expect(queueAmountMissing('IDR')).toBe(QUEUE_AMOUNT_MISSING);
		expect(queueAmountMissing('JPY')).toBe(QUEUE_AMOUNT_MISSING);
		expect(queueAmountMissing('USD')).toBe(QUEUE_AMOUNT_MISSING_CENTS);
		expect(queueAmountMissing('HKD')).toBe(QUEUE_AMOUNT_MISSING_CENTS);
		expect(QUEUE_AMOUNT_MISSING_CENTS).not.toContain('angka bulat');
	});
});
