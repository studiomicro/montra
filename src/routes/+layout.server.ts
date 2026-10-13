import { AMOUNTS_HIDDEN_COOKIE } from '#lib/ui/kit/amount-visibility';
import { isAppleUserAgent } from '#lib/shared/splash';
import { detectInAppBrowser, detectIosBrowser, detectMobileOs } from '#lib/shared/user-agent';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ cookies, locals, request }) => {
	const ua = request.headers.get('user-agent') ?? '';
	return {
		locale: locals.locale,
		theme: locals.theme,
		// Install guidance only (FN-13): which in-app browser and phone OS this page was opened in.
		inAppBrowser: detectInAppBrowser(ua),
		mobileOs: detectMobileOs(ua),
		// FN-13b, presentation only (never an access decision): which iOS browser (the install steps) and whether
		// to write the iOS launch-image links into the head. iPadOS sends a desktop Mac agent, hence the Mac match;
		// the pages refine the iOS browser in the browser itself.
		iosBrowser: detectIosBrowser(ua),
		appleDevice: isAppleUserAgent(ua),
		// FN-25b red team 1: the eye button's choice, so a page with hidden amounts is rendered masked (display only).
		amountsHidden: cookies.get(AMOUNTS_HIDDEN_COOKIE) === '1'
	};
};
