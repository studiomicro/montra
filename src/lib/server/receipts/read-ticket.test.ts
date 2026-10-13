import { describe, expect, it } from 'vitest';
import { checkReadTicket, issueReadTicket, READ_TICKET_TTL_MS } from './read-ticket';

const key = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const env = { AI_KEYS_ENCRYPTION_KEY: key() };
const binding = { userId: 'u1', spaceId: 's1', keyPrefix: 'receipt:aa:' };
const NOW = 1_791_500_000_000;

describe('receipt read ticket (FN-15 red team L3)', () => {
	it('opens for the same user, space and photo until it expires', async () => {
		const ticket = (await issueReadTicket(env, binding, NOW))!;
		expect(ticket).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
		expect(await checkReadTicket(env, ticket, binding, NOW + READ_TICKET_TTL_MS - 1)).toBe(true);
		expect(await checkReadTicket(env, ticket, binding, NOW + READ_TICKET_TTL_MS)).toBe(false);
	});

	it('never opens for another user, space or photo', async () => {
		const ticket = (await issueReadTicket(env, binding, NOW))!;
		for (const other of [
			{ ...binding, userId: 'u2' },
			{ ...binding, spaceId: 's2' },
			{ ...binding, keyPrefix: 'receipt:bb:' }
		])
			expect(await checkReadTicket(env, ticket, other, NOW)).toBe(false);
	});

	it('refuses an empty, malformed, tampered or over-long ticket', async () => {
		const ticket = (await issueReadTicket(env, binding, NOW))!;
		const [id, nonce, ct] = ticket.split('.') as [string, string, string];
		const flipped = `${id}.${nonce}.${ct.slice(0, -2)}${ct.endsWith('AA') ? 'AB' : 'AA'}`;
		for (const bad of ['', 'x', `${id}.${nonce}`, flipped, `${ticket}.x`, 'a'.repeat(300)])
			expect(await checkReadTicket(env, bad, binding, NOW)).toBe(false);
	});

	it('is not issued without a configured secret, and survives a rotation through _PREVIOUS', async () => {
		expect(await issueReadTicket({}, binding, NOW)).toBeNull();
		const ticket = (await issueReadTicket(env, binding, NOW))!;
		const rotated = {
			AI_KEYS_ENCRYPTION_KEY: key(),
			AI_KEYS_ENCRYPTION_KEY_PREVIOUS: env.AI_KEYS_ENCRYPTION_KEY
		};
		expect(await checkReadTicket(rotated, ticket, binding, NOW)).toBe(true);
		expect(await checkReadTicket({ AI_KEYS_ENCRYPTION_KEY: key() }, ticket, binding, NOW)).toBe(
			false
		);
	});
});
