import { msg } from '../i18n.ts';

/**
 * "Lihat ke belakang" (FN-19 Gmail PRD § 6): how far back a look-back scan reads, limited by plan
 * (`gmailLookbackMaxDays`: Gratis 7, Pro and Agent 365). The server refuses a value above the plan's maximum
 * and the scan handler clamps it again, so a forged form or a plan that lapsed meanwhile reads no further.
 */
export const LOOKBACK_DAYS = [7, 30, 90, 180, 365] as const;
export type LookbackDays = (typeof LOOKBACK_DAYS)[number];

export const LOOKBACK_LABELS: Readonly<Record<LookbackDays, string>> = {
	7: msg('7 hari'),
	30: msg('1 bulan'),
	90: msg('3 bulan'),
	180: msg('6 bulan'),
	365: msg('12 bulan')
};

/** The look-back value of a form field, or null when it is not one of LOOKBACK_DAYS. */
export function lookbackDaysOf(value: string): LookbackDays | null {
	const n = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
	return (LOOKBACK_DAYS as readonly number[]).includes(n) ? (n as LookbackDays) : null;
}

/** `days` within the plan's maximum. */
export const lookbackAllowed = (days: number, maxDays: number) => days <= maxDays;
