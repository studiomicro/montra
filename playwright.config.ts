import { defineConfig, devices } from '@playwright/test';
import { E2E_AI_KEYS_KEY, E2E_PORT, STORAGE_STATE } from './e2e/helpers';

// Parallel runs: E2E_PORT=<port> npm run test:e2e (own server and own persist dir per port).
const PORT = Number(E2E_PORT);
const IOS_SPEC = /ios-responsive\.spec\.ts/;
const PERSIST = `.wrangler/e2e-state-${PORT}`;
// FN-30 mock payments ("mode uji") for the e2e server only: a fixed, local-only HMAC key, not a real secret.
const MOCK_SECRET = 'e2e-mock-webhook-secret-not-real-0123456789abcdef';
// FN-41 personal AI keys (e2e/helpers.ts). No AI Gateway ids are set, so "Tes koneksi" stays "Belum
// dikonfigurasi" and no e2e test can reach Anthropic.
const AI_KEYS_KEY = E2E_AI_KEYS_KEY;
// FN-30 re-claim markers: a fixed, local-only HMAC key (32 bytes, base64url). Never reused for staging.
const CLAIM_KEY = 'ZTJlLWNsYWltLWhhc2gta2V5LW5vdC1yZWFsLTAwMDE';

export default defineConfig({
	testDir: 'e2e',
	outputDir: `test-results/port-${PORT}`,
	fullyParallel: true,
	retries: process.env.CI ? 1 : 0,
	// FN-40: journeys run with reduced motion. Cause (traced, e2e/motion.spec.ts): in a JavaScript-disabled page
	// requestAnimationFrame only fires while the page paints, and Playwright's "stable" check polls on it — so a
	// click whose first check sees a row mid-fade waits for frames that stop when the finite 200 ms fade ends, and
	// never completes. The row itself is static and clickable (a real tap mid-fade navigates, with and without
	// JavaScript); nothing in the app animates forever. e2e/motion.spec.ts opts back in to test the motion.
	use: {
		baseURL: `http://localhost:${PORT}`,
		locale: 'id-ID',
		reducedMotion: 'reduce',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: [
			// serialised, skipped when current: parallel runs in one checkout must not rebuild under each other
			'sh scripts/e2e-build.sh',
			`rm -rf ${PERSIST}`,
			`FIN_PERSIST_TO=${PERSIST} node scripts/migrate-local.ts`,
			`npx wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc --persist-to ${PERSIST} --port ${PORT} --inspector-port ${PORT + 1000} --var DEV_ROUTES:1 --var BILLING_MOCK_ENABLED:1 --var MOCK_PAYMENT_WEBHOOK_SECRET:${MOCK_SECRET} --var AI_KEYS_ENCRYPTION_KEY:${AI_KEYS_KEY} --var CLAIM_HASH_KEY:${CLAIM_KEY}`
		].join(' && '),
		url: `http://localhost:${PORT}/api/v1/health`,
		reuseExistingServer: !process.env.CI,
		env: { E2E_PORT: String(PORT) },
		timeout: 240_000
	},
	projects: [
		// One signed-up user per run; (app) pages need a session since FN-01.
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'phone',
			testIgnore: IOS_SPEC,
			use: {
				...devices['Pixel 7'],
				viewport: { width: 360, height: 780 },
				storageState: STORAGE_STATE
			},
			dependencies: ['setup']
		},
		{
			name: 'desktop',
			testIgnore: IOS_SPEC,
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 1280, height: 800 },
				storageState: STORAGE_STATE
			},
			dependencies: ['setup']
		},
		// ios-responsive: WebKit (closest to iOS Safari) at the iPhone SE and iPhone 15 Pro Max screen sizes, for
		// e2e/ios-responsive.spec.ts only (`npx playwright install webkit` once). The spec signs up its own user.
		{
			name: 'ios-se',
			testMatch: IOS_SPEC,
			use: {
				...devices['iPhone SE (3rd gen)'],
				viewport: { width: 375, height: 667 },
				deviceScaleFactor: 1
			}
		},
		{
			name: 'ios-pro-max',
			testMatch: IOS_SPEC,
			use: {
				...devices['iPhone 15 Pro Max'],
				viewport: { width: 430, height: 932 },
				deviceScaleFactor: 1
			}
		},
		// Owner request 2026-10-26: iPhone 17, 17 Pro and 18 Pro share one 402 x 874 viewport, so one project covers
		// the three, upright and turned (874 px: the 860 px tablet tier, both columns). iPhone Duo: folded 466 x 678,
		// unfolded 626 x 890 upright and 890 x 626 turned (the tablet tier).
		...(
			[
				['ios-17', 402, 874],
				['ios-17-landscape', 874, 402],
				['ios-duo-folded', 466, 678],
				['ios-duo-open', 626, 890],
				['ios-duo-open-landscape', 890, 626]
			] as const
		).map(([name, width, height]) => ({
			name,
			testMatch: IOS_SPEC,
			use: { ...devices['iPhone 15 Pro'], viewport: { width, height }, deviceScaleFactor: 1 }
		})),
		// Galaxy Z Fold (owner request 2026-10-26) on Chromium, the engine of Android Chrome, with Playwright's own
		// presets: the cover screen (phone layout), and unfolded upright (Fold 7 984 px, Fold 6 928 px: the 860 px
		// tablet tier, both columns). Unfolded and turned (1040 / 1028 px) is the desktop layout, which the
		// `desktop` project covers.
		...(
			[
				['android-fold7-cover', 'Galaxy Z Fold 7 Cover'],
				['android-fold7-open', 'Galaxy Z Fold 7'],
				['android-fold6-open', 'Galaxy Z Fold 6']
			] as const
		).map(([name, device]) => ({
			name,
			testMatch: IOS_SPEC,
			use: { ...devices[device], deviceScaleFactor: 1 }
		}))
	]
});
