import { env } from 'cloudflare:workers';

/** Cloudflare bindings for the app Worker. SvelteKit 3's Cloudflare adapter does not pass event.platform; this is the only accessor. */
export function getEnv(): Env {
	return env as Env;
}
