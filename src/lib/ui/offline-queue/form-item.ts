import { typedAmountMinor } from '#lib/shared/amount-input';
import type { Locale } from '#lib/shared/i18n';
import type { QueueSummary } from '#lib/shared/offline-queue';

/**
 * FN-02: a page form as a queue item's payload and summary. The payload is exactly the fields the page action
 * reads (text fields only; the item's own `clientId` travels beside it, not inside).
 */
export function formPayload(form: FormData): [string, string][] {
	const pairs: [string, string][] = [];
	for (const [name, value] of form.entries())
		if (typeof value === 'string' && name !== 'clientId') pairs.push([name, value]);
	return pairs;
}

const text = (form: FormData, name: string) => {
	const v = form.get(name);
	return typeof v === 'string' ? v : '';
};

/** Integer minor units of an amount field in the wallet's currency (`locale`'s separators), or null when empty. */
export function formAmountMinor(amount: string, currency: string, locale: Locale): number | null {
	return typedAmountMinor(amount, currency, locale);
}

/** The compose/edit form's summary: its title and amount in the chosen wallet's currency. */
export function transactionSummary(
	form: FormData,
	wallets: readonly { id: string; currency: string }[],
	locale: Locale
): QueueSummary {
	const currency = wallets.find((w) => w.id === text(form, 'walletId'))?.currency ?? 'IDR';
	return {
		title: text(form, 'title').trim().slice(0, 80),
		amountMinor: formAmountMinor(text(form, 'amount'), currency, locale),
		currency,
		count: 1
	};
}

/**
 * The voice review form's summary: the first row's title, the rows' total when they share one currency
 * (never summed across currencies), and the row count.
 */
export function voiceSummary(
	form: FormData,
	wallets: readonly { id: string; currency: string }[],
	locale: Locale
): QueueSummary {
	const count = Math.max(0, Math.min(Number(text(form, 'count')) || 0, 100));
	const rows = Array.from({ length: count }, (_, i) => {
		const currency = wallets.find((w) => w.id === text(form, `walletId.${i}`))?.currency ?? 'IDR';
		return { currency, minor: formAmountMinor(text(form, `amount.${i}`), currency, locale) };
	});
	const currencies = new Set(rows.map((r) => r.currency));
	const one = currencies.size === 1 && rows.every((r) => r.minor !== null);
	return {
		title: text(form, 'title.0').trim().slice(0, 80),
		amountMinor: one ? rows.reduce((sum, r) => sum + (r.minor ?? 0), 0) : null,
		currency: one ? (rows[0]?.currency ?? 'IDR') : 'IDR',
		count
	};
}
