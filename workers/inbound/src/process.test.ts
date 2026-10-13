import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveKey } from '#lib/server/ai-keys/repo';
import { signUp } from '#lib/server/auth/accounts';
import { getDb, type Db } from '#lib/server/db';
import { discardDraft } from '#lib/server/drafts/repo';
import {
	claimRateSlot,
	createAddress,
	getActiveAddress,
	revokeAddress
} from '#lib/server/inbound/repo';
import { resolveCurrentSpace } from '#lib/server/spaces/access';
import { createSharedSpace } from '#lib/server/spaces/spaces';
import { createTransaction } from '#lib/server/transactions/repo';
import { createWallet } from '#lib/server/wallets/repo';
import { ensurePresetCategories, listCategories } from '#lib/server/categories/repo';
import { base64urlEncode } from '#lib/shared/base64url';
import { INBOUND_RATE_PER_HOUR, MAX_INBOUND_BYTES } from '#lib/shared/inbound/address';
import type { JobMessage } from '#lib/shared/jobs';
import { openLocalD1 } from '../../../test/helpers/d1';
import { bytes, emailMessage, fixtureText } from '../../../test/helpers/mail';
import { handleEmail, type InboundEnv } from './process';

// FN-19 inbound Worker against a local D1 (workerd): every acceptance criterion of PRD § "Inbound handling" and
// the AI-path entry. Mails are the FICTIONAL fixtures; no test reaches a mail provider, the queue or AI.

const DOMAIN = 'in.contoh.example';
const AUTHSERV = 'mx.inbound.example';
const NOW = Date.parse('2026-10-08T08:00:00Z');
const ENC = base64urlEncode(new Uint8Array(32).fill(7));

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());
afterEach(() => vi.restoreAllMocks());

const fullEnv = (): InboundEnv => ({
	INBOUND_EMAIL_DOMAIN: DOMAIN,
	INBOUND_AUTHSERV_ID: AUTHSERV,
	AI_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
	AI_GATEWAY_ID: 'montra-test'
});

