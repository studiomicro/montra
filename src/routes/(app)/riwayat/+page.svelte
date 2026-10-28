<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { afterNavigate, beforeNavigate, goto, invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { addDays, formatDayHeader, formatDayLabel, shiftMonth } from '#lib/shared/dates';
	import { periodStepLabel } from '#lib/shared/report-period';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		PERIOD_PRESET_LABELS,
		periodPresets,
		presetOf,
		riwayatHref
	} from '#lib/shared/riwayat-query';
	import { CATEGORY_KIND_LABELS, categoryLabel } from '#lib/shared/transactions';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import Chip from '#lib/ui/kit/Chip.svelte';
	import DayHeader from '#lib/ui/kit/DayHeader.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import PickerSheet from '#lib/ui/kit/PickerSheet.svelte';
	import SearchField from '#lib/ui/kit/SearchField.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import type { PickerOption } from '#lib/ui/kit/picker';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import PullToRefresh from '#lib/ui/shell/PullToRefresh.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import { transactionSavedHop } from '#lib/ui/mascot-moments';
	import {
		rowKindLabel,
		rowMeta,
		rowTile,
		rowShare,
		rowTitle,
		signedAmount
	} from '#lib/ui/transactions/row-text';

	let { data } = $props();
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	type Day = (typeof data.page.days)[number];

	// "Muat lebih banyak": with JavaScript the next page is appended to the pages already shown (`earlier`);
	// without it the link opens the next page on its own, with a way back to the top.
	// `earlier.cursor` is the cursor of the page they lead to; they are shown only in front of that page.
	let earlier = $state<{ cursor: string | null; days: Day[] }>({ cursor: null, days: [] });
	let loadingMore = $state(false);

	function merge(a: Day[], b: Day[]): Day[] {
		const last = a.at(-1);
		const first = b[0];
		if (last && first && last.date === first.date)
			return [...a.slice(0, -1), { ...last, rows: [...last.rows, ...first.rows] }, ...b.slice(1)];
		return [...a, ...b];
	}
	const days = $derived(
		earlier.cursor && earlier.cursor === data.cursor
			? merge(earlier.days, data.page.days)
			: data.page.days
	);

	// "Muat lebih banyak" is a plain link (SvelteKit navigates it): when it leads to the next page of the same
	// list, the rows shown so far are kept and the new page is appended; any other navigation starts over.
	beforeNavigate(({ to }) => {
		const next = data.page.nextCursor;
		const cursor = to?.url.pathname === '/riwayat' ? to.url.searchParams.get('cursor') : null;
		if (next && cursor === next) {
			earlier = { cursor: next, days };
			loadingMore = true;
		} else earlier = { cursor: null, days: [] };
	});
	afterNavigate(() => {
		loadingMore = false;
	});

	let hydrated = $state(false);
	let pickCategory = $state(false);
	let pickWallet = $state(false);
	onMount(() => {
		hydrated = true;
		if (data.pick === 'kategori') pickCategory = true;
		if (data.pick === 'dompet') pickWallet = true;
	});
	const openPicker = (which: 'kategori' | 'dompet') => (event: MouseEvent) => {
		event.preventDefault();
		if (which === 'kategori') pickCategory = true;
		else pickWallet = true;
	};

	let refreshing = $state(false);
	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const loading = $derived(
		refreshing ||
			(!loadingMore &&
				navigating.to?.url.pathname === '/riwayat' &&
				navigating.from?.url.pathname === '/riwayat')
	);

	const view = $derived(data.view);

	// Search as you type (APP_PARITY § 3): the URL follows the field after a short pause; without
	// JavaScript, Enter submits the same GET form.
	// Follows the URL's term after every navigation; typing overrides it until then.
	let q = $derived(view.q);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	function onSearch(value: string) {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			if (value.trim() === view.q) return;
			// Typing stays in the field: no scroll or focus reset, no history entry per pause.
			goto(riwayatHref(view, { q: value.trim() }), { reset: false, replace: true });
		}, 350);
	}
	onDestroy(() => clearTimeout(searchTimer));

	/** Money in or out per currency, joined (never summed across currencies). */
	function moneyList(key: 'inMinor' | 'outMinor'): string {
		const totals = data.totals?.totals ?? [];
		if (totals.length === 0) return formatMoney(0, 'IDR', 'auto', locale);
		return totals
			.map((t) => {
				const minor = t[key];
				return minor === null
					? tr('Total terlalu besar untuk ditampilkan')
					: formatMoney(minor, t.currency, 'auto', locale);
			})
			.join(' + ');
	}
	const header = $derived(
		!data.totals
			? undefined
			: view.type === 'income'
				? trf('{n} transaksi · {in} masuk', { n: data.totals.count, in: moneyList('inMinor') })
				: view.type === 'transfer' || view.type === 'adjustment'
					? trf('{n} transaksi', { n: data.totals.count })
					: trf('{n} transaksi · {out} keluar', {
							n: data.totals.count,
							out: moneyList('outMinor')
						})
	);

	const thisMonth = $derived(data.today.slice(0, 7));
	const presets = $derived(periodPresets(data.today));
	const preset = $derived(presetOf(view, data.today));
	const rangeLabel = $derived(
		view.period === 'range'
			? `${formatDayLabel(view.from, locale)} – ${formatDayLabel(view.to, locale)}`
			: ''
	);

	function dayLabel(date: string): string {
		if (date === data.today) return tr('Hari ini');
		if (date === addDays(data.today, -1)) return tr('Kemarin');
		return formatDayHeader(date, data.today, locale);
	}

	const savedText: Record<string, string> = {
		created: msg('Transaksi disimpan.'),
		updated: msg('Perubahan disimpan.'),
		deleted: msg('Transaksi dihapus.'),
		adjusted: msg('Saldo disesuaikan.')
	};

	const noDayTotals = [{ currency: 'IDR', inMinor: 0, outMinor: 0 }];

	const TYPES = [
		{ type: null, label: msg('Semua'), count: 'count' },
		{ type: 'expense', label: msg('Pengeluaran'), count: 'expenseCount' },
		{ type: 'income', label: msg('Pemasukan'), count: 'incomeCount' },
		{ type: 'transfer', label: msg('Transfer'), count: 'transferCount' },
		{ type: 'adjustment', label: msg('Penyesuaian saldo'), count: 'adjustmentCount' }
	] as const;

	const selectedCategory = $derived(data.categories.find((c) => c.id === view.categoryId));
	const selectedWallet = $derived(data.wallets.find((w) => w.id === view.walletId));
	const categoryOptions: PickerOption<string>[] = $derived([
		{
			value: '',
			label: tr('Semua kategori'),
			href: riwayatHref(view, { categoryId: null })
		},
		...data.categories.map((c) => ({
			value: c.id,
			label: categoryLabel(c, tr),
			hint: tr(CATEGORY_KIND_LABELS[c.kind]),
			tile: c.tileKey,
			href: riwayatHref(view, { categoryId: c.id })
		}))
	]);
	const walletOptions: PickerOption<string>[] = $derived([
		{ value: '', label: tr('Semua dompet'), href: riwayatHref(view, { walletId: null }) },
		...data.wallets.map((w) => ({
			value: w.id,
			label: w.name,
			hint: w.archived ? tr('Diarsipkan') : undefined,
			href: riwayatHref(view, { walletId: w.id })
		}))
	]);
	const inlineValue = $derived((data.pick === 'kategori' ? view.categoryId : view.walletId) ?? '');
	const inlineOptions = $derived(
		!hydrated && data.pick ? (data.pick === 'kategori' ? categoryOptions : walletOptions) : null
	);
