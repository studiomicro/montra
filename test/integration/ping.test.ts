import { describe, expect, it } from 'vitest';
import { PING_KEEP_MS, pingReceived, recordPing } from '#lib/server/ping';
import { withLocalD1 } from '../helpers/d1';

describe('dev queue ping record', () => {
	it('keeps every concurrent ping visible to its own sender (no shared last_ping overwrite)', async () => {
		await withLocalD1(async (db) => {
			await Promise.all(['a', 'b', 'c'].map((id) => recordPing(db, id, 1_000)));
			expect(await pingReceived(db, 'a')).toBe(true);
			expect(await pingReceived(db, 'b')).toBe(true);
			expect(await pingReceived(db, 'c')).toBe(true);
			expect(await pingReceived(db, 'never-sent')).toBe(false);
			expect(await pingReceived(db, '')).toBe(false);
		});
	});

	it('is idempotent on a redelivered message and prunes old pings', async () => {
		await withLocalD1(async (db) => {
			await recordPing(db, 'old', 0);
			await recordPing(db, 'new', PING_KEEP_MS + 1);
			await recordPing(db, 'new', PING_KEEP_MS + 2);
			expect(await pingReceived(db, 'old')).toBe(false);
			expect(await pingReceived(db, 'new')).toBe(true);
			const { n } = (await db
				.prepare("SELECT count(*) AS n FROM app_meta WHERE key LIKE 'ping:%'")
				.first<{ n: number }>())!;
			expect(n).toBe(1);
		});
	});
});
