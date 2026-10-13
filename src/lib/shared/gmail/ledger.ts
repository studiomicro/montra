import { msg } from '../i18n.ts';

/**
 * FN-19 Gmail auto-capture (docs/features/fn-19-gmail/PRD.md): the states and limits of a user's Gmail
 * connection, its scans and its per-mail ledger. Shared by the app Worker (settings page) and the jobs Worker
 * (hourly checks, look-back scans, reads). The ledger holds ids, dates, status and reason codes only; a payment
 * mail adds its sender domain, masked subject, trust and parser. No column can hold mail text.
 */

export const GMAIL_CONNECTION_STATUSES = ['connected', 'needs_reconnect'] as const;
export type GmailConnectionStatus = (typeof GMAIL_CONNECTION_STATUSES)[number];

/** Why a connection needs reconnecting: Google refused the refresh token, or the sealing key no longer opens it. */
export const GMAIL_RECONNECT_REASONS = ['revoked', 'key'] as const;
export type GmailReconnectReason = (typeof GMAIL_RECONNECT_REASONS)[number];

/** Why automatic checks stopped without the user turning them off. */
export const GMAIL_PAUSED_REASONS = ['space_lost'] as const;
export type GmailPausedReason = (typeof GMAIL_PAUSED_REASONS)[number];

export const GMAIL_SCAN_KINDS = ['hourly', 'lookback'] as const;
export type GmailScanKind = (typeof GMAIL_SCAN_KINDS)[number];

export const GMAIL_SCAN_STATUSES = ['running', 'done', 'cancelled', 'failed'] as const;
export type GmailScanStatus = (typeof GMAIL_SCAN_STATUSES)[number];

export const GMAIL_MAIL_STATUSES = [
	'listed',
	'draft_created',
	'not_payment',
	'unreadable'
] as const;
export type GmailMailStatus = (typeof GMAIL_MAIL_STATUSES)[number];

export const GMAIL_MAIL_REASONS = [
	'malformed',
	'too_large',
	'gone',
	'fetch_failed',
	'no_ai_key',
	'ai_unconfigured',
	'ai_failed',
	'ai_invalid',
	'expired',
	'inbox_full',
	'currency',
	'unparsed',
	'key',
	'ai_limit'
] as const;
export type GmailMailReason = (typeof GMAIL_MAIL_REASONS)[number];

/** Reasons "Baca ulang yang tertunda" may re-queue (the user fixed the cause; nothing was kept). */
export const GMAIL_REREAD_REASONS = ['no_ai_key', 'ai_unconfigured', 'ai_limit'] as const;

/** Gmail captures are `verified` or `unverified`; there is no forwarded hop here. */
export const GMAIL_TRUST = ['verified', 'unverified'] as const;

/** Mail ids one `messages.list` page returns (Gmail allows up to 500; 100 fits one Queues `sendBatch`). */
export const GMAIL_PAGE_SIZE = 100;
/** Pages and ids one scan lists at most (said in the UI). */
export const GMAIL_SCAN_MAX_PAGES = 20;
export const GMAIL_SCAN_MAX_IDS = 2000;
/** Quota units (Gmail API quota page): `messages.list` 5, `messages.get` 20. */
export const GMAIL_UNITS = { list: 5, get: 20 } as const;
/** Units one connection may spend per minute: half of Google's documented 6,000 per user per minute. */
export const GMAIL_UNITS_PER_MINUTE = 3000;
/** The overlap of an hourly check with the previous one, so a mail on the boundary is never missed. */
export const GMAIL_CHECK_OVERLAP_S = 120;
/** How far back the very first hourly check of a new connection looks (older mail: "Lihat ke belakang"). */
export const GMAIL_FIRST_CHECK_S = 60 * 60;
/** "Periksa sekarang": one manual check per this many minutes (the scan window is the 5-minute bucket). */
export const GMAIL_CHECK_NOW_MINUTES = 5;
/**
 * AI reads one connection may make per 24 hours (red team L6): any outside sender can mail a payment-like subject,
 * and each such mail is read on the owner's own Anthropic key. Over it the mail is `unreadable/ai_limit`, which
 * "Baca ulang yang tertunda" can queue again later.
 */
export const GMAIL_AI_READS_PER_DAY = 200;
export const GMAIL_AI_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Look-back scans started per connection per 24 hours. */
export const GMAIL_LOOKBACKS_PER_DAY = 3;
/** Connect starts per user per throttle window (`gmail-connect`). */
export const GMAIL_CONNECTS_PER_WINDOW = 10;
/** Manual checks, look-backs and re-reads per user per throttle window (`gmail-scan`). */
export const GMAIL_SCAN_ACTIONS_PER_WINDOW = 10;
/** Unfinished OAuth states live this long, at most this many per user. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATES_PER_USER = 5;
/** A `listed` row older than this is sent to the queue again (its read may have failed or been lost). */
export const GMAIL_REQUEUE_AFTER_MS = 15 * 60 * 1000;
/** A `listed` row older than this is given up (`unreadable/expired`). */
export const GMAIL_LISTED_EXPIRE_MS = 48 * 60 * 60 * 1000;
/** A scan running longer than this is `failed` (its listed rows stay readable). */
export const GMAIL_SCAN_STALE_MS = 6 * 60 * 60 * 1000;
/** Ledger rows are deleted after 90 days. */
export const GMAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Rows "Baca ulang yang tertunda" re-queues at most. */
export const GMAIL_REREAD_MAX = 200;

/** The settings page's words for each ledger reason (translated with tr()). */
export const GMAIL_REASON_LABELS: Readonly<Record<GmailMailReason, string>> = {
	malformed: msg('E-mail rusak atau tidak bisa dibaca.'),
	too_large: msg('E-mail terlalu besar untuk dibaca.'),
	gone: msg('E-mail sudah tidak ada di Gmail.'),
	fetch_failed: msg('Gmail menolak membuka e-mail ini.'),
	no_ai_key: msg('Belum ada kunci Anthropic untuk membaca e-mail ini.'),
	ai_unconfigured: msg('Pembacaan AI belum dikonfigurasi di server ini.'),
	ai_failed: msg('Pembacaan AI gagal. Periksa kunci Anthropic-mu di Integrasi AI.'),
	ai_invalid: msg('AI tidak bisa membaca nominal dan tanggalnya.'),
	expired: msg('Terlalu lama menunggu dibaca.'),
	inbox_full: msg('Kotak masuk penuh (1.000 draf). Tinjau draf dulu.'),
	currency: msg('Mata uang selain rupiah belum didukung.'),
	unparsed: msg('Isi e-mail kosong atau tidak terbaca.'),
	key: msg('Sambungan Gmail perlu dihubungkan ulang.'),
	ai_limit: msg('Batas baca AI harian Gmail tercapai. Baca ulang besok.')
};
