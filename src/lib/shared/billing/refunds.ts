import { msg } from '../i18n.ts';

/** Why a verified payment granted nothing (FN-30 hardening). `unknown`: backfilled by migration 0031 only. */
export const REFUND_REASONS = ['checkout_expired', 'plan_higher', 'unknown'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
/** A refund obligation: `pending` until closed once, as `refunded` or `cancelled`. */
export const REFUND_STATUSES = ['pending', 'refunded', 'cancelled'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Operator-facing reason labels (/pengaturan/integrasi/admin). */
export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
	checkout_expired: msg('Checkout kedaluwarsa'),
	plan_higher: msg('Paket lebih tinggi aktif'),
	unknown: msg('Tidak diketahui')
};

/** User-facing status labels (/pengaturan/paket). */
export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
	pending: msg('Menunggu diproses'),
	refunded: msg('Sudah dikembalikan'),
	cancelled: msg('Dibatalkan')
};
