import { describe, expect, it } from 'vitest';
import {
	agentForm,
	agentRange,
	AGENT_STEPS,
	isAgentPeriod,
	isPartialPeriod,
	stepsOf
} from './agent';

describe('Agen periods (FN-23 owner decision 10, criterion 4)', () => {
	const today = '2026-10-10';

	it('accepts past and current months and years, never the future or more than 10 years back', () => {
		expect(isAgentPeriod('monthly', '2026-10', today)).toBe(true);
		expect(isAgentPeriod('monthly', '2026-09', today)).toBe(true);
		expect(isAgentPeriod('monthly', '2016-01', today)).toBe(true);
		expect(isAgentPeriod('monthly', '2015-12', today)).toBe(false);
		expect(isAgentPeriod('monthly', '2026-11', today)).toBe(false);
		expect(isAgentPeriod('monthly', '2026-13', today)).toBe(false);
		expect(isAgentPeriod('monthly', '2026', today)).toBe(false);
		expect(isAgentPeriod('annual', '2026', today)).toBe(true);
		expect(isAgentPeriod('annual', '2016', today)).toBe(true);
		expect(isAgentPeriod('annual', '2015', today)).toBe(false);
		expect(isAgentPeriod('spt_assets', '2027', today)).toBe(false);
		expect(isAgentPeriod('spt_assets', '2026-01', today)).toBe(false);
		expect(isAgentPeriod('annual', ' 2025', today)).toBe(false);
	});

	it('cuts the current period at today and keeps a past one whole (leap year included)', () => {
		expect(agentRange('monthly', '2026-10', today)).toEqual({ from: '2026-10-01', to: today });
		expect(agentRange('monthly', '2024-02', today)).toEqual({
			from: '2024-02-01',
			to: '2024-02-29'
		});
		expect(agentRange('annual', '2024', today)).toEqual({ from: '2024-01-01', to: '2024-12-31' });
		expect(agentRange('annual', '2026', today)).toEqual({ from: '2026-01-01', to: today });
		expect(isPartialPeriod('spt_assets', '2026', today)).toBe(true);
		expect(isPartialPeriod('spt_assets', '2025', today)).toBe(false);
	});

	it('has five steps for monthly and annual, four for the asset list (no narrative)', () => {
		expect(stepsOf('monthly')).toEqual(['read', 'group', 'summary', 'narrate', 'render']);
		expect(stepsOf('spt_assets')).toEqual(['read', 'balances', 'assets', 'render']);
		expect(AGENT_STEPS.spt_assets).not.toContain('narrate');
	});

	it('the form schema knows only its own fields and enum values', () => {
		const ok = {
			type: 'monthly',
			period: '2026-10',
			narrative: true,
			requestId: '0f8e4a52-6f43-4d61-9a1b-6c1f9d0c2b11'
		};
		expect(agentForm.safeParse(ok).success).toBe(true);
		expect(agentForm.safeParse({ ...ok, type: 'weekly' }).success).toBe(false);
		expect(agentForm.safeParse({ ...ok, requestId: 'x' }).success).toBe(false);
		const extra = agentForm.parse({ ...ok, spaceId: 's', userId: 'u', status: 'ready' });
		expect(Object.keys(extra).sort()).toEqual(['narrative', 'period', 'requestId', 'type']);
	});
});
