import { overUserAttemptLimit } from '../auth/throttle';
import type { Db } from '../db';

/**
 * Transaction-creating actions one user may send per budget window (THROTTLE_WINDOW_MS, 10 minutes), across
 * every space (FN-05 red team L2): the "Tambah" form and a balance adjustment, a voice save (one per "Simpan N
 * transaksi", however many rows) and "Catat lagi", a CSV import (one per import, not per row) and the offline
 * queue's creates. Generous: a full offline queue (200 items) drains within one window with room to spare; a
 * script flooding a space is stopped long before the 100.000-row space cap. Rows the jobs Worker writes
 * (recurring series, subscriptions) and saved capture drafts do not count.
 */
export const TRANSACTION_CREATES_MAX = 300;

/** Counts one creating action of `userId`; true when it is over TRANSACTION_CREATES_MAX (fails closed). */
export const overTransactionCreateLimit = (db: Db, userId: string, now: number) =>
	overUserAttemptLimit(db, userId, now, 'transaction-create', TRANSACTION_CREATES_MAX);
