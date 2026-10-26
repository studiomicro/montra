import type { Db } from '#lib/server/db';
import { isAiGatewayConfigured, type AiGatewayEnv } from '#lib/server/ai-keys/anthropic';
import { captureDraft, mailDedupeKey, messageKeyOf } from '#lib/server/inbound/draft';
import {
	claimRateSlot,
	findRecipient,
	hasAnthropicKey,
	recordMail,
	type MailRecord,
	type Recipient
} from '#lib/server/inbound/repo';
import { bytesToHex } from '#lib/server/util';
import {
	inboundDomain,
	MAX_INBOUND_BYTES,
	PENDING_TEXT_MAX,
	recipientLocalPart,
	SENDER_DOMAIN_MAX,
	SUBJECT_MAX
} from '#lib/shared/inbound/address';
import { authenticatedFrom, mailTrust, trustedAuthResults } from '#lib/shared/inbound/auth-results';
import {
	addressDomain,
	gmailConfirmationCode,
	looksLikePayment,
	maskMailLines,
	quotedSenderDomain
} from '#lib/shared/inbound/mail';
import { isAllowlistedSender, parsePaymentMail, parserFor } from '#lib/shared/inbound/parsers';
import type { JobMessage } from '#lib/shared/jobs';
import { cleanText, maskAccountNumbers } from '#lib/shared/text';
import { inboundDecision, TOO_LARGE, UNKNOWN_RECIPIENT } from './decide';
import { parseMail, readCapped, type InboundMail } from './mime';

/**
 * FN-19 forwarding: what happens to one received mail (PRD § 4), cheap checks first and the body read last:
 * size → recipient → hourly budget → read (capped) and parse → Gmail confirmation → authenticity → payment or
 * not → deterministic parser (draft here) → else the AI read through the jobs queue (ids only on the queue).
 * Every outcome is one ledger row; nothing here ever writes a transaction. Log lines carry counts and status
 * codes only: never the address, a sender, a subject, an amount or text.
 */

export interface InboundEnv extends AiGatewayEnv {
	INBOUND_EMAIL_DOMAIN?: string;
	INBOUND_AUTHSERV_ID?: string;
}

export interface InboundDeps {
	db: Db;
	env: InboundEnv;
	enqueue(message: JobMessage): Promise<void>;
	now(): number;
}

/** The parts of Email Routing's ForwardableEmailMessage this Worker uses. */
export interface EmailLike {
	readonly to: string;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	setReject(reason: string): void;
}

export type InboundOutcome =
	| 'rejected'
	| 'dropped'
	| 'malformed'
	| 'confirmation'
	| 'not_payment'
	| 'draft'
	| 'queued'
	| 'unreadable'
	| 'repeat';

