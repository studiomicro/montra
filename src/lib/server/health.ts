export interface HealthBody {
	ok: boolean;
	db: boolean;
	version: string;
}

/** Liveness plus a D1 round trip. Never includes error text or env values. */
export async function checkHealth(
	db: D1Database,
	version: string
): Promise<{ status: 200 | 503; body: HealthBody }> {
	try {
		await db.prepare('SELECT 1 AS ok').first();
		return { status: 200, body: { ok: true, db: true, version } };
	} catch {
		return { status: 503, body: { ok: false, db: false, version } };
	}
}
