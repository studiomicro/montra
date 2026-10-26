<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { walletSeries } from '#lib/shared/brands';
	import { formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { laporanHref } from '#lib/shared/laporan-query';
	import { FOLDED_ID, flowRiwayatHref, alurUangHref } from '#lib/shared/money-flow';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import {
		periodName,
		periodStepLabel,
		periodTitle,
		reportPeriodHref
	} from '#lib/shared/report-period';
	import { categoryLabel } from '#lib/shared/transactions';
	import ChevronLinks from '#lib/ui/laporan/ChevronLinks.svelte';
	import ReportPeriodNav from '#lib/ui/laporan/ReportPeriodNav.svelte';
	import FlowChart from '#lib/ui/charts/FlowChart.svelte';
	import '#lib/ui/charts/series.css';
	import { useI18n } from '#lib/ui/i18n-context';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import {
		amounts,
		applyAmountsHiddenAtLoad,
		loadAmountsHidden,
		shown
	} from '#lib/ui/kit/amounts.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	// FN-53 (AC 33): the eye's cookie choice masks every figure of this page from the first server render; the
	// device's stored choice applies on mount, and leaving the page shows amounts again (HeroAmount's rule).
	applyAmountsHiddenAtLoad();
	onMount(() => {
		loadAmountsHidden();
		return () => {
			amounts.hidden = false;
		};
	});
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	const r = $derived(data.report);
	const period = $derived(data.period);
	const today = $derived(data.today);
	/** The Riwayat filter of the period: its month, or its date range for a quarter or year. */
	const riwayatPeriod = $derived(
		r ? (period.kind === 'bulan' ? period.month : { from: r.from, to: r.to }) : ''
	);

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

	const subtitle = $derived(
		r?.partial && period.kind !== 'bulan'
			? `${periodTitle(period, i18n)} · ${tr('sejauh ini')}`
			: periodTitle(period, i18n)
	);

	type Report = NonNullable<typeof r>;
	const categoryName = (c: { categoryId: string; name: string | null; isPreset: boolean }) =>
		c.categoryId === FOLDED_ID
			? tr('Lainnya')
			: c.name === null
				? tr('Tanpa kategori')
				: categoryLabel({ name: c.name, isPreset: c.isPreset }, tr);
	const walletName = (w: { walletId: string; name: string }) =>
		w.walletId === FOLDED_ID ? tr('Dompet lainnya') : w.name;
	const walletColour = (w: { walletId: string; name: string }) =>
		w.walletId === FOLDED_ID ? 'lain' : walletSeries(w.name);

	/** Every node's display name and colour by key. */
	const names = $derived(
		new Map<string, { name: string; series: string }>(
			r
				? [
						...r.income.map((n) => [n.key, { name: categoryName(n), series: n.tileKey }] as const),
						...r.wallets.map(
							(n) => [n.key, { name: walletName(n), series: walletColour(n) }] as const
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

	/** A wallet's money out in the period (what the page is about), or its money in when nothing went out. */
	const walletAmount = (w: Report['wallets'][number], currency: string) =>
		w.outMinor ? compact(-w.outMinor, currency) : `+${compact(w.inMinor, currency)}`;
	const walletText = (w: Report['wallets'][number], currency: string) =>
		trf('{masuk} masuk · {keluar} keluar', {
			masuk: money(w.inMinor, currency),
			keluar: money(w.outMinor, currency)
		});

	/** A link's Riwayat list: the period, its type, its category and its wallet. */
	function linkHref(rep: Report, from: string, to: string): string | null {
		const income = from.startsWith('in:');
		const categoryKey = income ? from : to;
		const walletKey = income ? to : from;
		const category = (income ? rep.income : rep.expense).find((n) => n.key === categoryKey);
		const wallet = rep.wallets.find((w) => w.key === walletKey);
		if (!category || !wallet) return null;
		return flowRiwayatHref(riwayatPeriod, {
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
						href: flowRiwayatHref(riwayatPeriod, { type: 'income', categoryId: n.categoryId })
					})),
					r.wallets.map((w) => ({
						key: w.key,
						name: walletName(w),
						amount: walletAmount(w, r.currency),
						label: `${walletName(w)}: ${walletText(w, r.currency)}`,
						value: Math.max(w.inMinor ?? 0, w.outMinor ?? 0),
						series: walletColour(w),
						href: flowRiwayatHref(riwayatPeriod, { type: null, walletId: w.walletId })
					})),
					r.expense.map((n) => ({
						key: n.key,
						name: categoryName(n),
						amount: compact(n.minor, r.currency),
						label: `${categoryName(n)}: ${money(n.minor, r.currency)}`,
						value: n.minor ?? 0,
						series: n.tileKey,
						href: flowRiwayatHref(riwayatPeriod, { type: 'expense', categoryId: n.categoryId })
					}))
				]
	);
	const linkRow = (rep: Report, l: Report['links'][number]) => {
		const from = names.get(l.from);
		const to = names.get(l.to);
		return {
			key: `${l.from}>${l.to}`,
			text: `${from?.name ?? ''} → ${to?.name ?? ''}`,
			series: (l.from.startsWith('in:') ? from : to)?.series ?? 'lain',
			amount: money(l.amountMinor, rep.currency),
			value: l.amountMinor ?? 0,
			href: linkHref(rep, l.from, l.to)
		};
	};
	const chartLinks = $derived(
		!r
			? []
			: r.links.map((l) => {
					const row = linkRow(r, l);
					return {
						from: l.from,
						to: l.to,
						value: row.value,
						label: `${row.text}: ${row.amount}`,
						href: row.href
					};
				})
	);

	/**
	 * "Rp 25.000 lebih banyak dari Q3 2026" in rupiah (never percent); the glyph and the words carry the direction.
	 * While amounts are hidden neither the words nor the glyph say which way it went (red team L2): "•••• dibanding
	 * Q3 2026" with a neutral dot, from the first server render.
	 */
	const previousName = $derived(r?.comparison ? periodName(r.comparison.previous, locale) : '');
	function compareText(diff: number | null, currency: string): string {
		if (diff === null) return tr(TOO_LARGE);
		if (amounts.hidden)
			return trf('{jumlah} dibanding {periode}', {
				jumlah: money(Math.abs(diff), currency),
				periode: previousName
			});
		if (diff === 0) return trf('Sama dengan {periode}', { periode: previousName });
		return trf(
			diff > 0 ? '{jumlah} lebih banyak dari {periode}' : '{jumlah} lebih sedikit dari {periode}',
			{
				jumlah: money(Math.abs(diff), currency),
				periode: previousName
			}
		);
	}
	const glyph = (diff: number | null) =>
		amounts.hidden ? '•' : diff === null || diff === 0 ? '=' : diff > 0 ? '↑' : '↓';

	const laporanLink = $derived(
		period.kind === 'bulan'
			? laporanHref({ mode: 'bulan', month: period.month, direction: 'keluar' }, today)
			: laporanHref({ mode: 'tahun', year: period.year, direction: 'keluar' }, today)
	);
</script>

<svelte:head><title>{tr('Alur uang')}</title></svelte:head>

<ScreenTitle title={tr('Alur uang')} {subtitle}>
	{#snippet actions()}
		<ReportPeriodNav path="/alur-uang" {period} {today} defaultKind="bulan" />
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
			<!-- One number first (POLISH_AUDIT B1): the period's money out, with the in/out line as its context. -->
			<HeroAmount
				label={tr('Uang keluar')}
				amountMinor={r.outMinor}
				currency={r.currency}
				fallback={tr(TOO_LARGE)}
			>
				<p class="hero-line num">
					{trf('{masuk} masuk · {keluar} keluar', {
						masuk: money(r.inMinor, r.currency),
						keluar: money(r.outMinor, r.currency)
					})}
				</p>
			</HeroAmount>
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
						'Terlalu banyak alur di periode ini: hanya yang terbesar yang ditampilkan dan dijumlahkan.'
					)}
				</p>
			{/if}
		</section>

		<section class="block" aria-labelledby="flow-compare">
			<h2 id="flow-compare">{tr('Perbandingan')}</h2>
			{#if !r.comparison}
				<p class="none">{tr('Tidak ada periode sebelumnya')}</p>
			{:else if !r.comparison.hasRows}
				<p class="none">{trf('Belum ada data {periode}', { periode: previousName })}</p>
			{:else}
				<ul class="compare num">
					{#each [{ key: 'in', label: tr('Uang masuk'), diff: r.comparison.diff.inMinor }, { key: 'out', label: tr('Uang keluar'), diff: r.comparison.diff.outMinor }, { key: 'net', label: tr('Selisih'), diff: r.comparison.diff.netMinor }] as line (line.key)}
						<li
							class="compare-line"
							class:up={line.key === 'net' && !amounts.hidden && (line.diff ?? 0) > 0}
							class:down={line.key === 'net' && !amounts.hidden && (line.diff ?? 0) < 0}
						>
							<span class="glyph" aria-hidden="true">{glyph(line.diff)}</span>
							<span class="compare-label">{line.label}</span>
							<span>{compareText(line.diff, r.currency)}</span>
						</li>
					{/each}
				</ul>
				{#if r.comparison.cut}
					<p class="muted">
						{trf('Dibandingkan dengan {periode} sampai {tanggal}.', {
							periode: previousName,
							tanggal: formatShortDay(r.comparison.to, locale)
						})}
					</p>
				{/if}
			{/if}
		</section>

		{#if r.average}
			<section class="block" aria-labelledby="flow-average">
				<h2 id="flow-average">{tr('Rata-rata per bulan')}</h2>
				<p class="totals num">
					{trf('{masuk} masuk · {keluar} keluar', {
						masuk: money(r.average.inMinor, r.currency),
						keluar: money(r.average.outMinor, r.currency)
					})}
				</p>
				<p class="muted">{trf('Dibagi {n} bulan berjalan.', { n: r.average.months })}</p>
			</section>
		{/if}

		{#if empty}
			<section class="empty" aria-labelledby="flow-empty">
				<h2 id="flow-empty">{tr('Belum ada alur uang')}</h2>
				<p class="muted">
					{trf('Belum ada pemasukan atau pengeluaran di {periode}.', {
						periode: periodName(period, locale)
					})}
				</p>
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
							bulan: periodTitle(period, i18n)
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
							href={flowRiwayatHref(riwayatPeriod, { type: null, walletId: w.walletId }) ??
								undefined}
						>
							<span class="dot series-{walletColour(w)}" aria-hidden="true"></span>
							<span class="text">
								{walletName(w)}
								<span class="meta num">{walletText(w, r.currency)}</span>
							</span>
						</GroupRow>
					{/each}
				</GroupList>
				{#each [{ key: 'in', list: r.lists.income, title: tr('Masuk ke dompet') }, { key: 'out', list: r.lists.expense, title: tr('Keluar dari dompet') }] as side (side.key)}
					{#if side.list.links.length > 0}
						<h3>{side.title}</h3>
						<GroupList>
							{#each side.list.links.map((l) => linkRow(r, l)) as row (row.key)}
								<GroupRow href={row.href ?? undefined}>
									<span class="dot series-{row.series}" aria-hidden="true"></span>
									<span class="text">{row.text}</span>
									<span class="amount num">{row.amount}</span>
								</GroupRow>
							{/each}
							{#if side.list.rest}
								<GroupRow>
									<span class="dot series-lain" aria-hidden="true"></span>
									<span class="text">{trf('Alur lainnya ({n})', { n: side.list.rest.count })}</span>
									<span class="amount num">{money(side.list.rest.minor, r.currency)}</span>
								</GroupRow>
							{/if}
						</GroupList>
					{/if}
				{/each}
			</section>
		{/if}

		{#if r.months}
			<section class="block" aria-labelledby="flow-months">
				<h2 id="flow-months">{tr('Per bulan')}</h2>
				<GroupList>
					{#each r.months as m (m.month)}
						<GroupRow href={alurUangHref(m.month, today)}>
							<span class="text">{periodStepLabel({ kind: 'bulan', month: m.month }, locale)}</span>
							<span class="amount num month-amounts">
								<span class="in"
									>{m.inMinor === null
										? tr(TOO_LARGE)
										: shown(formatMoney(m.inMinor, r.currency, 'signed', locale))}</span
								>
								<span class="out"
									>{m.outMinor === null
										? tr(TOO_LARGE)
										: shown(formatMoney(-m.outMinor, r.currency, 'auto', locale))}</span
								>
							</span>
						</GroupRow>
					{/each}
				</GroupList>
			</section>
		{/if}

		<ChevronLinks
			links={[
				{ href: laporanLink, label: tr('Lihat di Laporan') },
				{
					href: reportPeriodHref('/kekayaan/laporan', period, today, 'kuartal'),
					label: tr('Lihat laporan kekayaan')
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
	.hero-line {
		margin: 0;
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
	.none {
		justify-self: start;
		margin: 0;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
	}
	.compare {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.compare-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
		font-size: 15px;
	}
	.compare-label {
		min-width: 64px;
		font-weight: 600;
	}
	.glyph {
		width: 1em;
		font-weight: 700;
		color: var(--muted);
	}
	.compare-line.up .glyph {
		color: var(--money-in);
	}
	.compare-line.down .glyph {
		color: var(--money-up);
	}
	.month-amounts {
		display: grid;
		justify-items: end;
		font-weight: 600;
	}
	.month-amounts .out {
		color: var(--muted);
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
