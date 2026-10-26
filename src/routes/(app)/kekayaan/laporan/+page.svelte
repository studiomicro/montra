<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatShortDay, formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { NET_WORTH_CLASS_LABELS } from '#lib/shared/net-worth';
	import {
		periodName,
		periodTitle,
		reportPeriodHref,
		type ReportPeriod
	} from '#lib/shared/report-period';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import { amounts, applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ChevronLinks from '#lib/ui/laporan/ChevronLinks.svelte';
	import ReportPeriodNav from '#lib/ui/laporan/ReportPeriodNav.svelte';
	import PeriodTrend from '#lib/ui/net-worth/PeriodTrend.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	// Laporan kekayaan (FN-53): the net worth at the start and end of a month, quarter or year from the stored daily
	// snapshots, the monthly points and the change per group. Read-only: nothing here is ever shown as saved.
	let { data } = $props();
	// AC 33: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	const r = $derived(data.report);
	const period = $derived<ReportPeriod>(data.period);
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
			(navigating.to?.url.pathname === '/kekayaan/laporan' &&
				navigating.from?.url.pathname === '/kekayaan/laporan')
	);

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, sign: 'auto' | 'signed' = 'auto') =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, 'IDR', sign, locale));
	const subtitle = $derived(
		r?.partial && period.kind !== 'bulan'
			? `${periodTitle(period, i18n)} · ${tr('sejauh ini')}`
			: periodTitle(period, i18n)
	);
	const day = (date: string) => formatShortDay(date, locale);

	// Red team L2: while amounts are hidden no word, sign or colour says which way it went (from the first
	// server render: applyAmountsHiddenAtLoad above).
	const heroLabel = $derived(
		r?.changeMinor === null || r?.changeMinor === undefined || amounts.hidden
			? tr('Perubahan kekayaan bersih')
			: r.changeMinor > 0
				? tr('Naik')
				: r.changeMinor < 0
					? tr('Turun')
					: tr('Tetap')
	);

	/** A group's change in words: a debt by what happened to it; every other group by its signed amount. */
	function groupText(cls: string, change: number | null): string {
		if (change === null) return tr(TOO_LARGE);
		if (amounts.hidden) return money(change);
		if (cls === 'debt')
			return trf(change > 0 ? 'Utang berkurang {jumlah}' : 'Utang bertambah {jumlah}', {
				jumlah: money(Math.abs(change))
			});
		return money(change, 'signed');
	}
	const groupLabel = (cls: string) =>
		cls === 'other'
			? tr('Lainnya')
			: tr(NET_WORTH_CLASS_LABELS[cls as keyof typeof NET_WORTH_CLASS_LABELS] ?? 'Lainnya');
</script>

<svelte:head><title>{tr('Laporan kekayaan')}</title></svelte:head>

<ScreenTitle
	title={tr('Laporan kekayaan')}
	{subtitle}
	back={{ href: '/kekayaan', label: tr('Kembali ke kekayaan bersih') }}
