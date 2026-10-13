import { describe, expect, it } from 'vitest';
import { inboundDecision, MAX_INBOUND_BYTES } from './decide';

describe('inboundDecision', () => {
	it('caps a message at 1 MiB (owner decision 4)', () => {
		expect(MAX_INBOUND_BYTES).toBe(1024 * 1024);
	});
	it('rejects messages over the cap with a reason', () => {
		expect(inboundDecision(MAX_INBOUND_BYTES + 1)).toEqual({
			action: 'reject',
			reason: 'Message too large'
		});
		expect(inboundDecision(Number.NaN).action).toBe('reject');
	});
	it('reads messages at or under the cap', () => {
		expect(inboundDecision(MAX_INBOUND_BYTES)).toEqual({ action: 'read' });
		expect(inboundDecision(0)).toEqual({ action: 'read' });
	});
});
