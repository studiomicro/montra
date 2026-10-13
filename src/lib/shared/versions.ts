/**
 * Release versions (`MAJOR.MINOR.PATCH`, the Worker's `APP_VERSION`), shared by the release-note loader on the
 * server (FN-42) and the "what's new" notice in the browser (FN-42b), so both order versions the same way.
 */

/** A release version: three numbers, no leading zeros, at most four digits each. */
export const VERSION_PATTERN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

export function isVersion(value: unknown): value is string {
	return typeof value === 'string' && VERSION_PATTERN.test(value);
}

/** Newer first by semantic version: 0.10.0 before 0.4.0 (a string compare would put it after). */
export function compareVersionsDesc(a: string, b: string): number {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}
