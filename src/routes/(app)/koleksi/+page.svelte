<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { groupDigits, minorToDigits } from '#lib/shared/amount-input';
	import {
		formatPermille,
		gainPermille,
		type CollectibleFormValues
	} from '#lib/shared/collectibles';
	import { formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import CollectibleForm from '#lib/ui/collectibles/CollectibleForm.svelte';
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

	const blank = (): CollectibleFormValues => ({
		name: '',
		purchasePrice: '',
		purchasedOn: data.today,
		currentValue: '',
		note: ''
	});
	const valuesOf = (c: Item): CollectibleFormValues => ({
		name: c.name,
		purchasePrice: groupDigits(minorToDigits(c.purchasePriceMinor, c.currency)),
		purchasedOn: c.purchasedOn,
		currentValue: groupDigits(minorToDigits(c.valueMinor, c.currency)),
		note: c.note ?? ''
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
							const fresh = data.items.find((c) => c.id === id);
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
		created: msg('Koleksi ditambahkan.'),
		createdWithPhoto: msg('Koleksi dan fotonya ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		archived: msg('Koleksi dihapus.')
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
			const collectible =
				form.action === 'update' && 'collectibleId' in form
					? data.items.find((c) => c.id === form.collectibleId && !c.isDemo)
					: undefined;
			if (form.action === 'update' && !collectible) return null;
			return {
				collectible: collectible ?? null,
				values: form.values ?? (collectible ? valuesOf(collectible) : blank()),
				errors: form.errors ?? {}
			};
		}
		if (data.open === 'add') return { collectible: null, values: blank(), errors: {} };
		const collectible = data.open
			? data.items.find((c) => c.id === data.open && !c.isDemo)
			: undefined;
		return collectible ? { collectible, values: valuesOf(collectible), errors: {} } : null;
	});

	const photoSrc = (c: Item) => `/koleksi/${c.id}/foto?v=${c.updatedAt}`;
	const anyDemo = $derived(data.items.some((c) => c.isDemo));
	/** The secondary percent annotation of a gain ('' for a gift: no percentage of zero). */
	const percentOf = (gainMinor: number, purchasePriceMinor: number) => {
		const permille = gainPermille(gainMinor, purchasePriceMinor);
		return permille === null ? '' : formatPermille(permille);
	};
	const tone = (gainMinor: number) => (gainMinor > 0 ? 'up' : gainMinor < 0 ? 'down' : '');
</script>

<svelte:head><title>{tr('Koleksi')}</title></svelte:head>
<ScreenTitle
	title={tr('Koleksi')}
	subtitle={data.loadError ? undefined : trf('{n} koleksi', { n: data.items.length })}
>
	{#snippet actions()}
		{#if !data.loadError && data.items.length > 0}
			<PageAction at="header" href="/koleksi?tambah=1" icon="plus" onclick={intercept(openAdd)}
				>{tr('Tambah koleksi')}</PageAction
			>
		{/if}
	{/snippet}
</ScreenTitle>

{#if data.hiddenModules.includes('koleksi')}
	<p class="hidden-note">
		{tr('Koleksi disembunyikan dari menu. Angkanya tetap dihitung.')}
		<a href="/pengaturan/fitur">{tr('Tampilkan lagi di menu')}</a>
	</p>
{/if}

{#snippet collectibleForm(
	collectible: Item | null,
	values: CollectibleFormValues,
	errors: Partial<Record<string, string>>
)}
	<CollectibleForm
		action={collectible ? '?/update' : '?/create'}
		collectible={collectible ?? undefined}
		{values}
		{errors}
		today={data.today}
		{busy}
		submit={track(collectible ? 'update' : 'create', true)}
	/>
	{#if collectible}
		<details class="confirm">
			<summary>{tr('Hapus koleksi')}</summary>
			<form method="POST" action="?/archive" use:enhance={track('archive', true)}>
				<input type="hidden" name="collectibleId" value={collectible.id} />
				<input type="hidden" name="updatedAt" value={collectible.updatedAt} />
				<p>{tr('Koleksi dan fotonya dihapus permanen.')}</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'archive' ? tr('Memproses…') : tr('Ya, hapus')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#snippet itemContent(item: Item)}
	{@const percent = percentOf(item.gainMinor, item.purchasePriceMinor)}
	{#if item.hasPhoto}
		<img class="thumb" src={photoSrc(item)} alt="" loading="lazy" decoding="async" />
	{:else}
		<span class="thumb placeholder"><Icon name="star" size={20} /></span>
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
		<span class="gain num {tone(item.gainMinor)}">
			{formatMoney(item.gainMinor, item.currency, 'signed')}
		</span>
		{#if percent}<span class="percent num">{percent}</span>{/if}
	</span>
{/snippet}

<!-- Nothing recorded yet: no Rp 0 hero, the empty state below carries the page, as on Langganan. -->
{#if data.items.length > 0 || data.loadError || refreshing}
	<section class="total" aria-labelledby="total-title">
		<h2 id="total-title" class="label">
			{data.space.kind === 'shared'
				? trf('Nilai koleksi di ruang {nama}', { nama: data.space.name })
				: tr('Nilai koleksi')}
		</h2>
		{#if data.loadError || refreshing}
			<p class="figure num muted">—</p>
		{:else if data.totals.length === 0}
			<p class="figure num">{formatMoney(0, 'IDR')}</p>
		{:else}
			{#each data.totals as total (total.currency)}
				<p class="figure num">
					{total.valueMinor === null
						? tr('Total terlalu besar untuk ditampilkan')
						: formatMoney(total.valueMinor, total.currency)}
				</p>
				{#if total.gainMinor !== null}
					<p class="gain-total num {tone(total.gainMinor)}">
						{trf('{jumlah} dari harga beli', {
							jumlah: formatMoney(total.gainMinor, total.currency, 'signed')
						})}
					</p>
				{/if}
			{/each}
		{/if}
		{#if !data.loadError}
			<p class="disclosure">
				{tr('Nilai diisi sendiri, bukan taksiran harga pasar atau penilaian keaslian.')}
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
		<h3 id="inline-title">{inline.collectible ? tr('Ubah koleksi') : tr('Tambah koleksi')}</h3>
		{@render collectibleForm(inline.collectible, inline.values, inline.errors)}
		<a class="cancel" href="/koleksi">{tr('Batal')}</a>
	</section>
{/if}

<section aria-labelledby="list-title">
	<h2 id="list-title" class="sr-only">{tr('Daftar koleksi')}</h2>
	{#if refreshing}
		<Skeleton rows={3} />
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if data.items.length === 0}
		<EmptyState
			illustration="parcels"
			text={tr('Belum ada koleksi. Catat kartu, sepatu atau figur beserta nilainya sekarang.')}
			actionLabel={tr('Tambah koleksi')}
			actionHref="/koleksi?tambah=1"
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
						<a
							class="open"
							href="/koleksi?ubah={item.id}"
							onclick={intercept(() => openEdit(item))}
						>
							{@render itemContent(item)}
							<span class="sr-only">{tr('Ubah')}</span>
						</a>
					{/if}
				</GroupRow>
			{/each}
		</GroupList>
		<PageAction at="bottom" href="/koleksi?tambah=1" icon="plus" onclick={intercept(openAdd)}
			>{tr('Tambah koleksi')}</PageAction
		>
	{/if}
</section>

<Sheet
	bind:open={sheetOpen}
	title={editing ? tr('Ubah koleksi') : tr('Tambah koleksi')}
	onclose={onSheetClose}
>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render collectibleForm(editing, editing ? valuesOf(editing) : blank(), fieldErrors)}
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
	/* The price after the date wraps to a second line rather than being cut with an ellipsis. */
	.meta {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
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
	.gain {
		font-size: 14px;
		font-weight: 600;
	}
	.gain-total {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.up {
		color: var(--money-in);
	}
	.down {
		color: var(--money-up);
	}
	.percent {
		font-size: 12px;
		color: var(--muted);
	}
	.demo {
		margin-top: 4px;
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
