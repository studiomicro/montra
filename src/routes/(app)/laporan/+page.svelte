<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatMonthName, formatShortDay, formatShortMonth } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { laporanHref, laporanRiwayatHref } from '#lib/shared/laporan-query';
	import { alurUangHref } from '#lib/shared/money-flow';
	import { reportPeriodHref } from '#lib/shared/report-period';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import CumulativeChart from '#lib/ui/charts/CumulativeChart.svelte';
	import Donut from '#lib/ui/charts/Donut.svelte';
	import HeatCalendar from '#lib/ui/charts/HeatCalendar.svelte';
	import StackedBars from '#lib/ui/charts/StackedBars.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Chip from '#lib/ui/kit/Chip.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import { richParts, type RichPart } from '#lib/ui/kit/rich';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import { joinMeta, rowShare } from '#lib/ui/transactions/row-text';
	import CompareLine from '#lib/ui/laporan/CompareLine.svelte';
	import ChevronLinks from '#lib/ui/laporan/ChevronLinks.svelte';
	import CategoryGrid from '#lib/ui/laporan/CategoryGrid.svelte';
	import CategoryList from '#lib/ui/laporan/CategoryList.svelte';
	import PeriodNav from '#lib/ui/laporan/PeriodNav.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const { tr, trf, locale } = useI18n();

	const r = $derived(data.report);
	const view = $derived(data.view);
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
			(navigating.to?.url.pathname === '/laporan' && navigating.from?.url.pathname === '/laporan')
	);

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const OTHER = msg('Lainnya');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	/**
	 * One sign rule for every list on the page (POLISH_AUDIT B3): an expense figure reads "−Rp", income "+Rp", as
	 * in "Pengeluaran terbesar" (DESIGN_SYSTEM § Formatting). The hero stays an unsigned total.
	 */
	const listMoney = (minor: number | null, currency: string) =>
		minor === null
			? tr(TOO_LARGE)
			: shown(formatMoney(isOut ? -minor : minor, currency, 'signed', locale));
	const compact = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoneyCompact(minor, currency, locale));
	const allKnown = (values: (number | null)[]): values is number[] =>
		values.every((v) => v !== null);

	const isOut = $derived(view.direction === 'keluar');
	const main = $derived(r?.stats[0]);
	const range = $derived(r ? { from: r.from, to: r.to } : null);
	/**
	 * Nothing in or out in the period, in any currency (a figure too large to show is not "nothing"): one empty
	 * state instead of an empty heatmap, a flat line and "Rp0 tersisa" (POLISH_AUDIT B6).
	 */
	const periodEmpty = $derived(!!r && r.stats.every((s) => s.inMinor === 0 && s.outMinor === 0));

	function nameOf(c: { key: string; name: string | null; isPreset: boolean }) {
		if (c.key === '*') return tr(OTHER);
		return c.name === null
			? tr('Tanpa kategori')
			: categoryLabel({ name: c.name, isPreset: c.isPreset }, tr);
	}

	const categoryRows = $derived(
		!r || !range
			? []
			: r.categories.map((c) => {
					const per =
						c.perUnitMinor === null
							? ''
							: r.detail.mode === 'bulan'
								? trf('{jumlah}/hari', { jumlah: compact(c.perUnitMinor, r.currency) })
								: trf('{jumlah}/bln', { jumlah: compact(c.perUnitMinor, r.currency) });
					return {
						name: nameOf(c),
						tileKey: c.tileKey,
						detail: c.percent === null ? per : `${c.percent}% · ${per}`,
						amount: listMoney(c.minor, r.currency),
						href: c.key ? laporanRiwayatHref(range, view.direction, c.key) : null
					};
				})
	);
	const categoriesKnown = $derived(!!r && allKnown(r.categories.map((c) => c.minor)));
	const donutSlices = $derived(
		!r || !range || !categoriesKnown
			? []
			: r.categories.map((c) => ({
					series: c.tileKey,
					minor: c.minor ?? 0,
					label: `${nameOf(c)}: ${money(c.minor, r.currency)}`,
					href: c.key ? laporanRiwayatHref(range, view.direction, c.key) : null
				}))
	);

	const periodName = $derived(
		r?.detail.mode === 'bulan'
			? formatMonthName(r.detail.month, locale)
			: r?.detail.mode === 'tahun'
				? r.detail.year
				: ''
	);
	const previousName = $derived(
		r?.detail.mode === 'bulan'
			? formatMonthName(r.detail.previousMonth, locale)
			: r?.detail.mode === 'tahun'
				? r.detail.previousYear
				: ''
	);

	function rowMeta(row: NonNullable<typeof r>['largest'][number]): string {
		const parts = [formatShortDay(row.occurredOn, locale)];
		if (row.category)
			parts.push(categoryLabel({ name: row.category.name, isPreset: row.category.isPreset }, tr));
		if (row.wallet.name) parts.push(row.wallet.name);
		return joinMeta(parts);
	}
