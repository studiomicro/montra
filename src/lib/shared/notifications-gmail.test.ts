import { describe, expect, it } from 'vitest';
import { createTranslator } from './i18n';
import {
	gmailGroupDataKey,
	gmailPaymentDataKey,
	isSpaceKind,
	NOTIFICATION_KIND_LABELS,
	notificationText,
	notificationUrl,
	parseParams
} from './notifications';

// FN-19b § A: the `gmail_payment` kind (AC 7): fixed templates, stored figures only, the shared money formatter.

const id = createTranslator('id');
const en = createTranslator('en');

const single = {
	draftId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
	transactionId: null,
	merchant: 'Kopi Kenangan',
	amountMinor: 4_500_000,
	currency: 'IDR',
	direction: 'expense',
	categoryName: 'Kopi',
	saved: false
};

describe('gmail_payment notifications', () => {
	it('is a space kind with a settings row', () => {
		expect(isSpaceKind('gmail_payment')).toBe(true);
		expect(NOTIFICATION_KIND_LABELS.gmail_payment.label).toBe('Pembayaran dari Gmail');
		expect(gmailPaymentDataKey('d1')).toBe('gmail:d1');
		expect(gmailGroupDataKey('s1', '2026-10-28')).toBe('gmailgroup:s1:2026-10-28');
	});

	it('parses only the stored single or group shape; anything else (mail fields, floats) is refused', () => {
		const p = parseParams('gmail_payment', JSON.stringify(single));
		expect(p).toEqual(single);
		expect(
			parseParams('gmail_payment', JSON.stringify({ count: 2, date: '2026-10-28', gmail: true }))
		).toEqual({ count: 2, date: '2026-10-28', gmail: true });
		for (const bad of [
			{ ...single, amountMinor: 45000.5 },
			{ ...single, direction: 'transfer' },
			{ ...single, saved: 'yes' },
			{ ...single, merchant: 'x'.repeat(201) },
			{ count: 0, date: '2026-10-28', gmail: true },
			{ count: 2, date: '2026-10-28' }
		])
			expect(parseParams('gmail_payment', JSON.stringify(bad))).toBeNull();
		// Extra fields are dropped: a sender, subject or Gmail id never reaches a payload.
		const extra = parseParams(
			'gmail_payment',
			JSON.stringify({ ...single, sender: 'a@b.example', subject: 's', gmailId: 'g' })
		);
		expect(Object.keys(extra!).sort()).toEqual(Object.keys(single).sort());
	});

	it('texts: owner wording in Indonesian and English, amount through formatMoney', () => {
		const p = parseParams('gmail_payment', JSON.stringify(single));
		expect(notificationText('gmail_payment', p, id, 'Pribadi')).toEqual({
			title: 'Pembayaran Rp 45.000 di Kopi Kenangan, Kopi',
			body: 'Perlu ditinjau'
		});
		const saved = parseParams(
			'gmail_payment',
			JSON.stringify({ ...single, saved: true, transactionId: 'tx1', categoryName: null })
		);
		expect(notificationText('gmail_payment', saved, id, 'Pribadi')).toEqual({
			title: 'Pembayaran Rp 45.000 di Kopi Kenangan',
			body: 'Tersimpan otomatis'
		});
		expect(notificationText('gmail_payment', saved, en, 'Personal').title).toBe(
			'Paid Rp 45.000 at Kopi Kenangan'
		);
		const income = parseParams(
			'gmail_payment',
			JSON.stringify({ ...single, direction: 'income', categoryName: null })
		);
		expect(notificationText('gmail_payment', income, id, null).title).toBe(
			'Uang masuk Rp 45.000 dari Kopi Kenangan'
		);
		const group = parseParams(
			'gmail_payment',
			JSON.stringify({ count: 2, date: '2026-10-28', gmail: true })
		);
		expect(notificationText('gmail_payment', group, id, 'Pribadi')).toEqual({
			title: '2 pembayaran baru dari Gmail',
			body: 'Pribadi'
		});
	});

	it('a generic notice (red team L1) names nothing', () => {
		const generic = parseParams(
			'gmail_payment',
			JSON.stringify({ ...single, merchant: null, amountMinor: null, categoryName: null })
		);
		expect(generic).not.toBeNull();
		expect(notificationText('gmail_payment', generic, id, 'Pribadi')).toEqual({
			title: 'Pembayaran baru dari Gmail',
			body: 'Perlu ditinjau'
		});
		expect(notificationText('gmail_payment', generic, en, 'Personal').title).toBe(
			'New payment from Gmail'
		);
		// Half-generic shapes are refused.
		expect(parseParams('gmail_payment', JSON.stringify({ ...single, merchant: null }))).toBeNull();
	});

	it('opens Kotak masuk for a draft, the review screen for a saved one or a group', () => {
		expect(
			notificationUrl('gmail_payment', parseParams('gmail_payment', JSON.stringify(single)))
		).toBe('/kotak-masuk');
		expect(
			notificationUrl(
				'gmail_payment',
				parseParams('gmail_payment', JSON.stringify({ ...single, saved: true, transactionId: 't' }))
			)
		).toBe('/pengaturan/aplikasi/gmail/transaksi');
		expect(notificationUrl('gmail_payment', { count: 3, date: '2026-10-28', gmail: true })).toBe(
			'/pengaturan/aplikasi/gmail/transaksi'
		);
	});
});
