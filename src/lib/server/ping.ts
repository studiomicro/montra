/**
 * The dev-only queue ping round trip (POST /api/v1/dev/ping → jobs Worker → D1). Each ping is recorded under its
 * own `app_meta` key, `ping:<id>`: a single shared `last_ping` value let a concurrent ping overwrite another before
 * its sender polled, so that sender never saw its own id (the e2e flake with the phone and desktop projects
 * pinging at once). Rows older than PING_KEEP_MS are pruned in the same batch, so the table stays bounded.
 */
export const PING_KEEP_MS = 60 * 60 * 1000;

const key = (id: string) => `ping:${id}`;

export async function recordPing(db: D1Database, id: string, now: number): Promise<void> {
	await db.batch([
		db
			.prepare("DELETE FROM app_meta WHERE key LIKE 'ping:%' AND updated_at < ?1")
			.bind(now - PING_KEEP_MS),
		db
			.prepare(
				'INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, ?3) ' +
					'ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at'
			)
			.bind(key(id), id, now)
	]);
}

export async function pingReceived(db: D1Database, id: string): Promise<boolean> {
	if (!id) return false;
	const row = await db
		.prepare('SELECT 1 AS one FROM app_meta WHERE key = ?1')
		.bind(key(id))
		.first();
	return row !== null;
}
