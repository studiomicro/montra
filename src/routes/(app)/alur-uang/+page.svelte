<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { walletSeries } from '#lib/shared/brands';
	import { formatMonthLabel, formatShortMonth } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { laporanHref } from '#lib/shared/laporan-query';
	import { flowRiwayatHref, alurUangHref, stepFlowMonth } from '#lib/shared/money-flow';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import ChevronLinks from '#lib/ui/laporan/ChevronLinks.svelte';
	import FlowChart from '#lib/ui/charts/FlowChart.svelte';
	import '#lib/ui/charts/series.css';
	import { useI18n } from '#lib/ui/i18n-context';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr, trf, locale } = useI18n();

	const r = $derived(data.report);
	const month = $derived(data.month);
	const today = $derived(data.today);

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
			(navigating.to?.url.pathname === '/alur-uang' &&
				navigating.from?.url.pathname === '/alur-uang')
	);

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	const compact = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoneyCompact(minor, currency, locale));

	const prev = $derived(stepFlowMonth(month, -1, today));
	const next = $derived(stepFlowMonth(month, 1, today));

	type Report = NonNullable<typeof r>;
	const categoryName = (c: { name: string | null; isPreset: boolean }) =>
		c.name === null
			? tr('Tanpa kategori')
			: categoryLabel({ name: c.name, isPreset: c.isPreset }, tr);

	/** Every node's display name and colour by key. */
	const names = $derived(
		new Map<string, { name: string; series: string }>(
			r
				? [
						...r.income.map((n) => [n.key, { name: categoryName(n), series: n.tileKey }] as const),
						...r.wallets.map(
							(n) => [n.key, { name: n.name, series: walletSeries(n.name) }] as const
						),
						...r.expense.map((n) => [n.key, { name: categoryName(n), series: n.tileKey }] as const)
					]
				: []
		)
	);
	const empty = $derived(!!r && r.links.length === 0);
	/** The diagram is drawn only when every figure is exact (a too-large sum has no honest width). */
	const drawable = $derived(
		!!r &&
			r.links.every((l) => l.amountMinor !== null) &&
			r.wallets.every((w) => w.inMinor !== null && w.outMinor !== null) &&
			[...r.income, ...r.expense].every((n) => n.minor !== null)
	);

	/** A wallet's money out this month (what the page is about), or its money in when nothing went out. */
	const walletAmount = (w: Report['wallets'][number], currency: string) =>
		w.outMinor ? compact(-w.outMinor, currency) : `+${compact(w.inMinor, currency)}`;
	const walletText = (w: Report['wallets'][number], currency: string) =>
		trf('{masuk} masuk · {keluar} keluar', {
			masuk: money(w.inMinor, currency),
			keluar: money(w.outMinor, currency)
		});

	/** A link's Riwayat list: the month, its type, its category and its wallet. */
	function linkHref(rep: Report, from: string, to: string): string | null {
		const income = from.startsWith('in:');
		const categoryKey = income ? from : to;
		const walletKey = income ? to : from;
		const category = (income ? rep.income : rep.expense).find((n) => n.key === categoryKey);
		const wallet = rep.wallets.find((w) => w.key === walletKey);
		if (!category || !wallet) return null;
		return flowRiwayatHref(rep.month, {
			type: income ? 'income' : 'expense',
			categoryId: category.categoryId,
			walletId: wallet.walletId
		});
	}

	const columns = $derived(
		!r || !drawable
			? []
			: [
					r.income.map((n) => ({
						key: n.key,
						name: categoryName(n),
						amount: compact(n.minor, r.currency),
						label: `${categoryName(n)}: ${money(n.minor, r.currency)}`,
						value: n.minor ?? 0,
						series: n.tileKey,
						href: flowRiwayatHref(r.month, { type: 'income', categoryId: n.categoryId })
					})),
					r.wallets.map((w) => ({
						key: w.key,
						name: w.name,
						amount: walletAmount(w, r.currency),
						label: `${w.name}: ${walletText(w, r.currency)}`,
						value: Math.max(w.inMinor ?? 0, w.outMinor ?? 0),
						series: walletSeries(w.name),
						href: flowRiwayatHref(r.month, { type: null, walletId: w.walletId })
					})),
					r.expense.map((n) => ({
						key: n.key,
						name: categoryName(n),
						amount: compact(n.minor, r.currency),
						label: `${categoryName(n)}: ${money(n.minor, r.currency)}`,
						value: n.minor ?? 0,
						series: n.tileKey,
						href: flowRiwayatHref(r.month, { type: 'expense', categoryId: n.categoryId })
					}))
				]
	);
	const rows = $derived(
		!r
			? []
			: r.links.map((l) => {
					const from = names.get(l.from);
					const to = names.get(l.to);
					return {
						key: `${l.from}>${l.to}`,
						income: l.from.startsWith('in:'),
						text: `${from?.name ?? ''} → ${to?.name ?? ''}`,
						series: (l.from.startsWith('in:') ? from : to)?.series ?? 'lain',
						amount: money(l.amountMinor, r.currency),
						value: l.amountMinor ?? 0,
						href: linkHref(r, l.from, l.to)
					};
				})
	);
	const chartLinks = $derived(
		rows.map((row, i) => ({
			from: r?.links[i]?.from ?? '',
			to: r?.links[i]?.to ?? '',
			value: row.value,
			label: `${row.text}: ${row.amount}`,
			href: row.href
		}))
	);
