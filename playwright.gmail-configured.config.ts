import { defineConfig } from '@playwright/test';
import base from './playwright.config';
import { E2E_AI_KEYS_KEY, E2E_PORT } from './e2e/helpers';

// QA cycle 1 (FN-19 Gmail): the same e2e server as playwright.config.ts, but with a fake Google OAuth client, so the
// configured pages can be driven in a browser. The id and secret are fictional and never leave the machine: the
// spec presses no button that makes the Worker call Google (no "Periksa sekarang", "Pindai", "Putuskan").
// Run: QA_GMAIL_CONFIGURED=1 E2E_PORT=8931 npx playwright test -c playwright.gmail-configured.config.ts
const PORT = Number(E2E_PORT);
const PERSIST = `.wrangler/e2e-state-${PORT}`;
const vars = [
	'DEV_ROUTES:1',
	`AI_KEYS_ENCRYPTION_KEY:${E2E_AI_KEYS_KEY}`,
	`CONNECTED_APPS_ENCRYPTION_KEY:${E2E_AI_KEYS_KEY}`,
	'GOOGLE_OAUTH_CLIENT_ID:qa-fake-client.apps.googleusercontent.com',
	'GOOGLE_OAUTH_CLIENT_SECRET:qa-fake-secret-not-real',
	`GOOGLE_OAUTH_REDIRECT_ORIGIN:http://localhost:${PORT}`
]
	.map((v) => `--var ${v}`)
	.join(' ');

export default defineConfig({
	...base,
	webServer: {
		command: [
			'sh scripts/e2e-build.sh',
			`rm -rf ${PERSIST}`,
			`FIN_PERSIST_TO=${PERSIST} node scripts/migrate-local.ts`,
			`npx wrangler dev -c wrangler.jsonc -c workers/jobs/wrangler.jsonc -c workers/inbound/wrangler.jsonc --persist-to ${PERSIST} --port ${PORT} --inspector-port ${PORT + 1000} ${vars}`
		].join(' && '),
		url: `http://localhost:${PORT}/api/v1/health`,
		reuseExistingServer: false,
		env: { E2E_PORT: String(PORT) },
		timeout: 240_000
	}
});
