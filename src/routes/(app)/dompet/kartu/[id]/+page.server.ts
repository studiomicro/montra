import { error } from '@sveltejs/kit';
import { listCardStatements } from '#lib/server/cards/statements';
import { cardSummaries } from '#lib/server/cards/summary';
import { CARD_LOAD_FAILED } from '#lib/server/cards/messages';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { safeMinor } from '#lib/server/transactions/aggregate';
import { readWalletBalance } from '#lib/server/transactions/wallet-sum';
import { errorLabel } from '#lib/server/util';
import { getWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import type { PageServerLoad } from './$types';
import { boundedId } from '#lib/server/forms';

// FN-55a card page: one live `kartu_kredit` wallet of the session's current space (locals.space, re-validated through
// requireSpaceAccess with locals.user). The wallet is looked up with `space_id` and `deleted_at is null` in the same
// query, so another space's id, an archived card, a non-card wallet and a malformed id all get the same 404 after
// the same single lookup. Read-only: "Bayar tagihan" is FN-05's transfer form, nothing is written here.

export const load: PageServerLoad = async ({ locals, params }) => {
	const { spaceId } = await currentSpaceScope(locals);
	const id = boundedId(params.id);
	const wallet = await getWallet(locals.db, spaceId, id);
	if (!wallet || wallet.type !== 'kartu_kredit') error(404, 'Not found');
	const card = {
		id: wallet.id,
		name: wallet.name,
		lastFour: wallet.lastFour,
		currency: wallet.currency,
		creditLimitMinor: wallet.creditLimitMinor,
		statementDay: wallet.statementDay,
		dueDay: wallet.dueDay
	};
	try {
		const today = wibTodayString();
		const [balance, statements] = await Promise.all([
			readWalletBalance(locals.db, spaceId, wallet.id),
			listCardStatements(locals.db, spaceId, wallet.id)
		]);
		const balanceMinor = balance === null ? null : safeMinor(balance);
		const [summary] = await cardSummaries(locals.db, spaceId, [{ ...card, balanceMinor }], today);
		return { card, balanceMinor, summary: summary ?? null, statements, today, loadError: null };
	} catch (e) {
		console.error('dompet/kartu: load failed', errorLabel(e));
		return {
			card,
			balanceMinor: null,
			summary: null,
			statements: [],
			today: wibTodayString(),
			loadError: CARD_LOAD_FAILED
		};
	}
};
