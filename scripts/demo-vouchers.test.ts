import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeVoucherCode } from '../src/lib/shared/billing/voucher-code';
import { DEMO_VOUCHERS, demoVoucherStatements } from './demo-vouchers';

describe('demo vouchers', () => {
	it('store only the SHA-256 of valid codes (canonical form), never the code', () => {
		const sql = demoVoucherStatements().join('\n');
		for (const v of DEMO_VOUCHERS) {
			const canonical = normalizeVoucherCode(v.code);
			expect(canonical).not.toBeNull();
			expect(sql).toContain(
				createHash('sha256')
					.update(canonical as string)
					.digest('hex')
			);
			expect(sql).not.toContain(v.code);
			expect(sql).not.toContain(canonical);
		}
		expect(sql.match(/INSERT OR IGNORE/g)).toHaveLength(DEMO_VOUCHERS.length);
	});

	it('the seed that writes them refuses any non-local target before running anything', () => {
		for (const flag of ['--remote', '--preview', '--env=staging', '-e']) {
			const r = spawnSync(process.execPath, ['scripts/seed-local.ts', flag], { encoding: 'utf8' });
			expect(r.status, flag).not.toBe(0);
			expect(r.stderr).toMatch(/Refusing/);
			expect(r.stderr).not.toMatch(/wrangler/i);
		}
	});
});
