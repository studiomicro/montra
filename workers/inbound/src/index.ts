import { getDb } from '#lib/server/db';
import { handleEmail } from './process';

export default {
	async email(message, env) {
		const outcome = await handleEmail(message, {
			db: getDb(env.DB),
			env,
			enqueue: async (body) => {
				await env.JOBS_QUEUE.send(body);
			},
			now: () => Date.now()
		});
		// One status code per mail: never the address, sender, subject, amount or text.
		console.log('inbound: mail', { outcome });
	}
} satisfies ExportedHandler<Env>;
