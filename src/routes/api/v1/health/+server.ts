import { json } from '@sveltejs/kit';
import { getEnv } from '#lib/server/env';
import { checkHealth } from '#lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const e = getEnv();
	const { status, body } = await checkHealth(e.DB, e.APP_VERSION);
	return json(body, { status, headers: { 'cache-control': 'no-store' } });
};
