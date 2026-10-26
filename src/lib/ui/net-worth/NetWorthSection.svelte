<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { navigating } from '$app/state';
	import { groupDigits, minorToAmountText } from '#lib/shared/amount-input';
	import { formatDateTimeWib, formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import {
		formatQuantity,
		NET_WORTH_KIND_LABELS,
		NET_WORTH_KINDS,
		type NetWorthClass,
		type NetWorthFormValues,
		type NetWorthKind,
		type PriceSource,
		type ValueBasis
	} from '#lib/shared/net-worth';
	import { walletKindLabel, type WalletType } from '#lib/shared/wallets';
	import {
		missingSuggestions,
		sectionOfKind,
		TREND_RANGE_LABELS,
		TREND_RANGES,
		type Allocation,
		type TrendRange,
		type WealthSection,
		type WealthSuggestion
	} from '#lib/shared/wealth';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ChevronLinks from '#lib/ui/laporan/ChevronLinks.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import type { Snippet } from 'svelte';
	import AllocationBar from './AllocationBar.svelte';
	import CreditCardCard from './CreditCardCard.svelte';
	import type { DueChip as DueChipValue } from '#lib/shared/cards';
	import MissingSuggestions from './MissingSuggestions.svelte';
	import NetWorthItemForm from './NetWorthItemForm.svelte';
	import TrendChart from './TrendChart.svelte';

	interface Item {
		id: string;
		kind: NetWorthKind;
		name: string;
		currency: string;
		priceSource: PriceSource;
		priceSymbol: string | null;
		quantityScaled: string | null;
		quantityScale: number | null;
		manualValueMinor: number | null;
		acquiredOn: string | null;
		note: string | null;
		/** Fictional local-review row: badged, read-only, not in the total. */
		isDemo: boolean;
		updatedAt: number;
		valueMinor: number | null;
		basis: ValueBasis | null;
		priceAt: number | null;
		stale: boolean;
		unlisted: boolean;
	}
	interface Summary {
		totalMinor: number | null;
		classes: { cls: NetWorthClass; minor: number | null }[];
		unconverted: { currency: string; minor: number | null }[];
		rates: { currency: string; rate: string; date: string }[];
		items: Item[];
		missingCount: number;
	}
	interface Change {
		kind: 'days30' | 'since' | 'since_start';
		fromDate: string;
		deltaMinor: number;
	}
	interface Wallet {
		id: string;
		name: string;
		type: WalletType;
		emoneyIssuer: string | null;
		currency: string;
		balanceMinor: number | null;
	}
	type Totals = { currency: string; totalMinor: number | null }[];
	interface Card {
		walletId: string;
		name: string;
		lastFour: string | null;
		currency: string;
		from: string;
		to: string;
		totals: { currency: string; outMinor: number | null }[];
		/** FN-55a: limit − owed, or over the limit; null without a limit. */
		available?: { kind: 'available'; minor: number | null } | { kind: 'over' } | null;
		due?: DueChipValue | null;
	}

	let {
		netWorth,
		trend,
		creditCards,
		openItem,
		suggestion,
		result,
		children
	}: {
		netWorth: {
			summary: Summary | null;
			change: Change | null;
			wallets: Wallet[];
			allocation: Allocation | null;
			sections: Record<'wallets' | WealthSection, Totals> | null;
			error: string | null;
		};
		/** FN-25b: the stored daily totals of the chosen range. */
		trend: {
			range: TrendRange;
			points: { date: string; totalMinor: number; partial: boolean }[];
			failed: boolean;
		};
		/** FN-25b: the credit-card wallets' 30-day spend. */
		creditCards: { cards: Card[]; failed: boolean };
		/** `?aset=baru` or `?aset=<id>`: open the add or edit form (inline without JavaScript). */
		openItem: string | null;
		/** `&saran=`: the "Belum dihitung" card the new item is pre-filled from. */
		suggestion: WealthSuggestion | null;
		/** The rest of the page (Barang, Koleksi), at the end of the main column. */
		children?: Snippet;
		/** This section's part of the page's action result. */
		result: {
			nwAction?: 'create' | 'update';
			nwItemId?: string;
			nwErrors?: Partial<Record<string, string>>;
			nwValues?: NetWorthFormValues;
			nwSaved?: 'created' | 'updated' | 'deleted';
			nwError?: string;
		} | null;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const summary = $derived(netWorth.summary);
	const items = $derived(summary?.items ?? []);
	/**
	 * Items of the kinds without their own section (FN-25b moves stocks and gold to Investasi, crypto to Kripto),
	 * in the fixed kind order, each kind's items oldest first (as loaded).
	 */
	const groups = $derived(
		NET_WORTH_KINDS.filter((kind) => sectionOfKind(kind) === null)
			.map((kind) => ({ kind, items: items.filter((i) => i.kind === kind) }))
			.filter((g) => g.items.length > 0)
	);
	/** FN-25b's named sections, in page order. */
	const SECTIONS: readonly { key: WealthSection; title: string }[] = [
		{ key: 'investment', title: msg('Investasi') },
		{ key: 'crypto', title: msg('Kripto') }
	];
	const sectionItems = (section: WealthSection) =>
		items.filter((i) => sectionOfKind(i.kind) === section);
	const suggestions = $derived(missingSuggestions(items));

	/** A new item's fields, pre-filled from a "Belum dihitung" card (editable before saving). */
	const blank = (from: WealthSuggestion | null = null): NetWorthFormValues => ({
		kind: from === 'gold' ? 'investment_gold' : from === 'pension' ? 'other_asset' : 'cash',
		name: from === 'pension' ? tr('Dana pensiun BPJS JHT/DPLK') : '',
		currency: 'IDR',
		priceSource: from === 'gold' ? 'gold_api' : 'manual',
		symbol: '',
		quantity: '',
		manualValue: '',
		acquiredOn: '',
		note: ''
	});
	const valuesOf = (i: Item): NetWorthFormValues => ({
		kind: i.kind,
		name: i.name,
		currency: i.currency,
		priceSource: i.priceSource,
		symbol: i.priceSymbol?.toUpperCase() ?? '',
		quantity:
			i.quantityScaled !== null && i.quantityScale !== null
				? formatQuantity(i.quantityScaled, i.quantityScale, false)
				: '',
		manualValue: minorToAmountText(i.manualValueMinor, i.currency, locale),
		acquiredOn: i.acquiredOn ?? '',
		note: i.note ?? ''
	});

	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let editing = $state<Item | null>(null);
	let prefill = $state<WealthSuggestion | null>(null);
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	/** Opens the add sheet (also the page header's Tambah, FN-25b), pre-filled from a suggestion card. */
	export function openAdd(from: WealthSuggestion | null = null) {
		editing = null;
		prefill = from;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	function openEdit(i: Item) {
		editing = i;
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
		if (openItem === 'baru') openAdd(suggestion);
		else if (openItem) {
			const i = items.find((x) => x.id === openItem && !x.isDemo);
			if (i) openEdit(i);
		}
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('aset')) {
			url.searchParams.delete('aset');
			replaceState(url, {});
		}
	}

	/** Success shows only once the server confirmed; the figures are reloaded from the server either way. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result: r, update }) => {
				if (r.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update();
				if (r.type === 'failure') {
					fieldErrors = (r.data?.nwErrors as Partial<Record<string, string>>) ?? {};
					if (r.status === 404 || r.status === 409) {
						await invalidateAll();
						if (editing) {
							const id = editing.id;
							const fresh = items.find((i) => i.id === id);
							if (fresh) {
								editing = fresh;
								formKey++;
							} else sheetOpen = false;
						}
					}
				} else if (r.type === 'success') {
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
		created: msg('Aset ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		deleted: msg('Aset dihapus.')
	};
	const saved = $derived(
		result?.nwSaved && Object.hasOwn(savedText, result.nwSaved)
			? tr(savedText[result.nwSaved] as string)
			: ''
	);
	const banner = $derived(actionError || (result?.nwError ? tr(result.nwError) : '') || undefined);

	/** The no-JavaScript form: a refused submission, or the form `?aset=` asks for. */
	const inline = $derived.by(() => {
		if (result?.nwAction) {
			const item =
				result.nwAction === 'update'
					? items.find((i) => i.id === result.nwItemId && !i.isDemo)
					: undefined;
			if (result.nwAction === 'update' && !item) return null;
			return {
				item: item ?? null,
				values: result.nwValues ?? blank(),
				errors: result.nwErrors ?? {}
			};
		}
		if (openItem === 'baru') return { item: null, values: blank(suggestion), errors: {} };
		const item = openItem ? items.find((i) => i.id === openItem && !i.isDemo) : undefined;
		return item ? { item, values: valuesOf(item), errors: {} } : null;
	});

	const tooLarge = () => tr('Total terlalu besar untuk ditampilkan');
	// Every figure on the page follows the hero's eye button (amounts.hidden, FN-25b).
	const money = (minor: number | null, currency = 'IDR') =>
		minor === null ? tooLarge() : shown(formatMoney(minor, currency, 'auto', locale));

	/** The item's figure: a debt with a minus sign; nothing invented when there is no value. */
	const itemAmount = (i: Item) => {
		if (i.basis === null) return tr('Belum ada harga');
		if (i.valueMinor === null) return tooLarge();
		return shown(
			formatMoney(i.kind === 'debt' ? -i.valueMinor : i.valueMinor, i.currency, 'auto', locale)
		);
	};

	const when = (at: number) => formatDateTimeWib(at, locale);
	/** Where the figure comes from, with the price time; never presented as advice. */
	const sourceText = (i: Item) => {
		if (i.basis === 'manual') return tr('Nilai manual');
		if (i.unlisted)
			return i.basis === 'fallback'
				? tr('Kode koin tidak ada di Indodax, harga tidak tersedia. Memakai nilai manual.')
				: tr('Kode koin tidak ada di Indodax, harga tidak tersedia.');
		if (i.basis === 'fallback') return tr('Harga belum tersedia, memakai nilai manual');
		if (i.basis === null) return tr('Belum ada harga dan belum ada nilai manual');
		const at = i.priceAt ?? 0;
		if (i.stale) return trf('Harga terakhir {waktu}, belum diperbarui', { waktu: when(at) });
		return i.priceSource === 'gold_api'
			? trf('Harga emas: gold-api.com · {waktu}', { waktu: when(at) })
			: trf('Harga dari Indodax · {waktu}', { waktu: when(at) });
	};
	const quantityText = (i: Item) => {
		if (i.quantityScaled === null || i.quantityScale === null) return '';
		const q = formatQuantity(i.quantityScaled, i.quantityScale);
		return i.kind === 'investment_gold'
			? trf('{jumlah} gram', { jumlah: q })
			: `${q}${i.priceSymbol ? ` ${i.priceSymbol.toUpperCase()}` : ''}`;
	};

	const changeText = $derived.by(() => {
		const c = netWorth.change;
		if (!c) return '';
		const tanggal = formatShortDay(c.fromDate, locale);
		if (c.deltaMinor === 0)
			return c.kind === 'days30'
				? tr('Tidak berubah dalam 30 hari')
				: c.kind === 'since'
					? trf('Tidak berubah sejak {tanggal}', { tanggal })
					: trf('Tidak berubah sejak mulai mencatat ({tanggal})', { tanggal });
		const arah = c.deltaMinor > 0 ? tr('Naik') : tr('Turun');
		const jumlah = shown(formatMoneyCompact(Math.abs(c.deltaMinor), 'IDR', locale));
		return c.kind === 'days30'
			? trf('{arah} {jumlah} dalam 30 hari', { arah, jumlah })
			: c.kind === 'since'
				? trf('{arah} {jumlah} sejak {tanggal}', { arah, jumlah, tanggal })
				: trf('{arah} {jumlah} sejak mulai mencatat ({tanggal})', { arah, jumlah, tanggal });
	});
	/** `17881.5` → `17.881,5` (the stored decimal text, grouped; no float). */
	const rateText = (rate: string) => {
		const [whole = '', frac] = rate.split('.');
		return frac ? `${groupDigits(whole)},${frac}` : groupDigits(whole);
	};
	// FN-25b trend range: a GET form (`rentang`) that works without JavaScript; with it, a choice reloads the
	// page's data from the server at once (Laporan's pattern), never a client-side cache.
	const rangeOptions = $derived(
		TREND_RANGES.map((r) => ({ value: r, label: tr(TREND_RANGE_LABELS[r]) }))
	);
	function chooseRange(value: string) {
		if ((TREND_RANGES as readonly string[]).includes(value))
			void goto(value === '1m' ? '/kekayaan' : `/kekayaan?rentang=${value}`, {
				replace: true,
				reset: false
			});
	}
	const switching = $derived(
		navigating.to?.url.pathname === '/kekayaan' && navigating.from?.url.pathname === '/kekayaan'
	);
	const usesIndodax = $derived(items.some((i) => i.priceSource === 'indodax'));
	const usesGold = $derived(items.some((i) => i.priceSource === 'gold_api'));
</script>

{#snippet itemContent(item: Item)}
	<span class="text">
		<span class="name">{item.name}</span>
		{#if quantityText(item)}<span class="meta num">{quantityText(item)}</span>{/if}
		<span class="meta" class:warn={item.stale || item.unlisted || item.basis !== 'price'}>
			{sourceText(item)}
		</span>
		{#if item.isDemo}<span class="demo"><Badge>{tr('Data demo')}</Badge></span>{/if}
	</span>
	<span class="amount num" class:muted={item.basis === null}>
		{itemAmount(item)}
	</span>
{/snippet}

{#snippet itemForm(
	item: Item | null,
	values: NetWorthFormValues,
	errors: Partial<Record<string, string>>
)}
	<NetWorthItemForm
		action={item ? '?/updateItem' : '?/createItem'}
		item={item ?? undefined}
		{values}
		{errors}
		busy={busy !== ''}
		submit={track(item ? 'update' : 'create')}
	/>
	{#if item}
		<details class="confirm">
			<summary>{tr('Hapus aset')}</summary>
			<form method="POST" action="?/deleteItem" use:enhance={track('delete')}>
				<input type="hidden" name="itemId" value={item.id} />
				<input type="hidden" name="updatedAt" value={item.updatedAt} />
				<p>{tr('Aset ini dihapus dari daftar dan dari total. Ini tidak bisa dibatalkan.')}</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'delete' ? tr('Memproses…') : tr('Ya, hapus')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#snippet sectionHead(id: string, title: string, totals: Totals | undefined)}
	<div class="section-head">
		<h3 {id}>{title}</h3>
		{#if totals && totals.length > 0}
			<span class="subtotal num">
				{#each totals as t (t.currency)}<span>{money(t.totalMinor, t.currency)}</span>{/each}
			</span>
		{/if}
	</div>
{/snippet}

{#snippet itemRows(list: Item[], withAdd = false)}
	<GroupList>
		{#each list as item (item.id)}
			<GroupRow>
				{#if item.isDemo}
					<!-- Data demo rows are read-only: no edit form, the server refuses edits too. -->
					<div class="open">{@render itemContent(item)}</div>
				{:else}
					<a class="open" href="/kekayaan?aset={item.id}" onclick={intercept(() => openEdit(item))}>
						{@render itemContent(item)}
						<span class="sr-only">{tr('Ubah')}</span>
					</a>
				{/if}
			</GroupRow>
		{/each}
		<!-- "Tambah aset" closes the last group instead of floating as a card of its own (POLISH_AUDIT B5). -->
		{#if withAdd}
			<GroupRow>
				<a class="add" href="/kekayaan?aset=baru" onclick={intercept(() => openAdd())}>
					<Icon name="plus" size={20} />
					<span>{tr('Tambah aset')}</span>
				</a>
			</GroupRow>
		{/if}
	</GroupList>
{/snippet}

<section class="net-worth" aria-label={tr('Kekayaan bersih')}>
	{#if saved}<p class="ok" role="status">{saved}</p>{/if}
	{#if !sheetOpen}<FormBanner message={banner} />{/if}

	{#if !hydrated && inline}
		<section class="inline-form" aria-labelledby="nw-inline-title">
			<h3 id="nw-inline-title">{inline.item ? tr('Ubah aset') : tr('Tambah aset')}</h3>
			{@render itemForm(inline.item, inline.values, inline.errors)}
			<a class="cancel" href="/kekayaan">{tr('Batal')}</a>
		</section>
	{/if}

	{#if refreshing}
		<Skeleton rows={3} />
	{:else if netWorth.error || !summary}
		<ErrorState text={tr(netWorth.error ?? '')} onretry={retry} />
	{:else}
		<!-- FN-25b: one column on a phone; from 1024 px the hero, chart and lists on the left, the allocation,
			suggestions and credit cards on the right. -->
		<div class="layout two-col">
			<div class="hero-area">
				<!-- Nothing recorded yet (no wallet, no item): no figure at all, not an invented Rp 0. -->
				{#if summary.classes.length > 0 || items.length > 0}
					<HeroAmount
						label={tr('Nilai bersih')}
						amountMinor={summary.totalMinor}
						fallback={tooLarge()}
					>
						{#if changeText}
							<p
								class="change"
								class:up={(netWorth.change?.deltaMinor ?? 0) > 0}
								class:down={(netWorth.change?.deltaMinor ?? 0) < 0}
							>
								{changeText}
							</p>
						{:else}
							<p class="meta">{tr('Perubahan tampil setelah satu hari pencatatan.')}</p>
						{/if}
					</HeroAmount>
				{/if}

				{#if summary.missingCount > 0}
					<p class="note">
						{trf('{n} aset belum punya harga dan belum dihitung.', { n: summary.missingCount })}
					</p>
				{/if}
				{#if items.some((i) => i.isDemo)}
					<p class="note">
						<Badge>{tr('Data demo')}</Badge>
						<span>{tr('Baris Data demo tidak dihitung dalam total.')}</span>
					</p>
				{/if}
				{#if summary.unconverted.length > 0}
					<p class="note">
						{trf('Belum termasuk (kurs belum tersedia): {daftar}.', {
							daftar: summary.unconverted.map((u) => money(u.minor, u.currency)).join(', ')
						})}
					</p>
				{/if}
			</div>

			<section class="chart-area" aria-label={tr('Perjalanan kekayaan bersih')}>
				{#if switching}
					<Skeleton rows={2} />
				{:else if trend.failed}
					<ErrorState text={tr('Grafik tidak bisa dimuat.')} onretry={retry} />
				{:else if trend.points.length < 2}
					<p class="chart-empty">{tr('Grafik tampil setelah beberapa hari pencatatan.')}</p>
				{:else}
					<TrendChart points={trend.points} label={tr('Perjalanan kekayaan bersih')} />
				{/if}
				<form method="GET" action="/kekayaan" class="ranges">
					<Segmented
						name="rentang"
						label={tr('Rentang grafik')}
						options={rangeOptions}
						value={trend.range}
						onchange={hydrated ? chooseRange : undefined}
					/>
					{#if !hydrated}<Button type="submit" variant="secondary">{tr('Tampilkan')}</Button>{/if}
				</form>
				<!-- FN-53: the period report (opening, closing and change per month, quarter or year). -->
				<ChevronLinks
					links={[{ href: '/kekayaan/laporan', label: tr('Laporan kuartal dan tahun') }]}
				/>
			</section>

			<aside class="side">
				{#if netWorth.allocation && (netWorth.allocation.slices.length > 0 || netWorth.allocation.outside.length > 0)}
					<section aria-labelledby="nw-allocation-title">
						<h3 id="nw-allocation-title">{tr('Pembagian')}</h3>
						<AllocationBar allocation={netWorth.allocation} />
					</section>
				{/if}

				<MissingSuggestions {suggestions} onpick={(s) => openAdd(s)} />

				{#if creditCards.failed}
					<section aria-labelledby="nw-cards-title">
						<h3 id="nw-cards-title">{tr('Kartu kredit')}</h3>
						<p class="note">{tr('Tidak bisa dimuat')}</p>
					</section>
				{:else if creditCards.cards.length > 0}
					<section aria-labelledby="nw-cards-title">
						<div class="section-head">
							<h3 id="nw-cards-title">{tr('Kartu kredit')}</h3>
							<a class="text-link" href="/dompet">{tr('Lihat semua')}</a>
						</div>
						<div class="cards">
							{#each creditCards.cards as card (card.walletId)}
								<CreditCardCard {card} />
							{/each}
						</div>
					</section>
				{/if}
			</aside>

			<div class="main">
				{#if netWorth.wallets.length > 0}
					<section aria-labelledby="nw-wallets-title">
						{@render sectionHead('nw-wallets-title', tr('Dompet'), netWorth.sections?.wallets)}
						<GroupList>
							{#each netWorth.wallets as w (w.id)}
								<GroupRow href="/dompet?ubah={w.id}">
									<BrandBadge name={w.name} round />
									<span class="text">
										<span class="name">{w.name}</span>
										<span class="meta">{walletKindLabel(w, tr)}</span>
									</span>
									<span class="amount num">{money(w.balanceMinor, w.currency)}</span>
									<span class="chev" aria-hidden="true"
										><Icon name="chevron-right" size={18} /></span
									>
								</GroupRow>
							{/each}
						</GroupList>
					</section>
				{/if}

				{#each SECTIONS as sec (sec.key)}
					{@const list = sectionItems(sec.key)}
					{#if list.length > 0}
						<section aria-labelledby="nw-{sec.key}-title">
							{@render sectionHead(
								`nw-${sec.key}-title`,
								tr(sec.title),
								netWorth.sections?.[sec.key]
							)}
							{@render itemRows(list)}
						</section>
					{/if}
				{/each}

				<section aria-labelledby="nw-items-title">
					<h3 id="nw-items-title">{tr('Aset dan utang')}</h3>
					{#if items.length === 0}
						<EmptyState
							illustration="growth"
							text={tr('Belum ada aset. Catat rumah, emas, kripto, saham atau utang.')}
							actionLabel={tr('Tambah aset')}
							actionHref="/kekayaan?aset=baru"
							onaction={() => openAdd()}
						/>
					{:else}
						{#each groups as g, i (g.kind)}
							<h4 class="kind">{tr(NET_WORTH_KIND_LABELS[g.kind])}</h4>
							{@render itemRows(g.items, i === groups.length - 1)}
						{/each}
					{/if}
				</section>

				{@render children?.()}

				<div class="sources">
					{#each summary.rates as r (r.currency)}
						<p>
							{trf('Kurs {mata}: Rp {kurs} ({tanggal}, Frankfurter)', {
								mata: r.currency,
								kurs: rateText(r.rate),
								tanggal: formatShortDay(r.date, locale)
							})}
						</p>
					{/each}
					{#if usesIndodax}<p>{tr('Harga kripto dari Indodax.')}</p>{/if}
					{#if usesGold}<p>{tr('Harga emas dari gold-api.com, dikonversi ke rupiah.')}</p>{/if}
					<p>
						{tr(
							'Angka ini catatan dan perkiraan, bukan saran investasi. Aplikasi ini tidak menyimpan atau memindahkan asetmu.'
						)}
					</p>
				</div>
			</div>
		</div>
	{/if}
</section>

<Sheet
	bind:open={sheetOpen}
	title={editing ? tr('Ubah aset') : tr('Tambah aset')}
	onclose={onSheetClose}
>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render itemForm(editing, editing ? valuesOf(editing) : blank(prefill), fieldErrors)}
		{/key}
	{/if}
</Sheet>

<style>
	.net-worth {
		margin-top: 8px;
		margin-bottom: 32px;
	}
	.layout {
		display: grid;
		gap: 24px;
	}
	.layout > * {
		min-width: 0;
	}
	.side,
	.main {
		display: grid;
		align-content: start;
		gap: 24px;
	}
	/* FN-25b desktop, and the 860 px tablet tier (app +layout.svelte): Laporan's two-column proportions; the side
	 * column spans the hero, chart and lists rows, and any extra height goes to the last row, so the left column never
	 * gets gaps. */
	@media (min-width: 860px) {
		.layout {
			grid-template-columns: minmax(0, 37fr) minmax(300px, 21fr);
			grid-template-rows: auto auto 1fr;
			grid-template-areas: 'hero side' 'chart side' 'main side';
			column-gap: 40px;
		}
		.hero-area {
			grid-area: hero;
		}
		.chart-area {
			grid-area: chart;
		}
		.side {
			grid-area: side;
		}
		.main {
			grid-area: main;
		}
	}
	.chart-area {
		display: grid;
		gap: 12px;
	}
	.chart-empty {
		display: grid;
		place-items: center;
		min-height: 120px;
		margin: 0;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		color: var(--muted);
		font-size: 14px;
		text-align: center;
	}
	.ranges {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.section-head h3 {
		margin: 0;
	}
	.subtotal {
		display: grid;
		justify-items: end;
		color: var(--muted);
		font-size: 14px;
		font-weight: 600;
	}
	.cards {
		display: grid;
		gap: 12px;
	}
	h3 {
		margin: 0 0 12px;
		font-size: 19px;
		font-weight: 600;
	}
	h4.kind {
		margin: 16px 0 8px;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.change {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.change.up {
		color: var(--money-in);
	}
	.change.down {
		color: var(--money-up);
	}
	.meta {
		font-size: 14px;
		color: var(--muted);
	}
	p.meta {
		margin: 0;
	}
	.warn {
		color: var(--ink);
	}
	.note {
		margin: 8px 0 0;
		font-size: 14px;
		color: var(--muted);
	}
	.chev {
		display: grid;
		flex: none;
		color: var(--muted);
	}
	/* As on Dompet: a narrow phone row keeps its width for the name; the whole row opens the wallet. */
	@media (max-width: 479px) {
		.chev {
			display: none;
		}
	}
	.demo {
		margin-top: 4px;
	}
	.open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	/* Row title 15 / 600 and amount 15 / 700, as on Dompet (DESIGN_SYSTEM § Transaction row). */
	.name {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.amount {
		flex: none;
		max-width: 50%;
		font-size: 15px;
		font-weight: 700;
		text-align: right;
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--muted);
	}
	.add {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	.inline-form {
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--bg-soft);
	}
	.sources {
		margin-top: 16px;
		font-size: 13px;
		color: var(--muted);
	}
	.sources p {
		margin: 4px 0;
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
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
