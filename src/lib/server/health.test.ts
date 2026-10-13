import { describe, expect, it } from 'vitest';
import { checkHealth } from '#lib/server/health';
import { withLocalD1 } from '../../../test/helpers/d1';

describe('checkHealth', () => {
	it('reports db true against local D1', async () => {
		await withLocalD1(async (db) => {
			const result = await checkHealth(db, '0.0.1');
			expect(result).toEqual({ status: 200, body: { ok: true, db: true, version: '0.0.1' } });
		});
	});

	it('reports 503 without details when the database fails', async () => {
		const broken = {
			prepare: () => ({
				first: async () => {
					throw new Error('D1_ERROR: secret detail /path/to/thing');
				}
			})
		} as unknown as D1Database;
		const result = await checkHealth(broken, '0.0.1');
		expect(result).toEqual({ status: 503, body: { ok: false, db: false, version: '0.0.1' } });
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});
