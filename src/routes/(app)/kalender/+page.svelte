<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { calendarHref, type DueItem } from '#lib/shared/calendar';
	import { formatDayLabel, formatMonthLabel } from '#lib/shared/dates';
	import { periodStepLabel } from '#lib/shared/report-period';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import HeatCalendar from '#lib/ui/charts/HeatCalendar.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import {
		amounts,
		applyAmountsHiddenAtLoad,
		loadAmountsHidden,
		shown
	} from '#lib/ui/kit/amounts.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import {
		rowKindLabel,
		rowMeta,
		rowTile,
		rowShare,
		rowTitle,
		signedAmount
	} from '#lib/ui/transactions/row-text';

	/**
	 * FN-54 Part C: the month behind Beranda's date badge. Spending per WIB day (the same aggregates Riwayat sums, so a
	 * day's figure equals Riwayat's one-day view), the account's closed days, and the bills and recurring items still
	 * to come. Read-only; the month and day live in the URL, so every control is a link and works without JavaScript.
	 */
	let { data } = $props();
	// QA FN-54 #1: the eye's cookie choice masks every figure here from the first server render (the root layout
	// resets the shared state per request; this page has no HeroAmount to apply it).
	applyAmountsHiddenAtLoad();
	// After hydration, and on a visit from Beranda's badge, the device's stored choice wins (as HeroAmount does on the
	// pages with a hero); leaving the page shows amounts again on pages without the eye.
	onMount(() => {
		loadAmountsHidden();
		return () => {
			amounts.hidden = false;
		};
	});
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	let refreshing = $state(false);
	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
	/** A retry, or a month or day switch on this page: what is below is being replaced (no stale figure is read out). */
	const loading = $derived(
		refreshing ||
			(navigating.to?.url.pathname === '/kalender' && navigating.from?.url.pathname === '/kalender')
	);

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));

	const monthLabel = $derived(formatMonthLabel(data.month, locale));
	const stepper = $derived({
		label: periodStepLabel({ kind: 'bulan', month: data.month }, locale),
		prevHref: data.neighbours.prev ? calendarHref(data.neighbours.prev, data.thisMonth) : null,
		nextHref: data.neighbours.next ? calendarHref(data.neighbours.next, data.thisMonth) : null
	});
	const hrefFor = (date: string) => calendarHref(data.month, data.thisMonth, date);

	const closed = $derived(new Set(data.closedOn ?? []));
	const dueDates = $derived(new Set((data.upcoming ?? []).map((item) => item.date)));
	const marks = $derived(
		Object.fromEntries(
			[...new Set([...closed, ...dueDates])].map((date) => [
				date,
				{ closed: closed.has(date), due: dueDates.has(date) }
			])
		)
	);
	const allFailed = $derived(
		data.spending === null &&
			data.closedOn === null &&
			data.upcoming === null &&
			data.dayRows === null
	);
	const monthEmpty = $derived(
		data.spending !== null && data.spending.days.every((d) => d.minor === 0)
	);

	const dayFigure = $derived(
		data.day && data.spending ? data.spending.days.find((d) => d.date === data.day) : undefined
	);
	const dayDue = $derived((data.upcoming ?? []).filter((item) => item.date === data.day));
	const dayIsPast = $derived(data.day !== null && data.day <= data.today);
	const dayRows = $derived(data.dayRows?.group?.rows ?? []);
	const dayHref = (date: string) => `/riwayat?period=range&from=${date}&to=${date}`;
	const dueName = (item: DueItem) =>
		item.title ?? (item.category ? categoryLabel(item.category, tr) : tr('Transaksi berulang'));
	const dueAmount = (item: DueItem) =>
		shown(
			formatMoney(
				item.type === 'income' ? item.amountMinor : -item.amountMinor,
				item.currency,
				'signed',
				locale
			)
		);
</script>

<svelte:head><title>{tr('Kalender')}</title></svelte:head>
<ScreenTitle back={{ href: '/', label: tr('Kembali ke Beranda') }} title={tr('Kalender')} />

<div class="head">
	<PeriodStepper {...stepper} />
</div>

