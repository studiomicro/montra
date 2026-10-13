import { describe, expect, it } from 'vitest';
import {
	advancesLastCheck,
	CHECK_INTERVAL_MS,
	type CheckTrigger,
	isSkipWaitingMessage,
	MIN_GAP_MS,
	shouldCheckForUpdate,
	offerUpdate,
	SKIP_WAITING,
	skipWaitingOnInstall,
	updateCheckOutcome
} from './sw-update';

describe('skipWaitingOnInstall', () => {
	it('activates a first install at once (no worker active: nothing open to disrupt)', () => {
		expect(skipWaitingOnInstall(false)).toBe(true);
	});
	it('makes an update wait for the person (an older worker is active)', () => {
		expect(skipWaitingOnInstall(true)).toBe(false);
	});
});

describe('isSkipWaitingMessage', () => {
	it('accepts only { type: "SKIP_WAITING" }', () => {
		expect(isSkipWaitingMessage({ type: SKIP_WAITING })).toBe(true);
		for (const data of [
			null,
			undefined,
			SKIP_WAITING,
			{},
			{ type: 'skip_waiting' },
			{ kind: SKIP_WAITING },
			[SKIP_WAITING],
			42
		])
			expect(isSkipWaitingMessage(data), JSON.stringify(data)).toBe(false);
	});
});

describe('offerUpdate', () => {
	it('offers the update once an update has finished installing and waits in this registration', () => {
		expect(offerUpdate({ state: 'installed', isWaiting: true, activeWorkerExists: true })).toBe(
			true
		);
	});

	it('never offers anything for a first install', () => {
		for (const state of ['installing', 'installed', 'activating', 'activated'])
			expect(
				offerUpdate({ state, isWaiting: state === 'installed', activeWorkerExists: false })
			).toBe(false);
	});

	it('not while the update is still installing, nor once it is no longer the waiting worker', () => {
		for (const state of ['parsed', 'installing', 'activating', 'activated', 'redundant'])
			expect(offerUpdate({ state, isWaiting: true, activeWorkerExists: true }), state).toBe(false);
		expect(offerUpdate({ state: 'installed', isWaiting: false, activeWorkerExists: true })).toBe(
			false
		);
	});
});

describe('updateCheckOutcome', () => {
	it('is "latest" when the registration holds nothing new after the check', () => {
		expect(updateCheckOutcome({ installing: false, waiting: false })).toBe('latest');
	});
	it('is "found" when a newer build is downloading or already waiting', () => {
		expect(updateCheckOutcome({ installing: true, waiting: false })).toBe('found');
		expect(updateCheckOutcome({ installing: false, waiting: true })).toBe('found');
	});
});

describe('shouldCheckForUpdate (FN-42b AC7)', () => {
	const NOW = 1_800_000_000_000;
	const ok = {
		now: NOW,
		lastCheckAt: NOW - MIN_GAP_MS,
		inFlight: false,
		visible: true,
		registrationReady: true,
		updateWaiting: false,
		enabled: true
	};
	const triggers: CheckTrigger[] = ['visible', 'online', 'interval'];

	for (const trigger of triggers) {
		it(`the same rules for the "${trigger}" trigger`, () => {
			expect(shouldCheckForUpdate({ ...ok, trigger })).toBe(true);
			expect(shouldCheckForUpdate({ ...ok, trigger, lastCheckAt: null })).toBe(true);
			expect(shouldCheckForUpdate({ ...ok, trigger, enabled: false })).toBe(false);
			expect(shouldCheckForUpdate({ ...ok, trigger, registrationReady: false })).toBe(false);
			expect(shouldCheckForUpdate({ ...ok, trigger, inFlight: true })).toBe(false);
			expect(shouldCheckForUpdate({ ...ok, trigger, updateWaiting: true })).toBe(false);
			expect(shouldCheckForUpdate({ ...ok, trigger, visible: false })).toBe(false);
			expect(shouldCheckForUpdate({ ...ok, trigger, lastCheckAt: NOW - (MIN_GAP_MS - 1) })).toBe(
				false
			);
			// Never-checked still obeys the other rules.
			expect(shouldCheckForUpdate({ ...ok, trigger, lastCheckAt: null, visible: false })).toBe(
				false
			);
		});
	}
});

describe('advancesLastCheck and the cadence (FN-42b AC8)', () => {
	it('a failed check does not count; found and latest do', () => {
		expect(advancesLastCheck('failed')).toBe(false);
		expect(advancesLastCheck('found')).toBe(true);
		expect(advancesLastCheck('latest')).toBe(true);
	});

	it('checks every 30 to 60 minutes, with a smaller minimum gap', () => {
		expect(CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(30 * 60_000);
		expect(CHECK_INTERVAL_MS).toBeLessThanOrEqual(60 * 60_000);
		expect(MIN_GAP_MS).toBeLessThan(CHECK_INTERVAL_MS);
		expect(MIN_GAP_MS).toBe(10 * 60_000);
	});
});
