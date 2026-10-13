import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { baseName, dropDecision, firstFile, pickerMode, type MatchMedia } from './picker-mode';

const media =
	(matching: string[]): MatchMedia =>
	(query) => ({ matches: matching.includes(query) });

describe('pickerMode', () => {
	it('is phone when any pointer is coarse', () => {
		expect(pickerMode(media(['(any-pointer: coarse)']))).toBe('phone');
		expect(pickerMode(media(['(any-pointer: coarse)', '(pointer: fine)']))).toBe('phone');
	});

	it('is desktop for a fine pointer only', () => {
		expect(pickerMode(media(['(pointer: fine)']))).toBe('desktop');
	});

	it('shows both when matchMedia is missing, throws or nothing matches', () => {
		expect(pickerMode(undefined)).toBe('both');
		expect(pickerMode(null)).toBe('both');
		expect(
			pickerMode(() => {
				throw new Error('no media queries');
			})
		).toBe('both');
		expect(pickerMode(media([]))).toBe('both');
	});
});

describe('firstFile', () => {
	const file = (name: string) => new File(['x'], name, { type: 'image/jpeg' });

	it('is null for no files', () => {
		expect(firstFile([])).toBeNull();
		expect(firstFile(null)).toBeNull();
		expect(firstFile(undefined)).toBeNull();
	});

	it('is the one file, or the first of several', () => {
		const one = file('a.jpg');
		expect(firstFile([one])).toBe(one);
		const many = [file('b.jpg'), file('c.jpg'), file('d.jpg')];
		expect(firstFile(many)).toBe(many[0]);
	});
});

describe('baseName', () => {
	it('drops any path', () => {
		expect(baseName('C:\\fakepath\\IMG_2026.jpg')).toBe('IMG_2026.jpg');
		expect(baseName('/home/u/foto.png')).toBe('foto.png');
		expect(baseName('IMG_1.HEIC')).toBe('IMG_1.HEIC');
	});
});

describe('no user-agent sniffing', () => {
	it('the picker and its detection never read navigator.userAgent', () => {
		for (const file of ['picker-mode.ts', 'PhotoPicker.svelte']) {
			const source = readFileSync(new URL(file, import.meta.url), 'utf8');
			expect(source, file).not.toMatch(/userAgent|navigator\.platform|userAgentData/);
		}
	});
});

describe('dropDecision (FN-45 red team 1 and 3)', () => {
	const bytes = (...b: number[]) => Uint8Array.from(b);
	const text = (t: string) => new TextEncoder().encode(t);
	const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0);
	const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	const webp = text('RIFF\0\0\0\0WEBPVP8 ');
	const heic = Uint8Array.from([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0, ...text('mif1heic')]);

	it('takes a JPEG, PNG, WebP or HEIF photo', () => {
		for (const head of [jpeg, png, webp, heic])
			expect(dropDecision({ preparing: false, count: 1, head })).toBe('take');
	});

	it('refuses a PDF, a GIF or text at once, by its bytes', () => {
		for (const head of [text('%PDF-1.7'), text('GIF89a'), text('hello'), new Uint8Array()])
			expect(dropDecision({ preparing: false, count: 1, head })).toBe('not_photo');
	});

	it('ignores a second drop while the first is still being prepared, and an empty drop', () => {
		expect(dropDecision({ preparing: true, count: 1, head: jpeg })).toBe('busy');
		expect(dropDecision({ preparing: false, count: 0, head: null })).toBe('empty');
	});
});