/** Processes one parsed mail for `recipient` (already admitted and counted). Unit-testable without a queue. */
async function processInboundMail(
	deps: InboundDeps,
	recipient: Recipient,
	mail: InboundMail
): Promise<InboundOutcome> {
	const { db, env } = deps;
	const receivedAt = deps.now();
	const base = { recipient, messageKey: await messageKeyOf(mail), receivedAt };
	const record = async (r: Omit<MailRecord, 'recipient' | 'messageKey' | 'receivedAt'>) =>
		(await recordMail(db, { ...base, ...r })) !== null;

	const auth = trustedAuthResults(mail.headers, env.INBOUND_AUTHSERV_ID);
	// A Gmail confirmation code is kept only when google.com itself authenticated the mail (DMARC + aligned
	// DKIM); a look-alike is kept like any non-payment mail, id and date only (red team L1).
	const code = gmailConfirmationCode(mail.fromAddress, mail.subject, mail.text);
	if (code) {
		if (!authenticatedFrom(auth, mail.fromAddress))
			return (await record({ status: 'not_payment' })) ? 'not_payment' : 'repeat';
		return (await record({ status: 'confirmation', confirmationCode: code }))
			? 'confirmation'
			: 'repeat';
	}

	const ownMailbox =
		mail.fromAddress !== '' && mail.fromAddress === recipient.ownerEmail.toLowerCase();
	const trust = mailTrust({
		auth,
		fromAddress: mail.fromAddress,
		ownerEmail: recipient.ownerEmail,
		allowlisted: isAllowlistedSender
	});
	const fromDomain = addressDomain(mail.fromAddress);
	// A manual forward: the original sender appears only quoted in the body, used to pick a parser (never as proof).
	const senderDomain = ownMailbox ? (quotedSenderDomain(mail.text) ?? fromDomain) : fromDomain;
	const parser = parserFor(senderDomain);
	if (!looksLikePayment({ allowlisted: parser !== null, subject: mail.subject, text: mail.text }))
		return (await record({ status: 'not_payment' })) ? 'not_payment' : 'repeat';

	const ledger = {
		trust,
		senderDomain: senderDomain ? senderDomain.slice(0, SENDER_DOMAIN_MAX) : null,
		subject: maskAccountNumbers(cleanText(mail.subject, SUBJECT_MAX)) || null
	};
	const payment = parser ? parsePaymentMail(parser, mail.subject, mail.text) : null;
	if (parser && payment) {
		const { referenceKey, ...shown } = payment;
		await captureDraft(
			db,
			{
				recipient,
				...shown,
				trust,
				parser: parser.id,
				dedupeKey: await mailDedupeKey({
					parser: parser.id,
					referenceKey,
					amountMinor: payment.amountMinor,
					messageKey: base.messageKey
				})
			},
			{ kind: 'record', record: { ...base, ...ledger, status: 'draft_created', parser: parser.id } }
		);
		return 'draft';
	}
	const unreadable = async (reason: MailRecord['reason']) =>
		(await record({ ...ledger, status: 'unreadable', reason })) ? 'unreadable' : 'repeat';
	if (mail.text === '') return unreadable('unparsed');
	// No text is kept when it could not be read anyway (owner decision 7): the user forwards it again later.
	if (!isAiGatewayConfigured(env)) return unreadable('ai_unconfigured');
	if (!(await hasAnthropicKey(db, recipient.userId))) return unreadable('no_ai_key');
	const mailId = await recordMail(db, {
		...base,
		...ledger,
		status: 'queued',
		parser: 'ai',
		pendingText: maskMailLines(mail.text).slice(0, PENDING_TEXT_MAX)
	});
	if (mailId === null) return 'repeat';
	try {
		await deps.enqueue({ type: 'inbound_read', mailId });
	} catch {
		// The row stays `queued`; the jobs Worker's hourly sweep enqueues it again.
		console.warn('inbound: enqueue failed', { queued: 1 });
	}
	return 'queued';
}

/** Handles one delivery end to end. Never throws for a malformed message. */
export async function handleEmail(message: EmailLike, deps: InboundDeps): Promise<InboundOutcome> {
	const decision = inboundDecision(message.rawSize);
	if (decision.action === 'reject') {
		message.setReject(decision.reason);
		return 'rejected';
	}
	const local = recipientLocalPart(message.to, inboundDomain(deps.env.INBOUND_EMAIL_DOMAIN));
	const recipient = local ? await findRecipient(deps.db, local) : null;
	if (!recipient) {
		message.setReject(UNKNOWN_RECIPIENT);
		return 'rejected';
	}
	if (!(await claimRateSlot(deps.db, recipient.addressId, deps.now()))) {
		// Silent drop: no bounce, so a flood never turns into backscatter. Counted, never identified.
		console.warn('inbound: over hourly budget', { dropped: 1 });
		return 'dropped';
	}
	const raw = await readCapped(message.raw, MAX_INBOUND_BYTES);
	if (!raw) {
		message.setReject(TOO_LARGE);
		return 'rejected';
	}
	const mail = await parseMail(raw);
	if (!mail) {
		const digest = await crypto.subtle.digest('SHA-256', raw);
		await recordMail(deps.db, {
			recipient,
			messageKey: bytesToHex(digest).slice(0, 32),
			receivedAt: deps.now(),
			status: 'unreadable',
			reason: 'malformed'
		});
		return 'malformed';
	}
	return processInboundMail(deps, recipient, mail);
}
