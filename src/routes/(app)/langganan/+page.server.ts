import { error, fail, redirect } from '@sveltejs/kit';
import { ensurePresetCategories, getCategory, listCategories } from '#lib/server/categories/repo';
import { readFormBody } from '#lib/server/forms';
import { requireSpaceAccess, type SpaceScope } from '#lib/server/spaces/access';
import { dismissCandidate, findCandidates } from '#lib/server/subscriptions/detect';
import {
	CANDIDATE_NOT_FOUND,
	DEMO_NOT_PAYABLE,
	SUBSCRIPTION_CHANGED,
	SUBSCRIPTION_LIMIT,
	SUBSCRIPTION_NOT_FOUND,
	SUBSCRIPTIONS_LOAD_FAILED,
	PAY_TRANSACTION_NOT_FOUND,
	WALLET_INVALID
} from '#lib/server/subscriptions/messages';
import {
	createSubscription,
	deleteSubscription,
	getSubscription,
	listPayableExpenses,
	listSubscriptions,
	markPaidWithExisting,
	markPaidWithNew,
	updateSubscription,
	type SubscriptionWriteResult
} from '#lib/server/subscriptions/repo';
import {
	expectedUpdatedAt,
	ID_MAX_LENGTH,
	idField,
	parsePayForm,
	parseSubscriptionForm
} from '#lib/server/subscriptions/validation';
import { REFS_GONE, TRANSACTION_LIMIT } from '#lib/server/transactions/messages';
import { capturedTransactionInput } from '#lib/server/transactions/validation';
import { listWallets, getWallet } from '#lib/server/wallets/repo';
import { wibTodayString } from '#lib/shared/dates';
import { monthlyTotals } from '#lib/shared/subscriptions';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

// FN-26 Langganan. The page works on the session's current space (locals.space); every load and action passes
// it through requireSpaceAccess with locals.user, so there is one access rule. Ids from a form are only looked
// up inside that space: another space's id and an unknown id get the same 404.

async function scopeOf(locals: App.Locals): Promise<SpaceScope> {
	const user = locals.user;
	if (!user) redirect(303, '/masuk');
	if (!locals.space) error(404, 'Not found');
	const access = await requireSpaceAccess(locals.db, user.id, locals.space.id);
	return { spaceId: access.space.id, userId: user.id };
}

const queryId = (url: URL, name: string) =>
	url.searchParams.get(name)?.slice(0, ID_MAX_LENGTH) ?? null;

export const load: PageServerLoad = async ({ locals, url }) => {
	const scope = await scopeOf(locals);
	const db = locals.db;
	const today = wibTodayString();
	// Without JavaScript: `?tambah=1` (picker), `?tambah=<catalogue id>` / `?tambah=lainnya` (the form),
	// `?ubah=<id>` (edit) and `?bayar=<id>` (mark paid) render inline; with it the same links open a sheet.
	const open = {
		add: queryId(url, 'tambah'),
		edit: queryId(url, 'ubah'),
		pay: queryId(url, 'bayar'),
		// FN-26b: `?periksa=1` (the candidate list) and `?kandidat=<match key>` (the add form filled from one).
		check: url.searchParams.get('periksa') === '1',
		fromCheck: queryId(url, 'kandidat')
	};
	try {
		await ensurePresetCategories(db, scope.spaceId);
		const [subscriptions, wallets, categories, expenses, candidates] = await Promise.all([
			listSubscriptions(db, scope.spaceId, today),
			listWallets(db, scope.spaceId),
			listCategories(db, scope.spaceId),
			listPayableExpenses(db, scope.spaceId),
			// FN-26b: the subscription check runs with every load (bounded), so its button needs no round trip.
			findCandidates(db, scope.spaceId, today)
		]);
		return {
			today,
			subscriptions,
			// `Data demo` rows are listed (badged) but never counted.
			totals: monthlyTotals(
				subscriptions
					.filter((s) => !s.isDemo)
					.map((s) => ({
						amountMinor: s.amountMinor,
						currency: s.currency,
						cycle: s.schedule.cycle
					}))
			),
			wallets: wallets.map((w) => ({ id: w.id, name: w.name, currency: w.currency })),
			categories: categories
				.filter((c) => c.kind === 'expense')
				.map((c) => ({ id: c.id, name: c.name, tileKey: c.tileKey, isPreset: c.isPreset })),
			expenses,
			candidates,
			loadError: null,
			open
		};
	} catch (e) {
		console.error('langganan: list failed', e instanceof Error ? e.name : 'unknown');
		return {
			today,
			subscriptions: [],
			totals: [],
			wallets: [],
			categories: [],
			expenses: [],
			candidates: [],
			loadError: SUBSCRIPTIONS_LOAD_FAILED,
			open
		};
	}
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await scopeOf(event.locals);
	return { form, scope, db: event.locals.db, today: wibTodayString() };
}

function refused(result: Exclude<SubscriptionWriteResult, 'ok'>) {
	return result === 'missing'
		? fail(404, { error: SUBSCRIPTION_NOT_FOUND })
		: fail(409, { error: SUBSCRIPTION_CHANGED });
}

