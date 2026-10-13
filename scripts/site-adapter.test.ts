import { describe, expect, it } from 'vitest';
import { siteFilesModule, workerEntry } from './site-adapter.ts';

const load = async (source: string) =>
	(await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
		default: Map<string, { type: string; body: string }>;
	};

describe('site-adapter generated modules (FN-32)', () => {
	it('bundles every prerendered file byte for byte, whatever it contains', async () => {
		const body = '<h1>"Halo"</h1>\n`${x}` </script> \\   ✓';
		const mod = await load(
			siteFilesModule([
				{ path: '/', type: 'text/html; charset=utf-8', body },
				{ path: '/robots.txt', type: 'text/plain', body: 'User-agent: *\n' }
			])
		);
		expect(mod.default.get('/')).toEqual({ type: 'text/html; charset=utf-8', body });
		expect(mod.default.get('/robots.txt')?.body).toBe('User-agent: *\n');
		expect([...mod.default.keys()]).toEqual(['/', '/robots.txt']);
	});

	it('writes an entry that answers prerendered files first, then SvelteKit', () => {
		const entry = workerEntry(
			'./_sveltekit_worker.js',
			'../../src/lib/server/site-static.ts',
			'../cloudflare-site/files.js'
		);
		expect(entry).toContain('import app from "./_sveltekit_worker.js";');
		expect(entry).toContain(
			'import { withPrerenderedSite } from "../../src/lib/server/site-static.ts";'
		);
		expect(entry).toContain('export default withPrerenderedSite(app, files);');
	});
});
