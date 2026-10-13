<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatDateTimeWib, formatDayLabel } from '#lib/shared/dates';
	import { MERCHANT_REASON_LABELS } from '#lib/shared/merchants/resolve';
	import { formatMoney } from '#lib/shared/money-format';
	import { categoryLabel, type TileKey } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	// Every proposed row starts selected; unticking keeps it out of the apply (AC-19).
	const unselected = new SvelteSet<string>();
	let busy = $state<'' | 'apply' | 'undo'>('');
	let refreshing = $state(false);

	const proposals = $derived(data.preview?.proposals ?? []);
	const selectedCount = $derived(proposals.filter((p) => !unselected.has(p.id)).length);
	const loading = $derived(refreshing || navigating.to?.url.pathname === '/impor/rapikan-kategori');
	const categoryOf = (id: string) => data.categories.find((c) => c.id === id);
	const nameOf = (id: string) => {
		const c = categoryOf(id);
		return c ? categoryLabel(c, tr) : tr('Tanpa kategori');
	};

	function toggle(id: string, on: boolean) {
		if (on) unselected.delete(id);
		else unselected.add(id);
	}

	// Shown as saved only once the server answered (CLAUDE.md: success only after a confirmed write).
	const done = $derived.by(() => {
		if (!form || !('done' in form)) return '';
		if (form.done === 'applied')
			return form.changed > 0
				? trf('{n} transaksi dirapikan. {m} dilewati karena berubah sejak ditinjau.', {
						n: form.applied,
						m: form.changed
					})
				: trf('{n} transaksi dirapikan.', { n: form.applied });
		if (form.done === 'undone')
			return form.kept > 0
				? trf('{n} transaksi dikembalikan. {m} dibiarkan karena sudah diubah lagi.', {
						n: form.reverted,
						m: form.kept
					})
				: trf('{n} transaksi dikembalikan ke kategori sebelumnya.', { n: form.reverted });
		return 'message' in form && form.message ? tr(form.message) : '';
	});
	const banner = $derived(form && 'error' in form && form.error ? tr(form.error) : '');

	const track: SubmitFunction = ({ action }) => {
		busy = action.search.includes('undo') ? 'undo' : 'apply';
		return async ({ update }) => {
			try {
				await update({ reset: false });
				unselected.clear();
			} finally {
				busy = '';
			}
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

	const amountOf = (p: { type: string; amountMinor: number; currency: string }) =>
		formatMoney(
			p.type === 'expense' ? -p.amountMinor : p.amountMinor,
			p.currency,
			'signed',
			locale
		);
</script>

<svelte:head><title>{tr('Rapikan kategori')}</title></svelte:head>
<ScreenTitle
	title={tr('Rapikan kategori')}
	subtitle={tr('Pindahkan transaksi impor dari Lainnya ke kategori yang lebih tepat.')}
	back={{ href: '/impor', label: tr('Kembali ke Impor') }}
/>

<FormBanner message={banner} />
{#if done}<p class="ok" role="status">{done}</p>{/if}

{#if data.latest}
	<section class="card" aria-labelledby="{uid}-latest">
		<h2 id="{uid}-latest">{tr('Perapian terakhir')}</h2>
		<p class="meta">
			{trf('{n} transaksi dipindah, {when}.', {
				n: data.latest.rowCount,
				when: formatDateTimeWib(data.latest.createdAt, locale)
			})}
		</p>
		<form method="POST" action="?/undo" use:enhance={track}>
			<input type="hidden" name="id" value={data.latest.id} />
			<input type="hidden" name="updatedAt" value={data.latest.updatedAt} />
			<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
				{busy === 'undo' ? tr('Memproses…') : tr('Urungkan')}
			</Button>
		</form>
	</section>
{/if}

<section class="card" aria-labelledby="{uid}-list" aria-busy={loading}>
	<h2 id="{uid}-list">{tr('Usulan kategori')}</h2>
	{#if loading}
		<Skeleton rows={4} />
	{:else if data.loadError || !data.preview}
		<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
	{:else if proposals.length === 0}
		<EmptyState
			illustration="history"
			text={tr('Tidak ada transaksi yang perlu dirapikan sekarang.')}
		/>
	{:else}
		<p class="meta">
			{trf(
				'{n} transaksi bisa pindah ke kategori yang lebih tepat. Hapus centang yang tidak ingin diubah.',
				{
					n: proposals.length
				}
			)}
		</p>
		{#if data.preview.total > data.preview.scanned}
			<p class="meta">
				{trf(
					'Ditinjau {shown} transaksi terbaru dari {total}. Buka lagi setelah ini untuk sisanya.',
					{
						shown: data.preview.scanned,
						total: data.preview.total
					}
				)}
			</p>
		{/if}
		<form method="POST" action="?/apply" use:enhance={track} class="apply">
			<input type="hidden" name="batchId" value={data.batchId} />
			<GroupList>
				{#each proposals as p (p.id)}
					<GroupRow
						selected={!unselected.has(p.id)}
						onToggle={(on) => toggle(p.id, on)}
						name="id"
						value={p.id}
					>
						<span class="row">
							<CategoryTile
								category={(categoryOf(p.toCategoryId)?.tileKey ?? 'lain') as TileKey}
								size={36}
							/>
							<span class="text">
								<span class="title">{p.title}</span>
								<span class="meta">
									{formatDayLabel(p.occurredOn, locale)} ·
									<span class="num amount">{amountOf(p)}</span>
								</span>
								<span class="move">
									<span>{nameOf(p.fromCategoryId)}</span>
									<span aria-hidden="true">→</span>
									<span class="sr-only">{tr('menjadi')}</span>
									<strong>{nameOf(p.toCategoryId)}</strong>
								</span>
								<span class="tags">
									<Badge>{tr(MERCHANT_REASON_LABELS[p.reason])}</Badge>
									{#if p.isDemo}<Badge>{tr('Data demo')}</Badge>{/if}
								</span>
							</span>
						</span>
					</GroupRow>
				{/each}
			</GroupList>
			<div class="actions">
				<Button type="submit" disabled={busy !== '' || selectedCount === 0}>
					{busy === 'apply'
						? tr('Menyimpan…')
						: trf('Terapkan ke {n} transaksi', { n: selectedCount })}
				</Button>
			</div>
		</form>
	{/if}
</section>

<style>
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		margin-bottom: 24px;
		padding: 20px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.meta {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.ok {
		margin: 0 0 16px;
		font-weight: 600;
	}
	.apply {
		display: grid;
		gap: 16px;
	}
	/* Phone first: tile, then one column (title, date and amount, the move, the chips) that wraps, never scrolls. */
	.row {
		display: grid;
		flex: 1;
		grid-template-columns: 36px minmax(0, 1fr);
		align-items: start;
		gap: 12px;
		min-width: 0;
	}
	.text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	/* Two lines at most: a bank narrative is long, and its first words are what tell rows apart. */
	.title {
		display: -webkit-box;
		min-width: 0;
		overflow: hidden;
		font-weight: 600;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.move {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		font-size: 14px;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 4px;
		white-space: nowrap;
	}
	.amount {
		color: var(--ink);
		font-weight: 600;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
