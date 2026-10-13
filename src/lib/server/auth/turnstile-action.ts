import type { RequestEvent } from '@sveltejs/kit';
import { getEnv } from '../env';
import { textField } from '../forms';
import {
	isTurnstileConfigured,
	TURNSTILE_FIELD,
	TURNSTILE_TOKEN_MAX_LENGTH,
	turnstileSiteKey,
	turnstileState,
	verifyTurnstile,
	type TurnstileAction,
	type TurnstileEnv
} from './turnstile';

/**
 * FN-50: the bot check as the two auth actions use it, bound to the Worker's env (turnstile.ts itself takes an env
 * and a fetch, so its tests need neither). Used by `/masuk` and `/daftar` only.
 */

const env = () => getEnv() as Env & TurnstileEnv;

/** What the page loaders return: the public site key while the check is on, else null. */
export function turnstileSiteKeyFor(): { siteKey: string } | null {
	return turnstileSiteKey(env());
}

/**
 * True when the request may go on: the check is off (unset, or half set — logged once per call without any
 * value), or the form's token verified for `action` and this request's host. False refuses the attempt. The
 * token is read from the form within its length cap and never logged.
 */
export async function requireBotCheck(
	event: Pick<RequestEvent, 'request' | 'url'>,
	form: FormData,
	action: TurnstileAction
): Promise<boolean> {
	const e = env();
	if (!isTurnstileConfigured(e)) {
		if (turnstileState(e) === 'partial') console.error('turnstile: partial configuration');
		return true;
	}
	const token = textField(form, TURNSTILE_FIELD).slice(0, TURNSTILE_TOKEN_MAX_LENGTH + 1);
	const result = await verifyTurnstile(
		e,
		token,
		{ action, hostname: event.url.hostname },
		event.request.headers.get('cf-connecting-ip')
	);
	if (!result.ok) console.warn('turnstile: refused', action, result.reason);
	return result.ok;
}
