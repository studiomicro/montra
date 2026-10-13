import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Toggle from './Toggle.svelte';

const input = (body: string) => body.match(/<input[^>]*>/)?.[0] ?? '';

describe('Toggle', () => {
	it('is a real checkbox with the switch role, labelled by its own <label>', () => {
		const { body } = render(Toggle, { props: { label: 'Kekayaan', name: 'enabled' } });
		const el = input(body);
		expect(el).toMatch(/type="checkbox"/);
		expect(el).toMatch(/role="switch"/);
		expect(el).toMatch(/name="enabled"/);
		const id = el.match(/id="([^"]+)"/)?.[1];
		expect(id).toBeTruthy();
		expect(body).toContain(`<label class="toggle svelte-`);
		expect(body).toMatch(new RegExp(`<label[^>]*for="${id}"`));
		expect(body).toContain('Kekayaan');
	});

	it('renders the checked state server-side, so it is right before (and without) JavaScript', () => {
		expect(input(render(Toggle, { props: { label: 'A', checked: true } }).body)).toMatch(
			/\schecked/
		);
		expect(input(render(Toggle, { props: { label: 'A', checked: false } }).body)).not.toMatch(
			/\schecked/
		);
	});

	it('describes itself with the hint, and is disabled while saving', () => {
		const { body } = render(Toggle, {
			props: { label: 'Koleksi', hint: 'Belum ada menu untuk disembunyikan', disabled: true }
		});
		const el = input(body);
		const described = el.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(body).toMatch(new RegExp(`id="${described}"[^>]*>Belum ada menu untuk disembunyikan`));
		expect(el).toMatch(/\sdisabled/);
	});

	it('has a 44 px touch target', () => {
		const css = readFileSync('src/lib/ui/kit/Toggle.svelte', 'utf8');
		expect(css.match(/\.toggle \{([^}]*)\}/)?.[1]).toMatch(/min-height:\s*44px/);
		expect(css.match(/\.switch \{([^}]*)\}/)?.[1]).toMatch(/height:\s*44px/);
	});
});
