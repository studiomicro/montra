import { describe, expect, it } from 'vitest';
import { bytes, jpeg, png } from '../../../../test/helpers/images';
import { PHOTO_HEIF, PHOTO_NOT_IMAGE } from './messages';
import { readPhotoField } from './upload';

/**
 * FN-45 follow-ups L1/L2: whatever the picker sends (a multi-file drop that failed to assign posts N `photo`
 * parts; a dropped PDF is assigned without a client check), the server reads only the first part and accepts
 * only what the bytes say is a JPEG, PNG or WebP. The browser-given name and type are never trusted.
 */
const part = (data: Uint8Array, name: string, type: string) =>
	new File([data as BlobPart], name, { type });

describe('readPhotoField: one file, sniffed type', () => {
	it('uses the first photo part and ignores the rest', async () => {
		const form = new FormData();
		const first = jpeg();
		form.append('photo', part(first, 'a.jpg', 'image/jpeg'));
		form.append('photo', part(bytes('%PDF-1.7'), 'b.pdf', 'application/pdf'));
		form.append('photo', part(png(), 'c.png', 'image/png'));
		const field = await readPhotoField(form);
		expect(field.kind).toBe('image');
		if (field.kind === 'image') expect(field.image.type).toBe('image/jpeg');
	});

	it('does not fall through to a later valid image when the first part is refused', async () => {
		const form = new FormData();
		form.append('photo', part(bytes('%PDF-1.7'), 'a.pdf', 'application/pdf'));
		form.append('photo', part(jpeg(), 'b.jpg', 'image/jpeg'));
		expect(await readPhotoField(form)).toEqual({ kind: 'refused', message: PHOTO_NOT_IMAGE });
	});

	it('refuses PDF, GIF, SVG and text by their bytes, whatever name and type they claim', async () => {
		for (const text of [
			'%PDF-1.7',
			'GIF89a\x01\x00\x01\x00',
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
			'just some text'
		]) {
			const form = new FormData();
			form.append('photo', part(bytes(text), 'struk.jpg', 'image/jpeg'));
			expect(await readPhotoField(form)).toEqual({ kind: 'refused', message: PHOTO_NOT_IMAGE });
		}
	});

	it('refuses a HEIC with the how-to-fix message', async () => {
		const form = new FormData();
		form.append(
			'photo',
			part(bytes('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), 'IMG.heic', 'image/heic')
		);
		expect(await readPhotoField(form)).toEqual({ kind: 'refused', message: PHOTO_HEIF });
	});
});
