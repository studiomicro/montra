import PostalMime from 'postal-mime';
import type { MailHeader } from '#lib/shared/inbound/auth-results';
import { cleanMailText, htmlToText } from '#lib/shared/inbound/mail';

/** One received mail as the processing step reads it: every string untrusted, the text already cleaned. */
export interface InboundMail {
	messageId: string | null;
	date: string | null;
	/** The From address (lower-cased), '' when absent. */
	fromAddress: string;
	subject: string;
	/** Plain text (or the HTML part as text), cleaned line by line; never rendered. */
	text: string;
	/** Every header, topmost first (for the topmost Authentication-Results). */
	headers: MailHeader[];
}

/** MIME parsing limits: a payment notification needs none of what these stop. */
const PARSE_LIMITS = { maxNestingDepth: 8, maxHeadersSize: 64 * 1024, maxRfc822NestingDepth: 1 };
const MAX_HEADERS = 200;
const MAX_HEADER_VALUE = 4096;

/**
 * The raw stream read to at most `max` bytes; null when it is longer (Email Routing's `rawSize` may not be what
 * the stream holds, so the cap is enforced on the bytes themselves and the rest is never read).
 */
export async function readCapped(
	stream: ReadableStream<Uint8Array>,
	max: number
): Promise<Uint8Array<ArrayBuffer> | null> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > max) return null;
			chunks.push(value);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		all.set(c, at);
		at += c.byteLength;
	}
	return all;
}

const short = (value: string | undefined, max: number) =>
	value === undefined ? null : value.slice(0, max).trim() || null;

/**
 * The mail parsed with postal-mime under PARSE_LIMITS, or null when it is malformed (any parser error, the
 * limits included). Attachments are never looked at.
 */
export async function parseMail(raw: Uint8Array): Promise<InboundMail | null> {
	try {
		const email = await PostalMime.parse(raw, PARSE_LIMITS);
		const from = email.from && 'address' in email.from ? (email.from.address ?? '') : '';
		const body = email.text ?? (email.html ? htmlToText(email.html) : '');
		return {
			messageId: short(email.messageId, 300),
			date: short(email.date, 100),
			fromAddress: from.slice(0, 320).trim().toLowerCase(),
			subject: (email.subject ?? '').slice(0, 1000),
			text: cleanMailText(body),
			headers: email.headers
				.slice(0, MAX_HEADERS)
				.map((h) => ({ key: h.key, value: h.value.slice(0, MAX_HEADER_VALUE) }))
		};
	} catch {
		return null;
	}
}
