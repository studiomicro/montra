import { describe, expect, it } from 'vitest';
import { fakeLocks } from '../../../../test/helpers/locks';
import { DRAIN_LOCK, drainLock } from './lock';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('drainLock (task 8)', () => {
	it('with Web Locks, two tabs draining at once: only one proceeds', async () => {
		const locks = fakeLocks();
		const tabA = drainLock(locks);
		const tabB = drainLock(locks);
		let runs = 0;
		const work = async () => {
			runs++;
			await tick();
		};
		const [a, b] = await Promise.all([tabA(work), tabB(work)]);
		expect([a, b].sort()).toEqual([false, true]);
		expect(runs).toBe(1);
		// Released afterwards: the next drain runs.
		expect(await tabB(work)).toBe(true);
		expect(DRAIN_LOCK).toBe('financer-queue-drain');
	});

	it('without Web Locks, a second drain in the same tab is skipped while one runs', async () => {
		const lock = drainLock(undefined);
		let runs = 0;
		const work = async () => {
			runs++;
			await tick();
		};
		const [a, b] = await Promise.all([lock(work), lock(work)]);
		expect([a, b]).toEqual([true, false]);
		expect(runs).toBe(1);
	});

	it('a failing drain still releases the lock', async () => {
		const lock = drainLock(fakeLocks());
		await expect(
			lock(async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await lock(async () => {})).toBe(true);
	});
});
