import { describe, expect, it } from 'vitest';
import { detectInAppBrowser, detectIosBrowser, detectMobileOs } from './user-agent';

// User-agent strings in the formats each app and browser publishes (version numbers vary by release). The
// in-app ones are the format the app appends to the system WebView's agent; see the ENGINEER_REPORT for the
// note that they were not captured from a live device in this pass.
const IN_APP = {
	instagram: [
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,2; iOS 17_5_1; id_ID; id; scale=3.00; 1179x2556; 619520717)',
		'Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 339.0.0.30.105 Android (34/14; 450dpi; 1080x2340; samsung; SM-A546E; a54x; s5e8835; id_ID; 618003347)'
	],
	tiktok: [
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/id Region/ID isDarkMode/0 WKWebView/1 RevealType/Dialog BytedanceWebview/d8a21c6',
		'Mozilla/5.0 (Linux; Android 13; 22111317PG Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36 trill_350104 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/trill app_version/35.1.4 ByteLocale/id ByteFullLocale/id Region/ID AppId/1180 Spark/1.5.8.4 AppVersion/35.1.4 BytedanceWebview/d8a21c6'
	],
	whatsapp: [
		'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240705.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 WhatsApp/2.24.14.79 A',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/24.13.79 i'
	]
} as const;

const ORDINARY = {
	'Chrome Android':
		'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
	'Safari iPhone':
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
	'Chrome iPhone':
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
	'Firefox Android': 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
	'Samsung Internet':
		'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
	'Edge Android':
		'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 EdgA/126.0.0.0',
	'Chrome desktop':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
	'Edge desktop':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
	'Firefox desktop': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
	'Safari Mac':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
} as const;

describe('detectInAppBrowser', () => {
	for (const [app, uas] of Object.entries(IN_APP))
		it.each(uas)(`${app}: %s`, (ua) => expect(detectInAppBrowser(ua)).toBe(app));

	it.each(Object.entries(ORDINARY))('%s is an ordinary browser', (_, ua) =>
		expect(detectInAppBrowser(ua)).toBeNull()
	);

	it('needs the marker followed by a version, not the word anywhere', () => {
		expect(detectInAppBrowser('Mozilla/5.0 InstagramBot')).toBeNull();
		expect(detectInAppBrowser('Mozilla/5.0 (WhatsApp clone)')).toBeNull();
		expect(detectInAppBrowser('')).toBeNull();
	});
});

describe('detectMobileOs', () => {
	it('iPhone and iPad user agents are iOS, also inside in-app browsers', () => {
		expect(detectMobileOs(ORDINARY['Safari iPhone'])).toBe('ios');
		expect(detectMobileOs(IN_APP.instagram[0])).toBe('ios');
	});
	it('a touch Mac (iPadOS desktop agent) is iOS only with touch points', () => {
		expect(detectMobileOs(ORDINARY['Safari Mac'], 5)).toBe('ios');
		expect(detectMobileOs(ORDINARY['Safari Mac'], 0)).toBe('other');
	});
	it('Android and desktop', () => {
		expect(detectMobileOs(ORDINARY['Chrome Android'])).toBe('android');
		expect(detectMobileOs(IN_APP.tiktok[1])).toBe('android');
		expect(detectMobileOs(ORDINARY['Chrome desktop'])).toBe('other');
	});
});

// FN-13b: which browser an iOS page runs in. Real-format strings; version numbers vary by release.
const IOS = {
	safari:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	chrome:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
	firefox:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
	edge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.52 Mobile/15E148 Safari/605.1.15',
	opera:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/16.0.15.124050 Version/17.5 Mobile/15E148 Safari/9537.53',
	google:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/330.0.649888111 Mobile/15E148 Safari/604.1',
	duckduckgo:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15',
	yandex:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 YaBrowser/24.6.0.1135.10 Mobile/15E148 Safari/605.1.15',
	ipadDesktop:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	ipadChromeDesktop:
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15 CriOS/130.0.6723.37',
	facebookWebView:
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.34.108;FBBV/569000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/id_ID]'
} as const;

describe('detectIosBrowser', () => {
	it('names Safari and each marker-carrying iOS browser', () => {
		expect(detectIosBrowser(IOS.safari)).toBe('safari');
		expect(detectIosBrowser(IOS.chrome)).toBe('chrome');
		expect(detectIosBrowser(IOS.firefox)).toBe('firefox');
		expect(detectIosBrowser(IOS.edge)).toBe('edge');
	});

	it('other iOS browsers are never Safari, even with Version/ and Safari/ tokens', () => {
		for (const ua of [IOS.opera, IOS.google, IOS.duckduckgo, IOS.yandex])
			expect(detectIosBrowser(ua), ua).toBe('other');
	});

	it('a WebView without a Safari token is "other"', () => {
		expect(detectIosBrowser(IOS.facebookWebView)).toBe('other');
	});

	it('iPadOS sends a desktop Mac agent: iOS only with touch points, then Safari or Chrome', () => {
		expect(detectIosBrowser(IOS.ipadDesktop)).toBeNull();
		expect(detectIosBrowser(IOS.ipadDesktop, 5)).toBe('safari');
		expect(detectIosBrowser(IOS.ipadChromeDesktop, 5)).toBe('chrome');
	});

	it('in-app browsers keep their own notice and are never Safari', () => {
		for (const ua of [IN_APP.instagram[0], IN_APP.tiktok[0], IN_APP.whatsapp[1]])
			expect(detectIosBrowser(ua), ua).toBe('other');
	});

	it('is null off iOS: Android Chrome, desktop Chrome, Safari on a Mac', () => {
		expect(detectIosBrowser(ORDINARY['Chrome Android'])).toBeNull();
		expect(detectIosBrowser(ORDINARY['Chrome desktop'])).toBeNull();
		expect(detectIosBrowser(ORDINARY['Safari Mac'])).toBeNull();
		expect(detectIosBrowser('')).toBeNull();
	});

	it('only reads the first kilobyte', () => {
		expect(detectIosBrowser(`${' '.repeat(2000)}${IOS.chrome}`)).toBeNull();
	});
});
