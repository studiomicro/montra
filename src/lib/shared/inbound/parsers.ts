import { z } from 'zod';
import { isDateString, pad, wibInstantUtcMs } from '../dates.ts';
import { findMoneyMentions, MAX_AMOUNT_MINOR, parseMoneyAmount } from '../money-parse.ts';
import { cleanText, maskAccountNumbers } from '../text.ts';
import { TITLE_MAX_LENGTH } from '../transactions.ts';
import type { InboundParser } from './address.ts';
import { SENDER_DOMAINS, type SenderDomain } from './sender-domains.ts';

/**
 * Deterministic readers of payment notification mails (FN-19 PRD § 6), tried before any AI. Each knows one mail
 * shape and returns null for anything else — a missing field, a field given twice, a DB/CR mark against its
 * direction — never a guess ("money is never invented"). Amounts go only through the shared money parser, dates
 * are WIB (the time printed is WIB, so the date printed is `occurred_on`).
 *
 * The shapes and sender domains below are FICTIONAL (`*.example`, RFC 2606), modelled on common Indonesian
 * notifications. A real bank's mail therefore never matches a parser here and goes to the AI path; a parser is
 * pointed at a real sender domain only after the owner's redacted real samples confirm its shape (owner item).
 */

export interface ParsedPayment {
	direction: 'expense' | 'income';
	amountMinor: number;
	merchant: string;
	occurredOn: string;
	occurredAt: number;
	/** Masked to its last 4 digits when it is number-like (maskAccountNumbers): what the draft's note shows. */
	reference: string | null;
	/**
	 * The full reference, cleaned and normalised (upper-case, no spaces): only ever hashed into the dedupe key,
	 * never stored, so two payments whose references share the last 4 digits stay two captures (red team M1).
	 */
	referenceKey: string | null;
	/** Last 4 digits of the paying account or card, when printed. */
	last4: string | null;
}

const parsedPaymentSchema = z
	.object({
		direction: z.enum(['expense', 'income']),
		amountMinor: z.number().int().min(1).max(MAX_AMOUNT_MINOR),
		merchant: z.string().min(1).max(TITLE_MAX_LENGTH),
		occurredOn: z.string().refine(isDateString),
		occurredAt: z.number().int().nonnegative(),
		reference: z.string().min(1).max(64).nullable(),
		referenceKey: z.string().min(1).max(64).nullable(),
		last4: z
			.string()
			.regex(/^\d{4}$/)
			.nullable()
	})
	.strict();

const MONTHS: Readonly<Record<string, number>> = {
	jan: 1,
	januari: 1,
	january: 1,
	feb: 2,
	februari: 2,
	february: 2,
	mar: 3,
	maret: 3,
	march: 3,
	apr: 4,
	april: 4,
	mei: 5,
	may: 5,
	jun: 6,
	juni: 6,
	june: 6,
	jul: 7,
	juli: 7,
	july: 7,
	agu: 8,
	agt: 8,
	ags: 8,
	aug: 8,
	agustus: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	okt: 10,
	oct: 10,
	oktober: 10,
	october: 10,
	nov: 11,
	november: 11,
	des: 12,
	dec: 12,
	desember: 12,
	december: 12
};

/**
 * A printed WIB date and time → `occurred_on` and the UTC instant: `08 Okt 2026 14:32:05 WIB`,
 * `8 Oktober 2026, 14:32`, `8 Okt 2026 09:10`, `08/10/2026 18:05` (day first). Null for anything else.
 */
