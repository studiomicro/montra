import { error } from '@sveltejs/kit';
import { amountDigits, amountFractionDigits, digitsToMinor } from '#lib/shared/amount-input';
import type { Locale } from '#lib/shared/i18n';
import { SEPARATORS } from '#lib/shared/money-format';

/**
 * Largest form body the app's actions read. The biggest form (sign-up) is four short fields plus a return
 * path capped at RETURN_TO_MAX_LENGTH, so 8 KiB is far above any honest submission.
 */
export const FORM_BODY_MAX_BYTES = 8 * 1024;
/** How long an action waits for a body to end; a client trickling bytes is cut off. */
const FORM_BODY_TIMEOUT_MS = 10_000;
/** What an HTML form sends and `formData()` parses (`text/plain` forms are refused). */
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

class BodyTooLarge extends Error {}
class BodyTimeout extends Error {}
/** The caller's buffer budget refused the bytes the body needs (readFormBody's `charge`): no 400, the caller decides. */
export class BodyBudgetExceeded extends Error {}

/** First buffer size of a body read; it doubles as bytes arrive. */
const BODY_INITIAL_BYTES = 64 * 1024;

/**
 * At most `max` bytes of the body (and no more than a declared Content-Length); throws BodyTooLarge past it and
 * BodyTimeout once `timeoutMs` of wall-clock time has passed, or when no bytes arrive for `idleMs` (a stalled
 * sender is cut off early; a slow but steady one may use the whole total). One buffer, grown by
 * doubling as bytes actually arrive (red team FN-27 N4: a declared length is never preallocated, so a client
 * that announces 8 MiB and sends nothing holds 64 KiB, not 8 MiB; L3: no chunk list plus a joined copy).
 */
async function readCapped(
	request: Request,
	max: number,
	timeoutMs: number,
	idleMs: number,
	charge: (bytes: number) => boolean = () => true
): Promise<Uint8Array> {
	const declared = Number(request.headers.get('content-length'));
	if (declared > max) throw new BodyTooLarge();
	if (!request.body) return new Uint8Array(0);
	const cap = Number.isSafeInteger(declared) && declared > 0 ? declared : max;
	const first = Math.min(cap, BODY_INITIAL_BYTES);
	if (!charge(first)) throw new BodyBudgetExceeded();
	let out = new Uint8Array(first);
	let size = 0;
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new BodyTimeout()), timeoutMs);
	});
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		for (;;) {
			const idle = new Promise<never>((_, reject) => {
				idleTimer = setTimeout(() => reject(new BodyTimeout()), idleMs);
			});
			const { done, value } = await Promise.race([reader.read(), deadline, idle]);
			clearTimeout(idleTimer);
			if (done) break;
			const needed = size + value.byteLength;
			if (needed > cap) throw new BodyTooLarge();
			if (needed > out.length) {
				const length = Math.min(cap, Math.max(needed, out.length * 2));
				if (!charge(length - out.length)) throw new BodyBudgetExceeded();
				const grown = new Uint8Array(length);
				grown.set(out.subarray(0, size));
				out = grown;
			}
			out.set(value, size);
			size = needed;
		}
	} catch (e) {
		reader.cancel().catch(() => {});
		throw e;
	} finally {
		clearTimeout(timer);
		clearTimeout(idleTimer);
	}
	return out.subarray(0, size);
}

/**
 * The form an action was sent, read within `max` bytes (FORM_BODY_MAX_BYTES unless a multi-row form names its
 * own bound) and FORM_BODY_TIMEOUT_MS in total (a photo upload names a longer one), with no gap without bytes
 * longer than `idleMs` (the total unless given). Refused with
 * `error()` (never a 500): 415 when it is not form-encoded, 400 when empty, oversized or unparseable,
 * 408 when the body does not end in time. Ported from the earlier project's `requireFormBody`/`readAuthForm`. `charge` (an
 * upload lane's byte budget) is asked before each buffer growth; a refusal throws BodyBudgetExceeded.
 */
export async function readFormBody(
	request: Request,
	max: number = FORM_BODY_MAX_BYTES,
	timeoutMs: number = FORM_BODY_TIMEOUT_MS,
	idleMs: number = timeoutMs,
	charge?: (bytes: number) => boolean
): Promise<FormData> {
	const type = request.headers.get('content-type') ?? '';
	if (!FORM_TYPES.has(type.split(';', 1)[0]?.trim().toLowerCase() ?? ''))
		error(415, 'Unsupported content type');
	let body: Uint8Array;
	try {
		body = await readCapped(request, max, timeoutMs, idleMs, charge);
	} catch (e) {
		if (e instanceof BodyBudgetExceeded) throw e;
		if (e instanceof BodyTimeout) error(408, 'Request body timeout');
		error(400, 'Invalid form');
	}
	const form = await new Response(body as BodyInit, { headers: { 'content-type': type } })
		.formData()
		.catch(() => null);
	if (!form) error(400, 'Invalid form');
	return form;
}

