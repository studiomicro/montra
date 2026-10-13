import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PickerSheetHost from '../../../../test/fixtures/PickerSheetHost.svelte';
import type { PickerOption } from './picker';

/** The `<button>` tags of the rendered sheet, by the label they hold. */
function rows(body: string) {
	return [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
		.filter((m) => m[1]?.includes('role="radio"'))
		.map((m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }));
}

function sheet(options: PickerOption<string>[], value: string | null) {
	return render(PickerSheetHost, { props: { options, value } }).body;
}

describe('PickerSheet', () => {
	it('an enabled-only picker is unchanged: every row a clickable, focusable radio (Dompet, Kategori, …)', () => {
		const body = sheet(
			[
				{ value: 'a', label: 'BCA', brand: 'bca' },
				{ value: 'b', label: 'Tunai', hint: 'Favorit' }
			],
			'a'
		);
		const list = rows(body);
		expect(list).toHaveLength(2);
		for (const row of list) {
			expect(row.attrs).not.toMatch(/\sdisabled/);
			expect(row.attrs).not.toContain('aria-disabled');
			expect(row.attrs).not.toContain('tabindex');
			expect(row.inner).toContain('class="radio');
		}
		expect(list[0]?.attrs).toContain('aria-checked="true"');
		expect(list[1]?.attrs).toContain('aria-checked="false"');
		expect(body).toContain('role="radiogroup"');
	});

	it('a disabled row shows its hint but is disabled, out of the tab order and never checked', () => {
		const body = sheet(
			[
				{ value: '', label: 'Deteksi otomatis' },
				{ value: 'bri', label: 'BRI', brand: 'bri', hint: 'pakai Foto', disabled: true }
			],
			'bri'
		);
		const [auto, bri] = rows(body);
		expect(auto?.attrs).not.toMatch(/\sdisabled/);
		expect(bri?.attrs).toMatch(/\sdisabled/);
		expect(bri?.attrs).toContain('aria-disabled="true"');
		expect(bri?.attrs).toContain('tabindex="-1"');
		// Even when the value names it, a disabled row is never shown as the choice.
		expect(bri?.attrs).toContain('aria-checked="false"');
		expect(bri?.inner).toContain('pakai Foto');
		expect(bri?.inner).not.toContain('class="radio');
	});

	it('a disabled row with a link is still a disabled button, never a live link (red team L1)', () => {
		const body = sheet(
			[
				{ value: 'a', label: 'A', href: '/a' },
				{ value: 'b', label: 'B', href: '/b', disabled: true }
			],
			'a'
		);
		expect(body).toContain('href="/a"');
		expect(body).not.toContain('href="/b"');
	});
});