export function parseWibDateTime(value: string): { occurredOn: string; occurredAt: number } | null {
	const v = value.trim().replace(/\s+WIB$/i, '');
	let day: number, month: number, year: number, hh: number, mm: number, ss: number;
	const named =
		/^(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/i.exec(v);
	const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/.exec(
		v
	);
	if (named) {
		const name = (named[2] as string).toLowerCase();
		if (!Object.hasOwn(MONTHS, name)) return null;
		day = Number(named[1]);
		month = MONTHS[name] as number;
		year = Number(named[3]);
		hh = Number(named[4]);
		mm = Number(named[5]);
		ss = Number(named[6] ?? 0);
	} else if (numeric) {
		day = Number(numeric[1]);
		month = Number(numeric[2]);
		year = Number(numeric[3]);
		hh = Number(numeric[4]);
		mm = Number(numeric[5]);
		ss = Number(numeric[6] ?? 0);
	} else return null;
	if (hh > 23 || mm > 59 || ss > 59) return null;
	const occurredOn = `${year}-${pad(month)}-${pad(day)}`;
	if (!isDateString(occurredOn)) return null;
	return {
		occurredOn,
		occurredAt: wibInstantUtcMs(occurredOn, `${pad(hh)}:${pad(mm)}`) + ss * 1000
	};
}

/** The values of every `Label : value` line whose label matches (case-insensitive, whole label). */
function fields(text: string, label: string): string[] {
	const re = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'gim');
	return [...text.matchAll(re)].map((m) => (m[1] as string).trim());
}

/** The values of every whole line matching `re` (its first group). */
function lines(text: string, re: RegExp): string[] {
	return [...text.matchAll(new RegExp(re.source, 'gim'))].map((m) => (m[1] as string).trim());
}

/** Exactly one value, else null (a field missing or printed twice is never guessed between). */
const one = (values: readonly string[]): string | null =>
	values.length === 1 ? (values[0] as string) : null;

