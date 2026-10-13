import type { Locale } from '#lib/shared/i18n';
import {
	isStatAction,
	isStatScreen,
	type StatAction,
	type StatEvent,
	type StatScreen
} from '#lib/shared/privacy';
import { detectMobileOs, type MobileOs } from '#lib/shared/user-agent';
import type { Db } from '../db';
import { getEnv } from '#lib/server/env';
import { usageStatsEnabled } from '../privacy/repo';

/**
 * Self-hosted usage statistics (FN-31): the only writer of the `STATS` Analytics Engine dataset.
 *
 * A data point holds exactly five blobs, in this order: screen, action, device type, language, country. By
 * construction nothing else can reach it: `StatsFields` has only these five, `statsDataPoint` refuses an
 * object with any other key, the screen and action come from a closed vocabulary, and the device type,
 * language and country are reduced to fixed short codes. Never written: account, session or user id,
 * e-mail, any amount, any typed text, any header or IP address. Analytics Engine adds its own write time.
 */
export interface StatsFields {
	screen: StatScreen;
	action: StatAction;
	deviceType: MobileOs;
	language: Locale;
	/** Cloudflare's two-letter country of the request (`request.cf.country`); `XX` when unknown. */
	country: string;
}

const FIELD_ORDER = ['screen', 'action', 'deviceType', 'language', 'country'] as const;
const DEVICE_TYPES: readonly MobileOs[] = ['ios', 'android', 'other'];
const LANGUAGES: readonly Locale[] = ['id', 'en'];
const COUNTRY = /^[A-Z]{2}$/;

/** `request.cf.country` when it is a two-letter code, `XX` otherwise. No other `cf` field is ever read. */
export function countryOf(cf: unknown): string {
	const country = (cf as { country?: unknown } | undefined)?.country;
	return typeof country === 'string' && COUNTRY.test(country) ? country : 'XX';
}

/**
 * The data point for `fields`: `{ blobs: [screen, action, deviceType, language, country] }` and nothing else.
 * Throws for an extra key or a value outside its vocabulary, so a future caller cannot widen it silently.
 */
export function statsDataPoint(fields: StatsFields): AnalyticsEngineDataPoint {
	const keys = Object.keys(fields).sort();
	if (keys.join() !== [...FIELD_ORDER].sort().join())
		throw new TypeError('stats: unexpected field');
	if (!isStatScreen(fields.screen) || !isStatAction(fields.action))
		throw new TypeError('stats: unknown event');
	if (!DEVICE_TYPES.includes(fields.deviceType) || !LANGUAGES.includes(fields.language))
		throw new TypeError('stats: unknown device or language');
	if (!COUNTRY.test(fields.country)) throw new TypeError('stats: bad country');
	return { blobs: FIELD_ORDER.map((k) => fields[k]) };
}

/**
 * Usage-statistics beacons one account may send per throttle window (10 minutes, per user, FN-31 red team
 * L3): far above real navigation; past it the beacon is answered as usual and nothing is written.
 */
export const TRACK_MAX_PER_WINDOW = 120;

/** What `trackEvent` needs from a request. `userId` is read only to check the opt-out; it is never written. */
export interface TrackContext {
	db: Db;
	/** The `STATS` binding; undefined where it is not bound (tests, some local runs): nothing is written. */
	stats: AnalyticsEngineDataset | undefined;
	userId: string | null;
	request: Request;
	locale: Locale;
}

/**
 * Counts one event, unless any of these holds (then nothing is written and nothing is called): no `STATS`
 * binding; no signed-in account (the opt-out lives with the account, so a signed-out visitor is not counted);
 * no `request.cf` (not served through Cloudflare's edge: local dev); the account turned statistics off. The
 * opt-out is checked here and only here, before the write, for every caller.
 *
 * Never throws and never blocks the caller's own work: a failure is logged by its kind only.
 * Returns whether a data point was written.
 */
export async function trackEvent(ctx: TrackContext, event: StatEvent): Promise<boolean> {
	try {
		if (!ctx.stats || !ctx.userId) return false;
		const cf = (ctx.request as { cf?: unknown }).cf;
		if (!cf) return false;
		if (!(await usageStatsEnabled(ctx.db, ctx.userId))) return false;
		ctx.stats.writeDataPoint(
			statsDataPoint({
				screen: event.screen,
				action: event.action,
				deviceType: detectMobileOs(ctx.request.headers.get('user-agent') ?? ''),
				language: ctx.locale,
				country: countryOf(cf)
			})
		);
		return true;
	} catch (e) {
		console.warn('stats: not written', e instanceof Error ? e.name : 'unknown');
		return false;
	}
}

/** The context of a request: its own database, `STATS`, locale and request; `userId` defaults to the session's. */
export function trackContext(
	event: { locals: App.Locals; request: Request },
	userId: string | null = event.locals.user?.id ?? null
): TrackContext {
	return {
		db: event.locals.db,
		stats: getEnv().STATS,
		userId,
		request: event.request,
		locale: event.locals.locale
	};
}
