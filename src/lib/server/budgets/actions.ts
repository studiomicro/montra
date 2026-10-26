import { error, fail } from '@sveltejs/kit';
import { CATEGORY_NOT_FOUND } from '../categories/messages';
import { readFormBody, textField, idField } from '../forms';
import { currentSpaceScope } from '../spaces/current';
import { deleteCategoryBudget, setCategoryBudget } from './category-repo';
import { BUDGET_CHANGED, BUDGET_CURRENCY_INVALID } from './messages';
import { deleteBudget, isBudgetCurrency, setBudget } from './repo';
import { expectedUpdatedAt, parseBudgetForm } from './validation';

// The budget form actions, shared by Beranda and Anggaran. Both work on the session's current space
// (locals.space), re-checked through requireSpaceAccess (currentSpaceScope); every write repeats the
// membership inside its own statements. No budget id is ever read from the client: the server resolves "the
// live budget of this space" (or of this space's category) itself.

interface ActionEvent {
	request: Request;
	locals: App.Locals;
}

async function guarded(event: ActionEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db };
}

/** `gone` (membership removed between the gate and the write) answers exactly as a non-member: 404. */
function refused(result: 'stale' | 'gone' | 'missing') {
	if (result === 'gone') error(404, 'Not found');
	if (result === 'missing') return fail(404, { error: CATEGORY_NOT_FOUND });
	return fail(409, { error: BUDGET_CHANGED });
}

/**
 * The amount text a refused submission posted, echoed so the form shows exactly what was typed and never the
 * stored budget instead (FN-47 follow-up: the no-JavaScript form re-showed the old amount).
 */
const typedAmount = (form: FormData) => textField(form, 'amount').slice(0, 64);

/** The category id a form names; an over-long one matches nothing. */
const categoryIdOf = (form: FormData) => idField(form, 'categoryId');

export async function setBudgetAction(event: ActionEvent) {
	const { form, scope, db } = await guarded(event);
	const parsed = parseBudgetForm(form, event.locals.locale);
	const typed = typedAmount(form);
	if (!parsed.ok) return fail(400, { action: 'setBudget' as const, error: parsed.error, typed });
	// The hidden field is only a request: the currency must be one the space actually holds.
	if (!(await isBudgetCurrency(db, scope.spaceId, parsed.value.currency)))
		return fail(400, { action: 'setBudget' as const, error: BUDGET_CURRENCY_INVALID, typed });
	const result = await setBudget(db, scope, parsed.value, expectedUpdatedAt(form), Date.now());
	if (result !== 'ok') return refused(result);
	return { saved: 'set' as const };
}

export async function deleteBudgetAction(event: ActionEvent) {
	const { form, scope, db } = await guarded(event);
	// A form without a budget's `updated_at` has nothing to remove: answered as "changed meanwhile".
	const expected = expectedUpdatedAt(form) ?? -1;
	const result = await deleteBudget(db, scope, expected, Date.now());
	if (result !== 'ok') return refused(result);
	return { saved: 'deleted' as const };
}

export async function setCategoryBudgetAction(event: ActionEvent) {
	const { form, scope, db } = await guarded(event);
	const categoryId = categoryIdOf(form);
	const parsed = parseBudgetForm(form, event.locals.locale);
	const typed = typedAmount(form);
	if (!parsed.ok)
		return fail(400, {
			action: 'setCategoryBudget' as const,
			categoryId,
			error: parsed.error,
			typed
		});
	if (!(await isBudgetCurrency(db, scope.spaceId, parsed.value.currency)))
		return fail(400, {
			action: 'setCategoryBudget' as const,
			categoryId,
			error: BUDGET_CURRENCY_INVALID,
			typed
		});
	const result = await setCategoryBudget(
		db,
		scope,
		categoryId,
		parsed.value,
		expectedUpdatedAt(form),
		Date.now()
	);
	if (result !== 'ok') return refused(result);
	return { saved: 'categorySet' as const };
}

export async function deleteCategoryBudgetAction(event: ActionEvent) {
	const { form, scope, db } = await guarded(event);
	const result = await deleteCategoryBudget(
		db,
		scope,
		categoryIdOf(form),
		expectedUpdatedAt(form) ?? -1,
		Date.now()
	);
	if (result !== 'ok') return refused(result);
	return { saved: 'categoryDeleted' as const };
}
