/**
 * A per-isolate lane of in-flight requests (FN-15 receipts, FN-22 Tanya): at most `max` requests at once and at
 * most one per user, so one user cannot occupy it. `reserve(userId)` returns a release function, or null when the
 * user already holds a place or the lane is full (the caller answers 503 with Retry-After). Call the release once,
 * on every exit; a second call does nothing.
 */
export function createUserLane(max: number): (userId: string) => (() => void) | null {
	const held = new Set<string>();
	return (userId) => {
		if (held.has(userId) || held.size >= max) return null;
		held.add(userId);
		let released = false;
		return () => {
			if (!released) held.delete(userId);
			released = true;
		};
	};
}
