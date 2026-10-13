import { describe, expect, it } from 'vitest';
import { readSplitForm, type SplitFormContext } from './form';

const ctx = (over: Partial<SplitFormContext> = {}): SplitFormContext => ({
	currency: 'IDR',
	fixedTotal: null,
	payer: { userId: 'u-ayu', name: 'Ayu' },
	members: [
		{ userId: 'u-ayu', name: 'Ayu' },
		{ userId: 'u-bima', name: 'Bima' }
	],
	locale: 'id',
	...over
});

function form(pairs: [string, string][]): FormData {
	const f = new FormData();
	for (const [k, v] of pairs) f.append(k, v);
	return f;
}

const base: [string, string][] = [
	['title', 'Makan bareng'],
	['occurredOn', '2026-10-11'],
	['mode', 'equal'],
	['amount', '100.000'],
	['note', '']
];

describe('readSplitForm', () => {
	it('puts the payer first, then picked members, then named guests; empty guest rows are no one', () => {
		const r = readSplitForm(
			form([
				...base,
				['member', 'u-bima'],
				['guestName', 'Rina'],
				['guestShare', ''],
				['guestName', '  '],
				['guestShare', '']
			]),
			ctx()
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.fields.participants).toEqual([
			{ kind: 'member', memberUserId: 'u-ayu', displayName: 'Ayu', shareAmountMinor: 3_333_400 },
			{ kind: 'member', memberUserId: 'u-bima', displayName: 'Bima', shareAmountMinor: 3_333_300 },
			{ kind: 'guest', memberUserId: null, displayName: 'Rina', shareAmountMinor: 3_333_300 }
		]);
		expect(r.fields.totalAmountMinor).toBe(10_000_000);
	});

	it('refuses a member not in the space, the payer picked as a member, and too few people', () => {
		const stranger = readSplitForm(form([...base, ['member', 'u-x']]), ctx());
		expect(stranger.ok ? null : stranger.errors.people).toBe(
			'Anggota ini sudah tidak ada di ruang.'
		);
		const self = readSplitForm(form([...base, ['member', 'u-ayu']]), ctx());
		expect(self.ok ? null : self.errors.people).toBe('Anggota ini sudah tidak ada di ruang.');
		const alone = readSplitForm(form(base), ctx());
		expect(alone.ok ? null : alone.errors.people).toBe(
			'Pilih minimal 1 orang lain, paling banyak 19.'
		);
	});

	it('cleans guest names (control and zero-width characters) and caps the rows at 20 people', () => {
		const r = readSplitForm(
			form([...base, ['guestName', 'Ri​na\u0007'], ['guestShare', '']]),
			ctx()
		);
		expect(r.ok && r.fields.participants[1]?.displayName).toBe('Rina');
		const many = readSplitForm(
			form([
				...base,
				['member', 'u-bima'],
				...Array.from({ length: 25 }, (_, i): [string, string] => ['guestName', `Tamu ${i}`])
			]),
			ctx()
		);
		// 25 rows posted, 20 read: payer + Bima + 20 guests = 22 people, over the limit.
		expect(many.ok ? null : many.errors.people).toBe(
			'Pilih minimal 1 orang lain, paling banyak 19.'
		);
	});

	it('exact mode: each share typed, refused per field when missing and as a whole when off', () => {
		const exact: [string, string][] = [...base.filter(([k]) => k !== 'mode'), ['mode', 'exact']];
		const ok = readSplitForm(
			form([...exact, ['payerShare', '60.000'], ['guestName', 'Rina'], ['guestShare', '40.000']]),
			ctx()
		);
		expect(ok.ok && ok.fields.participants.map((p) => p.shareAmountMinor)).toEqual([
			6_000_000, 4_000_000
		]);
		const off = readSplitForm(
			form([...exact, ['payerShare', '60.000'], ['guestName', 'Rina'], ['guestShare', '30.000']]),
			ctx()
		);
		expect(off.ok ? null : off.errors).toEqual({
			shares: 'Jumlah semua bagian harus sama dengan totalnya.'
		});
		const blank = readSplitForm(
			form([...exact, ['payerShare', ''], ['guestName', 'Rina'], ['guestShare', '30.000']]),
			ctx()
		);
		expect(blank.ok ? null : blank.errors.payerShare).toBe('Isi bagian setiap orang lebih dari 0.');
		// IDR is whole rupiah: "12,50" is not an amount.
		const sen = readSplitForm(
			form([...exact, ['payerShare', '99.999,50'], ['guestName', 'Rina'], ['guestShare', '0,50']]),
			ctx()
		);
		expect(sen.ok).toBe(false);
	});

	it('a currency with cents takes them in the UI language (AC-2 through the form)', () => {
		const r = readSplitForm(
			form([
				...base.filter(([k]) => k !== 'amount'),
				['amount', '1.00'],
				['guestName', 'Rina'],
				['guestName', 'Dodi']
			]),
			ctx({ currency: 'USD', locale: 'en' })
		);
		expect(r.ok && r.fields.participants.map((p) => p.shareAmountMinor)).toEqual([34, 33, 33]);
	});

	it('a linked bill fixes the total: whatever the form says is ignored', () => {
		const r = readSplitForm(
			form([...base.filter(([k]) => k !== 'amount'), ['amount', '1'], ['guestName', 'Rina']]),
			ctx({ fixedTotal: 40_000_000 })
		);
		expect(r.ok && r.fields.totalAmountMinor).toBe(40_000_000);
		expect(r.ok && r.fields.participants.map((p) => p.shareAmountMinor)).toEqual([
			20_000_000, 20_000_000
		]);
	});

	it('refuses a missing title, a bad date, an unknown mode, a zero total and a total too small to share', () => {
		const r = readSplitForm(
			form([
				['title', '​'],
				['occurredOn', '2026-02-30'],
				['mode', 'items'],
				['amount', '0'],
				['guestName', 'Rina']
			]),
			ctx()
		);
		expect(r.ok ? null : r.errors).toEqual({
			title: 'Isi nama patungan.',
			occurredOn: 'Pilih tanggal yang benar.',
			mode: 'Pilih cara membagi.',
			amount: 'Isi total tagihan lebih dari 0.'
		});
		const tiny = readSplitForm(
			form([
				...base.filter(([k]) => k !== 'amount'),
				['amount', '1'],
				['guestName', 'Rina'],
				['guestName', 'Dodi']
			]),
			ctx()
		);
		expect(tiny.ok ? null : tiny.errors.amount).toBe(
			'Total terlalu kecil untuk dibagi ke semua orang.'
		);
	});
});
