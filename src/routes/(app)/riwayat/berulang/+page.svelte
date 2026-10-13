<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		RECURRING_ATTENTION_HINTS,
		RECURRING_STATUS_LABELS,
		scheduleLabel
	} from '#lib/shared/recurring';
	import { categoryLabel } from '#lib/shared/transactions';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
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
	const loading = $derived(refreshing || navigating.to?.url.pathname === '/riwayat/berulang');

	const savedText: Record<string, string> = {
		created: msg('Transaksi berulang disimpan.'),
		updated: msg('Seri diubah. Transaksi berikutnya memakai perubahan ini.'),
		paused: msg('Seri dijeda.'),
		resumed: msg('Seri dilanjutkan.'),
		stopped: msg('Seri dihentikan.'),
		deleted: msg('Seri dihapus. Transaksi yang sudah tercatat tetap ada.')
	};

	type Series = (typeof data.series)[number];
	const title = (s: Series) =>
		s.title ?? (s.category ? categoryLabel(s.category, tr) : tr('Tanpa kategori'));
	function meta(s: Series): string {
		const when =
			s.status === 'active'
				? trf('Berikutnya {tanggal}', { tanggal: formatShortDate(s.nextRunOn, locale) })
				: tr(RECURRING_STATUS_LABELS[s.status]);
		return `${scheduleLabel(s.schedule, i18n)} · ${when}`;
	}
	const amount = (s: Series) =>
		formatMoney(
			s.type === 'expense' ? -s.amountMinor : s.amountMinor,
			s.currency,
			'signed',
			locale
		);
</script>

<svelte:head><title>{tr('Transaksi berulang')}</title></svelte:head>

<ScreenTitle
	back={{ href: '/riwayat', label: tr('Kembali ke Riwayat') }}
	title={tr('Transaksi berulang')}
	subtitle={tr('Dicatat otomatis pada jadwalnya, seperti kamu mencatatnya sendiri.')}
>
	{#snippet actions()}
		<Button variant="secondary" size="sm" href="/riwayat?berulang=1">
			{tr('Lihat transaksi dari seri aktif')}
		</Button>
		<Button size="sm" icon="plus" href="/riwayat/berulang/baru">{tr('Tambah')}</Button>
	{/snippet}
</ScreenTitle>

{#if data.saved && Object.hasOwn(savedText, data.saved)}
	<p class="ok" role="status">{tr(savedText[data.saved] as string)}</p>
{/if}

{#if loading}
	<div aria-busy="true"><Skeleton rows={4} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.series.length === 0}
	<EmptyState
		illustration="calendar"
		text={tr('Belum ada transaksi berulang')}
		actionLabel={tr('Tambah transaksi berulang')}
		actionHref="/riwayat/berulang/baru"
	/>
{:else}
	<GroupList label={tr('Transaksi berulang')}>
		{#each data.series as s (s.id)}
			<GroupRow href="/riwayat/berulang/{s.id}">
				<CategoryTile category={s.category?.tileKey ?? 'lain'} />
				<span class="text">
					<span class="title">{title(s)}</span>
					<span class="meta">{meta(s)}</span>
					{#if s.attention}
						<span class="attention">
							{tr('Perlu perhatian')}: {tr(RECURRING_ATTENTION_HINTS[s.attention])}
						</span>
					{/if}
				</span>
				<span
					class="amount num"
					class:income={s.type === 'income'}
					class:muted={s.status !== 'active'}>{shown(amount(s))}</span
				>
			</GroupRow>
		{/each}
	</GroupList>
{/if}

<style>
	.ok {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.attention {
		font-size: 13px;
		font-weight: 600;
		color: var(--warn-text);
	}
	.amount {
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	.income {
		color: var(--money-in);
	}
	.muted {
		color: var(--muted);
	}
</style>
