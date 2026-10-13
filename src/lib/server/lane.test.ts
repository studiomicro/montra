import { describe, expect, it } from 'vitest';
import { createUserLane } from './lane';

describe('createUserLane', () => {
	it('holds one place per user and at most `max` places', () => {
		const reserve = createUserLane(2);
		const a = reserve('a');
		expect(a).not.toBeNull();
		expect(reserve('a')).toBeNull();
		const b = reserve('b');
		expect(b).not.toBeNull();
		expect(reserve('c')).toBeNull();
		a!();
		expect(reserve('c')).not.toBeNull();
	});

	it('a second release does not free another user’s place', () => {
		const reserve = createUserLane(1);
		const first = reserve('a')!;
		first();
		const second = reserve('a')!;
		first();
		expect(reserve('a')).toBeNull();
		second();
		expect(reserve('a')).not.toBeNull();
	});

	it('separate lanes never share places', () => {
		const one = createUserLane(1);
		const two = createUserLane(1);
		expect(one('a')).not.toBeNull();
		expect(two('a')).not.toBeNull();
	});
});
