import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { BRANDS, institutionOption } from '#lib/shared/brands';
import CataloguePicker from '#lib/ui/subscriptions/CataloguePicker.svelte';
import Harness from '../../../../test/helpers/I18nHarness.svelte';
import BrandBadge from './BrandBadge.svelte';
import BrandBadgeById from './BrandBadgeById.svelte';
import Chip from './Chip.svelte';
import InitialsTile from './InitialsTile.svelte';
import PickerSheet from './PickerSheet.svelte';

const clean = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

describe('BrandBadge (FN-43)', () => {
	it('a name that names a service shows its monogram, decorative, with no image', () => {
		const html = clean(render(BrandBadge, { props: { name: 'Tabungan BCA', round: true } }).body);
		expect(html).toMatch(
			/<span class="tile s40 b-bca[^"]*round[^"]*" aria-hidden="true">BCA<\/span>/
		);
		expect(html).not.toMatch(/<img|<svg|url\(|style=/);
	});

	it('every registry entry renders as text only at every size', () => {
		for (const { id, badgeText } of BRANDS)
			for (const size of [36, 40, 44] as const) {
				const html = clean(render(BrandBadgeById, { props: { id, size } }).body);
				expect(html).toContain(`s${size} b-${id}`);
				expect(html).toContain(`aria-hidden="true">${badgeText}</span>`);
				expect(html).not.toMatch(/<img|<svg|url\(|style=/);
			}
	});

	it('an unmatched name renders exactly the InitialsTile it had before', () => {
		for (const name of ['Dompet harian', 'Netflix', 'Dana darurat'])
			for (const size of [36, 40, 44] as const) {
				const before = render(InitialsTile, { props: { name, size, round: true } }).body;
				const after = render(BrandBadge, { props: { name, size, round: true } }).body;
				expect(clean(after)).toBe(clean(before));
			}
	});

	it('an unknown id renders nothing', () => {
		expect(clean(render(BrandBadgeById, { props: { id: 'bank-x' } }).body).trim()).toBe('');
	});

	it('the chip size shows only the first character', () => {
		const html = clean(render(BrandBadgeById, { props: { id: 'gopay', size: 24 } }).body);
		expect(html).toMatch(/class="tile s24 b-gopay[^"]*" aria-hidden="true">G<\/span>/);
	});
});

describe('Chip brand badge', () => {
	const children = (() => {}) as never;

	it('draws the badge before the label, keeping the chip a link', () => {
		const html = clean(
			render(Chip, { props: { href: '/dompet?tambah=1&dompet=ovo', brand: 'ovo', children } }).body
		);
		expect(html).toMatch(
			/<a class="chip [^"]*branded[^"]*" href="\/dompet\?tambah=1&amp;dompet=ovo"/
		);
		expect(html).toMatch(/b-ovo[^"]*" aria-hidden="true">O<\/span>/);
	});

	it('a chip without a brand is unchanged', () => {
		const html = clean(render(Chip, { props: { selected: true, children } }).body);
		expect(html).not.toContain('branded');
		expect(html).not.toContain('class="tile');
	});
});

function inLocale(component: unknown, props: Record<string, unknown>): string {
	return clean(
		render(Harness, {
			props: { component: component as Component<Record<string, unknown>>, locale: 'id', props }
		}).body
	);
}

describe('where badges show', () => {
	it('the Impor institution picker draws a parser’s badge next to its unchanged label', () => {
		const options = [
			{ value: '', label: 'Deteksi otomatis' },
			...[
				{ id: 'bca', label: 'BCA' },
				{ id: 'bni', label: 'BNI' }
			].map(institutionOption)
		];
		const html = inLocale(PickerSheet, {
			open: true,
			title: 'Pilih institusi',
			options,
			value: ''
		});
		for (const key of ['bca', 'bni']) {
			expect(html).toMatch(
				new RegExp(`b-${key}[^"]*" aria-hidden="true">${key.toUpperCase()}</span>`)
			);
			expect(html).toMatch(new RegExp(`<span class="title[^"]*">${key.toUpperCase()}</span>`));
		}
		expect([...html.matchAll(/class="tile /g)]).toHaveLength(2);
	});

	it('the Langganan catalogue badges GoPay Plus, GoFood Plus and GrabUnlimited; Netflix keeps its initials', () => {
		const html = inLocale(CataloguePicker, {});
		expect(html).toMatch(
			/b-gopay[^"]*" aria-hidden="true">GoPay<\/span>\s*<span class="name[^"]*">GoPay Plus<\/span>/
		);
		expect(html).toContain('b-gofood');
		expect(html).toContain('b-grab');
		expect(html).toMatch(/aria-hidden="true">NE<\/span>\s*<span class="name[^"]*">Netflix<\/span>/);
		expect([...html.matchAll(/ b-[a-z]+ /g)]).toHaveLength(3);
	});
});
