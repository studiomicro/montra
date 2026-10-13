import { describe, expect, it } from 'vitest';
import { DRAFT_SOURCES } from '../drafts.ts';
import { parseVoiceSentence, VOICE_BATCH_MAX, type VoiceContext } from '../voice-parse.ts';
import { parseSlackMessage, SLACK_TEXT_MAX, type SlackMessage } from './slack-draft-parse.ts';

const none: VoiceContext = { wallets: [] };
const wallets: VoiceContext = {
	wallets: [
		{ id: 'w1', name: 'GoPay', type: 'e_wallet' },
		{ id: 'w2', name: 'Dompet', type: 'tunai' },
		{ id: 'w4', name: 'BCA', type: 'bank' }
	]
};
// 2026-10-31 23:30:00.123456 WIB = 16:30 UTC.
const TS = `${Date.parse('2026-10-31T16:30:00Z') / 1000}.123456`;
const msg = (text: string, over: Partial<SlackMessage> = {}): SlackMessage => ({
	text,
	teamId: 'T0123ABC',
	channelId: 'C0456DEF',
	ts: TS,
	...over
});

describe('parseSlackMessage — one parser, two capture paths (AC9)', () => {
	it('FN-39: inherits the widened keyword table ("gofood siang 35rb" → Pesan Antar Makanan)', () => {
		expect(parseSlackMessage(msg('gofood siang 35rb'), none)).toEqual([
			expect.objectContaining({ amountMinor: 3_500_000, categoryHint: 'pesan-antar-makanan' })
		]);
		expect(parseSlackMessage(msg('gojek ke kantor 15rb'), none)?.[0]?.categoryHint).toBe(
			'ojek-online'
		);
	});
	it('"kopi 25rb dan parkir goceng" gives the voice parser’s two items as slack drafts', () => {
		expect(parseSlackMessage(msg('kopi 25rb dan parkir goceng'), none)).toEqual([
			{
				type: 'expense',
				amountMinor: 2_500_000,
				currency: 'IDR',
				title: 'kopi',
				occurredOn: '2026-10-31',
				occurredAt: Date.parse('2026-10-31T16:30:00.123Z'),
				source: 'slack',
				dedupeKey: `slack:T0123ABC:C0456DEF:${TS}:0`,
				walletId: null,
				categoryHint: 'kopi'
			},
			{
				type: 'expense',
				amountMinor: 500_000,
				currency: 'IDR',
				title: 'parkir',
				occurredOn: '2026-10-31',
				occurredAt: Date.parse('2026-10-31T16:30:00.123Z'),
				source: 'slack',
				dedupeKey: `slack:T0123ABC:C0456DEF:${TS}:1`,
				walletId: null,
				categoryHint: 'transportasi'
			}
		]);
		expect(DRAFT_SOURCES).toContain('slack');
	});

	// FN-14's own vectors (src/lib/shared/voice-parse.test.ts) without Slack markup characters.
	const VOICE_VECTORS = [
		'25rb dan goceng',
		'bayar kopi pakai gopay 25rb',
		'beli 2 ceban kopi',
		'beli 2 kopi 50rb',
		'bensin 50rb bca',
		'dapat gaji 5 jt',
		'jual kopi 25rb',
		'kopi 25rb ,parkir goceng',
		'kopi 25rb dan roti',
		'kopi 25rb di kantor, parkir goceng',
		'kopi 25rb pakai gopay dan parkir goceng',
		'kopi 25rb parkir goceng',
		'kopi 25rb, parkir goceng',
		'kopi\u200b 25\u200brb',
		'makan 1,5 jt terus bensin 50.000 lalu parkir gopek',
		'makan siang 30rb',
		'parkir goceng tunai',
		'penjualan kopi 25rb',
		'refund -25rb'
	];

	it.each(VOICE_VECTORS)(
		'"%s": same amounts, titles, types and hints as the voice parser',
		(text) => {
			for (const ctx of [none, wallets]) {
				const voice = parseVoiceSentence(text, ctx);
				const slack = parseSlackMessage(msg(text), ctx)!;
				expect(
					slack.map((d) => [d.amountMinor, d.title ?? '', d.type, d.walletId, d.categoryHint])
				).toEqual(
					voice.map((c) => [c.amountMinor, c.title, c.type, c.walletHint ?? null, c.categoryHint])
				);
			}
		}
	);

	it('ordinary chat without an amount gives null, never a fabricated draft', () => {
		for (const text of [
			'ada yang mau ikut makan siang?',
			'beli 2 kopi',
			'kopi 0rb',
			'',
			'   ',
			'meeting jam 10:30 ya',
			':moneybag: :kopi:'
		])
			expect(parseSlackMessage(msg(text), none)).toBeNull();
	});
});

