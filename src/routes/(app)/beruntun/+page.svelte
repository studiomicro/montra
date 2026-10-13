<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatMonthLabel } from '#lib/shared/dates';
	import { FREEZE_BANK_MAX } from '#lib/shared/streak';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StreakCalendar from '#lib/ui/kit/StreakCalendar.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr, trf, locale } = useI18n();

	let refreshing = $state(false);
	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
	/** A retry, or a month switch on this page: the figures below are being replaced. */
	const loading = $derived(
		refreshing ||
			(navigating.to?.url.pathname === '/beruntun' && navigating.from?.url.pathname === '/beruntun')
	);

	/** "N hari berturut-turut" for a count of days (the FN-34 chip's own wording). */
	const daysInRow = (n: number) =>
		n === 0
			? tr('0 hari berturut-turut')
			: n === 1
				? tr('1 hari berturut-turut')
				: trf('{n} hari berturut-turut', { n });
	const days = (n: number) => (n === 1 ? tr('1 hari') : trf('{n} hari', { n }));
	const hourLabel = (h: number) => `${String(h).padStart(2, '0')}.00 WIB`;

	const closure = $derived(data.closure);
	const budget = $derived(data.budget);
	const isEmpty = $derived(closure !== null && closure.longest === 0 && !closure.closedToday);
	const monthLabel = $derived(formatMonthLabel(data.month, locale));
	const stepper = $derived({
		label: monthLabel,
		prevHref: data.month === data.thisMonth ? '/beruntun?bulan=' + data.lastMonth : null,
		nextHref: data.month === data.lastMonth ? '/beruntun' : null
	});
</script>

<svelte:head><title>{tr('Beruntun')}</title></svelte:head>
<ScreenTitle back={{ href: '/', label: tr('Kembali ke Beranda') }} title={tr('Beruntun')} />

{#if loading}
	<Skeleton rows={6} />
{:else}
	<section class="block" aria-labelledby="closure-title">
		<h2 id="closure-title" class="sr-heading">{tr('Tutup hari')}</h2>
		{#if !closure}
			<ErrorState text={tr('Beruntun belum bisa dimuat.')} onretry={retry} />
		{:else if isEmpty}
			<EmptyState
				text={tr('Belum ada hari berturut-turut. Tutup hari ini di Beranda untuk memulai.')}
				actionLabel={tr('Ke Beranda')}
				actionHref="/"
			/>
		{:else}
			<div class="hero">
				<p class="big num">{closure.current}</p>
				<p class="hero-label">
					{daysInRow(closure.current)} ·
					{closure.closedToday ? tr('Hari ini ditutup') : tr('Hari ini belum ditutup')}
				</p>
			</div>
			<GroupList>
				<GroupRow>
					<span class="row-text">{tr('Rekor terbaik')}</span>
					<span class="row-value num">{days(closure.longest)}</span>
				</GroupRow>
				<GroupRow>
					<span class="row-text">
						{tr('Pembeku tersimpan')}
						<span class="row-hint">
							{tr(
								'Didapat setiap 7 hari ditutup berturut-turut. Satu pembeku menjaga beruntun saat satu hari terlewat.'
							)}
						</span>
					</span>
					<span class="row-value num"
						>{trf('{n} dari {max}', { n: closure.bank, max: FREEZE_BANK_MAX })}</span
					>
				</GroupRow>
			</GroupList>

			<div class="cal-head">
				<h3>{tr('Kalender')}</h3>
				<PeriodStepper {...stepper} />
			</div>
			<StreakCalendar
				days={closure.calendar}
				label={trf('Hari ditutup, {bulan}', { bulan: monthLabel })}
				legend={['closed', 'frozen', 'missed', 'today']}
			/>

			<h3>{tr('Pencapaian')}</h3>
			<GroupList>
				{#each closure.milestones as m (m.days)}
					<GroupRow>
						<span class="mark" class:reached={m.reached}
							><Icon name={m.reached ? 'check' : 'star'} size={20} /></span
						>
						<span class="row-text">{daysInRow(m.days)}</span>
						<span class="row-value">{m.reached ? tr('Tercapai') : tr('Belum tercapai')}</span>
					</GroupRow>
				{/each}
			</GroupList>
		{/if}
	</section>

	<section class="block" aria-labelledby="budget-title">
		<h2 id="budget-title">{tr('Beruntun anggaran')}</h2>
		<p class="note">
			{tr(
				'Hari yang pengeluarannya tidak melebihi sisa anggaran per hari di ruang ini. Hari ini dinilai besok pagi.'
			)}
		</p>
		{#if !budget}
			<ErrorState text={tr('Beruntun anggaran belum bisa dimuat.')} onretry={retry} />
		{:else}
			{#if budget.hasBudget === false}
				<p class="note">
					{tr('Ruang ini belum punya anggaran bulanan, jadi hari-harinya belum dinilai.')}
					<a class="link" href="/anggaran?ubah=bulanan">{tr('Atur anggaran')}</a>
				</p>
			{/if}
			<GroupList>
				<GroupRow>
					<span class="row-text">{tr('Sekarang')}</span>
					<span class="row-value num">{days(budget.current)}</span>
				</GroupRow>
				<GroupRow>
					<span class="row-text">{tr('Rekor terbaik')}</span>
					<span class="row-value num">{days(budget.longest)}</span>
				</GroupRow>
			</GroupList>
			<StreakCalendar
				days={budget.calendar}
				label={trf('Hari sesuai anggaran, {bulan}', { bulan: monthLabel })}
				legend={['within', 'over', 'no_budget', 'today']}
			/>
		{/if}
	</section>

	<section class="block" aria-labelledby="reminder-title">
		<h2 id="reminder-title">{tr('Pengingat')}</h2>
		{#if !data.reminder}
			<ErrorState text={tr('Pengingat belum bisa dimuat.')} onretry={retry} />
		{:else}
			<GroupList>
				<GroupRow href="/pengaturan/notifikasi">
					<span class="row-text">{tr('Pengingat tutup hari')}</span>
					<span class="row-value"
						>{data.reminder.enabled
							? trf('Aktif · {jam}', { jam: hourLabel(data.reminder.hour) })
							: tr('Mati')}</span
					>
				</GroupRow>
			</GroupList>
		{/if}
	</section>
{/if}

<style>
	.block {
		display: grid;
		gap: 12px;
		margin-bottom: 32px;
	}
	.sr-heading {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.hero {
		display: grid;
		gap: 4px;
	}
	.big {
		margin: 0;
		font-size: 56px;
		font-weight: 800;
		line-height: 1;
		letter-spacing: -0.03em;
	}
	.hero-label {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 17px;
		font-weight: 700;
	}
	.cal-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.cal-head h3 {
		margin: 0;
	}
	.row-text {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.row-hint {
		color: var(--muted);
		font-size: 13px;
	}
	.row-value {
		color: var(--ink-2);
		font-size: 15px;
		text-align: right;
	}
	.mark {
		display: inline-grid;
		place-items: center;
		color: var(--muted);
	}
	.mark.reached {
		color: var(--money-in);
	}
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 700;
	}
</style>
