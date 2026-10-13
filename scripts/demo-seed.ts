import { addDays, wibInstantUtcMs } from '../src/lib/shared/dates.ts';
import { nextChargeOn, type BillingSchedule } from '../src/lib/shared/subscriptions.ts';

/**
 * Fictional `Data demo` transactions for local review (never remote: seed-local.ts runs only against local
 * state). Every live space that has an IDR wallet and its preset categories gets the same few rows, dated
 * relative to `today` (WIB), with `is_demo = 1`: Riwayat lists them with a "Data demo" badge and every total
 * (`periodTotals`, day headers, wallet balances) leaves them out. The same spaces get a few `Data demo`
 * subscriptions (FN-26) and collectibles (FN-28, no photo). Ids are deterministic per space, so a re-run
 * adds nothing and a demo row the reviewer deleted is not recreated.
 */
const ROWS = [
	{
		n: 1,
		daysAgo: 0,
		type: 'expense',
		tile: 'kopi',
		amountMinor: 2_800_000,
		title: 'Kopi susu (demo)'
	},
	{
		n: 2,
		daysAgo: 0,
		type: 'expense',
		tile: 'transportasi',
		amountMinor: 500_000,
		title: 'Parkir (demo)'
	},
	{
		n: 3,
		daysAgo: 1,
		type: 'expense',
		tile: 'makan',
		amountMinor: 4_500_000,
		title: 'Makan siang (demo)'
	},
	{
		n: 4,
		daysAgo: 2,
		type: 'expense',
		tile: 'belanja-harian',
		amountMinor: 18_750_000,
		title: 'Belanja mingguan (demo)'
	},
	{
		n: 5,
		daysAgo: 3,
		type: 'income',
		tile: 'freelance',
		amountMinor: 150_000_000,
		title: 'Proyek desain (demo)'
	},
	{
		n: 6,
		daysAgo: 5,
		type: 'expense',
		tile: 'tagihan',
		amountMinor: 32_500_000,
		title: 'Listrik (demo)'
	}
] as const;

/**
 * Fictional `Data demo` subscriptions (FN-26), plain names only: listed with the badge, left out of the monthly
 * total, bill reminders and "Tandai sudah dibayar".
 */
const SUBSCRIPTIONS: readonly {
	n: number;
	name: string;
	category: string;
	amountMinor: number;
	schedule: BillingSchedule;
}[] = [
	{
		n: 1,
		name: 'Streaming film (demo)',
		category: 'streaming',
		amountMinor: 5_499_000,
		schedule: { cycle: 'monthly', day: 28, month: null }
	},
	{
		n: 2,
		name: 'Paket data (demo)',
		category: 'telko',
		amountMinor: 10_000_000,
		schedule: { cycle: 'monthly', day: 5, month: null }
	},
	{
		n: 3,
		name: 'Penyimpanan foto (demo)',
		category: 'cloud',
		amountMinor: 26_900_000,
		schedule: { cycle: 'yearly', day: 14, month: 2 }
	}
];

/**
 * Fictional `Data demo` collectibles (FN-28), plain names only, without a photo: listed with the badge, left
 * out of the collectibles total on /koleksi and /kekayaan.
 */
const COLLECTIBLES = [
	{
		n: 1,
		name: 'Kartu langka (demo)',
		purchasePriceMinor: 150_000_000,
		valueMinor: 210_000_000,
		daysAgo: 400
	},
	{
		n: 2,
		name: 'Sepatu edisi terbatas (demo)',
		purchasePriceMinor: 320_000_000,
		valueMinor: 280_000_000,
		daysAgo: 120
	}
] as const;

/** A space this seed writes to: live, with a live IDR wallet. */
const ELIGIBLE = `s.deleted_at is null and exists (select 1 from wallets w where w.space_id = s.id
	and w.deleted_at is null and w.currency = 'IDR')`;

