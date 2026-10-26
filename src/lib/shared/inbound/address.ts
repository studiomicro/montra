import { msg } from '../i18n.ts';

/**
 * FN-19 e-mail forwarding (docs/features/fn-19-forwarding/PRD.md): one secret address per user, pointing at one
 * space. The address is `<local>@<INBOUND_EMAIL_DOMAIN>`, `local` = `m-` + 26 Crockford base32 characters from 16
 * random bytes (128 bits). It is a bearer secret: never logged, never in an analytics event or an error string.
 * Sender authenticity never depends on it (auth-results.ts).
 */

export const INBOUND_ADDRESS_STATUSES = ['active', 'revoked'] as const;

/** What became of one received mail (the `inbound_mail` ledger). */
export const INBOUND_MAIL_STATUSES = [
	'queued',
	'draft_created',
	'not_payment',
	'unreadable',
	'confirmation'
] as const;
export type InboundMailStatus = (typeof INBOUND_MAIL_STATUSES)[number];

/** Why a mail is `unreadable` (a fixed code list; the page translates it). */
export const INBOUND_MAIL_REASONS = [
	'malformed',
	'no_ai_key',
	'ai_unconfigured',
	'ai_failed',
	'ai_invalid',
	'expired',
	'inbox_full',
	'currency',
	'unparsed'
] as const;
export type InboundMailReason = (typeof INBOUND_MAIL_REASONS)[number];

/** Reasons a re-forward of the same mail may reprocess (the user fixed the cause; no text was kept). */
export const REPROCESSABLE_REASONS = ['no_ai_key', 'ai_unconfigured'] as const;

/** How far the sender is trusted (auth-results.ts). Only `verified` drafts carry no review flag. */
export const INBOUND_TRUST = ['verified', 'forwarded', 'unverified'] as const;
export type InboundTrust = (typeof INBOUND_TRUST)[number];

/** Who read a payment mail: one of the deterministic parsers, or the user's own AI key. */
export const INBOUND_PARSERS = [
	'bank-qris',
	'ewallet-payment',
	'bank-transfer-in',
	'bank-transfer-out',
	'ai'
] as const;
export type InboundParser = (typeof INBOUND_PARSERS)[number];

/** Owner decision 4: 1 MiB per message (receipts are text). */
export const MAX_INBOUND_BYTES = 1024 * 1024;
/** Owner decision 5: mails per address per hour; more are dropped silently (no bounce, no backscatter). */
export const INBOUND_RATE_PER_HOUR = 60;
export const INBOUND_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Longest mail text kept for the AI read (only while `queued`, at most 24 h). */
export const PENDING_TEXT_MAX = 6000;
export const SUBJECT_MAX = 200;
export const SENDER_DOMAIN_MAX = 80;
/** A Gmail forwarding confirmation code: digits only, at most 12. */
export const CONFIRMATION_CODE_MAX = 12;
/** How long the settings page shows a confirmation code, and pending AI text may live (owner decision 4). */
export const INBOUND_HOLD_MS = 24 * 60 * 60 * 1000;
/** Owner decision 4: ledger rows are deleted after 90 days. */
export const INBOUND_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const LOCAL_PART = /^m-[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
/** A DNS hostname with at least one dot: labels of 1–63 letters, digits and inner hyphens, at most 253 chars. */
const HOSTNAME =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A fresh local part: `m-` + 16 random bytes as 26 lower-case Crockford base32 characters. */
export function newLocalPart(
	bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))
): string {
	if (bytes.length !== 16) throw new RangeError('16 bytes expected');
	let out = '';
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
	return `m-${out}`;
}

export function isLocalPart(value: string): boolean {
	return LOCAL_PART.test(value);
}

/** The configured forwarding domain (`INBOUND_EMAIL_DOMAIN`), lower-cased, or null when unset or malformed. */
export function inboundDomain(value: string | undefined | null): string | null {
	const domain = (value ?? '').trim().toLowerCase();
	return HOSTNAME.test(domain) ? domain : null;
}

export function formatAddress(localPart: string, domain: string): string {
	return `${localPart}@${domain}`;
}

/**
 * The local part `to` names on `domain`, lower-cased, or null when it is another domain or not an address shape
 * MONTRA ever issues (so a guessed or malformed recipient costs no database read).
 */
export function recipientLocalPart(to: string, domain: string | null): string | null {
	if (!domain || to.length > 320) return null;
	const address = to.trim().toLowerCase();
	const at = address.lastIndexOf('@');
	if (at <= 0 || address.slice(at + 1) !== domain) return null;
	const local = address.slice(0, at);
	return isLocalPart(local) ? local : null;
}

/** The settings page's words for each ledger state and reason (translated with tr()). */
export const INBOUND_STATUS_LABELS: Readonly<Record<InboundMailStatus, string>> = {
	queued: msg('Sedang dibaca'),
	draft_created: msg('Masuk Kotak masuk'),
	not_payment: msg('Bukan pembayaran'),
	unreadable: msg('Tidak terbaca'),
	confirmation: msg('Kode konfirmasi Gmail')
};

export const INBOUND_REASON_LABELS: Readonly<Record<InboundMailReason, string>> = {
	malformed: msg('E-mail rusak atau tidak bisa dibaca.'),
	no_ai_key: msg('Belum ada kunci Anthropic. Tambahkan kunci, lalu teruskan e-mail ini lagi.'),
	ai_unconfigured: msg('Pembacaan AI belum dikonfigurasi di server ini.'),
	ai_failed: msg('Pembacaan AI gagal. Periksa kunci Anthropic-mu di Integrasi AI.'),
	ai_invalid: msg('AI tidak bisa membaca nominal dan tanggalnya.'),
	expired: msg('Terlalu lama menunggu dibaca; teksnya sudah dihapus.'),
	inbox_full: msg('Kotak masuk penuh (1.000 draf). Tinjau draf dulu.'),
	currency: msg('Mata uang selain rupiah belum didukung.'),
	unparsed: msg('Isi e-mail kosong atau tidak terbaca.')
};

export const INBOUND_TRUST_LABELS: Readonly<Record<InboundTrust, string>> = {
	verified: msg('Pengirim terverifikasi'),
	forwarded: msg('Diteruskan, belum terverifikasi'),
	unverified: msg('Pengirim belum terverifikasi')
};
