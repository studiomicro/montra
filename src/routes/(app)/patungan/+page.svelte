<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatDayLabel } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
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
	const loading = $derived(refreshing || navigating.to?.url.pathname === '/patungan');

	const savedText: Record<string, string> = {
		deleted: msg('Patungan dihapus.')
	};
	const money = (minor: number | null, currency: string) =>
		minor === null
			? tr('Total terlalu besar untuk ditampilkan')
			: formatMoney(minor, currency, 'auto', locale);
	/** "Belum dilunasi": what others still owe you, per currency (never added across currencies). */
	const owedText = $derived(data.owed.map((o) => money(o.owedMinor, o.currency)).join(' + '));
</script>

<svelte:head><title>{tr('Patungan')}</title></svelte:head>

<ScreenTitle
	title={tr('Patungan')}
	subtitle={owedText ? trf('Belum dilunasi: {amount}', { amount: owedText }) : undefined}
>
	{#snippet actions()}
		<Button size="sm" icon="plus" href="/patungan/baru">{tr('Patungan baru')}</Button>
	{/snippet}
</ScreenTitle>

{#if data.saved && Object.hasOwn(savedText, data.saved)}
	<p class="ok" role="status">{tr(savedText[data.saved] as string)}</p>
{/if}

{#if loading}
	<div aria-busy="true"><Skeleton rows={4} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.splits.length === 0}
	<EmptyState
		text={tr(
			'Bayar tagihan bersama lalu bagi ke teman. Hanya bagianmu yang dihitung sebagai pengeluaranmu.'
		)}
		actionLabel={tr('Patungan baru')}
		actionHref="/patungan/baru"
	/>
{:else}
	<GroupList records>
		{#each data.splits as split (split.id)}
			<GroupRow href="/patungan/{split.id}">
				<span class="text">
					<span class="title">{split.title}</span>
					<span class="meta">
						{formatDayLabel(split.occurredOn, locale)} ·
						{#if split.viewerIsPayer}
							{tr('Kamu sebagai pembayar')}
						{:else if split.viewerOwesMinor !== null && split.viewerOwesMinor > 0}
							{trf('Kamu ditagih {amount}', {
								amount: money(split.viewerOwesMinor, split.currency)
							})}
						{:else}
							{trf('Dibayar {name}', { name: split.payerName })}
						{/if}
					</span>
					<span class="tags">
						{#if split.settled}<StatusTag>{tr('Lunas')}</StatusTag>{:else}<span class="open"
								>{tr('Belum lunas')}</span
							>{/if}
						{#if split.linked}<span class="chip">{tr('Tertaut')}</span>{/if}
						{#if split.isDemo}<span class="chip">{tr('Data demo')}</span>{/if}
					</span>
				</span>
				<span class="amount num">{money(split.totalAmountMinor, split.currency)}</span>
			</GroupRow>
		{/each}
	</GroupList>
{/if}

<style>
	.ok {
		margin: 0 0 12px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 2px;
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
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		align-items: center;
	}
	.open,
	.chip {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	.amount {
		flex: none;
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
</style>