/** The SQL statements of the demo seed for `today` (`YYYY-MM-DD`, WIB). Values are constants, not user input. */
export function demoSeedStatements(today: string): string[] {
	const seq = `insert into space_seq (space_id, seq) select s.id, 1 from spaces s where ${ELIGIBLE}
		on conflict(space_id) do update set seq = seq + 1`;
	const rows = ROWS.map((r) => {
		const day = addDays(today, -r.daysAgo);
		const at = wibInstantUtcMs(day, '12:00');
		return `insert or ignore into transactions (id, space_id, type, amount_minor, currency, category_id,
			wallet_id, transfer_to_wallet_id, title, note, occurred_on, occurred_at, source, dedupe_key, is_demo,
			created_at, updated_at, deleted_at, seq)
		select 'demo-${r.n}-' || s.id, s.id, '${r.type}', ${r.amountMinor}, 'IDR', c.id, w.id, null,
			'${r.title}', null, '${day}', ${at}, 'manual', null, 1, ${at}, ${at}, null,
			(select seq from space_seq q where q.space_id = s.id)
		from spaces s
		join wallets w on w.id = (select x.id from wallets x where x.space_id = s.id and x.deleted_at is null
			and x.currency = 'IDR' order by x.is_favourite desc, x.created_at, x.id limit 1)
		join categories c on c.id = (select y.id from categories y where y.space_id = s.id
			and y.tile_key = '${r.tile}' and y.kind = '${r.type}' and y.deleted_at is null
			order by y.is_preset desc, y.sort_order limit 1)
		where ${ELIGIBLE}`;
	});
	const now = wibInstantUtcMs(today, '12:00');
	const subscriptions = SUBSCRIPTIONS.map(
		(
			r
		) => `insert or ignore into subscriptions (id, space_id, catalogue_id, name, category, amount_minor,
			currency, billing_cycle, billing_day, billing_month, wallet_id, linked_transaction_id, next_charge_on,
			reminder_days_before, is_demo, created_at, updated_at, deleted_at, seq)
		select 'demo-sub-${r.n}-' || s.id, s.id, null, '${r.name}', '${r.category}', ${r.amountMinor}, 'IDR',
			'${r.schedule.cycle}', ${r.schedule.day}, ${r.schedule.month ?? 'null'}, null, null,
			'${nextChargeOn(r.schedule, today)}', 2, 1, ${now}, ${now}, null,
			(select seq from space_seq q where q.space_id = s.id)
		from spaces s
		where ${ELIGIBLE}`
	);
	const collectibles = COLLECTIBLES.map(
		(r) => `insert or ignore into collectibles (id, space_id, name, purchase_price_minor, currency,
			purchased_on, manual_value_minor, photo_key, photo_type, note, is_demo, created_at, updated_at,
			deleted_at, seq)
		select 'demo-col-${r.n}-' || s.id, s.id, '${r.name}', ${r.purchasePriceMinor}, 'IDR',
			'${addDays(today, -r.daysAgo)}', ${r.valueMinor}, null, null, null, 1, ${now + r.n}, ${now + r.n},
			null, (select seq from space_seq q where q.space_id = s.id)
		from spaces s
		where ${ELIGIBLE}`
	);
	return [seq, ...rows, ...subscriptions, ...collectibles, ...demoSplitStatements(now)];
}

/**
 * One fictional `Data demo` split (FN-49): "Makan siang (demo)" (demo row 3, Rp 45.000) split equally between the
 * space's owner (the payer) and two named guests, linked as its bill. Badged on /patungan and left out of its
 * "Belum dilunasi" total; the linked demo row stays out of every total as before. Deleted by the reviewer, it is
 * not recreated (the tombstone keeps its id).
 */
function demoSplitStatements(now: number): string[] {
	const split = `'demo-split-1-' || s.id`;
	const owner = `(select m.user_id from space_members m where m.space_id = s.id and m.deleted_at is null
		and m.role = 'owner' order by m.created_at, m.id limit 1)`;
	const liveSplit = `exists (select 1 from patungan_splits x where x.id = ${split} and x.deleted_at is null)`;
	const people = [
		{ n: 1, kind: 'member', name: null, payer: 1 },
		{ n: 2, kind: 'guest', name: 'Rina (demo)', payer: 0 },
		{ n: 3, kind: 'guest', name: 'Dodi (demo)', payer: 0 }
	];
	return [
		`insert or ignore into patungan_splits (id, space_id, created_by_user_id, payer_name, title,
			total_amount_minor, currency, occurred_on, mode, note, payment_details, is_demo, created_at, updated_at,
			deleted_at, seq)
		select ${split}, s.id, ${owner}, (select substr(u.name, 1, 80) from users u where u.id = ${owner}),
			'Makan siang (demo)', 4500000, 'IDR', t.occurred_on, 'equal', null, null, 1, ${now}, ${now}, null,
			(select seq from space_seq q where q.space_id = s.id)
		from spaces s join transactions t on t.id = 'demo-3-' || s.id and t.deleted_at is null
		where ${ELIGIBLE} and ${owner} is not null`,
		...people.map(
			(p) => `insert or ignore into patungan_participants (id, split_id, space_id, position, kind,
				member_user_id, display_name, is_payer, share_amount_minor, breakdown_note, paid_amount_minor, paid_at,
				created_at, updated_at, deleted_at, seq)
			select 'demo-pp-${p.n}-' || s.id, ${split}, s.id, ${p.n - 1}, '${p.kind}',
				${p.payer ? owner : 'null'},
				${p.name ? `'${p.name}'` : `(select substr(u.name, 1, 80) from users u where u.id = ${owner})`},
				${p.payer}, 1500000, null, ${p.payer ? 1500000 : 0}, ${p.payer ? now : 'null'},
				${now}, ${now}, null, (select seq from space_seq q where q.space_id = s.id)
			from spaces s
			where ${ELIGIBLE} and ${liveSplit}`
		),
		`update transactions set patungan_split_id = 'demo-split-1-' || space_id,
			patungan_effective_amount_minor = 1500000
		where id in (select 'demo-3-' || s.id from spaces s where ${ELIGIBLE} and ${liveSplit})
			and deleted_at is null and patungan_split_id is null
			and not exists (select 1 from transactions z where z.patungan_split_id = 'demo-split-1-' || transactions.space_id)`
	];
}
