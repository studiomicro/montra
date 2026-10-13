import { isHeifBytes, sniffImageType } from '#lib/shared/photos';

/**
 * Which actions the photo picker shows (FN-45), decided from pointer media queries only — never the user agent
 * and never `navigator.mediaDevices` (desktop browsers ignore `capture`; a webcam does not make a phone).
 *
 * - `phone`: "Kamera" and "Galeri" (any coarse pointer: phones, tablets, touch laptops).
 * - `desktop`: "Pilih foto" and a drop zone (fine pointers only).
 * - `both`: unsure (no matchMedia, it throws, or nothing matches): "Kamera" and "Galeri" too, so the camera is
 *   never hidden from a phone we failed to recognise.
 */
export type PickerMode = 'phone' | 'desktop' | 'both';

export type MatchMedia = (query: string) => { matches: boolean };

export function pickerMode(matchMedia: MatchMedia | undefined | null): PickerMode {
	if (typeof matchMedia !== 'function') return 'both';
	try {
		if (matchMedia('(any-pointer: coarse)').matches) return 'phone';
		if (matchMedia('(pointer: fine)').matches) return 'desktop';
	} catch {
		return 'both';
	}
	return 'both';
}

/** The one file a pick or drop uses (several photos per item or receipt are not supported). */
export function firstFile(files: ArrayLike<File> | null | undefined): File | null {
	return files && files.length > 0 ? (files[0] ?? null) : null;
}

/** The file's base name for the status line: never a path (some browsers hand over a full path). */
export function baseName(name: string): string {
	return name.split(/[\\/]/).pop() || name;
}

/**
 * What a drop on the picker does (FN-45 red team 1 and 3): nothing while a photo is still being prepared or when
 * nothing was dropped; refused at once when the first file's bytes are not a JPEG, PNG, WebP or HEIF photo (the
 * drop zone has no `accept` of its own); otherwise the first file is taken.
 */
export type DropDecision = 'busy' | 'empty' | 'not_photo' | 'take';

export function dropDecision(input: {
	preparing: boolean;
	count: number;
	head: Uint8Array | null;
}): DropDecision {
	if (input.preparing) return 'busy';
	if (input.count === 0 || !input.head) return 'empty';
	return sniffImageType(input.head) || isHeifBytes(input.head) ? 'take' : 'not_photo';
}