{#if loading}
	<div aria-busy="true"><Skeleton rows={6} /></div>
{:else if allFailed}
	<ErrorState text={tr('Kalender belum bisa dimuat.')} onretry={retry} />
{:else}
	<section class="block" aria-labelledby="month-title">
		<h2 id="month-title" class="sr-only">
			{trf('Pengeluaran per hari, {bulan}', { bulan: monthLabel })}
		</h2>
		{#if data.spending === null}
			<ErrorState text={tr('Pengeluaran bulan ini belum bisa dimuat.')} onretry={retry} />
		{:else}
			<HeatCalendar
				days={data.spending.days}
				today={data.today}
				currency={data.spending.currency}
				label={trf('Pengeluaran per hari, {bulan}', { bulan: monthLabel })}
				{hrefFor}
				{marks}
				selected={data.day}
			/>
			{#if monthEmpty}<p class="muted">{tr('Belum ada transaksi bulan ini.')}</p>{/if}
			{#if data.spending.otherCurrencies}
				<p class="muted">{tr('Transaksi dalam mata uang lain tidak dihitung di sini.')}</p>
			{/if}
		{/if}
		{#if data.closedOn === null}
			<ErrorState text={tr('Hari yang ditutup belum bisa dimuat.')} onretry={retry} />
		{/if}
		{#if data.upcoming === null}
			<ErrorState text={tr('Tagihan yang akan datang belum bisa dimuat.')} onretry={retry} />
		{/if}
	</section>

	{#if data.day}
		<section class="block" aria-labelledby="day-title">
			<h2 id="day-title">{formatDayLabel(data.day, locale)}</h2>
			{#if dayIsPast && dayFigure}
				<p class="figure num">
					{tr('Pengeluaran')}
					<strong>{money(dayFigure.minor, data.spending?.currency ?? 'IDR')}</strong>
				</p>
			{/if}
			{#if data.day === data.today || closed.has(data.day)}
				<p class="closed">
					{data.day !== data.today
						? tr('Hari ditutup')
						: closed.has(data.day)
							? tr('Hari ini ditutup')
							: tr('Hari ini belum ditutup')}
				</p>
			{/if}

			{#if dayIsPast}
				{#if data.dayRows === null}
					<ErrorState text={tr('Transaksi hari itu belum bisa dimuat.')} onretry={retry} />
				{:else if dayRows.length > 0}
					<GroupList records>
						{#each dayRows as row (row.id)}
							<TransactionRow
								title={rowTitle(row, i18n)}
								meta={rowMeta(row, i18n)}
								amountMinor={signedAmount(row)}
								currency={row.currency}
								category={rowTile(row)}
								kind={row.type}
								label={rowKindLabel(row, i18n)}
								status={row.isDemo ? tr('Data demo') : undefined}
								share={rowShare(row, i18n)}
								href="/riwayat/{row.id}/edit"
							/>
						{/each}
					</GroupList>
				{/if}
				{#if dayRows.length > 0 || data.dayRows?.hasMore}
					<a class="link" href={dayHref(data.day)}>{tr('Lihat semua di Riwayat')}</a>
				{/if}
			{/if}

			{#if dayDue.length > 0}
				<h3>{tr('Jatuh tempo')}</h3>
				<GroupList>
					{#each dayDue as item (`${item.kind}:${item.id}`)}
						<GroupRow
							href={item.kind === 'subscription' ? '/langganan' : `/riwayat/berulang/${item.id}`}
						>
							<span class="due-text">
								<span class="due-title">{dueName(item)}</span>
								<span class="due-meta">
									{item.kind === 'subscription'
										? tr('Langganan')
										: tr('Transaksi berulang')}{item.walletName ? ` · ${item.walletName}` : ''}
								</span>
								{#if item.isDemo}<StatusTag>{tr('Data demo')}</StatusTag>{/if}
							</span>
							<span class="due-amount num">{dueAmount(item)}</span>
						</GroupRow>
					{/each}
				</GroupList>
			{/if}

			{#if (!dayIsPast || (data.dayRows !== null && dayRows.length === 0)) && dayDue.length === 0}
				<p class="muted">{tr('Tidak ada catatan atau tagihan pada hari itu.')}</p>
			{/if}
		</section>
	{/if}
{/if}

<style>
	.head {
		display: flex;
		justify-content: flex-end;
		margin: 4px 0 16px;
	}
	.block {
		display: grid;
		gap: 12px;
		margin-bottom: 28px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.muted {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.figure {
		margin: 0;
		color: var(--ink-2);
		font-size: 15px;
	}
	.figure strong {
		color: var(--ink);
	}
	.closed {
		margin: 0;
		font-size: 14px;
		color: var(--ink-2);
	}
	.link {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 14px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.due-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: flex-start;
		min-width: 0;
	}
	.due-title {
		max-width: 100%;
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.due-meta {
		font-size: 13px;
		color: var(--muted);
	}
	.due-amount {
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
</style>
