import type { Component } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '#lib/shared/i18n';
import I18nHarness from '../../../../test/helpers/I18nHarness.svelte';
import PhotoField from './PhotoField.svelte';
import PhotoPicker from './PhotoPicker.svelte';

const renderWith = (component: unknown, props: Record<string, unknown>) =>
	render(I18nHarness, {
		props: { component: component as Component<Record<string, unknown>>, props }
	}).body;

const fileInputs = (body: string) => body.match(/<input[^>]*type="file"[^>]*>/g) ?? [];

describe('PhotoPicker without JavaScript (server render)', () => {
	it('is exactly one plain file input with the field name, accept, id, label and hint', () => {
		const body = renderWith(PhotoPicker, {
			id: 'x-photo',
			name: 'photo',
			label: 'Pilih atau ambil foto struk',
			describedby: 'x-photo-hint'
		});
		const inputs = fileInputs(body);
		expect(inputs).toHaveLength(1);
		const input = inputs[0]!;
		expect(input).toContain('name="photo"');
		expect(input).toContain('accept="image/jpeg,image/png,image/webp"');
		expect(input).toContain('id="x-photo"');
		expect(input).toContain('aria-describedby="x-photo-hint"');
		expect(input).not.toContain('capture');
		expect(input).not.toContain('multiple');
		expect(input).not.toContain('required');
		expect(input).not.toContain('tabindex');
		expect(body).toMatch(/<label[^>]*for="x-photo"[^>]*>Pilih atau ambil foto struk<\/label>/);
		// The camera/gallery actions and the drop zone only appear after hydration.
		expect(body).not.toContain('<button');
		expect(body).not.toContain('<fieldset');
	});

	it('marks the input required when asked', () => {
		const [input] = fileInputs(
			renderWith(PhotoPicker, { id: 'r', label: 'Foto struk', required: true })
		);
		expect(input).toContain('required');
		expect(input).toContain('name="photo"');
	});

	it('keeps the item form field: one input named photo, its label, hint and error', () => {
		const body = renderWith(PhotoField, {
			id: 'item-photo',
			hasPhoto: true,
			serverError: 'Foto harus berupa JPEG, PNG atau WebP.'
		});
		const inputs = fileInputs(body);
		expect(inputs).toHaveLength(1);
		expect(inputs[0]).toContain('name="photo"');
		expect(inputs[0]).toContain('aria-invalid="true"');
		expect(inputs[0]).toContain('aria-describedby="item-photo-hint item-photo-error"');
		expect(body).toMatch(/<label[^>]*for="item-photo"[^>]*>Ganti foto<\/label>/);
		expect(body).toContain('name="removePhoto"');
	});
});

describe('PhotoPicker labels', () => {
	it('has English for the camera and gallery actions', () => {
		const { tr } = createTranslator('en');
		expect(tr('Kamera')).toBe('Camera');
		expect(tr('Galeri')).toBe('Gallery');
		expect(tr('Pilih foto')).toBe('Choose photo');
	});
});
