import { msg } from './i18n.ts';

/**
 * FN-54 B1: the time of day Beranda greets with, by the WIB hour (UTC+7 all year): pagi 04:00–10:59, siang
 * 11:00–14:59, sore 15:00–17:59, malam 18:00–03:59 (owner decision 4). The server computes it once per request; the
 * page never recomputes it from the device clock, so hydration cannot disagree with the server render.
 */
export type GreetingPeriod = 'pagi' | 'siang' | 'sore' | 'malam';

const WIB_OFFSET_HOURS = 7;

/** The WIB hour (0–23) of a UTC instant, from the epoch arithmetic only (never `getHours()`, the device's zone). */
export function wibHour(utcMs: number): number {
	const hours = Math.floor(utcMs / 3_600_000) + WIB_OFFSET_HOURS;
	return ((hours % 24) + 24) % 24;
}

export function greetingPeriod(utcMs: number): GreetingPeriod {
	const hour = wibHour(utcMs);
	if (hour >= 4 && hour < 11) return 'pagi';
	if (hour >= 11 && hour < 15) return 'siang';
	if (hour >= 15 && hour < 18) return 'sore';
	return 'malam';
}

/** The greeting line; English: morning, afternoon, afternoon, evening (owner decision 4). No name (decision 5). */
export const GREETINGS: Readonly<Record<GreetingPeriod, string>> = {
	pagi: msg('Selamat pagi.'),
	siang: msg('Selamat siang.'),
	sore: msg('Selamat sore.'),
	malam: msg('Selamat malam.')
};
