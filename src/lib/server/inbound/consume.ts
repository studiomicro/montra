import { and, eq } from 'drizzle-orm';
import type { InboundMailReason, InboundTrust } from '#lib/shared/inbound/address';
import type { Db } from '../db';
import { inboundMail } from '../db/schema';
import { isAiGatewayConfigured, type AiGatewayEnv } from '../ai-keys/anthropic';
import type { AiKeysEnv } from '../ai-keys/crypto';
import { resolveAnthropicKey } from '../ai-keys/lookup';
import { aiReadFailure, readMailText } from './ai-read';
import { captureDraft, mailDedupeKey } from './draft';

/**
 * The jobs Worker's `inbound_read` (FN-19 PRD § 8): one queued mail read with its owner's own Anthropic key.
 * Idempotent: only a row still `queued` is read (a redelivery after it finished acks), and every ending nulls
 * the text in the same statement that records it (the schema allows text only while `queued`). The key opened
 * is always the row's owner's (`user_id` of the row), never one named by the message.
 */

export type InboundReadEnv = AiKeysEnv & AiGatewayEnv;

export async function processInboundRead(
	db: Db,
	env: InboundReadEnv,
	mailId: string,
	attempts: number,
	now: number,
	fetchFn: typeof fetch = fetch
): Promise<'read' | 'skipped'> {
	const [row] = await db
		.select({
			userId: inboundMail.userId,
			spaceId: inboundMail.spaceId,
			messageKey: inboundMail.messageKey,
			trust: inboundMail.trust,
			text: inboundMail.pendingText
		})
		.from(inboundMail)
		.where(and(eq(inboundMail.id, mailId), eq(inboundMail.status, 'queued')))
		.limit(1);
	if (!row) return 'skipped';
	const queued = and(eq(inboundMail.id, mailId), eq(inboundMail.status, 'queued'));
	const finish = async (reason: InboundMailReason) => {
		await db
			.update(inboundMail)
			.set({ status: 'unreadable', reason, pendingText: null, updatedAt: now })
			.where(queued);
		return 'read' as const;
	};
	if (!row.text) return finish('unparsed');
	if (!isAiGatewayConfigured(env)) return finish('ai_unconfigured');
	const key = await resolveAnthropicKey(db, row.userId, env);
	if (!key) return finish('no_ai_key');
	const outcome = await readMailText(env, key, row.text, fetchFn);
	if (outcome.kind === 'ok') {
		const trust: InboundTrust = row.trust ?? 'unverified';
		await captureDraft(
			db,
			{
				recipient: { spaceId: row.spaceId, userId: row.userId },
				...outcome.reading,
				reference: null,
				trust,
				parser: 'ai',
				dedupeKey: await mailDedupeKey({
					parser: 'ai',
					referenceKey: null,
					amountMinor: outcome.reading.amountMinor,
					messageKey: row.messageKey
				})
			},
			{ kind: 'queued', mailId, now }
		);
		return 'read';
	}
	if (outcome.kind === 'not_payment') {
		// Id and date only, like every other non-payment mail.
		await db
			.update(inboundMail)
			.set({
				status: 'not_payment',
				reason: null,
				trust: null,
				parser: null,
				senderDomain: null,
				subject: null,
				pendingText: null,
				updatedAt: now
			})
			.where(queued);
		return 'read';
	}
	// Invalid key, quota, model unavailable: the user fixes it and forwards again.
	return finish(aiReadFailure(outcome, attempts, 'inbound read'));
}
