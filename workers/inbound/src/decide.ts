import { MAX_INBOUND_BYTES } from '#lib/shared/inbound/address';

export { MAX_INBOUND_BYTES };

/** The one answer for an address that is unknown, revoked, or whose owner left its space (no oracle). */
export const UNKNOWN_RECIPIENT = 'Unknown recipient';
export const TOO_LARGE = 'Message too large';

/** Cheapest check first (FN-19 PRD § 4.1): a message over the cap is refused before anything is read. */
export function inboundDecision(
	rawSize: number
): { action: 'reject'; reason: string } | { action: 'read' } {
	if (!Number.isFinite(rawSize) || rawSize > MAX_INBOUND_BYTES)
		return { action: 'reject', reason: TOO_LARGE };
	return { action: 'read' };
}
