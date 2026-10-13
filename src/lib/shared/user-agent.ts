/**
 * User-agent sniffing for install guidance only (FN-13): which in-app browser a link was opened in, and which
 * phone OS, so the app can say "open this in Safari/Chrome" and show the right install steps. Never used for
 * access decisions. Shared: the root layout reads it on the server, pages refine it in the browser.
 * Extend this module (not a second one) when a later feature needs more detection.
 */

export type InAppBrowser = 'instagram' | 'tiktok' | 'whatsapp';
export type MobileOs = 'ios' | 'android' | 'other';

/**
 * Markers each app appends to its in-app browser's user agent: Instagram adds `Instagram <version>`; TikTok
 * (`musical_ly` globally, `trill` in some regions) adds `<app>_<version>` and `BytedanceWebview/…`; WhatsApp
 * adds `WhatsApp/<version>`.
 */
const IN_APP: readonly [InAppBrowser, RegExp][] = [
	['instagram', /\bInstagram \d/],
	['tiktok', /\b(?:musical_ly|trill)_\d|\bBytedanceWebview\//],
	['whatsapp', /\bWhatsApp\/\d/]
];

/** The in-app browser `ua` belongs to, or null for an ordinary browser. */
export function detectInAppBrowser(ua: string): InAppBrowser | null {
	const text = ua.slice(0, 1024);
	for (const [app, marker] of IN_APP) if (marker.test(text)) return app;
	return null;
}

/**
 * The phone OS of `ua`. iPadOS 13+ reports a desktop Mac user agent; in the browser pass
 * `navigator.maxTouchPoints` so a touch "Macintosh" counts as iOS (no Mac has a touch screen).
 */
export function detectMobileOs(ua: string, maxTouchPoints = 0): MobileOs {
	const text = ua.slice(0, 1024);
	if (/\b(?:iPhone|iPad|iPod)\b/.test(text)) return 'ios';
	if (/\bMacintosh\b/.test(text) && maxTouchPoints > 1) return 'ios';
	if (/\bAndroid\b/.test(text)) return 'android';
	return 'other';
}

export type IosBrowser = 'safari' | 'chrome' | 'firefox' | 'edge' | 'other';

/**
 * Which browser an iPhone/iPad page runs in (FN-13b): only Safari can be trusted to offer "Tambah ke Layar
 * Utama" (and so push), so the install guide tells every other iOS browser to open Safari. Every iOS browser
 * is WebKit and carries Safari's tokens; each names itself with its own marker (`CriOS`, `FxiOS`, `EdgiOS`,
 * and `OPiOS`, `GSA`, `DuckDuckGo`, `YaBrowser` among the rest). A WebView with no `Safari/` token (most
 * in-app browsers) is never Safari. `null` when the device is not iOS. `maxTouchPoints` as in `detectMobileOs`.
 */
export function detectIosBrowser(ua: string, maxTouchPoints = 0): IosBrowser | null {
	if (detectMobileOs(ua, maxTouchPoints) !== 'ios') return null;
	const text = ua.slice(0, 1024);
	if (detectInAppBrowser(text)) return 'other';
	if (/\bCriOS\//.test(text)) return 'chrome';
	if (/\bFxiOS\//.test(text)) return 'firefox';
	if (/\bEdgiOS\//.test(text)) return 'edge';
	if (/\b(?:OPiOS|OPT|GSA|DuckDuckGo|YaBrowser)\b/.test(text)) return 'other';
	return /\bVersion\/[\d.]+.*\bSafari\//.test(text) ? 'safari' : 'other';
}
