import { describe, expect, it } from 'vitest';
import { isReadOnly, PROBES, type CardTech } from './commands';
import { cardTech, diagnoseCard, maskDiagnosis, type CardInfo } from './diagnose';
import { felicaFrame } from './hex';
import { kmtBalanceFrame, kmtPollingFrame } from './kmt';

// Fictional cards and frames, not from a real card.
const IDM = '0123456789ABCDEF';
const OTHER_IDM = '1123456789ABCDEF'; // the any-system Polling may answer for system 0, with its own IDm
const PMM = '0000000000000000';
const kmtBlock = '14CD00' + '00'.repeat(13); // 52.500 = 0x00CD14, little-endian

function fakeCard(answers: Record<string, string>) {
	const sent: { tech: CardTech; hex: string }[] = [];
	const transceive = async (tech: CardTech, hex: string) => {
		sent.push({ tech, hex });
		const answer = answers[hex];
		if (answer === undefined) throw new Error('The card moved away');
		return answer;
	};
	return { sent, transceive };
}

describe('card tech', () => {
	it('prefers ISO-DEP, then FeliCa, else none', () => {
		expect(cardTech({ techs: ['NfcA', 'IsoDep'], uidLength: 7 })).toBe('isodep');
		expect(cardTech({ techs: ['NfcF'], uidLength: 8 })).toBe('nfcf');
		expect(cardTech({ techs: ['MifareClassic', 'NfcA'], uidLength: 4 })).toBeNull();
	});
});

describe('diagnoseCard', () => {
	it('reads a KMT card and masks every IDm in the log', async () => {
		const card: CardInfo = { techs: ['NfcF'], uidLength: 8, systemCode: '90B7' };
		const { sent, transceive } = fakeCard({
			'0600FFFF0100': felicaFrame('01' + OTHER_IDM + PMM + '90B7'),
			[kmtPollingFrame()]: felicaFrame('01' + IDM + PMM),
			[kmtBalanceFrame(IDM)]: felicaFrame('07' + IDM + '0000' + '01' + kmtBlock)
		});
		const log = await diagnoseCard(card, transceive);
		expect(log.kmt).toEqual({ ok: true, balance: 52_500 });
		expect(log.answers.map((a) => a.name)).toEqual([
			'FeliCa Polling (any system)',
			'KMT Polling (90B7)',
			'KMT balance (1017)'
		]);
		const text = JSON.stringify(log);
		expect(text).not.toContain(IDM);
		expect(text).not.toContain(OTHER_IDM);
		expect(text).toContain('••••••••••••CDEF');
		for (const s of sent) expect(isReadOnly(s.tech, s.hex), s.hex).toBe(true);
	});
	it('sends only the ISO-DEP probes to an ISO-DEP card, and logs failures', async () => {
		const card: CardInfo = { techs: ['IsoDep', 'NfcA'], uidLength: 7, historicalBytes: '' };
		const { sent, transceive } = fakeCard({ '00A40000023F00': '6A82' });
		const log = await diagnoseCard(card, transceive);
		expect(sent.map((s) => s.hex)).toEqual(
			PROBES.filter((p) => p.tech === 'isodep').map((p) => p.hex)
		);
		expect(log.kmt).toBeNull();
		expect(log.answers[0]).toEqual({
			name: 'SELECT MF (3F00)',
			command: '00A40000023F00',
			response: '6A82'
		});
		expect(log.answers[1]!.response).toBe('The card moved away');
	});
	it('sends nothing to a card that is neither ISO-DEP nor FeliCa', async () => {
		const { sent, transceive } = fakeCard({});
		const log = await diagnoseCard({ techs: ['MifareClassic'], uidLength: 4 }, transceive);
		expect(sent).toEqual([]);
		expect(log.answers).toEqual([]);
	});
});

describe('maskDiagnosis', () => {
	it('masks long digit runs in answers and in the card bytes, keeping error text as it is', () => {
		const masked = maskDiagnosis(
			{
				card: {
					techs: ['IsoDep'],
					uidLength: 7,
					historicalBytes: '806032987654321234',
					hiLayerResponse: '00'
				},
				kmt: null,
				answers: [
					{ name: 'a', command: '00B00000', response: '5A0860329876543212349000' },
					{ name: 'b', command: '00B00000', response: 'The card moved away' }
				]
			},
			false
		);
		// Every digit counts toward a run, the status word too: 18 digits keep their last 4.
		expect(masked.card.historicalBytes).toBe('•'.repeat(14) + '1234');
		expect(masked.answers[0]!.response).toBe('5A' + '•'.repeat(18) + '9000');
		expect(masked.answers[1]!.response).toBe('The card moved away');
	});
	it('masks an IDm in lower case too', () => {
		const masked = maskDiagnosis(
			{
				card: { techs: ['NfcF'], uidLength: 8 },
				kmt: null,
				answers: [
					{ name: 'poll', command: '', response: felicaFrame('01' + IDM + PMM) },
					{ name: 'echo', command: '', response: IDM.toLowerCase() }
				]
			},
			true
		);
		expect(JSON.stringify(masked).toUpperCase()).not.toContain(IDM);
	});
});
