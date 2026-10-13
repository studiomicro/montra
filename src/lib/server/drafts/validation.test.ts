import { describe, expect, it } from 'vitest';
import { DRAFT_BATCH_MAX } from '#lib/shared/drafts';
import { parseSelection } from './validation';

const form = (values: string[]) => {
	const f = new FormData();
	for (const v of values) f.append('d', v);
	return f;
};
const id = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

describe('parseSelection (bounded, de-duplicated bulk selection)', () => {
	it('reads id:updated_at tokens', () => {
		expect(parseSelection(form([`${id(1)}:42`, `${id(2)}:7`]))).toEqual({
			items: [
				{ id: id(1), updatedAt: 42 },
				{ id: id(2), updatedAt: 7 }
			],
			remaining: 0
		});
	});

	it('processes a draft id posted twice exactly once (the first token wins)', () => {
		const r = parseSelection(form([`${id(1)}:42`, `${id(1)}:42`, `${id(1)}:43`]));
		expect(r.items).toEqual([{ id: id(1), updatedAt: 42 }]);
	});

	it(`cuts the selection to ${DRAFT_BATCH_MAX} and counts the distinct rest`, () => {
		const values = Array.from({ length: 60 }, (_, i) => `${id(i)}:1`);
		const r = parseSelection(form([...values, ...values]));
		expect(r.items).toHaveLength(DRAFT_BATCH_MAX);
		expect(r.items[0]?.id).toBe(id(0));
		expect(r.remaining).toBe(10);
	});

	it('ignores malformed tokens, over-long ids and other fields', () => {
		const f = form([
			'',
			'no-version',
			`${id(1)}:`,
			`${id(1)}:12a`,
			`${'x'.repeat(65)}:1`,
			`${id(1)}:1234567890123456`,
			`a b:1`,
			`${id(3)}:5`
		]);
		f.append('categoryId', 'x');
		expect(parseSelection(f)).toEqual({ items: [{ id: id(3), updatedAt: 5 }], remaining: 0 });
	});

	it('reads at most 200 tokens of a body before any work', () => {
		const values = Array.from({ length: 300 }, (_, i) => `${id(i)}:1`);
		expect(parseSelection(form(values)).remaining).toBe(200 - DRAFT_BATCH_MAX);
	});
});
