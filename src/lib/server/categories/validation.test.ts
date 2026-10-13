import { describe, expect, it } from 'vitest';
import { CATEGORY_KIND_INVALID, CATEGORY_NAME_REQUIRED, CATEGORY_TILE_INVALID } from './messages';
import { parseCategoryCreateForm, parseCategoryEditForm } from './validation';

function form(fields: Record<string, string>): FormData {
	const f = new FormData();
	for (const [k, v] of Object.entries({
		name: 'Ngopi',
		tileKey: 'kopi',
		kind: 'expense',
		...fields
	}))
		f.set(k, v);
	return f;
}

describe('category forms', () => {
	it('reads a new category', () => {
		expect(parseCategoryCreateForm(form({}))).toEqual({
			ok: true,
			value: { name: 'Ngopi', tileKey: 'kopi', kind: 'expense' }
		});
	});

	it('strips control and zero-width characters, caps at 40 and refuses an empty result', () => {
		expect(parseCategoryCreateForm(form({ name: ' Ng​opi\u0007 ' }))).toMatchObject({
			ok: true,
			value: { name: 'Ngopi' }
		});
		expect(parseCategoryEditForm(form({ name: 'x'.repeat(100) }))).toMatchObject({
			ok: true,
			value: { name: 'x'.repeat(40) }
		});
		for (const name of ['', '   ', '​‍\u0000'])
			expect(parseCategoryEditForm(form({ name }))).toMatchObject({
				ok: false,
				errors: { name: CATEGORY_NAME_REQUIRED }
			});
	});

	it('accepts only the 17 tile slots and the two kinds', () => {
		for (const tileKey of ['', 'pizza', '__proto__', 'Kopi', 'ojek', 'gofood'])
			expect(parseCategoryEditForm(form({ tileKey }))).toMatchObject({
				ok: false,
				errors: { tileKey: CATEGORY_TILE_INVALID }
			});
		for (const tileKey of ['ojek-online', 'pesan-antar-makanan'])
			expect(parseCategoryEditForm(form({ tileKey }))).toMatchObject({
				ok: true,
				value: { tileKey }
			});
		for (const kind of ['transfer', '', 'constructor'])
			expect(parseCategoryCreateForm(form({ kind }))).toMatchObject({
				ok: false,
				errors: { kind: CATEGORY_KIND_INVALID }
			});
	});

	it('an edit never reads a kind (it cannot change)', () => {
		expect(parseCategoryEditForm(form({ kind: 'income' }))).toEqual({
			ok: true,
			value: { name: 'Ngopi', tileKey: 'kopi' }
		});
	});
});
