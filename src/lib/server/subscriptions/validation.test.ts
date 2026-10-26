import { describe, expect, it } from 'vitest';
import {
	AMOUNT_INVALID,
	AMOUNT_INVALID_CENTS,
	AMOUNT_TOO_LARGE,
	CATALOGUE_INVALID,
	CATEGORY_INVALID,
	CURRENCY_INVALID,
	CYCLE_INVALID,
	DAY_INVALID,
	MONTH_INVALID,
	NAME_INVALID,
	PAY_MODE_INVALID,
	REMINDER_INVALID,
	WEEKDAY_INVALID
} from './messages';
import { parsePayForm, parseSubscriptionForm } from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
}

const base = {
	name: 'Netflix',
	category: 'streaming',
	amount: '186.000',
	currency: 'IDR',
	cycle: 'monthly',
	day: '31',
	weekday: '1',
	month: '1',
	reminderDays: '2'
};

describe('parseSubscriptionForm', () => {
	it('reads a monthly bill into integer minor units', () => {
		expect(parseSubscriptionForm(form(base), 'id')).toMatchObject({
			ok: true,
			value: {
				catalogueId: null,
				name: 'Netflix',
				category: 'streaming',
				amountMinor: 18_600_000,
				currency: 'IDR',
				schedule: { cycle: 'monthly', day: 31, month: null },
				walletId: null,
				reminderDaysBefore: 2
			}
		});
	});

	it('copies name and category from a catalogue entry when left blank; keeps typed ones', () => {
		const r = parseSubscriptionForm(
			form({ ...base, catalogueId: 'disney-hotstar', name: '', category: '' }),
			'id'
		);
		expect(r).toMatchObject({
			ok: true,
			value: { catalogueId: 'disney-hotstar', name: 'Disney+ Hotstar', category: 'streaming' }
		});
		expect(
			parseSubscriptionForm(form({ ...base, catalogueId: 'spotify', name: 'Spotify Duo' }), 'id')
		).toMatchObject({ ok: true, value: { catalogueId: 'spotify', name: 'Spotify Duo' } });
		// FN-39 memberships: name and category from the entry; the amount is still the one typed.
		for (const [id, name] of [
			['gopay-plus', 'GoPay Plus'],
			['gofood-plus', 'GoFood Plus'],
			['grabunlimited', 'GrabUnlimited']
		] as const)
			expect(
				parseSubscriptionForm(form({ ...base, catalogueId: id, name: '', category: '' }), 'id')
			).toMatchObject({
				ok: true,
				value: { catalogueId: id, name, category: 'lainnya', amountMinor: 18_600_000 }
			});
		// No price comes from the catalogue: without a typed amount the form is refused.
		expect(
			parseSubscriptionForm(
				form({ ...base, catalogueId: 'gopay-plus', name: '', amount: '' }),
				'id'
			)
		).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_INVALID } });
	});

	it('refuses an unknown or prototype catalogue id, never storing it', () => {
		for (const id of ['tidak-ada', '__proto__', 'constructor', 'x'.repeat(70)])
			expect(parseSubscriptionForm(form({ ...base, catalogueId: id }), 'id')).toMatchObject({
				ok: false,
				errors: { catalogueId: CATALOGUE_INVALID }
			});
	});

	it('cleans the name; refuses blank and 61 characters (emoji count as one)', () => {
		expect(parseSubscriptionForm(form({ ...base, name: 'Net​flix\u0007' }), 'id')).toMatchObject({
			ok: true,
			value: { name: 'Netflix' }
		});
		expect(parseSubscriptionForm(form({ ...base, name: '​' }), 'id')).toMatchObject({
			ok: false,
			errors: { name: NAME_INVALID }
		});
		expect(parseSubscriptionForm(form({ ...base, name: '🎬'.repeat(60) }), 'id')).toMatchObject({
			ok: true
		});
		expect(parseSubscriptionForm(form({ ...base, name: 'a'.repeat(61) }), 'id')).toMatchObject({
			ok: false,
			errors: { name: NAME_INVALID }
		});
	});

	it.each(['', '0', '-5', '12,50', '12.50', '1e6', 'sejuta', '12345678901234'])(
		'refuses the amount %j',
		(amount) => {
			expect(parseSubscriptionForm(form({ ...base, amount }), 'id')).toMatchObject({
				ok: false,
				errors: { amountMinor: AMOUNT_INVALID }
			});
		}
	);

	it('caps the amount at 10^13 minor units (the transaction cap)', () => {
		expect(parseSubscriptionForm(form({ ...base, amount: '100.000.000.000' }), 'id')).toMatchObject(
			{
				ok: true,
				value: { amountMinor: 10_000_000_000_000 }
			}
		);
		expect(parseSubscriptionForm(form({ ...base, amount: '100.000.000.001' }), 'id')).toMatchObject(
			{
				ok: false,
				errors: { amountMinor: AMOUNT_TOO_LARGE }
			}
		);
	});

	it('reads the amount in the chosen currency (JPY has no minor unit) and refuses unknown codes', () => {
		expect(
			parseSubscriptionForm(form({ ...base, currency: 'JPY', amount: '1.500' }), 'id')
		).toMatchObject({ ok: true, value: { amountMinor: 1500, currency: 'JPY' } });
		expect(parseSubscriptionForm(form({ ...base, currency: 'XYZ' }), 'id')).toMatchObject({
			ok: false,
			errors: { currency: CURRENCY_INVALID }
		});
	});

	it('reads only the day field of the chosen cycle', () => {
		expect(
			parseSubscriptionForm(form({ ...base, cycle: 'weekly', day: 'x', weekday: '7' }), 'id')
		).toMatchObject({ ok: true, value: { schedule: { cycle: 'weekly', day: 7, month: null } } });
		expect(
			parseSubscriptionForm(
				form({ ...base, cycle: 'yearly', month: '2', day: '29', weekday: 'x' }),
				'id'
			)
		).toMatchObject({ ok: true, value: { schedule: { cycle: 'yearly', day: 29, month: 2 } } });
	});

	it.each([
		[{ cycle: 'daily' }, { cycle: CYCLE_INVALID }],
		[{ cycle: 'monthly', day: '0' }, { day: DAY_INVALID }],
		[{ cycle: 'monthly', day: '32' }, { day: DAY_INVALID }],
		[{ cycle: 'monthly', day: '1.5' }, { day: DAY_INVALID }],
		[{ cycle: 'weekly', weekday: '8' }, { weekday: WEEKDAY_INVALID }],
		[{ cycle: 'weekly', weekday: '' }, { weekday: WEEKDAY_INVALID }],
		[{ cycle: 'yearly', month: '13' }, { month: MONTH_INVALID }],
		[{ cycle: 'yearly', month: '2', day: '30' }, { day: DAY_INVALID }],
		[{ cycle: 'yearly', month: '4', day: '31' }, { day: DAY_INVALID }]
	])('refuses the schedule %j', (fields, errors) => {
		expect(parseSubscriptionForm(form({ ...base, ...fields }), 'id')).toMatchObject({
			ok: false,
			errors
		});
	});

	it('defaults the reminder to 2 days and refuses past 14', () => {
		expect(parseSubscriptionForm(form({ ...base, reminderDays: '' }), 'id')).toMatchObject({
			ok: true,
			value: { reminderDaysBefore: 2 }
		});
		expect(parseSubscriptionForm(form({ ...base, reminderDays: '0' }), 'id')).toMatchObject({
			ok: true,
			value: { reminderDaysBefore: 0 }
		});
		for (const reminderDays of ['15', '-1', 'x'])
			expect(parseSubscriptionForm(form({ ...base, reminderDays }), 'id')).toMatchObject({
				ok: false,
				errors: { reminderDays: REMINDER_INVALID }
			});
	});

	it('refuses an unknown category and echoes every typed value back', () => {
		const r = parseSubscriptionForm(form({ ...base, category: 'judi' }), 'id');
		expect(r).toMatchObject({ ok: false, errors: { category: CATEGORY_INVALID } });
		if (!r.ok) expect(r.values.amount).toBe('186.000');
	});

	it('FN-47: cents in a currency that has them, read like a budget; TWD is a known code', () => {
		expect(
			parseSubscriptionForm(form({ ...base, currency: 'TWD', amount: '1.234,56' }), 'id')
		).toMatchObject({ ok: true, value: { amountMinor: 123_456, currency: 'TWD' } });
		expect(
			parseSubscriptionForm(form({ ...base, currency: 'USD', amount: '15.99' }), 'en')
		).toMatchObject({ ok: true, value: { amountMinor: 1599, currency: 'USD' } });
		expect(
			parseSubscriptionForm(form({ ...base, currency: 'USD', amount: '15,999' }), 'id')
		).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_INVALID_CENTS } });
		expect(
			parseSubscriptionForm(form({ ...base, currency: 'IDR', amount: '15,99' }), 'id')
		).toMatchObject({ ok: false, errors: { amountMinor: AMOUNT_INVALID } });
	});
});

describe('parsePayForm', () => {
	it('reads a new-transaction choice; a bad date becomes blank (FN-05 refuses it)', () => {
		expect(
			parsePayForm(form({ mode: 'new', walletId: 'w', categoryId: 'c', occurredOn: '2026-10-08' }))
		).toEqual({
			ok: true,
			value: { mode: 'new', walletId: 'w', categoryId: 'c', occurredOn: '2026-10-08' }
		});
		expect(parsePayForm(form({ mode: 'new', occurredOn: '2026-02-30' }))).toMatchObject({
			ok: true,
			value: { occurredOn: '' }
		});
	});

	it('reads a link choice and refuses a missing id or mode', () => {
		expect(parsePayForm(form({ mode: 'link', transactionId: 't1' }))).toEqual({
			ok: true,
			value: { mode: 'link', transactionId: 't1' }
		});
		expect(parsePayForm(form({ mode: 'link' }))).toEqual({ ok: false, error: PAY_MODE_INVALID });
		expect(parsePayForm(form({}))).toEqual({ ok: false, error: PAY_MODE_INVALID });
	});
});
