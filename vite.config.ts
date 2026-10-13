import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { pdfjsBounded } from './scripts/pdfjs-bounded.ts';
import { withPrerenderedSiteAdapter } from './scripts/site-adapter.ts';
import { CSP_DIRECTIVES } from './src/lib/server/csp.ts';

export default defineConfig({
	// FN-16a: PDF.js is bundled (not left to the Worker bundler) so the decode budget patch applies to it.
	ssr: { noExternal: ['unpdf'] },
	plugins: [
		pdfjsBounded(),
		tailwindcss(),
		sveltekit({
			// FN-32: the prerendered public site is bundled into the Worker and answered on the site host only.
			adapter: withPrerenderedSiteAdapter(
				adapter({
					platformProxy: { remoteBindings: false }
				})
			),
			// src/routes/+layout.svelte registers the service worker itself (not under `vite dev`, FN-13).
			serviceWorker: { register: false },
			// FN-32: only the public site is prerendered. The crawler starts from the two landing pages and the two
			// files nothing links to, and follows the site's own links (hooks.ts resolves them as site paths).
			// `paths.origin` stays unset: SvelteKit would also use it as the CSRF origin of every form POST.
			prerender: { entries: ['/', '/en', '/sitemap.xml', '/robots.txt'], crawl: true },
			csp: { mode: 'auto', directives: CSP_DIRECTIVES },
			// FN-38: SvelteKit's form CSRF check is off ('*' is its documented switch,
			// https://svelte.dev/docs/kit/configuration#csrf) because it has no per-route exemption and refused
			// Bearer-only API calls. hooks.server.ts applies the same check to every other route (lib/server/csrf.ts).
			csrf: { trustedOrigins: ['*'] }
		})
	]
});
