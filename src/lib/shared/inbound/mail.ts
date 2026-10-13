import { findMoneyMentions } from '../money-parse.ts';
import { cleanText, maskAccountNumbers } from '../text.ts';
import { CONFIRMATION_CODE_MAX } from './address.ts';

/**
 * Untrusted mail text made safe to read (checklist › Untrusted text): capped before any work, each line cleaned
 * by the shared `cleanText` (invisible and control characters stripped, NFC, whitespace collapsed), quote marks of
 * a forwarded mail (`> `) dropped, empty lines removed. The result is only ever parsed or sent to the AI as data,
 * never rendered as HTML.
 */

/** Characters of a mail body looked at; a payment notification is far shorter. */
export const MAIL_TEXT_MAX = 20_000;
const LINE_MAX = 500;
const MAX_LINES = 400;

export function cleanMailText(text: string, max = MAIL_TEXT_MAX): string {
	const lines: string[] = [];
	let size = 0;
	for (const raw of text.slice(0, max).split(/\r\n|\r|\n/)) {
		const line = cleanText(raw.replace(/^(?:\s*>)+/, ''), LINE_MAX);
		if (line === '') continue;
		lines.push(line);
		size += line.length + 1;
		if (lines.length >= MAX_LINES || size >= max) break;
	}
	return lines.join('\n').slice(0, max);
}

const ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

/** Plain text of an HTML body (tags dropped, block ends as line breaks, a few entities decoded). Never rendered. */
export function htmlToText(html: string, max = MAIL_TEXT_MAX * 4): string {
	return html
		.slice(0, max)
		.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|table)\s*>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, name: string) => {
			const n = name.toLowerCase();
			if (n.startsWith('#x')) return safeChar(parseInt(n.slice(2), 16), whole);
			if (n.startsWith('#')) return safeChar(parseInt(n.slice(1), 10), whole);
			return Object.hasOwn(ENTITIES, n) ? (ENTITIES[n] as string) : whole;
		});
}

function safeChar(code: number, fallback: string): string {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff
		? String.fromCodePoint(code)
		: fallback;
}

const EMAIL =
	/([a-z0-9._%+-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/i;

/** The domain of an e-mail address, lower-cased, or null. */
export function addressDomain(address: string): string | null {
	const m = EMAIL.exec(address.trim());
	return m && m[0].length === address.trim().length ? (m[2] as string).toLowerCase() : null;
}

/**
 * The sender domain quoted in a manually forwarded mail ("From: Bank <info@bank.example>" / "Dari: …"), used only
 * to pick a parser, never as proof of anything.
 */
export function quotedSenderDomain(text: string): string | null {
	for (const line of text.matchAll(/^(?:from|dari)\s*:\s*(.{1,300})$/gim)) {
		const m = EMAIL.exec(line[1] as string);
		if (m) return (m[2] as string).toLowerCase();
	}
	return null;
}

/** Google's forwarding-confirmation sender (Gmail › Settings › Forwarding). */
const GMAIL_CONFIRMATION_FROM = 'forwarding-noreply@google.com';

/**
 * The code of a Gmail forwarding confirmation mail ("(#123456789) Gmail Forwarding Confirmation …"; the body's
 * "Confirmation code: 123456789"), digits only, or null when this is not one. The link and body are discarded.
 */
export function gmailConfirmationCode(
	fromAddress: string,
	subject: string,
	text: string
): string | null {
	if (fromAddress.trim().toLowerCase() !== GMAIL_CONFIRMATION_FROM) return null;
	if (!/forwarding confirmation|konfirmasi penerusan/i.test(subject)) return null;
	const m =
		/\(#(\d{1,12})\)/.exec(subject) ??
		/(?:confirmation code|kode konfirmasi)\s*:\s*(\d{1,12})\b/i.exec(text);
	const code = m?.[1] ?? null;
	return code && code.length <= CONFIRMATION_CODE_MAX ? code : null;
}

/**
 * FN-19 payment words in a subject (owner list). Also the subject terms of the Gmail search prefilter
 * (shared/gmail/query.ts), so both paths look for the same words.
 */
export const PAYMENT_SUBJECT_WORDS = [
	'qris',
	'struk',
	'invoice',
	'tagihan',
	'bukti pembayaran',
	'transaksi berhasil',
	'pembayaran berhasil',
	'transfer berhasil',
	'menerima transfer',
	'receipt'
] as const;
const PAYMENT_SUBJECT = new RegExp(`\\b(?:${PAYMENT_SUBJECT_WORDS.join('|')})\\b`, 'i');
/** Never a payment: one-time codes, promotions, an unpaid bill, shipping. Checked before the payment words. */
const NOT_PAYMENT_SUBJECT =
	/\b(?:otp|kode verifikasi|verification code|one[- ]time|promo|diskon spesial|penawaran|jatuh tempo|belum dibayar|segera bayar|pengiriman|dikirim|nomor resi|newsletter)\b/i;

/**
 * Whether a mail is worth reading as a payment: its sender domain is on a parser's allowlist or its subject
 * carries a payment word, it is not an OTP/promo/unpaid-bill/shipping mail, and its text holds an amount.
 * Everything else is `not_payment` and keeps only its id and date.
 */
export function looksLikePayment(input: {
	allowlisted: boolean;
	subject: string;
	text: string;
}): boolean {
	if (NOT_PAYMENT_SUBJECT.test(input.subject)) return false;
	if (!input.allowlisted && !PAYMENT_SUBJECT.test(input.subject)) return false;
	return mailAmounts(input.text).length > 0;
}

/**
 * Every amount printed in a cleaned mail text (minor units, sign dropped), read line by line so a long mail is
 * read whole (the money parser caps one input at MONEY_TEXT_MAX).
 */
export function mailAmounts(text: string): number[] {
	return text
		.slice(0, MAIL_TEXT_MAX)
		.split('\n')
		.flatMap((line) => findMoneyMentions(line).map((m) => Math.abs(m.minor)));
}

/** Lines of a cleaned text, each masked to the last 4 digits of any account or card number (before the AI read). */
export const maskMailLines = (text: string) => text.split('\n').map(maskAccountNumbers).join('\n');
