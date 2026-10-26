import { z } from 'zod';
import { isDateString } from '../../shared/dates.ts';
import { currencyExponent } from '../../shared/money-format.ts';
import { MAX_AMOUNT_MINOR, parseMoneyAmount } from '../../shared/money-parse.ts';
import {
	RECEIPT_ITEMS_MAX,
	RECEIPT_PAYMENT_MAX_LENGTH,
	type ReceiptReading
} from '../../shared/receipts.ts';
import { cleanText, maskAccountNumbers } from '../../shared/text.ts';
import { TITLE_MAX_LENGTH } from '../../shared/transactions.ts';

/**
 * The model's answer checked field by field (checklist › Schema-validated output). Everything in it is untrusted
 * — the receipt itself may carry text written to steer the model — so only these fields are read, each bounded,
 * cleaned of control and zero-width characters, card and account numbers masked to the last 4 digits, amounts
 * parsed by the shared money parser (never `parseFloat`). An answer that does not fit is `invalid`: a clear
 * "Tidak bisa membaca strukmu", never a crash and never a half-filled form.
 */

/** Longest text field accepted from the model (a printed line is far shorter). */
const FIELD_MAX = 500;

const text = z.string().max(FIELD_MAX);
const nullableText = text.nullable();

const receiptOutputSchema = z
	.object({
		is_receipt: z.boolean(),
		shop: nullableText,
		date: nullableText,
		currency: nullableText,
		items: z.array(z.object({ name: text, amount: nullableText }).strict()).max(RECEIPT_ITEMS_MAX),
		tax: nullableText,
		service: nullableText,
		discount: nullableText,
		total: nullableText,
		payment_method: nullableText
	})
	.strict();

/**
 * A printed amount → IDR minor units, or null when it is missing, not one amount, has sen (the review form
 * holds whole rupiah, so a figure with sen is left for the user rather than cut), or is out of range. A leading
 * minus or brackets (a printed discount) are dropped: the field says what the amount is.
 */
export function printedAmountMinor(printed: string | null): number | null {
	if (printed === null) return null;
	const bare = printed
		.trim()
		.replace(/^[-−]\s*/, '')
		.replace(/^\((.*)\)$/, '$1');
	const parsed = parseMoneyAmount(bare);
	if (!parsed) return null;
	const minor = Math.abs(parsed.minor);
	if (!Number.isSafeInteger(minor) || minor <= 0 || minor > MAX_AMOUNT_MINOR) return null;
	return minor % 10 ** currencyExponent('IDR') === 0 ? minor : null;
}

const clean = (value: string | null, max: number) =>
	value === null ? '' : maskAccountNumbers(cleanText(value, max));

export type ReceiptInterpretation =
	{ kind: 'ok'; reading: ReceiptReading } | { kind: 'not_a_receipt' } | { kind: 'invalid' };

/** The text of the model's answer → a reading, `not_a_receipt`, or `invalid`. Never throws. */
export function interpretReceiptAnswer(answer: string): ReceiptInterpretation {
	let json: unknown;
	try {
		json = JSON.parse(answer);
	} catch {
		return { kind: 'invalid' };
	}
	const parsed = receiptOutputSchema.safeParse(json);
	if (!parsed.success) return { kind: 'invalid' };
	const out = parsed.data;
	if (!out.is_receipt) return { kind: 'not_a_receipt' };
	const items = out.items
		.map((item) => ({
			name: clean(item.name, TITLE_MAX_LENGTH),
			amountMinor: printedAmountMinor(item.amount)
		}))
		.filter((item) => item.name !== '' || item.amountMinor !== null);
	const totalMinor = printedAmountMinor(out.total);
	// Nothing legible to review: the same answer as an unreadable photo.
	if (items.length === 0 && totalMinor === null) return { kind: 'invalid' };
	const currency = out.currency?.trim().toUpperCase() ?? '';
	const date = out.date?.trim() ?? '';
	return {
		kind: 'ok',
		reading: {
			shop: clean(out.shop, TITLE_MAX_LENGTH),
			occurredOn: isDateString(date) ? date : null,
			items,
			taxMinor: printedAmountMinor(out.tax),
			serviceMinor: printedAmountMinor(out.service),
			discountMinor: printedAmountMinor(out.discount),
			totalMinor,
			currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
			paymentMethod: clean(out.payment_method, RECEIPT_PAYMENT_MAX_LENGTH)
		}
	};
}
