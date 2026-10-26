<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatDateTimeWib, formatDayLabel } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	// "Lewati" hides a group for this visit only: nothing is written (owner decision 3), the group is offered
	// again on the next load. Not a saved state, so never shown as one.
	const skipped = new SvelteSet<string>();
	let busy = $state('');
	let refreshing = $state(false);

	const groups = $derived((data.preview?.groups ?? []).filter((g) => !skipped.has(g.key)));
	const loading = $derived(
		refreshing || navigating.to?.url.pathname === '/impor/cocokkan-transfer'
	);
	const walletName = (id: string | null) =>
		data.wallets.find((w) => w.id === id)?.name ?? tr('Dompet dihapus');
	const pairKey = (p: { debit: { id: string }; credit: { id: string } }) =>
		`${p.debit.id}:${p.credit.id}`;

	// Shown as saved only once the server answered (CLAUDE.md: success only after a confirmed write).
	const done = $derived.by(() => {
		if (!form || !('done' in form)) return '';
		if (form.done === 'merged') return tr('Pasangan dicocokkan menjadi satu transfer.');
		if (form.done === 'undone') return tr('Pencocokan diurungkan; kedua transaksi dikembalikan.');
		return 'message' in form && form.message ? tr(form.message) : '';
	});
	const banner = $derived(form && 'error' in form && form.error ? tr(form.error) : '');

	const track: SubmitFunction = ({ action, formData }) => {
		busy = action.search.includes('undo')
			? `undo:${String(formData.get('id'))}`
			: `merge:${String(formData.get('debitId'))}:${String(formData.get('creditId'))}`;
		return async ({ update }) => {
			try {
				await update({ reset: false });
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
</script>

<svelte:head><title>{tr('Cocokkan transfer')}</title></svelte:head>
<ScreenTitle
	title={tr('Cocokkan transfer')}
	subtitle={tr('Gabungkan transfer antar dompetmu sendiri yang terbaca dua kali menjadi satu.')}
	back={{ href: '/impor', label: tr('Kembali ke Impor') }}
/>

<FormBanner message={banner} />
{#if done}<p class="ok" role="status">{done}</p>{/if}

{#if data.links.length > 0 || data.linksPaged}
	<section class="card" aria-labelledby="{uid}-links">
		<h2 id="{uid}-links">{tr('Sudah dicocokkan')}</h2>
		<ul class="list">
			{#each data.links as link (link.id)}
				<li class="pair">
					<div class="text">
						<span class="title">{link.title ?? tr('Transaksi dihapus')}</span>
						{#if link.source === 'auto'}<Badge>{tr('Otomatis')}</Badge>{/if}
						<span class="meta">
							{formatDayLabel(link.occurredOn, locale)} ·
							<span class="num amount"
								>{formatMoney(link.amountMinor, link.currency, 'auto', locale)}</span
							>
						</span>
						<span class="meta">
							{walletName(link.fromWalletId)}
							<span aria-hidden="true">→</span>
							<span class="sr-only">{tr('ke')}</span>
							{walletName(link.toWalletId)} · {formatDateTimeWib(link.createdAt, locale)}
						</span>
					</div>
					<form method="POST" action="?/undo" use:enhance={track}>
						<input type="hidden" name="id" value={link.id} />
						<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
							{busy === `undo:${link.id}` ? tr('Memproses…') : tr('Urungkan')}
						</Button>
					</form>
				</li>
			{/each}
		</ul>
		{#if data.linksOlder || data.linksPaged}
			<p class="pages">
				{#if data.linksPaged}<a href="?">{tr('Kembali ke yang terbaru')}</a>{/if}
				{#if data.linksOlder}
					<a href="?sebelum={encodeURIComponent(data.linksOlder)}">{tr('Lihat yang lebih lama')}</a>
				{/if}
			</p>
		{/if}
	</section>
{/if}

<section class="card" aria-labelledby="{uid}-list" aria-busy={loading}>
	<h2 id="{uid}-list">{tr('Usulan pasangan transfer')}</h2>
	{#if loading}
		<Skeleton rows={4} />
	{:else if data.loadError || !data.preview}
		<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
	{:else if groups.length === 0}
		<EmptyState
			illustration="history"
			text={tr('Tidak ada pasangan transfer yang perlu dicocokkan sekarang.')}
		/>
	{:else}
		<p class="meta">
			{tr(
				'Setiap pasangan: satu Transfer keluar dan satu Transfer masuk dengan jumlah sama di dua dompet, selisih paling lama satu hari. Periksa, lalu cocokkan satu per satu.'
			)}
		</p>
		<p class="meta">
			{tr(
				'Pembayaran kartu kredit: debit kartu kredit atau Transfer keluar di rekening dengan pembayaran yang tercatat di dompet kartu, dari sehari sebelum sampai tiga hari sesudah debit. Setelah dicocokkan menjadi satu transfer ke kartu, bukan pengeluaran.'
			)}
		</p>
		{#if data.preview.total > data.preview.shown}
			<p class="meta">
				{trf(
					'Ditampilkan {shown} pasangan terbaru dari {total}. Buka lagi setelah ini untuk sisanya.',
					{
						shown: data.preview.shown,
						total: data.preview.total
					}
				)}
			</p>
		{/if}
		<ul class="groups">
			{#each groups as group (group.key)}
				<li class="group" class:ambiguous={group.ambiguous}>
					<div class="group-head">
						<span class="num amount"
							>{formatMoney(group.amountMinor, group.currency, 'auto', locale)}</span
						>
						{#if group.ambiguous}<Badge>{tr('Beberapa kandidat')}</Badge>{/if}
						<Button variant="ghost" size="sm" onclick={() => skipped.add(group.key)}>
							{tr('Lewati')}
						</Button>
					</div>
					{#if group.ambiguous}
						<p class="meta">
							{tr(
								'Lebih dari satu transaksi cocok dengan jumlah dan tanggal ini. Pilih pasangan yang benar, atau lewati semuanya.'
							)}
						</p>
					{/if}
					<ul class="list">
						{#each group.pairs as p (pairKey(p))}
							<li class="pair">
								{#if p.kind === 'card'}<Badge>{tr('Pembayaran kartu kredit')}</Badge>{/if}
								<div class="text">
									<span class="side">
										<span class="title">{p.debit.title || tr('Tanpa judul')}</span>
										<span class="meta">
											{walletName(p.debit.walletId)} · {formatDayLabel(p.debit.occurredOn, locale)}
										</span>
									</span>
									<span class="arrow" aria-hidden="true">→</span>
									<span class="sr-only">{tr('ke')}</span>
									<span class="side">
										<span class="title">{p.credit.title || tr('Tanpa judul')}</span>
										<span class="meta">
											{walletName(p.credit.walletId)} · {formatDayLabel(
												p.credit.occurredOn,
												locale
											)}
										</span>
									</span>
								</div>
								<form method="POST" action="?/merge" use:enhance={track}>
									<input type="hidden" name="debitId" value={p.debit.id} />
									<input type="hidden" name="creditId" value={p.credit.id} />
									<input type="hidden" name="debitUpdatedAt" value={p.debit.updatedAt} />
									<input type="hidden" name="creditUpdatedAt" value={p.credit.updatedAt} />
									<Button type="submit" size="sm" disabled={busy !== ''}>
										{busy === `merge:${pairKey(p)}` ? tr('Menyimpan…') : tr('Cocokkan')}
									</Button>
								</form>
							</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
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
	.pages {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin: 12px 0 0;
	}
	.pages a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.groups,
	.list {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.group {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: var(--r-s);
		background: var(--bg);
	}
	.group-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.group-head .amount {
		flex: 1;
		font-size: 18px;
	}
	/* Phone first: the two sides stack with the arrow between them; the button sits under them, never beside. */
	.pair {
		display: grid;
		gap: 10px;
		padding: 12px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.text {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.side {
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
	.arrow {
		color: var(--muted);
	}
	.amount {
		color: var(--ink);
		font-weight: 600;
		white-space: nowrap;
	}
	form {
		display: flex;
		justify-content: flex-end;
	}
</style>
