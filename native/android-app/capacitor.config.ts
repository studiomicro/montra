import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Montra's Android app (FN-58): a Capacitor shell that loads the web app from its own host, so the app and the site
 * stay one codebase, plus the read-only NFC bridge in `android/app/src/main/java/id/montra/app/MontraNfcPlugin.kt`.
 * MONTRA_APP_URL picks the host at sync time (staging today; never committed). Without it the shell shows the bundled
 * `www/index.html`, which says the host is missing.
 */
const appUrl = process.env.MONTRA_APP_URL;

const config: CapacitorConfig = {
	appId: 'id.montra.app',
	appName: 'Montra',
	webDir: 'www',
	server: appUrl
		? {
				url: appUrl,
				// Only the app's own host opens inside the shell; every other link goes to the browser.
				allowNavigation: [new URL(appUrl).host],
				cleartext: false
			}
		: undefined,
	android: {
		allowMixedContent: false,
		webContentsDebuggingEnabled: false
	}
};

export default config;
