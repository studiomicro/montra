import { msg } from '#lib/shared/i18n';

/** Answers of a photo upload (FN-27; reused by FN-28), translated by the page with tr(). */
export const PHOTO_TOO_LARGE = msg('Foto terlalu besar. Paling besar 8 MB.');
export const PHOTO_NOT_IMAGE = msg('Foto harus berupa JPEG, PNG atau WebP.');
export const PHOTO_UNREADABLE = msg('Foto tidak bisa dibaca. Coba foto lain.');
export const PHOTO_DIMENSIONS = msg(
	'Ukuran foto terlalu besar. Paling besar 10.000 piksel per sisi.'
);
export const PHOTO_UPLOAD_FAILED = msg('Foto tidak bisa diunggah. Coba lagi sebentar lagi.');
/** A HEIC/HEIF file (FN-45 Owner decision 2): still refused, with how to fix it. */
export const PHOTO_HEIF = msg(
	'Foto HEIC/HEIF belum bisa dipakai. Ubah format kamera ke JPEG (Android: Kamera › Setelan › Format gambar; iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu pilih lagi.'
);