/**
 * A raw (non-form) body, such as a webhook's JSON, read within `max` bytes and FORM_BODY_TIMEOUT_MS: the
 * bytes exactly as sent (a signature is computed over them). Refused with `error()`, never a 500: 413 when
 * oversized, 408 when the body does not end in time.
 */
export async function readRawBody(request: Request, max: number): Promise<Uint8Array> {
	try {
		return await readCapped(request, max, FORM_BODY_TIMEOUT_MS, FORM_BODY_TIMEOUT_MS);
	} catch (e) {
		if (e instanceof BodyTimeout) error(408, 'Request body timeout');
		error(413, 'Payload too large');
	}
}

/** A text field's value ('' when missing or a file). Reads by name only, so no prototype keys are involved. */
export function textField(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === 'string' ? value : '';
}

/** Most whole-unit digits of an amount field (the AmountInput limit; 13 digits × 100 stays a safe integer). */
const WHOLE_AMOUNT_MAX_DIGITS = 13;
/**
 * The form contract of an amount field (what AmountInput sends): whole currency units, either plain digits or
 * grouped by Indonesian thousands dots in groups of exactly three (`25000`, `1.250`, `1.250.000`). Anything else
 * (`12.50`, `12,50`, `1e3`, `1 250`, `-5`) is refused, never reinterpreted.
 */
const WHOLE_AMOUNT_TEXT = /^(?:\d+|\d{1,3}(?:\.\d{3})+)$/;

/**
 * An amount field's whole-unit text → non-negative integer minor units of `currency`: 0 when blank, null when
 * it is not a whole amount. Never `parseFloat`: the digits go through `digitsToMinor`.
 */
export function wholeAmountMinor(text: string, currency: string): number | null {
	const trimmed = text.trim();
	if (trimmed === '') return 0;
	if (!WHOLE_AMOUNT_TEXT.test(trimmed)) return null;
	const digits = trimmed.replaceAll('.', '').replace(/^0+/, '');
	if (digits.length > WHOLE_AMOUNT_MAX_DIGITS) return null;
	return digitsToMinor(amountDigits(digits), currency) ?? 0;
}

/**
 * FN-47: the refusal an amount field of `currency` shows. `whole` ("…angka bulat, tanpa sen") for a whole-unit
 * currency (IDR, JPY); `cents` ("…maksimal 2 angka di belakang koma") for one typed with cents, so a USD amount
 * refused for a third fraction digit is never told that cents are not allowed at all.
 */
export function amountRefusal(currency: string, whole: string, cents: string): string {
	return amountFractionDigits(currency) > 0 ? cents : whole;
}

/** Whole units grouped in threes by the UI language's thousands separator. */
const GROUPED: Readonly<Record<Locale, RegExp>> = {
	id: /^\d{1,3}(?:\.\d{3})+$/,
	en: /^\d{1,3}(?:,\d{3})+$/
};

/**
 * FN-47: an amount field's text → non-negative integer minor units of `currency`, read with the separators of
 * the UI language the form was shown in (`locale`): 0 when blank, null when it is not an amount. A whole-unit
 * currency (IDR, JPY) keeps the `wholeAmountMinor` contract exactly. A currency with cents also takes a
 * fraction of at most its exponent's digits after the decimal mark, padded on the right (`12,5` → 1250):
 * `1.234,56` (id) / `1,234.56` (en). More fraction digits (`12,345`) are refused, never rounded or cut; so are
 * any other grouping (`12.50` in id) and a mark with no digit at all. `fractionDigits` (FN-55a card amounts:
 * `cardFractionDigits`, the currency's full exponent, so an IDR card bill is typed with its printed sen) must be 0
 * or the currency's exponent.
 */
export function amountMinorFromText(
	text: string,
	currency: string,
	locale: Locale,
	fractionDigits: number = amountFractionDigits(currency)
): number | null {
	const fd = fractionDigits;
	if (fd === 0) return wholeAmountMinor(text, currency);
	const trimmed = text.trim();
	if (trimmed === '') return 0;
	const { group, decimal } = SEPARATORS[locale];
	const cut = trimmed.lastIndexOf(decimal);
	const wholeText = cut < 0 ? trimmed : trimmed.slice(0, cut);
	const frac = cut < 0 ? '' : trimmed.slice(cut + 1);
	if (frac.length > fd || !/^\d*$/.test(frac)) return null;
	const wholeOk = wholeText === '' || /^\d+$/.test(wholeText) || GROUPED[locale].test(wholeText);
	if (!wholeOk || wholeText + frac === '') return null;
	const digits = wholeText.replaceAll(group, '').replace(/^0+/, '');
	if (digits.length > WHOLE_AMOUNT_MAX_DIGITS) return null;
	return Number(`${digits}${frac.padEnd(fd, '0')}`);
}
