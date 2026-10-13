import { base64urlDecode } from '../base64url.ts';
import type { MailHeader } from '../inbound/auth-results.ts';
import { cleanMailText, htmlToText } from '../inbound/mail.ts';

/**
 * One Gmail `users.messages.get` (`format=full`) answer turned into the mail the shared pipeline reads (FN-19
 * Gmail PRD § 7.3), every value untrusted. Only the top-level headers and the body text of `text/plain` and
 * `text/html` parts WITHOUT a `filename` and WITHOUT an `attachmentId` are looked at; every other part
 * (attachments, inline images, `message/rfc822`) is skipped unread and undecoded. Depth, part count, header count
 * and decoded size are capped; anything that does not fit the expected shape is `malformed`. Never throws.
 */

export interface GmailMail {
	gmailId: string;
	/** Epoch ms Gmail received it (`internalDate`), null when absent. */
	internalDate: number | null;
	labelIds: string[];
	messageId: string | null;
	date: string | null;
	/** The From address (lower-cased), '' when absent. */
	fromAddress: string;
	subject: string;
	/** Cleaned text (plain part, else the HTML part as text); never rendered. */
	text: string;
	/** Top-level headers, topmost first, lower-case names. */
	headers: MailHeader[];
}

export type GmailParse = { kind: 'ok'; mail: GmailMail } | { kind: 'malformed' };

/** Labels that make a mail `not_payment` whatever the search returned. */
export const EXCLUDED_LABELS = [
	'CATEGORY_PROMOTIONS',
	'CATEGORY_SOCIAL',
	'SPAM',
	'TRASH',
	'DRAFT',
	'SENT'
] as const;

export const isExcludedByLabel = (labelIds: readonly string[]) =>
	labelIds.some((l) => (EXCLUDED_LABELS as readonly string[]).includes(l));

const MAX_DEPTH = 8;
const MAX_PARTS = 100;
const MAX_HEADERS = 200;
const MAX_HEADER_VALUE = 4096;
const MAX_LABELS = 100;
/** Decoded bytes of one body part looked at; a payment notification is far smaller. */
const MAX_PART_BYTES = 512 * 1024;
const GMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** RFC 2047 encoded words (`=?charset?B|Q?text?=`) decoded; anything undecodable is left as it was. */
export function decodeEncodedWords(value: string): string {
	return value
		.replace(/(=\?[^?\s]{1,40}\?[bq]\?[^?\s]*\?=)\s+(?==\?)/gi, '$1')
		.replace(
			/=\?([^?\s]{1,40})\?([bq])\?([^?\s]*)\?=/gi,
			(whole, charset: string, enc: string, text: string) => {
				let bytes: Uint8Array | null;
				if (enc.toLowerCase() === 'b') {
					try {
						const binary = atob(text);
						bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
					} catch {
						bytes = null;
					}
				} else {
					const q = text.replace(/_/g, ' ');
					const out: number[] = [];
					for (let i = 0; i < q.length; i++) {
						const hex = q[i] === '=' ? /^[0-9a-f]{2}$/i.exec(q.slice(i + 1, i + 3)) : null;
						if (hex) {
							out.push(parseInt(hex[0], 16));
							i += 2;
						} else out.push(q.charCodeAt(i) & 0xff);
					}
					bytes = Uint8Array.from(out);
				}
				return bytes ? decodeText(bytes, charset) : whole;
			}
		);
}