let n = 0;
async function person() {
	const email = `penerusan${++n}@mail.example`;
	const r = await signUp(
		db,
		{ name: 'Uji', email, password: 'kopi-pagi-2026', adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const space = (await resolveCurrentSpace(db, r.userId, undefined))!;
	expect(await createAddress(db, r.userId, space.id, NOW)).toBe('created');
	const address = (await getActiveAddress(db, r.userId))!;
	return {
		userId: r.userId,
		email,
		spaceId: space.id,
		address,
		to: `${address.localPart}@${DOMAIN}`
	};
}
type Person = Awaited<ReturnType<typeof person>>;

function deliver(
	who: { to: string },
	raw: string | Uint8Array,
	o: { env?: InboundEnv; now?: number; rawSize?: number; queue?: JobMessage[] } = {}
) {
	const data = typeof raw === 'string' ? bytes(raw) : raw;
	const message = emailMessage(data, who.to, o.rawSize ?? data.length);
	const queue = o.queue ?? [];
	const outcome = handleEmail(message, {
		db,
		env: o.env ?? fullEnv(),
		enqueue: async (m) => {
			queue.push(m);
		},
		now: () => o.now ?? NOW
	});
	return { message, outcome, queue };
}
const send = async (who: Person, fixture: string, o: Parameters<typeof deliver>[2] = {}) => {
	const d = deliver(who, fixtureText(fixture, who.to), o);
	return { ...d, outcome: await d.outcome };
};

const draftsOf = (spaceId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from drafts where space_id = ${spaceId} order by created_at, rowid`
	);
const ledgerOf = (userId: string) =>
	db.all<Record<string, unknown>>(
		sql`select * from inbound_mail where user_id = ${userId} order by received_at, rowid`
	);
const transactionCount = async () =>
	(await db.get<{ n: number }>(sql`select count(*) as n from transactions`))!.n;

describe('cheap checks first: size, recipient, budget', () => {
	it('rejects a message over 1 MiB by its declared size without reading it', async () => {
		const who = await person();
		const pull = vi.fn();
		const message = {
			to: who.to,
			rawSize: MAX_INBOUND_BYTES + 1,
			raw: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
			rejected: '',
			setReject(r: string) {
				message.rejected = r;
			}
		};
		const outcome = await handleEmail(message, {
			db,
			env: fullEnv(),
			enqueue: async () => {},
			now: () => NOW
		});
		expect(outcome).toBe('rejected');
		expect(message.rejected).toBe('Message too large');
		expect(pull).not.toHaveBeenCalled();
		expect(await ledgerOf(who.userId)).toEqual([]);
	});

	it('stops a stream longer than its declared size at the cap, without parsing or storing anything', async () => {
		const who = await person();
		const big = new Uint8Array(MAX_INBOUND_BYTES + 1).fill(0x61);
		const { message, outcome } = deliver(who, big, { rawSize: 100 });
		expect(await outcome).toBe('rejected');
		expect(message.rejected).toBe('Message too large');
		expect(await ledgerOf(who.userId)).toEqual([]);
	});

	it('unknown, revoked and owner-removed addresses get one identical answer; so does an unset domain', async () => {
		const owner = await person();
		const member = await person();
		const shared = (await createSharedSpace(db, owner.userId, 'Keluarga', NOW))!;
		await db.run(sql`insert into space_members (id, space_id, user_id, role, created_at, updated_at)
			values (${crypto.randomUUID()}, ${shared}, ${member.userId}, 'member', ${NOW}, ${NOW})`);
		await db.run(
			sql`update inbound_addresses set space_id = ${shared} where user_id = ${member.userId}`
		);
		// While a member, mail is accepted.
		expect((await send(member, 'other/promo')).outcome).toBe('not_payment');
		await db.run(
			sql`update space_members set deleted_at = ${NOW} where space_id = ${shared} and user_id = ${member.userId}`
		);
		const removed = await send(member, 'other/promo');
		const revokedPerson = await person();
		await revokeAddress(db, revokedPerson.userId, revokedPerson.address, NOW + 1);
		const revoked = await send(revokedPerson, 'other/promo');
		const unknown = await send(
			{ ...owner, to: `m-${'0'.repeat(26)}@${DOMAIN}` } as Person,
			'other/promo'
		);
		const unset = await send(owner, 'other/promo', {
			env: { ...fullEnv(), INBOUND_EMAIL_DOMAIN: undefined }
		});
		const guessed = await send({ ...owner, to: `budi@${DOMAIN}` } as Person, 'other/promo');
		for (const r of [removed, revoked, unknown, unset, guessed]) {
			expect(r.outcome).toBe('rejected');
			expect(r.message.rejected).toBe('Unknown recipient');
		}
		expect((await ledgerOf(member.userId)).length).toBe(1);
		expect(await ledgerOf(revokedPerson.userId)).toEqual([]);
	});

	it('the 61st mail in an hour is dropped silently and counted; a new hour starts a new budget', async () => {
		const who = await person();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (let i = 0; i < INBOUND_RATE_PER_HOUR; i++)
			expect(await claimRateSlot(db, who.address.id, NOW + i)).toBe(true);
		const over = await send(who, 'other/promo', { now: NOW + 100 });
		expect(over.outcome).toBe('dropped');
		expect(over.message.rejected).toBeNull();
		expect(warn).toHaveBeenCalledWith('inbound: over hourly budget', { dropped: 1 });
		expect(JSON.stringify(warn.mock.calls)).not.toContain(who.address.localPart);
		expect((await send(who, 'other/promo', { now: NOW + 60 * 60 * 1000 })).outcome).toBe(
			'not_payment'
		);
	});

	it('the hourly limit holds exactly under 20 concurrent deliveries', async () => {
		const who = await person();
		await db.run(
			sql`update inbound_addresses set window_start = ${NOW}, window_count = 50 where id = ${who.address.id}`
		);
		const results = await Promise.all(
			Array.from({ length: 20 }, () => claimRateSlot(db, who.address.id, NOW + 5))
		);
		expect(results.filter(Boolean).length).toBe(10);
		const row = await db.get<{ c: number }>(
			sql`select window_count as c from inbound_addresses where id = ${who.address.id}`
		);
		expect(row?.c).toBe(INBOUND_RATE_PER_HOUR);
	});
});

describe('malformed mail never throws and stores no text', () => {
	it('truncated boundary, 10,000 headers, deep nesting, invalid charset, 1 MiB of one line', async () => {
		const who = await person();
		let id = 0;
		const head = (extra = '') =>
			`From: a@toko.example\r\nTo: ${who.to}\r\nSubject: Invoice\r\nMessage-ID: <m${++id}@toko.example>\r\n${extra}`;
		let nested = '';
		for (let i = 0; i < 40; i++)
			nested += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
		const cases = [
			`${head('Content-Type: multipart/mixed; boundary="x"\r\n')}\r\n--x\r\nContent-Type: text/plain\r\n\r\nTotal Rp 5.000`,
			`${head()}${Array.from({ length: 10_000 }, (_, i) => `X-H${i}: v`).join('\r\n')}\r\n\r\nbody`,
			`${head()}${nested}Total Rp 5.000`,
			`${head('Content-Type: text/plain; charset=x-no-such-charset\r\n')}\r\n\xff\xfe Total Rp 5.000`,
			`${head()}\r\n${'a'.repeat(MAX_INBOUND_BYTES - 200)}`
		];
		const outcomes: string[] = [];
		for (const [i, raw] of cases.entries()) {
			const d = deliver(who, raw, { now: NOW + i });
			outcomes.push(await d.outcome);
		}
		expect(outcomes).toEqual(['unreadable', 'malformed', 'malformed', 'unreadable', 'not_payment']);
		const rows = await ledgerOf(who.userId);
		expect(rows.length).toBe(cases.length);
		expect(rows.some((r) => r.status === 'unreadable' && r.reason === 'malformed')).toBe(true);
		for (const r of rows) {
			expect(r.pending_text).toBeNull();
			if (r.reason === 'malformed')
				expect([r.subject, r.sender_domain, r.trust]).toEqual([null, null, null]);
		}
		expect(await draftsOf(who.spaceId)).toEqual([]);
	});
});

describe('deterministic parsers → drafts, never transactions', () => {
	it('bank-qris (verified): one draft, expense 2.800.000 minor, WIB date, source gmail, no flag, no wallet', async () => {
		const who = await person();
		const before = await transactionCount();
		expect((await send(who, 'bank-qris/payment')).outcome).toBe('draft');
		const [draft] = await draftsOf(who.spaceId);
		expect(draft).toMatchObject({
			type: 'expense',
			amount_minor: 2_800_000,
			currency: 'IDR',
			// FN-20: the cleaned merchant name; the space has no categories yet, so none is set.
			title: 'Kedai Kopi Senja',
			occurred_on: '2026-10-08',
			occurred_at: Date.parse('2026-10-08T14:32:05+07:00'),
			source: 'gmail',
			flag: null,
			wallet_id: null,
			category_id: null,
			is_demo: 0,
			deleted_at: null
		});
		// FN-20: the merchant text as the mail gave it stays in the note.
		expect(draft?.note).toBe('Pengirim terverifikasi · Ref ••••3456 · KEDAI KOPI SENJA');
		expect(String(draft?.dedupe_key)).toMatch(/^mail:r:[0-9a-f]{32}$/);
		const [row] = await ledgerOf(who.userId);
		expect(row).toMatchObject({
			status: 'draft_created',
			reason: null,
			trust: 'verified',
			parser: 'bank-qris',
			sender_domain: 'notifikasi.bank-qris.example',
			subject: 'Transaksi QRIS Berhasil',
			pending_text: null,
			confirmation_code: null
		});
		expect(await transactionCount()).toBe(before);
	});

	it('every parser yields its draft, income for an incoming transfer', async () => {
		const who = await person();
		for (const f of [
			'ewallet-payment/payment',
			'bank-transfer-in/transfer',
			'bank-transfer-out/transfer'
		])
			expect((await send(who, f)).outcome).toBe('draft');
		const rows = await draftsOf(who.spaceId);
		expect(rows.map((r) => [r.type, r.amount_minor, r.title, r.flag])).toEqual([
			['expense', 2_800_000, 'Kedai Kopi Senja', null],
			['income', 150_000_000, 'Budi Santoso', null],
			['expense', 25_000_000, 'Siti Aminah', null]
		]);
	});

	it('wrong shapes create no draft (without an AI key they are unreadable, text not kept)', async () => {
		const who = await person();
		for (const f of [
			'bank-qris/wrong-two-amounts',
			'bank-qris/wrong-credit',
			'bank-transfer-in/wrong-debit'
		])
			expect((await send(who, f)).outcome).toBe('unreadable');
		expect(await draftsOf(who.spaceId)).toEqual([]);
		for (const r of await ledgerOf(who.userId))
			expect([r.status, r.reason, r.pending_text]).toEqual(['unreadable', 'no_ai_key', null]);
	});

	it('month boundaries follow the WIB date printed', async () => {
		const who = await person();
		await send(who, 'bank-qris/month-end');
		await send(who, 'bank-qris/month-start');
		expect((await draftsOf(who.spaceId)).map((r) => r.occurred_on)).toEqual([
			'2026-10-31',
			'2026-11-01'
		]);
	});
});

describe('authenticity: spoofed mail is only ever a flagged draft', () => {
	it('authserv-id unset or foreign, DMARC fail, or an injected header: needs_review, never a transaction', async () => {
		const before = await transactionCount();
		const raw = (who: Person) => fixtureText('bank-qris/payment', who.to);
		const variants: [string, (who: Person) => string, InboundEnv][] = [
			['unset', raw, { ...fullEnv(), INBOUND_AUTHSERV_ID: undefined }],
			['foreign', raw, { ...fullEnv(), INBOUND_AUTHSERV_ID: 'mx.other.example' }],
			['dmarc fail', (w) => raw(w).replace(/dmarc=pass \(p=REJECT\)/, 'dmarc=fail'), fullEnv()],
			[
				'injected below a failing top header',
				(w) => `Authentication-Results: ${AUTHSERV}; dmarc=fail header.from=x.example\r\n${raw(w)}`,
				fullEnv()
			]
		];
		for (const [name, make, env] of variants) {
			const who = await person();
			const d = deliver(who, make(who), { env });
			expect(await d.outcome, name).toBe('draft');
			const [draft] = await draftsOf(who.spaceId);
			expect(draft?.flag, name).toBe('needs_review');
			expect(String(draft?.note), name).toContain('Pengirim belum terverifikasi');
			expect((await ledgerOf(who.userId))[0]?.trust, name).toBe('unverified');
		}
		expect(await transactionCount()).toBe(before);
	});

	it('a manual forward from the owner’s own mailbox picks the parser from the quoted sender; flagged', async () => {
		const who = await person();
		const original = fixtureText('bank-qris/payment', who.to)
			.split('\r\n\r\n')
			.slice(1)
			.join('\r\n\r\n');
		const forward = [
			`Authentication-Results: ${AUTHSERV}; dkim=pass header.d=mail.example; dmarc=pass header.from=mail.example`,
			`From: Uji <${who.email}>`,
			`To: ${who.to}`,
			'Subject: Fwd: Transaksi QRIS Berhasil',
			'Message-ID: <fwd-1@mail.example>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'---------- Forwarded message ---------',
			'From: Bank Contoh <noreply@notifikasi.bank-qris.example>',
			'Subject: Transaksi QRIS Berhasil',
			'',
			original
		].join('\r\n');
		expect(await deliver(who, forward).outcome).toBe('draft');
		const [draft] = await draftsOf(who.spaceId);
		expect(draft).toMatchObject({ amount_minor: 2_800_000, flag: 'needs_review' });
		expect(String(draft?.note)).toContain('Diteruskan, belum terverifikasi');
		expect((await ledgerOf(who.userId))[0]).toMatchObject({
			trust: 'forwarded',
			sender_domain: 'notifikasi.bank-qris.example'
		});
	});
});

describe('idempotent capture', () => {
	it('the same mail twice, the same reference with a new Message-ID, 20 concurrent deliveries: one draft', async () => {
		const who = await person();
		await send(who, 'bank-qris/payment');
		await send(who, 'bank-qris/payment');
		const renamed = fixtureText('bank-qris/payment', who.to).replace(
			'qris-20261008-0001',
			'qris-resent-9'
		);
		await deliver(who, renamed).outcome;
		await Promise.all(
			Array.from({ length: 20 }, () => send(who, 'bank-qris/payment', { now: NOW + 7 }))
		);
		expect((await draftsOf(who.spaceId)).length).toBe(1);
		expect((await ledgerOf(who.userId)).length).toBe(2);
	});

	it('red team M1: a different payment with the same amount and the same last 4 reference digits gets its own draft', async () => {
		const who = await person();
		await send(who, 'bank-qris/payment');
		const other = fixtureText('bank-qris/payment', who.to)
			.replace('qris-20261008-0001', 'qris-20261009-0002')
			.replace('20261008143205123456', '99999999999999993456')
			.replace('08 Okt 2026 14:32:05', '09 Okt 2026 08:15:00');
		expect(await deliver(who, other).outcome).toBe('draft');
		const rows = await draftsOf(who.spaceId);
		expect(rows.length).toBe(2);
		// The note still shows only the last 4; the full reference is never stored anywhere.
		expect(rows.map((r) => r.note)).toEqual([
			'Pengirim terverifikasi · Ref \u2022\u2022\u2022\u20223456 · KEDAI KOPI SENJA',
			'Pengirim terverifikasi · Ref \u2022\u2022\u2022\u20223456 · KEDAI KOPI SENJA'
		]);
		expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(2);
		const stored = JSON.stringify([rows, await ledgerOf(who.userId)]);
		expect(stored).not.toContain('99999999999999993456');
		expect(stored).not.toContain('20261008143205123456');
		// Truthful ledger: one draft_created row per draft.
		expect((await ledgerOf(who.userId)).map((r) => r.status)).toEqual([
			'draft_created',
			'draft_created'
		]);
	});

	it('red team L6: mails without a Message-ID collide only when they are the same mail', async () => {
		const who = await person();
		const mail = (body: string) =>
			`From: a@toko.example\r\nTo: ${who.to}\r\nSubject: Promo\r\nContent-Type: text/plain\r\n\r\n${body}`;
		expect(await deliver(who, mail('Diskon A')).outcome).toBe('not_payment');
		expect(await deliver(who, mail('Diskon B')).outcome).toBe('not_payment');
		expect(await deliver(who, mail('Diskon A')).outcome).toBe('repeat');
		expect((await ledgerOf(who.userId)).length).toBe(2);
	});

	it('a discarded capture is never recreated from the same mail', async () => {
		const who = await person();
		await send(who, 'ewallet-payment/payment');
		const [draft] = await draftsOf(who.spaceId);
		expect(
			await discardDraft(
				db,
				{ spaceId: who.spaceId, userId: who.userId },
				{ id: String(draft?.id), updatedAt: Number(draft?.updated_at) },
				NOW + 1
			)
		).toBe('ok');
		const renamed = fixtureText('ewallet-payment/payment', who.to).replace(
			'ew-20261008-1432',
			'ew-again'
		);
		await deliver(who, renamed, { now: NOW + 2 }).outcome;
		await send(who, 'ewallet-payment/payment', { now: NOW + 3 });
		const rows = await draftsOf(who.spaceId);
		expect(rows.length).toBe(1);
		expect(rows[0]?.deleted_at).not.toBeNull();
	});

	it('a live real IDR transaction with the same amount within 12 h flags the draft duplicate', async () => {
		const who = await person();
		const scope = { spaceId: who.spaceId, userId: who.userId };
		const wallet = await createWallet(
			db,
			scope,
			{
				name: 'BCA',
				type: 'bank',
				currency: 'IDR',
				openingBalanceMinor: 0,
				isFavourite: false,
				lastFour: null
			},
			NOW
		);
		if (!wallet.ok) throw new Error('wallet');
		await ensurePresetCategories(db, who.spaceId);
		const category = (await listCategories(db, who.spaceId)).find((c) => c.kind === 'expense')!;
		const tx = await createTransaction(
			db,
			scope,
			{
				type: 'expense',
				amountMinor: 2_800_000,
				currency: 'IDR',
				walletId: wallet.id,
				transferToWalletId: null,
				categoryId: category.id,
				title: 'Kopi',
				note: null,
				occurredOn: '2026-10-08',
				occurredTime: '09:00'
			},
			NOW
		);
		expect(tx.ok).toBe(true);
		await send(who, 'bank-qris/payment');
		expect((await draftsOf(who.spaceId))[0]?.flag).toBe('duplicate');
	});

	it('at 1,000 pending drafts the mail is unreadable/inbox_full and no draft is added', async () => {
		const who = await person();
		await db.run(sql`with recursive k(i) as (select 1 union all select i + 1 from k where i < 1000)
			insert into drafts (id, space_id, type, amount_minor, currency, occurred_on, occurred_at, source,
				dedupe_key, is_demo, created_at, updated_at, seq)
			select 'cap-' || ${who.spaceId} || '-' || i, ${who.spaceId}, 'expense', 100, 'IDR', '2026-10-01', ${NOW},
				'voice', null, 0, ${NOW}, ${NOW}, 1 from k`);
		await send(who, 'bank-qris/payment');
		const live = await db.get<{ n: number }>(
			sql`select count(*) as n from drafts where space_id = ${who.spaceId} and deleted_at is null`
		);
		expect(live?.n).toBe(1000);
		expect((await ledgerOf(who.userId))[0]).toMatchObject({
			status: 'unreadable',
			reason: 'inbox_full'
		});
	});
});

describe('privacy of what is kept', () => {
	it('non-payment mail (promo, OTP) keeps only its key, date and status', async () => {
		const who = await person();
		await send(who, 'other/promo');
		await send(who, 'other/otp');
		const rows = await ledgerOf(who.userId);
		expect(rows.length).toBe(2);
		for (const r of rows)
			expect(r).toMatchObject({
				status: 'not_payment',
				reason: null,
				trust: null,
				parser: null,
				sender_domain: null,
				subject: null,
				pending_text: null,
				confirmation_code: null
			});
	});

	it('card and account numbers are reduced to the last 4 digits in every column written, and never logged', async () => {
		const who = await person();
		await saveKey(
			db,
			who.userId,
			'anthropic',
			'sk-ant-api03-synthetic-0001-AbCdEfGh',
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			NOW
		);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { outcome, queue } = await send(who, 'other/shop-invoice');
		expect(outcome).toBe('queued');
		const [row] = await ledgerOf(who.userId);
		const all = JSON.stringify(row);
		expect(all).not.toMatch(/4111\s?1111\s?1111\s?1234|1234567890/);
		expect(String(row?.pending_text)).toContain('••••1234');
		expect(String(row?.pending_text)).toContain('Rp 125.500');
		expect(String(row?.pending_text)).toContain('pada 8 Oktober 2026');
		// Ids only on the queue.
		expect(queue).toEqual([{ type: 'inbound_read', mailId: row?.id }]);
		const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
		for (const secret of [who.address.localPart, 'toko-daring', 'Invoice', '125.500'])
			expect(logged).not.toContain(secret);
	});
});

describe('AI path entry (no AI call here)', () => {
	it('red team L3: card and account numbers split by *, / or a spaced dash are masked before storage', async () => {
		const who = await person();
		await saveKey(
			db,
			who.userId,
			'anthropic',
			'sk-ant-api03-synthetic-0009-AbCdEfGh',
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			NOW
		);
		const raw = fixtureText('other/shop-invoice', who.to).replace(
			'Rekening pengembalian 1234567890.',
			'Kartu 4111*1111*1111*1111, rek 1234 - 5678 - 9012, HP 0812/3456/7890.'
		);
		expect(await deliver(who, raw).outcome).toBe('queued');
		const text = String((await ledgerOf(who.userId))[0]?.pending_text);
		const m = '\u2022\u2022\u2022\u2022';
		expect(text).toContain(`Kartu ${m}1111, rek ${m}9012, HP ${m}7890.`);
		expect(text.replace(/\D/g, '')).not.toMatch(/411111111111|123456789012|081234567890/);
	});

	it('no key → unreadable/no_ai_key, gateway unset → ai_unconfigured, text never stored; a re-forward after adding a key is read', async () => {
		const who = await person();
		const env = { ...fullEnv(), AI_GATEWAY_ID: undefined };
		expect((await send(who, 'other/shop-invoice', { env })).outcome).toBe('unreadable');
		expect((await ledgerOf(who.userId))[0]).toMatchObject({
			reason: 'ai_unconfigured',
			pending_text: null
		});
		expect((await send(who, 'other/shop-invoice', { now: NOW + 1 })).outcome).toBe('unreadable');
		expect((await ledgerOf(who.userId))[0]).toMatchObject({
			reason: 'no_ai_key',
			pending_text: null
		});
		await saveKey(
			db,
			who.userId,
			'anthropic',
			'sk-ant-api03-synthetic-0002-AbCdEfGh',
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			NOW
		);
		const again = await send(who, 'other/shop-invoice', { now: NOW + 2 });
		expect(again.outcome).toBe('queued');
		const rows = await ledgerOf(who.userId);
		expect(rows.length).toBe(1);
		expect(rows[0]).toMatchObject({ status: 'queued', reason: null, parser: 'ai' });
		expect(again.queue).toEqual([{ type: 'inbound_read', mailId: rows[0]?.id }]);
		// A queued (or finished) mail is not reprocessed by a repeat.
		expect((await send(who, 'other/shop-invoice', { now: NOW + 3 })).outcome).toBe('repeat');
	});

	it('a failed enqueue leaves the row queued for the sweep', async () => {
		const who = await person();
		await saveKey(
			db,
			who.userId,
			'anthropic',
			'sk-ant-api03-synthetic-0003-AbCdEfGh',
			{ AI_KEYS_ENCRYPTION_KEY: ENC },
			NOW
		);
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const message = emailMessage(bytes(fixtureText('other/shop-invoice', who.to)), who.to);
		const outcome = await handleEmail(message, {
			db,
			env: fullEnv(),
			enqueue: async () => {
				throw new Error('queue down');
			},
			now: () => NOW
		});
		expect(outcome).toBe('queued');
		expect((await ledgerOf(who.userId))[0]?.status).toBe('queued');
	});
});

describe('Gmail forwarding confirmation', () => {
	it('red team L1: a look-alike confirmation (not authenticated by google.com) keeps no code', async () => {
		const forged = await person();
		const raw = fixtureText('other/gmail-confirmation', forged.to).replace(
			/^Authentication-Results:[^\r]*\r\n/,
			''
		);
		expect(await deliver(forged, raw).outcome).toBe('not_payment');
		const unset = await person();
		const noId = await send(unset, 'other/gmail-confirmation', {
			env: { ...fullEnv(), INBOUND_AUTHSERV_ID: undefined }
		});
		expect(noId.outcome).toBe('not_payment');
		for (const who of [forged, unset])
			expect((await ledgerOf(who.userId))[0]).toMatchObject({
				status: 'not_payment',
				confirmation_code: null
			});
	});

	it('keeps only the digit code', async () => {
		const who = await person();
		expect((await send(who, 'other/gmail-confirmation')).outcome).toBe('confirmation');
		expect((await ledgerOf(who.userId))[0]).toMatchObject({
			status: 'confirmation',
			confirmation_code: '123456789',
			subject: null,
			sender_domain: null,
			pending_text: null
		});
	});
});
