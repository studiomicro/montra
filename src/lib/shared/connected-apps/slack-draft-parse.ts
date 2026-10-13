import { isDateString, wibDateString } from '../dates.ts';
import type { TileKey } from '../transactions.ts';
import { parseVoiceSentence, VOICE_BATCH_MAX, type VoiceContext } from '../voice-parse.ts';

/**
 * A Slack message → FN-11 draft rows (FN-29; no network call, no live Slack endpoint yet). A message such as
 * "kopi 25rb dan parkir goceng" is free text exactly like a voice transcript, so the amounts, titles, income
 * words and category hints come from FN-14's `parseVoiceSentence` (itself on FN-14a's money parser): one parser,
 * two capture paths. This module only removes Slack's own markup first, so a link, mention or channel reference
 * is never read as an amount, and gives each draft its source and dedupe key.
 *
 * Untrusted input: the raw text is capped before any work, and the voice parser strips control and zero-width
 * characters. Ordinary chat without an amount gives `null`: Slack chatter never becomes a fabricated draft.
 * The dedupe key is the message's identity (workspace, channel, Slack `ts`) plus the item's position, so a
 * redelivered or edited message (same `ts`) never creates a second draft (drafts_dedupe_uq).
 */

export interface SlackMessage {
	text: string;
	/** Slack workspace (`team_id`), channel (`channel`) and message timestamp (`ts`, "seconds.micros"). */
	teamId: string;
	channelId: string;
	ts: string;
}

/** One draft as the `drafts` insert path stores it (FN-11), with `source: 'slack'`. */
export interface SlackDraft {
	type: 'expense' | 'income';
	/** IDR minor units, positive (the ledger's sign convention: direction from `type`). */
	amountMinor: number;
	currency: 'IDR';
	title: string | null;
	/** WIB calendar date of the message, from its `ts`. */
	occurredOn: string;
	occurredAt: number;
	source: 'slack';
	dedupeKey: string;
	/** The space wallet the message named, else null (review picks one). */
	walletId: string | null;
	categoryHint?: TileKey;
}

/** Raw characters read from one message; the voice parser caps further. */
export const SLACK_TEXT_MAX = 4000;
const SLACK_ID = /^[A-Z0-9]{1,24}$/;
const SLACK_TS = /^(\d{1,12})\.(\d{6})$/;

/**
 * Slack markup removed before parsing: `<…>` links, mentions and channel refs, `:emoji:`, `*_~`` ` marks. The
 * entities `&lt;` `&gt;` `&amp;` are decoded first and `<…>` stripped after, then any lone `<`/`>` dropped, so a
 * typed `&lt;!channel&gt;` can never come back as mention markup in a title (red team L1).
 */
function plainText(text: string): string {
	return text
		.slice(0, SLACK_TEXT_MAX)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/<[^<>]*>/g, ' ')
		.replace(/[<>]/g, ' ')
		.replace(/:[a-z0-9_+-]{1,64}:/gi, ' ')
		.replace(/[*_~`]/g, ' ');
}

/** The UTC instant of a Slack `ts`, or null when it is not a well-formed timestamp in 2000–2099. */
function instantOf(ts: string): number | null {
	const m = SLACK_TS.exec(ts);
	if (!m) return null;
	const ms = Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000);
	return Number.isSafeInteger(ms) && isDateString(wibDateString(ms)) ? ms : null;
}

export function parseSlackMessage(message: SlackMessage, hints: VoiceContext): SlackDraft[] | null {
	if (typeof message?.text !== 'string') return null;
	const { teamId, channelId, ts } = message;
	if (!SLACK_ID.test(String(teamId)) || !SLACK_ID.test(String(channelId))) return null;
	const at = instantOf(String(ts));
	if (at === null) return null;
	const candidates = parseVoiceSentence(plainText(message.text), hints).slice(0, VOICE_BATCH_MAX);
	if (candidates.length === 0) return null;
	const occurredOn = wibDateString(at);
	return candidates.map((c, i) => {
		const draft: SlackDraft = {
			type: c.type,
			amountMinor: c.amountMinor,
			currency: 'IDR',
			title: c.title === '' ? null : c.title,
			occurredOn,
			occurredAt: at,
			source: 'slack',
			dedupeKey: `slack:${teamId}:${channelId}:${ts}:${i}`,
			walletId: c.walletHint ?? null
		};
		if (c.categoryHint !== undefined) draft.categoryHint = c.categoryHint;
		return draft;
	});
}
