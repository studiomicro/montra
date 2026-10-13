<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { groupDigits, minorToDigits } from '#lib/shared/amount-input';
	import type { BelongingFormValues } from '#lib/shared/belongings';
	import { formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import BelongingForm from '#lib/ui/belongings/BelongingForm.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import PageAction from '#lib/ui/shell/PageAction.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	type Item = (typeof data.items)[number];

	const blank = (): BelongingFormValues => ({
		name: '',
		purchasePrice: '',
		purchasedOn: data.today,
		currentValue: '',
		note: ''
	});
	const valuesOf = (b: Item): BelongingFormValues => ({
		name: b.name,
		purchasePrice: groupDigits(minorToDigits(b.purchasePriceMinor, b.currency)),
		purchasedOn: b.purchasedOn,
		currentValue:
			b.currentValueMinor === null
				? ''
				: groupDigits(minorToDigits(b.currentValueMinor, b.currency)),
		note: b.note ?? ''
	});

	// With JavaScript the form opens in a sheet; without it, `?tambah=1` / `?ubah=<id>` (and a refused
	// submission) render the same form inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let editing = $state<Item | null>(null);
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	/** The action in flight ('' when none; 'upload' while a photo is sent). */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openAdd() {
		editing = null;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	function openEdit(b: Item) {
		editing = b;
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
		if (data.open === 'add') openAdd();
		else if (data.open) {
			const b = data.items.find((x) => x.id === data.open && !x.isDemo);
			if (b) openEdit(b);
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

	const withPhoto = (formData: FormData) => {
		const file = formData.get('photo');
		return file instanceof File && file.size > 0;
	};

	/** Shows success only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		({ formData }) => {
			busy = withPhoto(formData) ? 'upload' : name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update({ reset: false });
				if (result.type === 'failure') {
					fieldErrors = (result.data?.errors as Partial<Record<string, string>>) ?? {};
					if (result.status === 404 || result.status === 409) {
						await invalidateAll();
						if (editing) {
							const id = editing.id;
							const fresh = data.items.find((b) => b.id === id);
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
		created: msg('Barang ditambahkan.'),
		createdWithPhoto: msg('Barang dan fotonya ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		archived: msg('Barang dihapus.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by(() => {
		if (form && 'action' in form && form.action) {
			const belonging =
				form.action === 'update' && 'belongingId' in form
					? data.items.find((b) => b.id === form.belongingId && !b.isDemo)
					: undefined;
			if (form.action === 'update' && !belonging) return null;
			return {
				belonging: belonging ?? null,
				values: form.values ?? (belonging ? valuesOf(belonging) : blank()),
				errors: form.errors ?? {}
			};
		}
		if (data.open === 'add') return { belonging: null, values: blank(), errors: {} };
		const belonging = data.open
			? data.items.find((b) => b.id === data.open && !b.isDemo)
			: undefined;
		return belonging ? { belonging, values: valuesOf(belonging), errors: {} } : null;
	});

	const photoSrc = (b: Item) => `/barang/${b.id}/foto?v=${b.updatedAt}`;
	// `Data demo` rows are not in the total, so neither their estimate nor their mark is the total's.
	const anyEstimated = $derived(data.items.some((b) => b.estimated && !b.isDemo));
	const anyDemo = $derived(data.items.some((b) => b.isDemo));
</script>

<svelte:head><title>{tr('Barang')}</title></svelte:head>
<ScreenTitle
	title={tr('Barang')}
	subtitle={data.loadError ? undefined : trf('{n} barang', { n: data.items.length })}
>
	{#snippet actions()}
		{#if !data.loadError && data.items.length > 0}
			<PageAction at="header" href="/barang?tambah=1" icon="plus" onclick={intercept(openAdd)}
				>{tr('Tambah barang')}</PageAction
			>
		{/if}
	{/snippet}
</ScreenTitle>

{#if data.hiddenModules.includes('barang')}
	<p class="hidden-note">
		{tr('Barang disembunyikan dari menu. Angkanya tetap dihitung.')}
		<a href="/pengaturan/fitur">{tr('Tampilkan lagi di menu')}</a>
	</p>
{/if}

{#snippet belongingForm(
	belonging: Item | null,
	values: BelongingFormValues,
	errors: Partial<Record<string, string>>
)}
	<BelongingForm
		action={belonging ? '?/update' : '?/create'}
		belonging={belonging ?? undefined}
		{values}
		{errors}
		today={data.today}
		{busy}
		submit={track(belonging ? 'update' : 'create', true)}
	/>
	{#if belonging}
		<details class="confirm">
			<summary>{tr('Hapus barang')}</summary>
			<form method="POST" action="?/archive" use:enhance={track('archive', true)}>
				<input type="hidden" name="belongingId" value={belonging.id} />
				<input type="hidden" name="updatedAt" value={belonging.updatedAt} />
				<p>{tr('Barang dan fotonya dihapus permanen.')}</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'archive' ? tr('Memproses…') : tr('Ya, hapus')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#snippet itemContent(item: Item)}
	{#if item.hasPhoto}
		<img class="thumb" src={photoSrc(item)} alt="" loading="lazy" decoding="async" />
	{:else}
		<span class="thumb placeholder"><Icon name="box" size={20} /></span>
	{/if}
	<span class="text">
		<span class="name">{item.name}</span>
		<span class="meta">
			{trf('Dibeli {tanggal}', { tanggal: formatShortDate(item.purchasedOn, locale) })}
			· {formatMoney(item.purchasePriceMinor, item.currency)}
		</span>
		{#if item.isDemo}<span class="demo"><Badge>{tr('Data demo')}</Badge></span>{/if}
	</span>
	<span class="value">
		<span class="amount num">{formatMoney(item.valueMinor, item.currency)}</span>
		{#if item.estimated}<span class="est">{tr('Estimasi')}</span>{/if}
	</span>
{/snippet}

<!-- Nothing recorded yet: no Rp 0 hero, the empty state below carries the page, as on Langganan. -->
{#if data.items.length > 0 || data.loadError || refreshing}
	<section class="total" aria-labelledby="total-title">
		<h2 id="total-title" class="label">
			{data.space.kind === 'shared'
				? trf('Nilai barang di ruang {nama}', { nama: data.space.name })
				: tr('Nilai barang')}
		</h2>
		{#if data.loadError || refreshing}
			<p class="figure num muted">—</p>
		{:else if data.totals.length === 0}
			<p class="figure num">{formatMoney(0, 'IDR')}</p>
		{:else}
			{#each data.totals as total (total.currency)}
				<p class="figure num">
					{total.totalMinor === null
						? tr('Total terlalu besar untuk ditampilkan')
						: formatMoney(total.totalMinor, total.currency)}
				</p>
			{/each}
		{/if}
		{#if anyEstimated && !data.loadError}
			<p class="disclosure">
				<Badge>{tr('Estimasi')}</Badge>
				<span>{tr('Estimasi, bukan nilai pasar sebenarnya.')}</span>
			</p>
		{/if}
		{#if anyDemo && !data.loadError}
			<p class="disclosure">
				<Badge>{tr('Data demo')}</Badge>
				<span>{tr('Baris Data demo tidak dihitung dalam total.')}</span>
			</p>
		{/if}
	</section>
{/if}

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if !hydrated && inline}
	<section class="inline-form" aria-labelledby="inline-title">
		<h3 id="inline-title">{inline.belonging ? tr('Ubah barang') : tr('Tambah barang')}</h3>
		{@render belongingForm(inline.belonging, inline.values, inline.errors)}
		<a class="cancel" href="/barang">{tr('Batal')}</a>
	</section>
{/if}

<section aria-labelledby="list-title">
	<h2 id="list-title" class="sr-only">{tr('Daftar barang')}</h2>
	{#if refreshing}
		<Skeleton rows={3} />
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if data.items.length === 0}
		<EmptyState
			illustration="parcels"
			text={tr('Belum ada barang. Catat laptop, motor atau perabot beserta fotonya.')}
			actionLabel={tr('Tambah barang')}
			actionHref="/barang?tambah=1"
			onaction={openAdd}
		/>
	{:else}
		<GroupList>
			{#each data.items as item (item.id)}
				<GroupRow>
					{#if item.isDemo}
						<!-- Data demo rows are read-only: no edit form, the server refuses edits too. -->
						<div class="open">{@render itemContent(item)}</div>
					{:else}
						<a class="open" href="/barang?ubah={item.id}" onclick={intercept(() => openEdit(item))}>
							{@render itemContent(item)}
							<span class="sr-only">{tr('Ubah')}</span>
						</a>
					{/if}
				</GroupRow>
			{/each}
		</GroupList>
		<PageAction at="bottom" href="/barang?tambah=1" icon="plus" onclick={intercept(openAdd)}
			>{tr('Tambah barang')}</PageAction
		>
	{/if}
</section>

<Sheet
	bind:open={sheetOpen}
	title={editing ? tr('Ubah barang') : tr('Tambah barang')}
	onclose={onSheetClose}
>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render belongingForm(editing, editing ? valuesOf(editing) : blank(), fieldErrors)}
		{/key}
	{/if}
</Sheet>

<style>
	/* One big number first (§ 2 HeroAmount scale), left-aligned on the page, no card. */
	.total {
		display: grid;
		gap: 6px;
		padding: 8px 0 24px;
	}
	.label {
		margin: 0;
		font-size: 15px;
		font-weight: 500;
		color: var(--muted);
	}
	.figure {
		margin: 0;
		font-size: 44px;
		font-weight: 700;
		line-height: 1.05;
		letter-spacing: -0.04em;
		overflow-wrap: anywhere;
	}
	@media (min-width: 1024px) {
		.figure {
			font-size: 52px;
		}
	}
	.disclosure {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	h3 {
		margin: 0 0 12px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 56px;
		color: var(--ink);
		text-decoration: none;
	}
	.thumb {
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: var(--r-s);
		background: var(--bg);
		object-fit: cover;
	}
	.placeholder {
		display: grid;
		place-items: center;
		border-radius: var(--r-pill);
		color: var(--ink);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		overflow: hidden;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.demo {
		margin-top: 4px;
	}
	.value {
		display: flex;
		flex: none;
		flex-direction: column;
		align-items: flex-end;
	}
	.amount {
		font-size: 15px;
		font-weight: 700;
	}
	.est {
		font-size: 13px;
		color: var(--muted);
	}
	.muted {
		color: var(--muted);
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	/* No-JavaScript form: on the page colour, so its panel-filled inputs stay visible. */
	.inline-form {
		margin: 8px 0 24px;
	}
	.confirm {
		margin-top: 16px;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.hidden-note {
		margin: 4px 0 8px;
		font-size: 14px;
		color: var(--muted);
	}
	.hidden-note a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
