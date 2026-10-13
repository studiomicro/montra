/**
 * "Lampirkan fotonya saja" (FN-15): the receipt photo /riwayat/struk hands to /riwayat/baru across a client-side
 * navigation, so the user is not asked to pick it again. Page memory only — never stored, gone on a reload —
 * and taken once.
 */
export interface HeldPhoto {
	file: File;
	preview: string | null;
}

let held: HeldPhoto | null = null;

export function holdPhoto(photo: HeldPhoto): void {
	held = photo;
}

export function takeHeldPhoto(): HeldPhoto | null {
	const photo = held;
	held = null;
	return photo;
}
