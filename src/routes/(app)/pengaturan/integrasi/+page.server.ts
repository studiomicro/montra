import { fail, redirect } from '@sveltejs/kit';
import { isAiGatewayConfigured, testAnthropicKey } from '#lib/server/ai-keys/anthropic';
import { isAiKeysConfigured } from '#lib/server/ai-keys/crypto';
import { openUserKey } from '#lib/server/ai-keys/lookup';
import {
	AI_KEY_CHANGED_MEANWHILE,
	AI_KEY_INVALID_FORMAT,
	AI_KEY_MISSING,
	AI_KEY_SAVE_FAILED,
	AI_KEY_UNREADABLE,
	AI_KEYS_LOAD_FAILED,
	AI_KEYS_NOT_CONFIGURED,
	AI_TEST_NOT_CONFIGURED,
	AI_TEST_RATE_LIMITED
} from '#lib/server/ai-keys/messages';
import { deleteKey, listKeysForDisplay, recordTestResult, saveKey } from '#lib/server/ai-keys/repo';
import { overUserAttemptLimit } from '#lib/server/auth/throttle';
import { getEnv } from '#lib/server/env';
import { readFormBody, textField } from '#lib/server/forms';
import { errorLabel } from '#lib/server/util';
import {
	AI_KEY_MAX_LENGTH,
	AI_KEY_MIN_LENGTH,
	AI_KEY_TEST_MAX_ATTEMPTS,
	parseAiKey
} from '#lib/shared/ai-keys';
import type { Actions, PageServerLoad } from './$types';

// FN-41 Integrasi AI. Account-level, like /pengaturan/api: every load and action works on locals.user only, and
// the key row is addressed by (session user, 'anthropic'), never by an id from the form. The raw key is read from
// the save form, sealed and stored; it never comes back: not in page data, an action answer, a log line or an
// export. "Tes koneksi" is the only provider call, counted per user before the key is even opened.

function signedIn(locals: App.Locals) {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	return user;
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = signedIn(locals);
	const env = getEnv();
	const base = {
		configured: isAiKeysConfigured(env),
		testConfigured: isAiGatewayConfigured(env),
		minLength: AI_KEY_MIN_LENGTH,
		maxLength: AI_KEY_MAX_LENGTH
	};
	try {
		return { ...base, keys: await listKeysForDisplay(locals.db, user.id), loadError: null };
	} catch (e) {
		console.error('pengaturan/integrasi: load failed', errorLabel(e));
		return { ...base, keys: [], loadError: AI_KEYS_LOAD_FAILED };
	}
};

export const actions: Actions = {
	/** "Tambahkan kunci" and "Ganti kunci": the same form; a stored key is replaced in place. */
	save: async ({ request, locals }) => {
		const form = await readFormBody(request);
		const user = signedIn(locals);
		const env = getEnv();
		if (!isAiKeysConfigured(env)) return fail(503, { error: AI_KEYS_NOT_CONFIGURED });
		// The pasted value is never echoed back, not even after a format error.
		const key = parseAiKey(textField(form, 'key'));
		if (!key) return fail(400, { error: AI_KEY_INVALID_FORMAT });
		try {
			const saved = await saveKey(locals.db, user.id, 'anthropic', key, env, Date.now());
			if (saved === 'not_configured') return fail(503, { error: AI_KEYS_NOT_CONFIGURED });
			return { done: saved };
		} catch (e) {
			console.error('pengaturan/integrasi: save failed', errorLabel(e));
			return fail(503, { error: AI_KEY_SAVE_FAILED });
		}
	},

	/** "Hapus kunci": the row is deleted (not a tombstone). */
	delete: async ({ request, locals }) => {
		await readFormBody(request);
		const user = signedIn(locals);
		if (!(await deleteKey(locals.db, user.id, 'anthropic', Date.now())))
			return fail(404, { error: AI_KEY_MISSING });
		return { done: 'removed' as const };
	},

	/**
	 * "Tes koneksi": the per-user budget is counted first, so a refused attempt never reaches the provider; then
	 * the key is opened and sent once through the AI Gateway. The outcome is stored against the row that was
	 * tested (a `network` outcome leaves the stored result as it was).
	 */
	test: async ({ request, locals }) => {
		await readFormBody(request);
		const user = signedIn(locals);
		const env = getEnv();
		if (!isAiGatewayConfigured(env)) return fail(503, { error: AI_TEST_NOT_CONFIGURED });
		const now = Date.now();
		if (
			await overUserAttemptLimit(locals.db, user.id, now, 'ai-key-test', AI_KEY_TEST_MAX_ATTEMPTS)
		)
			return fail(429, { error: AI_TEST_RATE_LIMITED });
		const opened = await openUserKey(locals.db, user.id, 'anthropic', env);
		if (opened === 'missing') return fail(404, { error: AI_KEY_MISSING });
		if (opened === 'unreadable') return fail(409, { error: AI_KEY_UNREADABLE });
		const result = await testAnthropicKey(env, opened.key);
		if (result === null) return fail(503, { error: AI_TEST_NOT_CONFIGURED });
		// The key was replaced or removed while it was being tested: its result belongs to no stored key.
		if (
			!(await recordTestResult(locals.db, user.id, 'anthropic', opened.rowId, result, Date.now()))
		)
			return fail(409, { error: AI_KEY_CHANGED_MEANWHILE });
		return { tested: result };
	}
};