</script>

<svelte:head><title>{tr('Alur uang')}</title></svelte:head>

<ScreenTitle title={tr('Alur uang')} subtitle={formatMonthLabel(month, locale)}>
	{#snippet actions()}
		<PeriodStepper
			label="{formatShortMonth(month, locale)} '{month.slice(2, 4)}"
			prevHref={prev ? alurUangHref(prev, today) : null}
			nextHref={next ? alurUangHref(next, today) : null}
		/>
	{/snippet}
</ScreenTitle>

{#if loading}
	<div class="loading" aria-busy="true">
		<Skeleton rows={4} />
		<Skeleton rows={2} />
	</div>
{:else if data.loadError || !r}
	<ErrorState
		text={tr(data.loadError ?? 'Alur uang tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<div class="page">
		<section class="summary" aria-labelledby="flow-summary">
			<h2 id="flow-summary" class="sr-only">{tr('Ringkasan alur uang')}</h2>
			<p class="totals num">
				{trf('{masuk} masuk · {keluar} keluar', {
					masuk: money(r.inMinor, r.currency),
					keluar: money(r.outMinor, r.currency)
				})}
			</p>
			<p class="muted">
				{trf('Ditampilkan dalam {mata_uang}. Transfer antardompet tidak dihitung.', {
					mata_uang: r.currency
				})}
				{#if r.otherCount > 0}
					{trf('+{n} transaksi mata uang lain ({mata_uang}) tidak ditampilkan.', {
						n: r.otherCount,
						mata_uang: r.otherCurrencies.join(', ')
					})}
				{/if}
			</p>
			{#if r.truncated}
				<p class="warn" role="note">
					{tr(
						'Terlalu banyak alur bulan ini: hanya yang terbesar yang ditampilkan dan dijumlahkan.'
					)}
				</p>
			{/if}
		</section>

		{#if empty}
			<section class="empty" aria-labelledby="flow-empty">
				<h2 id="flow-empty">{tr('Belum ada alur uang')}</h2>
				<p class="muted">{tr('Belum ada pemasukan atau pengeluaran di bulan ini.')}</p>
				<a class="link" href="/riwayat/baru">{tr('Catat transaksi')}</a>
			</section>
		{:else}
			<section class="block" aria-labelledby="flow-chart">
				<h2 id="flow-chart">{tr('Dari mana ke mana')}</h2>
				{#if drawable}
					<FlowChart
						{columns}
						links={chartLinks}
						heads={[tr('Pemasukan'), tr('Dompet'), tr('Pengeluaran')]}
						label={trf('Alur uang {bulan}: pemasukan ke dompet, dompet ke pengeluaran', {
							bulan: formatMonthLabel(month, locale)
						})}
					/>
				{:else}
					<p class="muted">{tr(TOO_LARGE)}</p>
				{/if}
			</section>

			<section class="block" aria-labelledby="flow-list">
				<h2 id="flow-list">{tr('Rincian alur')}</h2>
				<h3>{tr('Dompet')}</h3>
				<GroupList>
					{#each r.wallets as w (w.key)}
						<GroupRow
							href={flowRiwayatHref(r.month, { type: null, walletId: w.walletId }) ?? undefined}
						>
							<span class="dot series-{walletSeries(w.name)}" aria-hidden="true"></span>
							<span class="text">
								{w.name}
								<span class="meta num">{walletText(w, r.currency)}</span>
							</span>
						</GroupRow>
					{/each}
				</GroupList>
				{#each [true, false] as income (income)}
					{@const list = rows
						.filter((row) => row.income === income)
						.toSorted((a, b) => b.value - a.value)}
					{#if list.length > 0}
						<h3>{income ? tr('Masuk ke dompet') : tr('Keluar dari dompet')}</h3>
						<GroupList>
							{#each list as row (row.key)}
								<GroupRow href={row.href ?? undefined}>
									<span class="dot series-{row.series}" aria-hidden="true"></span>
									<span class="text">{row.text}</span>
									<span class="amount num">{row.amount}</span>
								</GroupRow>
							{/each}
						</GroupList>
					{/if}
				{/each}
			</section>
		{/if}

		<ChevronLinks
			links={[
				{
					href: laporanHref({ mode: 'bulan', month, direction: 'keluar' }, today),
					label: tr('Lihat di Laporan')
				}
			]}
		/>
	</div>
{/if}

<style>
	.loading {
		display: grid;
		gap: 24px;
		padding: 24px 0;
	}
	.page {
		display: grid;
		gap: 28px;
		max-width: 880px;
	}
	.summary,
	.block,
	.empty {
		display: grid;
		align-content: start;
		gap: 12px;
		min-width: 0;
	}
	.totals {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.muted {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.warn {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--warn-text);
	}
	.dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: var(--r-pill);
		background: var(--c);
	}
	.series-accent {
		--c: var(--accent);
	}
	.text {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	.text .meta {
		display: block;
		color: var(--muted);
		font-size: 13px;
		font-weight: 400;
	}
	.amount {
		flex: none;
		font-weight: 700;
	}
	/* A secondary action in the content: underlined, never bold like a heading. */
	.link {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 14px;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
