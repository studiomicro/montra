import { z } from 'zod';
import { msg } from './i18n.ts';
import { cleanText } from './text.ts';

/**
 * Tanya (FN-22): limits, the stored card shape and the question cleaner, shared by the server and the page. Every
 * figure a card shows was computed and formatted by the server from stored rows; the model never writes one.
 */

export const TANYA_ROLES = ['user', 'assistant'] as const;
type TanyaRole = (typeof TANYA_ROLES)[number];

/** Longest question (characters, after cleaning). */
export const TANYA_QUESTION_MAX = 500;
/** Longest stored body (the CHECK of `tanya_messages`). */
export const TANYA_BODY_MAX = 4000;
/** Largest stored `cards_json` in bytes (the CHECK of `tanya_messages`). */
export const TANYA_CARDS_MAX_BYTES = 32 * 1024;
/** Questions one user may ask per THROTTLE_WINDOW_MS (owner decision 5). */
export const TANYA_ASKS_PER_WINDOW = 30;
/** Rows kept per (user, space) conversation before they expire (owner decision 6). */
export const TANYA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Most rows the page lists. */
export const TANYA_LIST_MAX = 50;
/** Prior question-and-answer pairs sent to the model with a new question. */
export const TANYA_HISTORY_TURNS = 6;

/** The suggested questions shown on an empty conversation (FEATURES.md FN-22 examples plus two). */
export const TANYA_CHIPS: readonly string[] = [
	msg('Bulan lalu habis berapa buat kopi?'),
	msg('Langganan apa yang paling mahal?'),
	msg('Pengeluaran terbesarku bulan ini apa saja?'),
	msg('Berapa saldo semua dompetku?'),
	msg('Anggaran mana yang hampir habis?')
];

/**
 * A question as the server uses it: invisible and control characters stripped, whitespace collapsed,
 * NFC-normalised, capped to TANYA_QUESTION_MAX characters (cleanText caps before normalising).
 */
export function cleanQuestion(input: string): string {
	return cleanText(input, TANYA_QUESTION_MAX);
}

/** One line of a card: a label (a phrase translated by the page, or user data shown as it is) and a value. */
const rowSchema = z
	.object({
		label: z.string().max(120),
		/** True when `label` is user data (a category, wallet or merchant name): never translated. */
		raw: z.boolean().optional(),
		value: z.string().max(80)
	})
	.strict();

const chartSchema = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('donut'),
			currency: z.string().max(3),
			slices: z
				.array(
					z
						.object({
							series: z.string().max(20),
							label: z.string().max(120),
							minor: z.number().int().nonnegative()
						})
						.strict()
				)
				.max(9)
		})
		.strict(),
	z
		.object({
			type: z.literal('bars'),
			currency: z.string().max(3),
			bars: z
				.array(
					z.object({ label: z.string().max(20), minor: z.number().int().nonnegative() }).strict()
				)
				.max(13)
		})
		.strict()
]);

/** Most rows one card holds; a tool never builds more (a longer card fails the schema and is dropped on read). */
export const TANYA_CARD_ROWS_MAX = 40;

const tanyaCardSchema = z
	.object({
		/** A phrase, translated by the page. */
		title: z.string().max(120),
		/** The WIB period the card covers (shown by the page in the reader's locale), when it has one. */
		period: z
			.object({ from: z.string().max(10), to: z.string().max(10) })
			.strict()
			.nullable(),
		rows: z.array(rowSchema).max(TANYA_CARD_ROWS_MAX),
		chart: chartSchema.nullable()
	})
	.strict();

export type TanyaCard = z.infer<typeof tanyaCardSchema>;
export type TanyaCardRow = z.infer<typeof rowSchema>;

const tanyaCardsSchema = z.array(tanyaCardSchema).max(8);

/** Stored cards read back: validated again, so a row the page cannot show safely shows none (never a crash). */
export function parseCards(json: string | null): TanyaCard[] {
	if (!json) return [];
	try {
		const parsed = tanyaCardsSchema.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

/** One listed message (page data). */
export interface TanyaMessageView {
	id: string;
	role: TanyaRole;
	body: string;
	cards: TanyaCard[];
	createdAt: number;
}

/** Why the composer is off: no AI Gateway on this server, or no personal Anthropic key (FN-41). */
export type TanyaReady = 'ok' | 'no_gateway' | 'no_key';
