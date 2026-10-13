import { defineParams } from '@sveltejs/kit/params';
import { match as legal } from './legal.ts';

/** SvelteKit 3 loads route matchers from this module (`[legal=legal]`). */
export const params = defineParams({
	legal: (param) => (legal(param) ? param : undefined)
});
