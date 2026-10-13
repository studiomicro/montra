import { msg } from '#lib/shared/i18n';

/** Server answers of /pengaturan/paket and the mock checkout (translated by the pages with tr()). */
export const BILLING_LOAD_FAILED = msg(
	'Paket dan kredit tidak bisa dimuat. Coba lagi sebentar lagi.'
);

/**
 * Voucher refusals. A code nobody can redeem (malformed, unknown, revoked, expired or used up) gets ONE answer,
 * so a guess never learns that a code exists (red team L2). Refusals about the user's own state stay specific.
 */
export const VOUCHER_INVALID = msg('Kode tidak valid atau sudah tidak berlaku.');
export const VOUCHER_ALREADY_REDEEMED = msg('Kamu sudah pernah menukar voucher ini.');
export const VOUCHER_PLAN_HIGHER = msg(
	'Paketmu sekarang lebih tinggi dari paket voucher ini. Tukar setelah paketmu berakhir.'
);
export const BILLING_THROTTLED = msg('Terlalu banyak percobaan. Coba lagi dalam 10 menit.');

/** Mock checkout (test mode). */
export const PLAN_INVALID = msg('Pilih paket Pro atau Agen.');
export const PLAN_LOWER = msg('Paketmu sekarang lebih tinggi dari paket ini.');
export const CHECKOUT_NOT_FOUND = msg('Pembayaran uji tidak ditemukan atau sudah kedaluwarsa.');
export const CHECKOUT_ALREADY_PAID = msg('Pembayaran uji ini sudah selesai.');
/**
 * The mock payment verified but granted nothing (lower tier or expired checkout): its refund obligation is
 * recorded (billing_refunds) and listed on /pengaturan/paket.
 */
export const CHECKOUT_NOT_APPLIED = msg(
	'Pembayaran uji tercatat tetapi tidak diterapkan ke paketmu. Pengembalian dana dicatat dan bisa kamu lihat di Paket & kredit.'
);
export const CHECKOUT_FAILED = msg('Pembayaran uji tidak bisa diproses. Coba lagi.');