</script>

<svelte:head><title>{tr('Transaksi')}</title></svelte:head>
<!-- FN-51: in the installed app, a pull from the top reloads this list from the server. -->
<PullToRefresh onrefresh={() => invalidateAll()} />

<ScreenTitle title={tr('Transaksi')} subtitle={data.loadError ? undefined : header}>
	{#snippet actions()}
		<Button variant="secondary" size="sm" icon="repeat" href="/riwayat/berulang">
			{tr('Berulang')}
		</Button>
		<Button
			variant="secondary"
			size="sm"
			icon="download"
			href="/impor/ekspor?from={view.from}&to={view.to}"
		>
			{tr('Ekspor CSV')}
		</Button>
		<span class="hide-phone">
			<Button size="sm" icon="plus" href="/riwayat/baru">{tr('Tambah transaksi')}</Button>
		</span>
	{/snippet}
</ScreenTitle>

{#if data.saved && Object.hasOwn(savedText, data.saved)}
	<p class="ok" role="status">
		<!-- FN-44: the new transaction is in the server's list; Koko hops beside the confirmation. -->
		{#if transactionSavedHop(data.saved)}<Mascot pose="hop" size={40} />{/if}
		{tr(savedText[data.saved] as string)}
	</p>
{/if}

<div class="filters">
	<div class="row-1">
		<div class="toolbar">
			<form method="GET" action="/riwayat" class="search" role="search">
				{#if view.type}<input type="hidden" name="type" value={view.type} />{/if}
				{#if view.period === 'range'}
					<input type="hidden" name="period" value="range" />
					<input type="hidden" name="from" value={view.from} />
					<input type="hidden" name="to" value={view.to} />
				{:else}
					<input type="hidden" name="month" value={view.month} />
				{/if}
				{#if view.categoryId}<input type="hidden" name="category" value={view.categoryId} />{/if}
				{#if view.walletId}<input type="hidden" name="wallet" value={view.walletId} />{/if}
				{#if view.recurring}<input type="hidden" name="berulang" value="1" />{/if}
				<SearchField
					name="q"
					label={tr('Cari judul atau catatan')}
					bind:value={q}
					maxlength={100}
					oninput={onSearch}
				/>
			</form>
			<!-- Phone layout v3: the primary add action sits beside the search field; desktop has it in the header. -->
			<a class="add-sq" href="/riwayat/baru" aria-label={tr('Tambah transaksi')}>
				<Icon name="plus" size={22} />
			</a>
		</div>
		<div class="period">
			<nav class="chip-row" aria-label={tr('Periode')}>
				{#each presets as p (p.id)}
					<Chip href={riwayatHref(view, p.changes)} selected={preset === p.id}>
						{tr(PERIOD_PRESET_LABELS[p.id])}
					</Chip>
				{/each}
			</nav>
			{#if view.period === 'month'}
				<PeriodStepper
					label={periodStepLabel({ kind: 'bulan', month: view.month }, locale)}
					prevHref={riwayatHref(view, { month: shiftMonth(view.month, -1) })}
					nextHref={view.month < thisMonth
						? riwayatHref(view, { month: shiftMonth(view.month, 1) })
						: null}
				/>
			{:else if !preset}
				<span class="range num">{rangeLabel}</span>
			{/if}
		</div>
	</div>
	<nav class="chip-row" aria-label={tr('Jenis transaksi')}>
		{#each TYPES as t (t.label)}
			<Chip
				href={riwayatHref(view, { type: t.type })}
				selected={view.type === t.type}
				count={data.chipTotals?.[t.count]}
			>
				{tr(t.label)}
			</Chip>
		{/each}
		<Chip
			icon="grid"
			popup
			selected={!!selectedCategory}
			href="{riwayatHref(view)}&pilih=kategori"
			onclick={openPicker('kategori')}
		>
			{selectedCategory ? categoryLabel(selectedCategory, tr) : tr('Kategori')}
		</Chip>
		<Chip
			icon="wallet"
			popup
			selected={!!selectedWallet}
			href="{riwayatHref(view)}&pilih=dompet"
			onclick={openPicker('dompet')}
		>
			{selectedWallet ? selectedWallet.name : tr('Dompet')}
		</Chip>
		<Chip
			icon="repeat"
			href={riwayatHref(view, { recurring: !view.recurring })}
			selected={view.recurring}
		>
			{tr('Aktif berulang')}
		</Chip>
	</nav>
</div>

{#if inlineOptions}
	<section class="inline-pick" aria-labelledby="pick-title">
		<h2 id="pick-title">{data.pick === 'kategori' ? tr('Kategori') : tr('Dompet')}</h2>
		<GroupList>
			{#each inlineOptions as option (option.value)}
				<li>
					<a
						class="pick"
						href={option.href}
						aria-current={option.value === inlineValue ? 'true' : undefined}
					>
						{option.label}
						{#if option.hint}<span class="meta">· {option.hint}</span>{/if}
					</a>
				</li>
			{/each}
		</GroupList>
	</section>
{/if}

{#if loading}
	<div aria-busy="true"><Skeleton rows={5} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if !data.hasAny}
	<EmptyState
		illustration="history"
		text={tr('Transaksi yang kamu catat muncul di sini.')}
		actionLabel={tr('Tambah transaksi')}
		actionHref="/riwayat/baru"
	/>
{:else if days.length === 0}
	<EmptyState
		text={tr('Tidak ada transaksi yang cocok dengan filter ini.')}
		actionLabel={tr('Hapus filter')}
		actionHref="/riwayat"
	/>
{:else}
	{#if data.cursor && earlier.cursor !== data.cursor}
		<a class="link" href={riwayatHref(view)}>{tr('Ke awal daftar')}</a>
	{/if}
	{#each days as day (day.date)}
		<section class="day" aria-label={dayLabel(day.date)}>
			{#each day.totals.length > 0 ? day.totals : noDayTotals as total, i (total.currency)}
				{#if total.inMinor === null || total.outMinor === null}
					<p class="too-large">
						{i === 0 ? `${dayLabel(day.date)} · ` : ''}{tr('Total terlalu besar untuk ditampilkan')}
					</p>
				{:else}
					<DayHeader
						label={i === 0 ? dayLabel(day.date) : ''}
						inMinor={total.inMinor}
						outMinor={total.outMinor}
						currency={total.currency}
					/>
				{/if}
			{/each}
			<GroupList records>
				{#each day.rows as row (row.id)}
					<TransactionRow
						title={rowTitle(row, i18n)}
						meta={rowMeta(row, i18n)}
						amountMinor={signedAmount(row)}
						currency={row.currency}
						category={rowTile(row)}
						kind={row.type}
						label={rowKindLabel(row, i18n)}
						status={row.isDemo
							? tr('Data demo')
							: row.source === 'gmail'
								? tr('Dari Gmail')
								: undefined}
						recurring={row.recurringSeriesId ? tr('Berulang') : undefined}
						share={rowShare(row, i18n)}
						href="/riwayat/{row.id}/edit"
					/>
				{/each}
			</GroupList>
		</section>
	{/each}
	{#if data.page.nextCursor}
		<a
			class="more"
			href={riwayatHref(view, {}, data.page.nextCursor)}
			data-sveltekit-noscroll
			data-sveltekit-keepfocus
			aria-disabled={loadingMore ? 'true' : undefined}
		>
			{loadingMore ? tr('Memuat…') : tr('Muat lebih banyak')}
		</a>
	{/if}
{/if}

<PickerSheet
	bind:open={pickCategory}
	title={tr('Kategori')}
	options={categoryOptions}
	value={view.categoryId ?? ''}
/>
<PickerSheet
	bind:open={pickWallet}
	title={tr('Dompet')}
	options={walletOptions}
	value={view.walletId ?? ''}
	addHref="/dompet?tambah=1"
	addLabel={tr('Tambah dompet')}
/>

<style>
	.filters {
		display: grid;
		/* minmax(0, …): the chip rows scroll inside the column instead of widening the page. */
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		margin: 4px 0 8px;
	}
	.search {
		min-width: 0;
	}
	.chip-row {
		display: flex;
		gap: 8px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		/* Room for the focus ring inside the scroller. */
		padding: 3px 2px;
		margin: -3px -2px;
	}
	.chip-row::-webkit-scrollbar {
		display: none;
	}
	/* Row 1: search, then the period chips with the month stepper (wrapping under the search when narrow). */
	.row-1 {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 12px;
		min-width: 0;
	}
	.toolbar {
		display: flex;
		flex: 1 1 280px;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.search {
		flex: 1 1 auto;
	}
	.add-sq {
		display: none;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 14px;
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
		color: var(--ink);
	}
	@media (max-width: 600px) {
		.add-sq {
			display: grid;
		}
	}
	.period {
		display: flex;
		flex: 1 1 auto;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.period .chip-row {
		flex: 1 1 420px;
	}
	.period :global(.stepper) {
		flex: none;
	}
	/* Desktop and tablet: a row that is too long wraps instead of hiding its last chips behind the edge. */
	@media (min-width: 601px) {
		.filters .chip-row {
			flex-wrap: wrap;
			overflow: visible;
		}
	}
	/*
	 * Phone: two scrolling rows (period with the month stepper in front, then type and pickers) instead of
	 * four stacked ones. A fade at the right edge says the row scrolls; the end padding keeps the last chip
	 * clear of it once scrolled.
	 */
	@media (max-width: 600px) {
		.row-1 {
			gap: 10px;
		}
		.period,
		.filters > .chip-row {
			flex-wrap: nowrap;
			overflow-x: auto;
			scrollbar-width: none;
			padding: 3px 32px 3px 2px;
			margin: -3px -2px;
			mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent);
		}
		.period::-webkit-scrollbar {
			display: none;
		}
		.period {
			flex: 1 1 100%;
			justify-content: flex-start;
		}
		.period .chip-row {
			flex: none;
			overflow: visible;
			padding: 0;
			margin: 0;
		}
		.period :global(.stepper) {
			order: -1;
		}
		.range {
			order: -1;
			white-space: nowrap;
		}
		/*
		 * The meta line keeps wallet and category: two lines instead of an ellipsis. rowMeta binds each "·" to the
		 * segment before it, so a wrapped line never starts with "· Tunai".
		 */
		.day :global(.meta) {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
	.hide-phone {
		display: contents;
	}
	/* The tab bar's Tambah is one tap away on a phone. */
	@media (max-width: 1023.98px) {
		.hide-phone {
			display: none;
		}
	}
	.range {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	.link,
	.more {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.too-large {
		margin: 0;
		padding: 20px 4px 8px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	.ok {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.more {
		justify-content: center;
		width: 100%;
		margin-top: 16px;
		border-radius: var(--r-pill);
		background: var(--panel);
		text-decoration: none;
	}
	.inline-pick {
		display: grid;
		gap: 8px;
		margin: 8px 0 16px;
	}
	.inline-pick h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	.pick {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 52px;
		padding: 4px 16px;
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.pick[aria-current='true'] {
		text-decoration: underline;
	}
	.meta {
		color: var(--muted);
		font-size: 13px;
		font-weight: 400;
	}
</style>
