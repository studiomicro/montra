import type { Page } from '@playwright/test';
import * as devalue from 'devalue';
import { sanitizeImage } from '../src/lib/server/photos/image';
import { receiptKeyPrefix } from '../src/lib/server/receipts/dedupe';
import { issueReadTicket } from '../src/lib/server/receipts/read-ticket';
import { E2E_AI_KEYS_KEY } from './helpers';

/**
 * FN-15 red team L3: `save` tags rows `receipt` only with the ticket a real `read` issues. The e2e server cannot
 * read (no AI Gateway), so a journey that mocks `read` at the browser mints the ticket the server would have
 * issued: the e2e server's fixed sealing key, the signed-in user and space (the (app) layout's FN-02 `queue`
 * data) and the dedupe-key prefix of the photo exactly as the server sanitises it.
 */

/** The signed-in user and current space, from the (app) layout data of `path`. */
export async function scopeOf(page: Page, path = '/riwayat/struk') {
	const res = await page.request.get(`${path}/__data.json`);
	const json = (await res.json()) as { nodes: ({ type: string; data: unknown[] } | null)[] };
	for (const node of json.nodes) {
		if (node?.type !== 'data') continue;
		const data = devalue.unflatten(node.data) as { queue?: { accountId: string; spaceId: string } };
		if (data.queue?.spaceId) return { userId: data.queue.accountId, spaceId: data.queue.spaceId };
	}
	throw new Error('no (app) layout queue data');
}

/** The ticket a real `read` of `photo` (the bytes as posted) would hand this user in this space. */
export async function readTicketFor(scope: { userId: string; spaceId: string }, photo: Uint8Array) {
	const image = sanitizeImage(photo);
	if (!image.ok) throw new Error(`photo refused: ${image.reason}`);
	const keyPrefix = await receiptKeyPrefix(image.bytes);
	const ticket = await issueReadTicket(
		{ AI_KEYS_ENCRYPTION_KEY: E2E_AI_KEYS_KEY },
		{ ...scope, keyPrefix },
		Date.now()
	);
	if (!ticket) throw new Error('no ticket');
	return ticket;
}