/** One printed amount → IDR minor units, refusing a second amount on the line or a DB/CR mark against `direction`. */
function amountOf(value: string | null, direction: ParsedPayment['direction']): number | null {
	if (value === null) return null;
	if (findMoneyMentions(value).length > 1) return null;
	const parsed = parseMoneyAmount(value);
	if (!parsed) return null;
	if (direction === 'expense' && parsed.direction === 'credit') return null;
	if (direction === 'income' && parsed.direction === 'debit') return null;
	const minor = parsed.minor;
	return Number.isSafeInteger(minor) && minor > 0 && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

const name = (value: string | null) =>
	value === null ? '' : maskAccountNumbers(cleanText(value, TITLE_MAX_LENGTH));
/** The reference as shown (masked) and as hashed (full, normalised); both null when none is printed. */
function reference(value: string | null): {
	reference: string | null;
	referenceKey: string | null;
} {
	const cleaned = value === null ? '' : cleanText(value, 64);
	if (cleaned === '') return { reference: null, referenceKey: null };
	return {
		reference: maskAccountNumbers(cleaned),
		referenceKey: cleaned.replace(/\s+/g, '').toUpperCase()
	};
}
function last4(value: string | null): string | null {
	const digits = (value ?? '').replace(/\D/g, '');
	return digits.length >= 4 ? digits.slice(-4) : null;
}

export interface MailParser {
	id: Exclude<InboundParser, 'ai'>;
	/** Sender domains this parser reads (fictional until confirmed by a real sample). */
	domains: readonly string[];
	subject: RegExp;
	read(text: string): Omit<ParsedPayment, 'occurredOn' | 'occurredAt'> & { when: string | null };
}

export const MAIL_PARSERS: readonly MailParser[] = [
	{
		// BCA-style QRIS notification.
		id: 'bank-qris',
		domains: ['notifikasi.bank-qris.example'],
		subject: /transaksi qris berhasil/i,
		read: (text) => ({
			direction: 'expense',
			amountMinor: amountOf(one(fields(text, 'Nominal')), 'expense') ?? 0,
			merchant: name(one(fields(text, 'Merchant'))),
			when: one(fields(text, 'Tanggal')),
			...reference(one(fields(text, 'No\\.? Referensi'))),
			last4: last4(one(fields(text, 'Sumber dana')))
		})
	},
	{
		// GoPay-style e-wallet payment receipt.
		id: 'ewallet-payment',
		domains: ['struk.dompet-digital.example'],
		subject: /bukti pembayaran/i,
		read: (text) => ({
			direction: 'expense',
			amountMinor: amountOf(one(lines(text, /^total bayar\s+(.+)$/)), 'expense') ?? 0,
			merchant: name(one(lines(text, /^pembayaran ke\s+(.+)$/))),
			when: one(lines(text, /^(\d{1,2}\s+[a-z]{3,9}\s+\d{4},\s+\d{1,2}:\d{2})$/)),
			...reference(one(fields(text, 'ID Transaksi'))),
			last4: null
		})
	},
	{
		// Jago-style incoming transfer.
		id: 'bank-transfer-in',
		domains: ['info.bank-digital.example'],
		subject: /kamu menerima transfer/i,
		read: (text) => ({
			direction: 'income',
			amountMinor: amountOf(one(fields(text, 'Jumlah')), 'income') ?? 0,
			merchant: name(one(fields(text, 'Dari'))),
			when: one(lines(text, /^(\d{1,2}\s+[a-z]{3,9}\s+\d{4}\s+\d{1,2}:\d{2})$/)),
			...reference(one(fields(text, 'Ref'))),
			last4: null
		})
	},
	{
		// Mandiri-style outgoing transfer.
		id: 'bank-transfer-out',
		domains: ['notif.bank-transfer.example'],
		subject: /transfer berhasil/i,
		read: (text) => ({
			direction: 'expense',
			amountMinor: amountOf(one(fields(text, 'Nominal')), 'expense') ?? 0,
			merchant: name(one(fields(text, 'Ke'))),
			when: one(fields(text, 'Tanggal')),
			...reference(one(fields(text, 'No\\.? Ref'))),
			last4: null
		})
	}
];

/**
 * The fictional fixture domains the parsers read (tests and local review only), tagged `fixture: true`: they are
 * never a confirmed sender (sender-domains.ts), so Gmail auto-save never trusts one.
 */
export const FIXTURE_SENDER_DOMAINS: readonly {
	domain: string;
	parserId: MailParser['id'];
	fixture: true;
}[] = MAIL_PARSERS.flatMap((p) =>
	p.domains.map((domain) => ({ domain, parserId: p.id, fixture: true as const }))
);

/**
 * The parser that reads mail from `domain` (exact, case-folded match), or null: a confirmed registry domain
 * (FN-19b, `registry` defaults to SENDER_DOMAINS) names its parser by id; else a fixture domain. A look-alike
 * (`evil-<domain>`, `<domain>.evil.tld`) matches nothing and goes to the AI path; a registry domain whose mail
 * does not fit its parser's shape also does (`parsePaymentMail` returns null), never a guessed amount.
 */
export function parserFor(
	domain: string | null,
	registry: readonly SenderDomain[] = SENDER_DOMAINS
): MailParser | null {
	if (!domain) return null;
	const d = domain.toLowerCase();
	const confirmed = registry.find((e) => e.domain === d);
	if (confirmed) return MAIL_PARSERS.find((p) => p.id === confirmed.parserId) ?? null;
	return MAIL_PARSERS.find((p) => p.domains.includes(d)) ?? null;
}

/** Whether `domain` is a sender some parser reads (the allowlist of `verified` trust). */
export const isAllowlistedSender = (domain: string): boolean => parserFor(domain) !== null;

/** One mail read by `parser`, schema-checked, or null when anything does not fit its shape. Never throws. */
export function parsePaymentMail(
	parser: MailParser,
	subject: string,
	text: string
): ParsedPayment | null {
	if (!parser.subject.test(subject)) return null;
	const { when, ...read } = parser.read(text);
	const at = when === null ? null : parseWibDateTime(when);
	if (!at || read.amountMinor <= 0 || read.merchant === '') return null;
	const checked = parsedPaymentSchema.safeParse({ ...read, ...at });
	return checked.success ? checked.data : null;
}
