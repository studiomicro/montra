import { fail } from '@sveltejs/kit';
import {
	CATEGORIES_LOAD_FAILED,
	CATEGORY_LIMIT,
	CATEGORY_NOT_FOUND
} from '#lib/server/categories/messages';
import {
	createCategory,
	listCategoriesWithPresets,
	setCategoryHidden,
	updateCategory
} from '#lib/server/categories/repo';
import { parseCategoryCreateForm, parseCategoryEditForm } from '#lib/server/categories/validation';
import { readFormBody, ID_MAX_LENGTH, expectedUpdatedAt, idField } from '#lib/server/forms';
import { currentSpaceScope } from '#lib/server/spaces/current';
import { TRANSACTION_CHANGED } from '#lib/server/transactions/messages';
import { errorLabel } from '#lib/server/util';
import type { CategoryKind } from '#lib/shared/transactions';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const categoryId = (form: FormData) => idField(form, 'categoryId');

export const load: PageServerLoad = async ({ locals, url }) => {
	const { spaceId } = await currentSpaceScope(locals);
	// `?tambah=expense|income` / `?ubah=<id>` open the form without JavaScript (a sheet does it with it).
	const add = url.searchParams.get('tambah');
	const open: { add: CategoryKind | null; edit: string | null } = {
		add: add === 'expense' || add === 'income' ? add : null,
		edit: url.searchParams.get('ubah')?.slice(0, ID_MAX_LENGTH) ?? null
	};
	try {
		const categories = await listCategoriesWithPresets(locals.db, spaceId, { includeHidden: true });
		return { categories, open, loadError: null };
	} catch (e) {
		console.error('kategori: list failed', errorLabel(e));
		return { categories: [], open, loadError: CATEGORIES_LOAD_FAILED };
	}
};

async function guarded(event: RequestEvent) {
	const form = await readFormBody(event.request);
	const scope = await currentSpaceScope(event.locals);
	return { form, scope, db: event.locals.db };
}

export const actions: Actions = {
	createCategory: async (event) => {
		const { form, scope, db } = await guarded(event);
		const parsed = parseCategoryCreateForm(form);
		if (!parsed.ok)
			return fail(400, { action: 'create', errors: parsed.errors, values: parsed.values });
		const created = await createCategory(db, scope, parsed.value, Date.now());
		if (!created.ok)
			return created.reason === 'limit'
				? fail(409, { error: CATEGORY_LIMIT })
				: fail(404, { error: CATEGORY_NOT_FOUND });
		return { saved: 'created' as const };
	},

	updateCategory: async (event) => {
		const { form, scope, db } = await guarded(event);
		const id = categoryId(form);
		const parsed = parseCategoryEditForm(form);
		if (!parsed.ok)
			return fail(400, {
				action: 'update',
				categoryId: id,
				errors: parsed.errors,
				values: parsed.values
			});
		const result = await updateCategory(
			db,
			scope,
			id,
			parsed.value,
			expectedUpdatedAt(form),
			Date.now()
		);
		if (result === 'missing') return fail(404, { error: CATEGORY_NOT_FOUND });
		if (result === 'stale') return fail(409, { error: TRANSACTION_CHANGED });
		return { saved: 'updated' as const };
	},

	hideCategory: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await setCategoryHidden(db, scope, categoryId(form), true, Date.now());
		if (result !== 'ok') return fail(404, { error: CATEGORY_NOT_FOUND });
		return { saved: 'hidden' as const };
	},

	showCategory: async (event) => {
		const { form, scope, db } = await guarded(event);
		const result = await setCategoryHidden(db, scope, categoryId(form), false, Date.now());
		if (result !== 'ok') return fail(404, { error: CATEGORY_NOT_FOUND });
		return { saved: 'shown' as const };
	}
};