export const actions: Actions = {
	createSubscription: async (event) => {
		const { form, scope, db, today } = await guarded(event);
		const parsed = parseSubscriptionForm(form, event.locals.locale);
		if (!parsed.ok)
			return fail(400, { action: 'create' as const, errors: parsed.errors, values: parsed.values });
		const created = await createSubscription(db, scope, parsed.value, today, Date.now());
		if (created.ok) return { saved: 'created' as const };
		if (created.reason === 'wallet')
			return fail(400, {
				action: 'create' as const,
				errors: { walletId: WALLET_INVALID },
				values: parsed.values
			});
		return created.reason === 'limit'
			? fail(409, { error: SUBSCRIPTION_LIMIT })
			: fail(404, { error: SUBSCRIPTION_NOT_FOUND });
	},

	updateSubscription: async (event) => {
		const { form, scope, db, today } = await guarded(event);
		const id = idField(form, 'subscriptionId');
		const parsed = parseSubscriptionForm(form, event.locals.locale);
		if (!parsed.ok)
			return fail(400, {
				action: 'update' as const,
				subscriptionId: id,
				errors: parsed.errors,
				values: parsed.values
			});
		const current = await getSubscription(db, scope.spaceId, id, today);
		if (!current) return fail(404, { error: SUBSCRIPTION_NOT_FOUND });
		// The catalogue entry it was added from stays as it was; only the shown name and category are editable.
		const input = { ...parsed.value, catalogueId: current.catalogueId };
		const result = await updateSubscription(
			db,
			scope,
			id,
			input,
			current,
			expectedUpdatedAt(form),
			today,
			Date.now()
		);
		if (result === 'wallet')
			return fail(400, {
				action: 'update' as const,
				subscriptionId: id,
				errors: { walletId: WALLET_INVALID },
				values: parsed.values
			});
		if (result !== 'ok') return refused(result);
		return { saved: 'updated' as const };
	},

	deleteSubscription: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await deleteSubscription(
			db,
			scope,
			idField(form, 'subscriptionId'),
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result !== 'ok') return refused(result);
		return { saved: 'deleted' as const };
	},

	/** FN-26b "Bukan langganan": the candidate never comes back in this space. */
	dismissCandidate: async (event) => {
		const { form, scope, db, today } = await guarded(event);
		const matchKey = idField(form, 'matchKey');
		const result = matchKey
			? await dismissCandidate(db, scope, matchKey, today, Date.now())
			: 'missing';
		if (result === 'missing') return fail(404, { error: CANDIDATE_NOT_FOUND });
		return { saved: 'dismissed' as const, matchKey };
	},

	/** "Tandai sudah dibayar": record a new expense through FN-05, or link an existing one; then advance. */
	markPaid: async (event) => {
		const { form, scope, db, today } = await guarded(event);
		const id = idField(form, 'subscriptionId');
		const expected = expectedUpdatedAt(form);
		const current = await getSubscription(db, scope.spaceId, id, today);
		if (!current) return fail(404, { error: SUBSCRIPTION_NOT_FOUND });
		if (current.updatedAt !== expected) return fail(409, { error: SUBSCRIPTION_CHANGED });
		if (current.isDemo) return fail(400, { error: DEMO_NOT_PAYABLE });
		const pay = parsePayForm(form);
		if (!pay.ok) return fail(400, { payFor: id, payError: pay.error });
		const now = Date.now();

		if (pay.value.mode === 'link') {
			const result = await markPaidWithExisting(
				db,
				scope,
				current,
				expected,
				pay.value.transactionId,
				now
			);
			// Unknown, deleted, other-space or other-currency ids: one answer (no existence oracle).
			if (result === 'transaction')
				return fail(404, { payFor: id, payError: PAY_TRANSACTION_NOT_FOUND });
			if (result !== 'ok') return refused(result);
			return { saved: 'paid' as const };
		}

		// The expense goes through FN-05's own checks: a live wallet of the bill's currency and a visible
		// expense category of this space, a real date; the amount and currency are the bill's own.
		const { walletId, categoryId, occurredOn } = pay.value;
		const [wallet, category] = await Promise.all([
			walletId ? getWallet(db, scope.spaceId, walletId) : null,
			categoryId ? getCategory(db, scope.spaceId, categoryId) : null
		]);
		const checked = capturedTransactionInput(
			{
				type: 'expense',
				amountMinor: current.amountMinor,
				currency: current.currency,
				walletId: walletId || null,
				categoryId: categoryId || null,
				title: current.name,
				note: null,
				occurredOn
			},
			{
				wallet: wallet ? { id: wallet.id, currency: wallet.currency } : null,
				toWallet: null,
				category: category && !category.isHidden ? { id: category.id, kind: category.kind } : null
			}
		);
		if (!checked.ok) return fail(400, { payFor: id, payErrors: checked.errors });
		const result = await markPaidWithNew(db, scope, current, expected, checked.value, now);
		if (result.ok) return { saved: 'paid' as const };
		if (result.reason === 'missing' || result.reason === 'stale') return refused(result.reason);
		return fail(409, { error: result.reason === 'limit' ? TRANSACTION_LIMIT : REFS_GONE });
	}
};
