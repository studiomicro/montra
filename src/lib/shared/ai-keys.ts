import { msg } from './i18n.ts';
import { cleanText } from './text.ts';

/**
 * FN-41 personal AI keys (BYOK): the values the settings page, the server and the schema share. Owner decision
 * 2026-10-09: each user brings their own Anthropic key and pays their own AI cost; there is no app-wide key.
 * Only `anthropic` exists; the column keeps a second provider additive.
 */
export const AI_KEY_PROVIDERS = ['anthropic'] as const;
export type AiKeyProvider = (typeof AI_KEY_PROVIDERS)[number];

/** The only state a stored key has; removing a key deletes the row. */
export const AI_KEY_STATUSES = ['active'] as const;

/** The stored outcome of the last "Tes koneksi" (null: never tested, or replaced since). */
export const AI_KEY_TEST_RESULTS = ['ok', 'invalid', 'quota', 'network'] as const;
type AiKeyTestResult = (typeof AI_KEY_TEST_RESULTS)[number];

/**
 * Every outcome of one "Tes koneksi": the stored results plus `model_unavailable` (Anthropic answered 404 for the
 * test model, e.g. once the alias is retired). Like `network`, that outcome says nothing about the key, so it is
 * shown but never stored.
 */
export const AI_KEY_TEST_OUTCOMES = [...AI_KEY_TEST_RESULTS, 'model_unavailable'] as const;
export type AiKeyTestOutcome = (typeof AI_KEY_TEST_OUTCOMES)[number];

/** What each "Tes koneksi" outcome tells the user: distinct messages, never conflated (PRD FN-41). */
export const AI_KEY_TEST_LABELS: Readonly<Record<AiKeyTestOutcome, string>> = {
	ok: msg('Berhasil terhubung'),
	invalid: msg('Kunci tidak valid atau sudah dicabut'),
	// The user's own Anthropic account, never a Montra plan limit.
	quota: msg('Kuota Anthropic-mu habis atau tagihan bermasalah — periksa akun Anthropic-mu'),
	network: msg('Tidak bisa menghubungi Anthropic sekarang, coba lagi'),
	model_unavailable: msg(
		'Model uji tidak tersedia di Anthropic saat ini; kunci dan hasil tes sebelumnya tidak diubah'
	)
};

export const AI_KEY_AUDIT_ACTIONS = [
	'created',
	'replaced',
	'removed',
	'test_ok',
	'test_failed'
] as const;
export type AiKeyAuditAction = (typeof AI_KEY_AUDIT_ACTIONS)[number];

/**
 * A loose format check only (owner decision 7): the prefix and length bounds reject obviously wrong pastes (a
 * sentence, a cookie); whether the key works is decided by "Tes koneksi" or first real use. No stricter pattern,
 * since Anthropic's exact format is not specified in its public docs.
 */
export const AI_KEY_MIN_LENGTH = 20;
export const AI_KEY_MAX_LENGTH = 300;
/** Printable ASCII without spaces, starting with the prefix. */
const AI_KEY_SHAPE = /^sk-ant-[\x21-\x7e]+$/;

/**
 * "Tes koneksi" attempts per user per throttle window (10 minutes), owner decision 3: each one is a real call the
 * user's own Anthropic account pays for, so the budget is far below the default 20.
 */
export const AI_KEY_TEST_MAX_ATTEMPTS = 5;

/** A view of a stored key safe for a page: never the key, its ciphertext, nonce or key id. */
export interface AiKeyView {
	provider: AiKeyProvider;
	lastFour: string;
	createdAt: number;
	updatedAt: number;
	lastTestedAt: number | null;
	lastTestResult: AiKeyTestResult | null;
}

/**
 * The pasted text as a key, or null when it cannot be one. The input is capped before any work, then invisible
 * characters are stripped and whitespace trimmed (cleanText), so a key copied with a trailing newline or a
 * zero-width space still saves.
 */
export function parseAiKey(input: string): string | null {
	const key = cleanText(input, AI_KEY_MAX_LENGTH + 1);
	if (key.length < AI_KEY_MIN_LENGTH || key.length > AI_KEY_MAX_LENGTH) return null;
	return AI_KEY_SHAPE.test(key) ? key : null;
}
