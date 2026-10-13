import { createHash } from 'node:crypto';
import { normalizeVoucherCode } from '../src/lib/shared/billing/voucher-code.ts';

/**
 * Local-review voucher codes (FN-30), seeded by seed-local.ts only (never remote). There is no admin screen to
 * create vouchers (out of scope), so these let a reviewer try "Tukar voucher" locally. Only the SHA-256 of
 * each code's canonical form is stored, like every voucher; the plaintext codes are documented here and in the
 * FN-30 report. Crockford base32, ≥ 10 symbols (U is not in the alphabet, so the prefix is COBA, not UJI).
 * Deterministic ids with INSERT OR IGNORE: a re-run adds nothing.
 */
export const DEMO_VOUCHERS = [
	{
		id: 'demo-voucher-kredit',
		code: 'COBA-KREDIT-100',
		kind: 'credits',
		credits: 100,
		plan: null,
		days: null
	},
	{
		id: 'demo-voucher-pro',
		code: 'COBA-PRO-7-HARI',
		kind: 'plan_days',
		credits: null,
		plan: 'pro',
		days: 7
	}
] as const;

const sqlValue = (v: string | number | null) =>
	v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

export function demoVoucherStatements(): string[] {
	return DEMO_VOUCHERS.map((v) => {
		const canonical = normalizeVoucherCode(v.code);
		if (!canonical) throw new Error(`demo voucher ${v.id} is not a valid code`);
		const hash = createHash('sha256').update(canonical).digest('hex');
		return (
			'INSERT OR IGNORE INTO vouchers (id, code_hash, kind, credits_amount, plan, plan_days, ' +
			'max_redemptions, redemption_count, expires_at, created_at, updated_at, deleted_at) VALUES (' +
			[v.id, hash, v.kind, v.credits, v.plan, v.days, 1000, 0, null, 0, 0, null]
				.map(sqlValue)
				.join(', ') +
			')'
		);
	});
}
