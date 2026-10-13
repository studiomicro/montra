import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { pdfjsBounded } from './scripts/pdfjs-bounded.ts';

export default defineConfig({
	// Compiles .svelte files for server-render tests (svelte/server); there is no browser environment. FN-16a:
	// the PDF.js decode budget (scripts/pdfjs-bounded.ts); unpdf is inlined so the plugin sees it.
	plugins: [svelte(), pdfjsBounded()],
	// hooks.ts and hooks.server.ts read `building` (FN-32 prerendering); Vitest has no SvelteKit plugin.
	resolve: {
		alias: { '$app/env': fileURLToPath(new URL('./test/helpers/app-env.ts', import.meta.url)) }
	},
	test: {
		include: [
			'src/**/*.test.ts',
			'workers/**/*.test.ts',
			'scripts/**/*.test.ts',
			'test/**/*.test.ts'
		],
		environment: 'node',
		server: { deps: { inline: ['unpdf'] } },
		testTimeout: 30_000,
		// openLocalD1 (workerd start + every migration) in beforeAll can pass the 10 s default when many
		// integration files start at once; QA saw flaky hook timeouts under parallel load (FN-07 cycle 3).
		hookTimeout: 60_000
	}
});