</script>

<svelte:head><title>{tr('Laporan')}</title></svelte:head>

{#snippet rich(parts: RichPart[])}
	{#each parts as part, i (i)}{#if part.strong}<strong>{part.text}</strong
			>{:else}{part.text}{/if}{/each}
{/snippet}

<ScreenTitle title={tr('Laporan')}>
	{#snippet actions()}<PeriodNav {view} {today} />{/snippet}
</ScreenTitle>

{#if loading}
	<div class="loading" aria-busy="true">
		<Skeleton rows={3} />
		<Skeleton rows={2} />
	</div>
{:else if data.loadError || !r || !main || !range}
	<ErrorState
		text={tr(data.loadError ?? 'Laporan tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<!-- `two-col` opts into the shell's 1200 px desktop width (APP_PARITY § 1), as Beranda does. -->
	<div class="cols two-col">
		<div class="col">
			<section class="hero" aria-labelledby="hero-title">
				<h2 id="hero-title" class="sr-only">{tr('Pemasukan dan pengeluaran')}</h2>
				<HeroAmount
					label={isOut ? tr('Uang keluar') : tr('Uang masuk')}
					amountMinor={r.directionMinor}
					currency={r.currency}
					fallback={tr(TOO_LARGE)}
				>
					<!-- One line: the hero's context slot is a grid, so bare text nodes would stack. -->
					{#if !periodEmpty}<p class="hero-line num">
							{#if isOut}
								{@render rich(
									richParts(tr('dari {jumlah} pemasukan'), {
										jumlah: compact(main.inMinor, r.currency)
									})
								)}
							{:else}
								{@render rich(
									richParts(tr('{jumlah} keluar'), { jumlah: compact(main.outMinor, r.currency) })
								)}
							{/if}
							·
							{#if main.netMinor !== null && main.netMinor < 0}
								<span class="over"
									>{trf('{jumlah} melebihi pemasukan', {
										jumlah: compact(-main.netMinor, r.currency)
									})}</span
								>
							{:else}
								<span class="left"
									>{trf('{jumlah} tersisa', { jumlah: compact(main.netMinor, r.currency) })}</span
								>
							{/if}
						</p>{/if}
				</HeroAmount>
				{#each r.stats.slice(1) as s (s.currency)}
					<p class="other num">
						{s.currency}: {trf('{masuk} masuk · {keluar} keluar', {
							masuk: money(s.inMinor, s.currency),
							keluar: money(s.outMinor, s.currency)
						})}
					</p>
				{/each}
				<nav class="chips" aria-label={tr('Jenis transaksi')}>
					<Chip href={laporanHref({ ...view, direction: 'keluar' }, today)} selected={isOut}>
						{tr('Pengeluaran')}
					</Chip>
					<Chip href={laporanHref({ ...view, direction: 'masuk' }, today)} selected={!isOut}>
						{tr('Pemasukan')}
					</Chip>
				</nav>
				{#if r.otherCurrencies.length > 0}
					<p class="muted">
						{trf('Rincian di bawah hanya dalam {mata_uang}.', { mata_uang: r.currency })}
					</p>
				{/if}
			</section>

			{#if periodEmpty}
				<EmptyState
					mascot={false}
					text={tr('Belum ada transaksi di periode ini.')}
					actionLabel={tr('Catat transaksi')}
					actionHref="/riwayat/baru"
				/>
			{:else if r.detail.mode === 'bulan'}
				{@const d = r.detail}
				<section class="block" aria-labelledby="heat-title">
					<h2 id="heat-title">{tr('Tren harian')}</h2>
					{#if !allKnown(d.heatmap.map((x) => x.minor))}
						<p class="muted">{tr(TOO_LARGE)}</p>
					{:else}
						<HeatCalendar
							days={d.heatmap}
							{today}
							currency={r.currency}
							label={isOut ? tr('Pengeluaran per hari') : tr('Pemasukan per hari')}
							hrefFor={(date) => laporanRiwayatHref({ from: date, to: date }, view.direction)}
						/>
					{/if}
				</section>

				<section class="block" aria-labelledby="trend-title">
					<h2 id="trend-title">{isOut ? tr('Tren pengeluaran') : tr('Tren pemasukan')}</h2>
					{#if !allKnown(d.lines.current) || !allKnown(d.lines.previous)}
						<p class="muted">{tr(TOO_LARGE)}</p>
					{:else}
						<CumulativeChart
							current={d.lines.current}
							previous={d.lines.previous}
							axisLength={d.lines.previous.length}
							slotLabel={(i) =>
								formatShortDay(`${d.month}-${String(i + 1).padStart(2, '0')}`, locale)}
							currentName={periodName}
							{previousName}
							markerIndex={d.month === today.slice(0, 7) ? d.elapsed - 1 : null}
							currency={r.currency}
							label={trf('{bulan} dibanding {sebelumnya}', {
								bulan: periodName,
								sebelumnya: previousName
							})}
						/>
						{#if isOut}
							<CompareLine
								currentMinor={d.lines.current.at(-1) ?? 0}
								diffMinor={d.lines.diffMinor}
								monthName={previousName}
							/>
						{/if}
					{/if}
				</section>

				<div class="pair">
					<section class="block" aria-labelledby="places-title">
						<h2 id="places-title">{tr('Tempat teratas')}</h2>
						{#if r.merchants.length === 0}
							<p class="muted">{tr('Belum ada transaksi di periode ini.')}</p>
						{:else}
							<GroupList>
								{#each r.merchants as m, i (i)}
									<GroupRow>
										<span class="rank num" aria-hidden="true">{i + 1}</span>
										<span class="place">
											<span class="name">{m.title ?? tr('Tanpa judul')}</span>
											{#if m.count > 1}<span class="meta num">{trf('{n}×', { n: m.count })}</span
												>{/if}
										</span>
										<span class="amount num" class:income={!isOut}
											>{listMoney(m.amountMinor, r.currency)}</span
										>
									</GroupRow>
								{/each}
							</GroupList>
						{/if}
					</section>
					<section class="block" aria-labelledby="largest-title">
						<h2 id="largest-title">
							{isOut ? tr('Pengeluaran terbesar') : tr('Pemasukan terbesar')}
						</h2>
						{#if r.largest.length === 0}
							<p class="muted">{tr('Belum ada transaksi di periode ini.')}</p>
						{:else}
							<GroupList>
								{#each r.largest as row (row.id)}
									<TransactionRow
										title={row.title ??
											(row.category
												? categoryLabel(
														{ name: row.category.name, isPreset: row.category.isPreset },
														tr
													)
												: tr('Tanpa judul'))}
										meta={rowMeta(row)}
										amountMinor={row.type === 'expense' ? -row.amountMinor : row.amountMinor}
										currency={row.currency}
										category={row.category?.tileKey ?? 'lain'}
										share={rowShare(row, { tr, trf, locale })}
										href="/riwayat/{row.id}/edit"
									/>
								{/each}
							</GroupList>
						{/if}
					</section>
				</div>
			{:else}
				{@const d = r.detail}
				<section class="block" aria-labelledby="bars-title">
					<h2 id="bars-title">{tr('Tren bulanan')}</h2>
					{#if !allKnown(d.stack.map((m) => m.total)) || d.averageMinor === null}
						<p class="muted">{tr(TOO_LARGE)}</p>
					{:else}
						<StackedBars
							months={d.stack.map((m) => ({
								label: formatShortMonth(m.month, locale),
								total: m.total ?? 0,
								segments: m.segments.map((s, i) => ({
									series: s.key === '*' ? 'other' : (d.stackKeys[i]?.tileKey ?? 'lain'),
									minor: s.minor ?? 0
								}))
							}))}
							averageMinor={d.averageMinor}
							legend={d.stackKeys.map((k) => ({
								series: k.key === '*' ? 'other' : k.tileKey,
								label: nameOf(k)
							}))}
							currency={r.currency}
							label={isOut ? tr('Pengeluaran per bulan') : tr('Pemasukan per bulan')}
						/>
					{/if}
				</section>

				<section class="block" aria-labelledby="trend-title">
					<h2 id="trend-title">{isOut ? tr('Tren pengeluaran') : tr('Tren pemasukan')}</h2>
					{#if !allKnown(d.lines.current) || !allKnown(d.lines.previous)}
						<p class="muted">{tr(TOO_LARGE)}</p>
					{:else}
						<CumulativeChart
							current={d.lines.current}
							previous={d.lines.previous}
							axisLength={12}
							slotLabel={(i) =>
								formatShortMonth(`${d.year}-${String(i + 1).padStart(2, '0')}`, locale)}
							currentName={d.year}
							previousName={d.previousYear}
							markerIndex={d.year === today.slice(0, 4) ? d.months.length - 1 : null}
							currency={r.currency}
							label={trf('{bulan} dibanding {sebelumnya}', {
								bulan: d.year,
								sebelumnya: d.previousYear
							})}
						/>
						{#if isOut}
							<CompareLine
								currentMinor={d.lines.current.at(-1) ?? 0}
								diffMinor={d.lines.diffMinor}
								monthName={d.previousYear}
							/>
						{/if}
					{/if}
				</section>

				<section class="block" aria-labelledby="grid-title">
					<h2 id="grid-title">{tr('Kategori dari waktu ke waktu')}</h2>
					{#if d.grid.length === 0}
						<p class="muted">{tr('Belum ada transaksi di periode ini.')}</p>
					{:else if !allKnown(d.grid.flatMap((g) => [g.total, ...g.cells.map((c) => c.minor)]))}
						<p class="muted">{tr(TOO_LARGE)}</p>
					{:else}
						<CategoryGrid
							rows={d.grid.map((g) => ({
								name: nameOf(g),
								tileKey: g.tileKey,
								cells: g.cells.map((c) => ({ minor: c.minor ?? 0, level: c.level })),
								total: g.total ?? 0
							}))}
							months={d.months}
							currency={r.currency}
							label={tr('Kategori dari waktu ke waktu')}
						/>
					{/if}
				</section>
			{/if}
		</div>

		{#if !periodEmpty}<aside class="col side" aria-labelledby="where-title">
				<section class="block">
					<h2 id="where-title">{isOut ? tr('Ke mana uangnya') : tr('Dari mana uangnya')}</h2>
					{#if r.categories.length === 0}
						<p class="muted">{tr('Belum ada transaksi di periode ini.')}</p>
					{:else}
						{#if categoriesKnown}
							<Donut
								slices={donutSlices}
								title={isOut ? tr('Uang keluar') : tr('Uang masuk')}
								value={compact(r.directionMinor, r.currency)}
								sub={trf('{n} kategori', { n: r.categories.length })}
								label={isOut ? tr('Pengeluaran per kategori') : tr('Pemasukan per kategori')}
							/>
						{:else}
							<p class="muted">{tr(TOO_LARGE)}</p>
						{/if}
						<CategoryList rows={categoryRows} income={!isOut} />
					{/if}
					<ChevronLinks
						links={[
							{
								href: laporanRiwayatHref(range, view.direction),
								label: tr('Lihat semua di Riwayat')
							},
							{
								href:
									view.mode === 'bulan'
										? alurUangHref(view.month, today)
										: reportPeriodHref(
												'/alur-uang',
												{ kind: 'tahun', year: view.year },
												today,
												'bulan'
											),
								label: tr('Lihat alur uang')
							}
						]}
					/>
				</section>
			</aside>{/if}
	</div>
{/if}

<style>
	.loading {
		display: grid;
		gap: 24px;
		padding: 24px 0;
	}
	.cols {
		display: grid;
		gap: 28px;
	}
	.col {
		display: grid;
		align-content: start;
		gap: 28px;
		min-width: 0;
		/* .pair splits on the column's own width, never the window's (the column can be far narrower). */
		container-type: inline-size;
	}
	/* The tablet tier (860 – 1023 px, no sidebar; app +layout.svelte) and the full desktop width. */
	@media (min-width: 860px) and (max-width: 1023.98px), (min-width: 1200px) {
		.cols {
			/* 740 : 420 at the full 1200 px; narrower content keeps the same proportions. */
			grid-template-columns: minmax(0, 37fr) minmax(300px, 21fr);
			gap: 40px;
		}
	}
	.pair {
		display: grid;
		gap: 28px;
	}
	@container (min-width: 600px) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 20px;
		}
	}
	.hero {
		display: grid;
		gap: 8px;
	}
	.hero-line {
		margin: 0;
	}
	.left {
		color: var(--money-in);
		font-weight: 700;
	}
	.over {
		color: var(--money-up);
		font-weight: 700;
	}
	.other {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.block {
		display: grid;
		align-content: start;
		gap: 12px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	.muted {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.rank {
		width: 20px;
		flex: none;
		color: var(--muted);
		text-align: center;
	}
	.place {
		display: grid;
		align-content: center;
		flex: 1;
		min-width: 0;
	}
	/* Places read like the record rows beside them: 15 / 600 title, 15 / 700 amount (DESIGN_SYSTEM § Transaction row). */
	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.amount {
		flex: none;
		font-size: 15px;
		font-weight: 700;
	}
	.income {
		color: var(--money-in);
	}
	/* The meta line keeps wallet and category on a phone: two lines instead of an ellipsis. */
	@media (max-width: 600px) {
		.block :global(.meta) {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
</style>
