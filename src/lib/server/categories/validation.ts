import { z } from 'zod';
import { cleanText } from '#lib/shared/text';
import { CATEGORY_KINDS, CATEGORY_NAME_MAX_LENGTH, TILE_KEYS } from '#lib/shared/transactions';
import { textField } from '../forms';
import { CATEGORY_KIND_INVALID, CATEGORY_NAME_REQUIRED, CATEGORY_TILE_INVALID } from './messages';

const categoryEditSchema = z.object({
	name: z.string().min(1, CATEGORY_NAME_REQUIRED).max(CATEGORY_NAME_MAX_LENGTH),
	tileKey: z.enum(TILE_KEYS, { error: CATEGORY_TILE_INVALID })
});
const categoryCreateSchema = categoryEditSchema.extend({
	kind: z.enum(CATEGORY_KINDS, { error: CATEGORY_KIND_INVALID })
});

export type CategoryEdit = z.infer<typeof categoryEditSchema>;
export type CategoryCreate = z.infer<typeof categoryCreateSchema>;

/** The add/edit form as typed (a refused no-JavaScript form echoes it back). */
interface CategoryFormValues {
	name: string;
	tileKey: string;
	kind: string;
}

export type ParsedCategoryForm<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			errors: Partial<Record<keyof CategoryCreate, string>>;
			values: CategoryFormValues;
	  };

function parse<T>(form: FormData, schema: z.ZodType<T>): ParsedCategoryForm<T> {
	const values: CategoryFormValues = {
		name: textField(form, 'name').slice(0, CATEGORY_NAME_MAX_LENGTH * 4),
		tileKey: textField(form, 'tileKey').slice(0, 32),
		kind: textField(form, 'kind').slice(0, 16)
	};
	// Control and zero-width characters stripped and the length capped before validation (checklist).
	const parsed = schema.safeParse({
		name: cleanText(values.name, CATEGORY_NAME_MAX_LENGTH),
		tileKey: values.tileKey,
		kind: values.kind
	});
	if (parsed.success) return { ok: true, value: parsed.data };
	const errors: Partial<Record<keyof CategoryCreate, string>> = {};
	for (const issue of parsed.error.issues) {
		const field = issue.path[0] as keyof CategoryCreate;
		errors[field] ??= issue.message;
	}
	return { ok: false, errors, values };
}

/** "Tambah kategori": name, tile slot and kind. */
export function parseCategoryCreateForm(form: FormData): ParsedCategoryForm<CategoryCreate> {
	return parse(form, categoryCreateSchema);
}

/** Rename and/or change the tile of an existing category (its kind never changes). */
export function parseCategoryEditForm(form: FormData): ParsedCategoryForm<CategoryEdit> {
	return parse(form, categoryEditSchema);
}