>
	{#snippet actions()}
		<ReportPeriodNav path="/kekayaan/laporan" {period} {today} defaultKind="kuartal" />
	{/snippet}
</ScreenTitle>

{#if data.hiddenModules.includes('kekayaan')}
	<p class="hidden-note">
		{tr('Kekayaan disembunyikan dari menu. Angkanya tetap dihitung.')}
		<a href="/pengaturan/fitur">{tr('Tampilkan lagi di menu')}</a>
	</p>
{/if}

{#if loading}
	<div class="loading" aria-busy="true">
		<Skeleton rows={4} />
		<Skeleton rows={2} />
	</div>
{:else if data.loadError || !r}
	<ErrorState
		text={tr(data.loadError ?? 'Laporan kekayaan tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else if r.empty}
	<section class="empty" aria-labelledby="nw-report-empty">
		<h2 id="nw-report-empty">{tr('Belum ada catatan kekayaan')}</h2>
		<p class="muted">
			{tr(
				'Belum ada catatan kekayaan di periode ini. Catatan harian mulai setelah kamu menambahkan dompet atau aset.'
			)}
		</p>
		<a class="link" href="/dompet">{tr('Tambah dompet')}</a>
		<a class="link" href="/kekayaan?aset=baru">{tr('Tambah aset')}</a>
		{#if r.hasDemo}
			<p class="note">
				<Badge>{tr('Data demo')}</Badge>
				<span>{tr('Baris Data demo tidak dihitung dalam total.')}</span>
			</p>
		{/if}
	</section>
{:else}
	<div class="page">
		<div
			class="hero"
			class:up={!amounts.hidden && (r.changeMinor ?? 0) > 0}
			class:down={!amounts.hidden && (r.changeMinor ?? 0) < 0}
		>
			<HeroAmount
				label={heroLabel}
				amountMinor={r.changeMinor}
				signed
				fallback={tr('Belum cukup catatan untuk menghitung perubahan')}
			>
				{#if r.changeMinor !== null && r.opening && r.closing}
					<p>
						{trf('dari {awal} ({tanggal_awal}) menjadi {akhir} ({tanggal_akhir})', {
							awal: money(r.opening.minor),
							tanggal_awal: day(r.opening.date),
							akhir: money(r.closing.minor),
							tanggal_akhir: r.closing.live ? tr('sekarang') : day(r.closing.date)
						})}
					</p>
				{:else if r.closing}
					<p>
						{trf('Nilai akhir {akhir} ({tanggal_akhir})', {
							akhir: money(r.closing.minor),
							tanggal_akhir: r.closing.live ? tr('sekarang') : day(r.closing.date)
						})}
					</p>
				{/if}
			</HeroAmount>
		</div>
		{#if r.opening?.basis === 'since_start'}
			<p class="note">
				{trf('Dihitung sejak {tanggal}: belum ada catatan sebelum itu.', {
					tanggal: day(r.opening.date)
				})}
			</p>
		{:else if r.opening?.basis === 'earlier'}
			<p class="note">
				{trf('Nilai awal memakai catatan {tanggal}, catatan terakhir sebelum periode ini.', {
					tanggal: day(r.opening.date)
				})}
			</p>
		{/if}
		{#if r.closing?.partial}
			<p class="note">{tr('Sebagian harga belum tersedia, jadi nilai akhir belum lengkap.')}</p>
		{/if}
		{#if r.hasDemo}
			<p class="note">
				<Badge>{tr('Data demo')}</Badge>
				<span>{tr('Baris Data demo tidak dihitung dalam total.')}</span>
			</p>
		{/if}

		<section class="block" aria-labelledby="nw-report-trend">
			<h2 id="nw-report-trend">{tr('Per bulan')}</h2>
			<PeriodTrend
				points={r.points}
				label={trf('Kekayaan bersih per bulan, {periode}', { periode: periodName(period, locale) })}
			/>
		</section>

		{#if r.changeMinor !== null}
			<section class="block" aria-labelledby="nw-report-groups">
				<h2 id="nw-report-groups">{tr('Perubahan per kelompok')}</h2>
				{#if r.groups === null}
					<p class="muted">
						{r.groupsSince
							? trf('Rincian per kelompok tersedia mulai {tanggal}.', {
									tanggal: formatShortDate(r.groupsSince, locale)
								})
							: tr('Rincian per kelompok tersedia setelah pembaruan berikutnya.')}
					</p>
				{:else if r.groups.length === 0}
					<p class="muted">{tr('Tidak ada kelompok yang berubah.')}</p>
				{:else}
					<GroupList>
						{#each r.groups as g (g.cls)}
							<GroupRow>
								<span class="text">
									{groupLabel(g.cls)}
									<span class="meta num">
										{trf('{awal} menjadi {akhir}', {
											awal: money(g.openingMinor),
											akhir: money(g.closingMinor)
										})}
									</span>
								</span>
								<span
									class="amount num"
									class:up={!amounts.hidden && (g.changeMinor ?? 0) > 0}
									class:down={!amounts.hidden && (g.changeMinor ?? 0) < 0}
								>
									{groupText(g.cls, g.changeMinor)}
								</span>
							</GroupRow>
						{/each}
					</GroupList>
				{/if}
			</section>
		{/if}

		{#if r.rates}
			<p class="note">
				{tr('Aset mata uang asing dinilai dengan kurs harian; perubahan bisa berasal dari kurs.')}
				{trf('Kurs: {daftar}.', {
					daftar: r.rates.map((x) => `${x.currency} ${formatShortDate(x.date, locale)}`).join(', ')
				})}
			</p>
		{/if}

		<ChevronLinks
			links={[
				{ href: '/kekayaan', label: tr('Kembali ke kekayaan bersih') },
				{
					href: reportPeriodHref('/alur-uang', period, today, 'bulan'),
					label: tr('Lihat alur uang')
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
		gap: 24px;
		max-width: 880px;
	}
	.block,
	.empty {
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
	.muted,
	.note {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	/* The change's colour follows its sign on the hero figure itself (never while hidden). */
	.hero.up :global(.figure),
	.amount.up {
		color: var(--money-in);
	}
	.hero.down :global(.figure),
	.amount.down {
		color: var(--money-up);
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
		max-width: 50%;
		text-align: right;
		font-weight: 700;
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
