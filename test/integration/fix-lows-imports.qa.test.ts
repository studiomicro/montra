import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { overUserSlidingLimit } from '#lib/server/auth/throttle';
import { getDb, type Db } from '#lib/server/db';
import { LINKS_LIST_MAX, listTransferLinks } from '#lib/server/transfers/match';
import { STATEMENT_UPLOADS_PER_WINDOW } from '#lib/server/statements/validation';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

async function account(email: string) {
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		0
	);
	if (!r.ok) throw new Error('setup failed');
	const row = await d1
		.prepare('select space_id as spaceId from space_members where user_id = ? limit 1')
		.bind(r.userId)
		.first<{ spaceId: string }>();
	return { userId: r.userId, spaceId: row!.spaceId };
}

describe('QA fix-lows-imports', () => {
	it('a user importing 12 monthly statements (preview + import each, one a minute) is never throttled', async () => {
		const T0 = 1_800_000_000_000 + 7 * 60_000;
		for (let m = 0; m < 12; m++)
			for (let i = 0; i < 2; i++)
				expect(
					await overUserSlidingLimit(
						db,
						'rajin',
						T0 + m * 60_000 + i * 1000,
						'statement-upload',
						STATEMENT_UPLOADS_PER_WINDOW
					),
					`statement ${m} upload ${i}`
				).toBe(false);
	});

	it('a statement burst of 12 (24 uploads) inside two minutes is not throttled either, the 31st upload is', async () => {
		const T0 = 1_800_100_000_000;
		let refused = 0;
		for (let i = 0; i < 31; i++)
			if (await overUserSlidingLimit(db, 'burst', T0 + i * 1000, 'statement-upload', 30)) refused++;
		expect(refused).toBe(1);
	});

	it('links paging: a cursor from one space shows only the other space’s own older links, never the first space’s', async () => {
		const a = await account('qa-a@contoh.id');
		const b = await account('qa-b@contoh.id');
		const ins = (space: string, tag: string, n: number, base: number) =>
			d1
				.prepare(
					`with recursive k(i) as (select 1 union all select i + 1 from k where i < ?)
					insert into transfer_links (id, space_id, debit_transaction_id, credit_transaction_id, debit_snapshot,
						credit_snapshot, created_at, updated_at, undone_at, seq)
					select printf('${tag}-%03d', i), ?, 'd-${tag}-' || i, 'c-${tag}-' || i, '{}',
						json_object('amountMinor', 1000, 'currency', 'IDR', 'occurredOn', '2026-07-10', 'walletId', 'w'),
						? + i, ? + i, null, 1 from k`
				)
				.bind(n, space, base, base)
				.run();
		await ins(a.spaceId, 'aa', LINKS_LIST_MAX + 5, 1000);
		await ins(b.spaceId, 'bb', 3, 500);
		const first = await listTransferLinks(db, a.spaceId);
		expect(first.links).toHaveLength(LINKS_LIST_MAX);
		expect(first.next).not.toBeNull();
		const second = await listTransferLinks(db, a.spaceId, first.next);
		expect(second.links).toHaveLength(5);
		expect(second.next).toBeNull();
		expect(new Set([...first.links, ...second.links].map((l) => l.id)).size).toBe(
			LINKS_LIST_MAX + 5
		);
		// A's cursor used against B's space: B's own older rows only (all of them older than A's cursor), none of A's.
		const crossed = await listTransferLinks(db, b.spaceId, first.next);
		expect(crossed.links.map((l) => l.id).every((id) => id.startsWith('bb-'))).toBe(true);
		// Exactly LINKS_LIST_MAX rows leave no phantom next page.
		const exact = await account('qa-c@contoh.id');
		await ins(exact.spaceId, 'cc', LINKS_LIST_MAX, 2000);
		const page = await listTransferLinks(db, exact.spaceId);
		expect(page.links).toHaveLength(LINKS_LIST_MAX);
		expect(page.next).toBeNull();
	});
});
