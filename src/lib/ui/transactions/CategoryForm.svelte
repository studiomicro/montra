<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import {
		CATEGORY_KIND_LABELS,
		CATEGORY_KINDS,
		CATEGORY_NAME_MAX_LENGTH,
		TILE_KEYS
	} from '#lib/shared/transactions';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import { CATEGORIES } from '#lib/ui/kit/category';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	let {
		category,
		values,
		errors = {},
		busy,
		submit
	}: {
		/** The category being edited (absent when adding; its kind then comes from the form). */
		category?: { id: string; updatedAt: number };
		values: { name: string; tileKey: string; kind: string };
		errors?: Partial<Record<string, string>>;
		busy: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr } = useI18n();
	const uid = $props.id();
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<form
	method="POST"
	action={category ? '?/updateCategory' : '?/createCategory'}
	use:enhance={submit}
	class="category-form"
	novalidate
>
	{#if category}
		<input type="hidden" name="categoryId" value={category.id} />
		<input type="hidden" name="updatedAt" value={category.updatedAt} />
	{:else}
		<Segmented
			name="kind"
			label={tr('Jenis kategori')}
			value={values.kind || 'expense'}
			options={CATEGORY_KINDS.map((k) => ({ value: k, label: tr(CATEGORY_KIND_LABELS[k]) }))}
		/>
		{#if error('kind')}<p class="error">{error('kind')}</p>{/if}
	{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama kategori')}
		value={values.name}
		maxlength={CATEGORY_NAME_MAX_LENGTH}
		autocomplete="off"
		error={error('name')}
	/>

	<fieldset>
		<legend>{tr('Ikon')}</legend>
		<div class="tiles">
			{#each TILE_KEYS as key (key)}
				<label class="tile">
					<input type="radio" name="tileKey" value={key} checked={values.tileKey === key} />
					<CategoryTile category={key} />
					<span class="sr-only">{tr(CATEGORIES[key].label)}</span>
				</label>
			{/each}
		</div>
		{#if error('tileKey')}<p class="error">{error('tileKey')}</p>{/if}
	</fieldset>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : category ? tr('Simpan perubahan') : tr('Tambah kategori')}
	</Button>
</form>

<style>
	.category-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend {
		margin-bottom: 6px;
		padding: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
		gap: 8px;
	}
	.tile {
		position: relative;
		display: grid;
		place-items: center;
		min-height: 56px;
		border-radius: var(--r-s);
		background: var(--panel);
		cursor: pointer;
	}
	.tile input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.tile:has(input:checked) {
		outline: 2px solid var(--ink);
		outline-offset: -2px;
	}
	.tile:has(input:focus-visible) {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