describe('Slack markup and hostile text', () => {
	it('never reads a link, mention, channel reference or emoji code as an amount', () => {
		expect(parseSlackMessage(msg('<https://contoh.id/promo/25rb|promo 25rb>'), none)).toBeNull();
		expect(parseSlackMessage(msg('<@U25000000> <#C123|kas-25rb> <!here>'), none)).toBeNull();
		expect(parseSlackMessage(msg(':25rb:'), none)).toBeNull();
		const [d] = parseSlackMessage(
			msg('<@U0123> *kopi* _25rb_ :coffee: <https://x.id|link>'),
			none
		)!;
		expect(d).toMatchObject({ title: 'kopi', amountMinor: 2_500_000 });
	});

	it('red team L1: decoded entities never re-create mention markup; titles never hold < or >', () => {
		const [d] = parseSlackMessage(msg('kopi 25rb &lt;!channel&gt; &lt;@U12345&gt;'), none)!;
		expect(d).toMatchObject({ title: 'kopi', amountMinor: 2_500_000 });
		for (const text of [
			'kopi 25rb &lt;!channel&gt;',
			'&lt;!here&gt; kopi 25rb &lt;#C123|umum&gt;',
			'kopi &lt;@U1&gt; 25rb',
			'kopi 25rb &amp;lt;!channel&amp;gt;',
			'kopi 25rb &lt;&lt;!everyone&gt;&gt;',
			'kopi 25rb <!channel> > < &gt;'
		]) {
			const drafts = parseSlackMessage(msg(text), none)!;
			for (const draft of drafts) expect(draft.title ?? '').not.toMatch(/[<>]/);
		}
	});

	it('decodes &amp; to & in titles; HTML-looking text is removed, never kept as markup', () => {
		const [d] = parseSlackMessage(msg('kopi &amp; roti 25rb &lt;script&gt;'), none)!;
		expect(d).toMatchObject({ amountMinor: 2_500_000, title: 'kopi & roti' });
		const [e] = parseSlackMessage(msg('&lt;img src=x onerror=alert(1)&gt; 25rb'), none)!;
		expect(e!.title).toBeNull();
	});

	it('strips control, zero-width and bidi characters; keeps a formula-looking title as text', () => {
		const [d] = parseSlackMessage(msg('\u202ekopi\u0000\u200b 25rb\u2028'), none)!;
		expect(d).toMatchObject({ title: 'kopi', amountMinor: 2_500_000 });
		// Stored as typed; FN-18/FN-29 exports guard it (formula injection is an export concern).
		const [f] = parseSlackMessage(msg('=HYPERLINK("http://x") 25rb'), none)!;
		expect(f!.title?.startsWith('=HYPERLINK("http://x')).toBe(true);
	});

	it('caps huge input, never throws, and caps the drafts one message can give', () => {
		const huge = 'kopi 25rb '.repeat(50_000);
		const drafts = parseSlackMessage(msg(huge), none)!;
		expect(drafts.length).toBeGreaterThan(0);
		expect(drafts.length).toBeLessThanOrEqual(VOICE_BATCH_MAX);
		expect(SLACK_TEXT_MAX).toBeLessThan(huge.length);
		const pathological = '<'.repeat(100_000) + ':'.repeat(100_000) + ' 25rb';
		const start = performance.now();
		expect(parseSlackMessage(msg(pathological), none)).toBeNull();
		expect(performance.now() - start).toBeLessThan(1000);
	});

	it('prototype-looking words are ordinary text', () => {
		const [d] = parseSlackMessage(msg('__proto__ constructor 25rb'), none)!;
		expect(d).toMatchObject({ amountMinor: 2_500_000, walletId: null });
		expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
	});

	it('refuses a message without a well-formed identity (no dedupe key, no draft)', () => {
		const bad: Partial<SlackMessage>[] = [
			{ ts: '' },
			{ ts: '1790000000' },
			{ ts: '1790000000.12' },
			{ ts: '99999999999.000000' },
			{ ts: '1.000000' },
			{ teamId: '' },
			{ teamId: 'T:1' },
			{ channelId: 'c-lower' },
			{ channelId: 'C'.repeat(30) }
		];
		for (const over of bad) expect(parseSlackMessage(msg('kopi 25rb', over), none)).toBeNull();
		expect(parseSlackMessage({ ...msg(''), text: 42 as unknown as string }, none)).toBeNull();
		expect(parseSlackMessage(null as unknown as SlackMessage, none)).toBeNull();
	});
});

describe('dates and dedupe keys', () => {
	it('dates the drafts by the WIB date of ts: 00:30 WIB on the 1st is the 1st, not the UTC 31st', () => {
		const ts = `${Date.parse('2026-10-31T17:30:00Z') / 1000}.000000`;
		expect(parseSlackMessage(msg('kopi 25rb', { ts }), none)![0]!.occurredOn).toBe('2026-11-01');
	});

	it('the same message gives the same keys (a redelivery or edit dedupes); another message other keys', () => {
		const a = parseSlackMessage(msg('kopi 25rb dan parkir goceng'), none)!.map((d) => d.dedupeKey);
		const edited = parseSlackMessage(msg('kopi 26rb dan parkir goceng'), none)!.map(
			(d) => d.dedupeKey
		);
		expect(edited).toEqual(a);
		const other = parseSlackMessage(
			msg('kopi 25rb dan parkir goceng', { ts: '1790000000.000001' }),
			none
		)!;
		expect(other.map((d) => d.dedupeKey).some((k) => a.includes(k))).toBe(false);
		const otherChannel = parseSlackMessage(msg('kopi 25rb', { channelId: 'C999' }), none)!;
		expect(a).not.toContain(otherChannel[0]!.dedupeKey);
	});
});
