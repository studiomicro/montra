<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { msg } from '#lib/shared/i18n';
	import {
		CATEGORY_KIND_LABELS,
		CATEGORY_KINDS,
		categoryLabel,
		type CategoryKind
	} from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import CategoryForm from '#lib/ui/transactions/CategoryForm.svelte';

	let { data, form } = $props();
	const { tr, trf } = useI18n();

	type Category = (typeof data.categories)[number];
	type Values = { name: string; tileKey: string; kind: string };

	const visible = $derived(data.categories.filter((c) => !c.isHidden));
	const hidden = $derived(data.categories.filter((c) => c.isHidden));
	const ofKind = (kind: CategoryKind) => visible.filter((c) => c.kind === kind);

	// With JavaScript the form opens in a sheet; without it `?tambah=…` / `?ubah=<id>` (and a refused
	// submission) render the same form inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let editing = $state<Category | null>(null);
	let addKind = $state<CategoryKind>('expense');
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openAdd(kind: CategoryKind) {
		editing = null;
		addKind = kind;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	function openEdit(c: Category) {
		editing = c;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	const intercept = (fn: () => void) => (event: MouseEvent) => {
		event.preventDefault();
		fn();
	};

	onMount(() => {
		hydrated = true;
		const open = data.open;
		if (open.add) openAdd(open.add as CategoryKind);
		else if (open.edit) {
			const c = data.categories.find((x) => x.id === open.edit);
			if (c) openEdit(c);
		}
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('tambah') || url.searchParams.has('ubah')) {
			url.searchParams.delete('tambah');
			url.searchParams.delete('ubah');
			replaceState(url, {});
		}
	}

	/** Shows success only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update();
				if (result.type === 'failure') {
					fieldErrors = (result.data?.errors as Partial<Record<string, string>>) ?? {};
					if (result.status === 404 || result.status === 409) {
						await invalidateAll();
						if (editing) {
							const id = editing.id;
							const fresh = data.categories.find((c) => c.id === id);
							if (fresh) {
								editing = fresh;
								formKey++;
							}
						}
					}
				} else if (result.type === 'success' && closeSheet) {
					sheetOpen = false;
				}
				busy = '';
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const savedText: Record<string, string> = {
		created: msg('Kategori ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		hidden: msg('Kategori disembunyikan.'),
		shown: msg('Kategori ditampilkan lagi.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);

	const valuesOf = (c: Category): Values => ({ name: c.name, tileKey: c.tileKey, kind: c.kind });
	const blank = (kind: CategoryKind): Values => ({ name: '', tileKey: 'lain', kind });

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by(() => {
		if (form && 'action' in form && form.action) {
			const category =
				form.action === 'update'
					? data.categories.find((c) => c.id === form.categoryId)
					: undefined;
			if (form.action === 'update' && !category) return null;
			return { category: category ?? null, values: form.values as Values, errors: form.errors };
		}
		const open = data.open;
		if (open.add) return { category: null, values: blank(open.add as CategoryKind), errors: {} };
		const category = open.edit ? data.categories.find((c) => c.id === open.edit) : undefined;
		return category ? { category, values: valuesOf(category), errors: {} } : null;
	});
</script>

<svelte:head><title>{tr('Kategori')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Kategori')}
	subtitle={tr(
		'Ubah nama atau ikon, sembunyikan yang tidak dipakai, atau tambah kategori sendiri.'
	)}
/>

{#snippet categoryForm(
	category: Category | null,
	values: Values,
	errors: Partial<Record<string, string>>
)}
	<CategoryForm
		category={category ?? undefined}
		{values}
		{errors}
		busy={busy !== ''}
		submit={track(category ? 'update' : 'create', true)}
	/>
{/snippet}

{#snippet row(category: Category)}
	<GroupRow>
		<a
			class="open"
			href="/pengaturan/kategori?ubah={category.id}"
			onclick={intercept(() => openEdit(category))}
		>
			<CategoryTile category={category.tileKey} />
			<span class="name">{categoryLabel(category, tr)}</span>
			<span class="sr-only">{tr('Ubah')}</span>
		</a>
		<form
			method="POST"
			action={category.isHidden ? '?/showCategory' : '?/hideCategory'}
			use:enhance={track(`toggle-${category.id}`)}
		>
			<input type="hidden" name="categoryId" value={category.id} />
			<!-- Icon only, so the name keeps the whole row (a text pill took ~150 px on a phone). -->
			<button
				type="submit"
				class="eye"
				disabled={busy !== ''}
				aria-label={category.isHidden ? tr('Tampilkan') : tr('Sembunyikan')}
				title={category.isHidden ? tr('Tampilkan') : tr('Sembunyikan')}
			>
				<Icon name={category.isHidden ? 'eye' : 'eye-off'} size={20} />
			</button>
		</form>
	</GroupRow>
{/snippet}

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if !hydrated && inline}
	<section class="inline-form" aria-labelledby="inline-title">
		<h2 id="inline-title">{inline.category ? tr('Ubah kategori') : tr('Tambah kategori')}</h2>
		{@render categoryForm(inline.category, inline.values, inline.errors)}
		<a class="cancel" href="/pengaturan/kategori">{tr('Batal')}</a>
	</section>
{/if}

{#if refreshing}
	<Skeleton rows={6} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else}
	{#each CATEGORY_KINDS as kind (kind)}
		<section aria-labelledby="kind-{kind}">
			<h2 id="kind-{kind}">{tr(CATEGORY_KIND_LABELS[kind])}</h2>
			<GroupList>
				{#each ofKind(kind) as category (category.id)}
					{@render row(category)}
				{/each}
				<GroupRow>
					<a
						class="add"
						href="/pengaturan/kategori?tambah={kind}"
						onclick={intercept(() => openAdd(kind))}
					>
						<span class="add-tile" aria-hidden="true"><Icon name="plus" size={20} /></span>
						<span>{tr('Tambah kategori')}</span>
					</a>
				</GroupRow>
			</GroupList>
		</section>
	{/each}

	{#if hidden.length > 0}
		<details class="hidden-list">
			<summary>{trf('Disembunyikan ({n})', { n: hidden.length })}</summary>
			<GroupList>
				{#each hidden as category (category.id)}
					{@render row(category)}
				{/each}
			</GroupList>
		</details>
	{/if}
	<section class="rules" aria-label={tr('Pedagang & aturan')}>
		<GroupList>
			<IconRow
				icon="receipt"
				title={tr('Pedagang & aturan')}
				hint={tr('Diingat dari koreksimu')}
				href="/pengaturan/pedagang"
			/>
		</GroupList>
	</section>
{/if}

<Sheet
	bind:open={sheetOpen}
	title={editing ? tr('Ubah kategori') : tr('Tambah kategori')}
	onclose={onSheetClose}
>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render categoryForm(editing, editing ? valuesOf(editing) : blank(addKind), fieldErrors)}
		{/key}
	{/if}
</Sheet>

<style>
	section {
		margin-top: 24px;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.add-tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.open,
	.add {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.add {
		font-weight: 600;
	}
	.name {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.hidden-list {
		margin-top: 24px;
	}
	.hidden-list summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		margin-bottom: 8px;
		font-weight: 600;
		cursor: pointer;
	}
	/* No-JavaScript form: on the page colour, so its panel-filled inputs stay visible. */
	.inline-form {
		margin: 8px 0 24px;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	.ok {
		margin: 12px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.eye {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.eye:hover {
		background: var(--bg);
		color: var(--ink);
	}
	.eye:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
