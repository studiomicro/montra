import { dev } from '$app/env';
import { error, json } from '@sveltejs/kit';
import { devRoutesEnabled } from '#lib/server/dev';
import { getEnv } from '#lib/server/env';
import { pingReceived } from '#lib/server/ping';
import type { JobMessage } from '#lib/shared/jobs';
import type { RequestHandler } from './$types';

function guard(): Env {
	const e = getEnv();
	if (!devRoutesEnabled(e as { DEV_ROUTES?: string }, dev)) error(404);
	return e;
}

export const POST: RequestHandler = async () => {
	const { JOBS_QUEUE } = guard();
	const message: JobMessage = { type: 'ping', id: crypto.randomUUID() };
	await JOBS_QUEUE.send(message);
	return json({ id: message.id });
};

export const GET: RequestHandler = async ({ url }) => {
	const { DB } = guard();
	const id = url.searchParams.get('id') ?? '';
	return json({ received: await pingReceived(DB, id) });
};
