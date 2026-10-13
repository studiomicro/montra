import { describe, expect, it } from 'vitest';
import { OFFLINE_PAGE, requestPolicy, shellPaths } from './sw-policy';

const ORIGIN = 'https://app.example';
const immutable = [
	{ path: '_app/immutable/entry/start.abc.js' },
	{ path: '_app/immutable/assets/0.css' }
];
const assets = [
	{ path: 'favicon.svg' },
	{ path: 'manifest.webmanifest' },
	{ path: 'offline.html' },
	{ path: 'icons/icon-192.png' }
];
const shell = new Set(shellPaths(immutable, assets));
const get = (path: string, mode = 'no-cors') => ({ method: 'GET', url: ORIGIN + path, mode });

describe('shellPaths', () => {
	it('is the build files and static files as absolute paths, the offline page included', () => {
		expect([...shell]).toEqual([
			'/_app/immutable/entry/start.abc.js',
			'/_app/immutable/assets/0.css',
			'/favicon.svg',
			'/manifest.webmanifest',
			'/offline.html',
			'/icons/icon-192.png'
		]);
		expect(shell.has(OFFLINE_PAGE)).toBe(true);
	});

	it('never includes an /api/ path or a page data response, even if one were listed', () => {
		const paths = shellPaths(immutable, [
			...assets,
			{ path: 'api/v1/health' },
			{ path: '__data.json' },
			{ path: 'riwayat/__data.json' }
		]);
		expect(paths.some((p) => p.startsWith('/api/') || p.endsWith('__data.json'))).toBe(false);
	});

	it('never precaches launch images or store screenshots (FN-13b), but keeps the small icons', () => {
		const paths = shellPaths(immutable, [
			...assets,
			{ path: 'splash/splash-440x956-light.png' },
			{ path: 'screenshots/narrow-riwayat.png' },
			{ path: 'icons/shortcut-suara.png' },
			{ path: 'splashy.png' }
		]);
		expect(paths.filter((p) => p.startsWith('/splash/') || p.startsWith('/screenshots/'))).toEqual(
			[]
		);
		expect(paths).toContain('/icons/shortcut-suara.png');
		expect(paths).toContain('/splashy.png');
		const pathsWithBase = shellPaths([], [{ path: '/splash/a.png' }, { path: '/offline.html' }]);
		expect(pathsWithBase).toEqual(['/offline.html']);
	});
});

describe('requestPolicy', () => {
	it('serves shell files from the cache', () => {
		expect(requestPolicy(get('/_app/immutable/entry/start.abc.js'), ORIGIN, shell)).toBe('shell');
		expect(requestPolicy(get('/manifest.webmanifest'), ORIGIN, shell)).toBe('shell');
	});

	it('sends page loads to the network (offline page only on failure), signed-in pages included', () => {
		for (const path of ['/', '/riwayat', '/pengaturan/akun', '/offline.html'])
			expect(requestPolicy(get(path, 'navigate'), ORIGIN, shell)).toBe('navigate');
	});

	it('never answers data, API, query or foreign requests from the cache', () => {
		for (const path of [
			'/__data.json',
			'/riwayat/__data.json?x-sveltekit-invalidated=01',
			'/api/v1/health',
			'/manifest.webmanifest?v=2',
			'/unknown.js'
		])
			expect(requestPolicy(get(path), ORIGIN, shell)).toBe('network');
		expect(
			requestPolicy(
				{
					method: 'GET',
					url: 'https://cdn.example/_app/immutable/entry/start.abc.js',
					mode: 'cors'
				},
				ORIGIN,
				shell
			)
		).toBe('network');
		expect(
			requestPolicy({ method: 'POST', url: `${ORIGIN}/?/signOut`, mode: 'navigate' }, ORIGIN, shell)
		).toBe('network');
	});
});

describe('fonts (owner decision 2026-10-10)', () => {
	const fonts = [
		{ path: 'fonts/geist/1.7.2/Geist-Variable.woff2' },
		{ path: 'fonts/geist/1.7.2/OFL.txt' },
		{ path: 'fonts/geist-mono/1.7.2/GeistMono-Variable.woff2' },
		{ path: 'fonts/geist-mono/1.7.2/OFL.txt' }
	];

	it('precaches the one preloaded Geist file and leaves Geist Mono and licence texts to the HTTP cache', () => {
		const paths = shellPaths(immutable, [...assets, ...fonts]);
		expect(paths.filter((p) => p.startsWith('/fonts/'))).toEqual([
			'/fonts/geist/1.7.2/Geist-Variable.woff2'
		]);
	});

	it('serves the precached file from the shell and Geist Mono from the network', () => {
		const withFonts = new Set(shellPaths(immutable, [...assets, ...fonts]));
		expect(
			requestPolicy(get('/fonts/geist/1.7.2/Geist-Variable.woff2', 'cors'), ORIGIN, withFonts)
		).toBe('shell');
		expect(
			requestPolicy(
				get('/fonts/geist-mono/1.7.2/GeistMono-Variable.woff2', 'cors'),
				ORIGIN,
				withFonts
			)
		).toBe('network');
	});
});

describe('the on-device OCR engine (FN-16g, criterion 5)', () => {
	const engine = [
		{ path: '_ocr/v1/worker.min.js' },
		{ path: '_ocr/v1/core/tesseract-core-simd-lstm.wasm.js' },
		{ path: '_ocr/v1/lang/eng.traineddata' }
	];

	it('is never precached on install, even though the static manifest lists it', () => {
		const paths = shellPaths(immutable, [...assets, ...engine]);
		expect(paths.some((p) => p.startsWith('/_ocr/'))).toBe(false);
		expect(paths).toEqual([...shell]);
	});

	it('is left to the browser (HTTP cache), even if a cached shell listed it', () => {
		const withEngine = new Set([...shell, '/_ocr/v1/worker.min.js']);
		expect(requestPolicy(get('/_ocr/v1/worker.min.js'), ORIGIN, withEngine)).toBe('network');
		expect(requestPolicy(get('/_ocr/v1/lang/eng.traineddata', 'cors'), ORIGIN, withEngine)).toBe(
			'network'
		);
	});
});
