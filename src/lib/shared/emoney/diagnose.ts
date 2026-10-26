/**
 * FN-58 "Diagnosa kartu": what happens after a card is tapped, apart from the page so it can be tested without a
 * phone. The standard probes for the card's tech (commands.ts), then for a FeliCa card the KMT reader's own two reads
 * (kmt.ts), so one log both identifies the card and checks the KMT reader. The returned log is already masked: a
 * FeliCa IDm keeps only its last 2 bytes and any run of 12 or more digits only its last 4, in every command, answer
 * and card field, before anything shows or copies it.
 */

import {
	maskLongDigitRuns,
	PROBES,
	recordExchange,
	type CardTech,
	type Exchange
} from './commands';
import { idmFromPolling, readKmtBalance, type KmtBalance } from './kmt';

/** What the Android bridge reports when a card is tapped. Never the card's UID, only its length. */
export type CardInfo = {
	techs: string[];
	uidLength: number;
	atqa?: string;
	sak?: number;
	historicalBytes?: string;
	hiLayerResponse?: string;
	systemCode?: string;
	manufacturer?: string;
	error?: string;
};

/** The tech a tapped card speaks, or null when it is neither an ISO-DEP nor a FeliCa card. */
export function cardTech(info: CardInfo): CardTech | null {
	if (info.techs.includes('IsoDep')) return 'isodep';
	if (info.techs.includes('NfcF')) return 'nfcf';
	return null;
}

/** One tapped card's diagnosis, masked: the card as reported, the KMT balance when it is one, every exchange. */
export type Diagnosis = { card: CardInfo; kmt: KmtBalance | null; answers: Exchange[] };

/** Sends one read command to the connected card and gives its answer (the bridge refuses anything else). */
export type Transceive = (tech: CardTech, hex: string) => Promise<string>;

/** Runs the probes (and for FeliCa the KMT read) on a tapped card. Send failures land in the log; it never throws. */
export async function diagnoseCard(card: CardInfo, transceive: Transceive): Promise<Diagnosis> {
	const tech = cardTech(card);
	const answers: Exchange[] = [];
	let kmt: KmtBalance | null = null;
	if (tech) {
		const send = (hex: string) => transceive(tech, hex);
		for (const p of PROBES) if (p.tech === tech) await recordExchange(answers, p.name, p.hex, send);
	}
	if (tech === 'nfcf') {
		const read = await readKmtBalance((hex) => transceive('nfcf', hex));
		answers.push(...read.exchanges);
		kmt = read.balance;
	}
	return maskDiagnosis({ card, kmt, answers }, tech === 'nfcf');
}

/**
 * The log as it may be shown or copied. For a FeliCa card every IDm found in a Polling answer (the KMT one and the
 * any-system one may differ) is cut to its last 2 bytes wherever it appears; then long digit runs are cut to their
 * last 4 in every command, answer and card byte field.
 */
export function maskDiagnosis(diagnosis: Diagnosis, felica: boolean): Diagnosis {
	const idms = felica
		? [
				...new Set(
					diagnosis.answers.flatMap((a) => {
						const idm = idmFromPolling(a.response);
						return idm ? [idm] : [];
					})
				)
			]
		: [];
	// An IDm is 16 hex digits, so it is safe as a pattern; case-insensitive so a lower-case answer is masked too.
	const mask = (text: string) =>
		maskLongDigitRuns(
			idms.reduce(
				(out, idm) => out.replace(new RegExp(idm, 'gi'), '••••••••••••' + idm.slice(-4)),
				text
			)
		);
	const { card } = diagnosis;
	return {
		card: {
			...card,
			...(card.historicalBytes !== undefined && {
				historicalBytes: maskLongDigitRuns(card.historicalBytes)
			}),
			...(card.hiLayerResponse !== undefined && {
				hiLayerResponse: maskLongDigitRuns(card.hiLayerResponse)
			})
		},
		kmt: diagnosis.kmt,
		answers: diagnosis.answers.map((a) => ({
			name: a.name,
			command: mask(a.command),
			response: mask(a.response)
		}))
	};
}