/** Bytes as text in `charset` (unknown charsets as UTF-8), invalid sequences replaced, never throwing. */
function decodeText(bytes: Uint8Array, charset: string | null): string {
	try {
		return new TextDecoder(charset ?? 'utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
	} catch {
		return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
	}
}

/** The `charset` parameter of a part's Content-Type header, or null. */
function charsetOf(part: Json): string | null {
	const headers = Array.isArray(part.headers) ? part.headers.slice(0, MAX_HEADERS) : [];
	for (const h of headers) {
		if (!isObject(h) || str(h.name)?.toLowerCase() !== 'content-type') continue;
		const m = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(str(h.value) ?? '');
		return m ? (m[1] as string) : null;
	}
	return null;
}

/**
 * The Date header as the forwarding path's MIME parser gives it (ISO 8601 when it parses, else the raw value),
 * so a mail without a Message-ID gets the same fallback ledger key through Gmail and through forwarding.
 */
function isoDate(value: string | null): string | null {
	if (value === null) return null;
	const raw = value.slice(0, 100).trim();
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : raw || null;
}

/** The From header's address, lower-cased: `Name <addr>` or a bare address; '' when there is none. */
function addressOf(from: string): string {
	const angle = /<([^<>\s]{1,320})>/.exec(from);
	const raw = angle ? (angle[1] as string) : from.trim();
	return /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(raw) ? raw.toLowerCase() : '';
}

interface Bodies {
	plain: string | null;
	html: string | null;
	parts: number;
}

/** Collects the first plain and first HTML body part; false when a cap or the shape is broken. */
function walk(part: unknown, depth: number, out: Bodies): boolean {
	if (!isObject(part) || depth > MAX_DEPTH || ++out.parts > MAX_PARTS) return false;
	const mime = (str(part.mimeType) ?? '').toLowerCase();
	const body = isObject(part.body) ? part.body : {};
	// An attachment, however small and whatever its type, is never decoded.
	if ((str(part.filename) ?? '') !== '' || str(body.attachmentId) !== null) return true;
	if (mime.startsWith('multipart/')) {
		const parts = Array.isArray(part.parts) ? part.parts : [];
		for (const p of parts) if (!walk(p, depth + 1, out)) return false;
		return true;
	}
	if (mime !== 'text/plain' && mime !== 'text/html') return true;
	if ((mime === 'text/plain' ? out.plain : out.html) !== null) return true;
	const data = str(body.data) ?? '';
	// Base64url grows by 4/3: anything longer than the cap decodes past it.
	if (data.length > Math.ceil((MAX_PART_BYTES * 4) / 3) + 4) return true;
	const bytes = base64urlDecode(data);
	if (!bytes) return false;
	const text = decodeText(bytes, charsetOf(part));
	if (mime === 'text/plain') out.plain = text;
	else out.html = text;
	return true;
}

/** The answer of `messages.get` as a mail, or `malformed`. */
export function parseGmailMessage(json: unknown): GmailParse {
	try {
		if (!isObject(json) || !isObject(json.payload)) return { kind: 'malformed' };
		const gmailId = str(json.id) ?? '';
		if (!GMAIL_ID.test(gmailId)) return { kind: 'malformed' };
		const internal = Number(str(json.internalDate) ?? json.internalDate);
		const labelIds = (Array.isArray(json.labelIds) ? json.labelIds : [])
			.slice(0, MAX_LABELS)
			.filter((l): l is string => typeof l === 'string' && l.length <= 100);
		const rawHeaders = Array.isArray(json.payload.headers)
			? json.payload.headers.slice(0, MAX_HEADERS)
			: [];
		const headers: MailHeader[] = [];
		for (const h of rawHeaders) {
			const name = isObject(h) ? str(h.name) : null;
			const value = isObject(h) ? str(h.value) : null;
			if (name === null || value === null || name.length > 100) continue;
			headers.push({ key: name.toLowerCase(), value: value.slice(0, MAX_HEADER_VALUE) });
		}
		const header = (name: string) => headers.find((h) => h.key === name)?.value ?? null;
		const bodies: Bodies = { plain: null, html: null, parts: 0 };
		if (!walk(json.payload, 0, bodies)) return { kind: 'malformed' };
		const body = bodies.plain ?? (bodies.html !== null ? htmlToText(bodies.html) : '');
		const short = (v: string | null, max: number) =>
			v === null ? null : v.slice(0, max).trim() || null;
		return {
			kind: 'ok',
			mail: {
				gmailId,
				internalDate: Number.isSafeInteger(internal) && internal > 0 ? internal : null,
				labelIds,
				messageId: short(header('message-id'), 300),
				date: isoDate(header('date')),
				fromAddress: addressOf(decodeEncodedWords(header('from') ?? '')),
				subject: decodeEncodedWords(header('subject') ?? '').slice(0, 1000),
				text: cleanMailText(body),
				headers
			}
		};
	} catch {
		return { kind: 'malformed' };
	}
}
