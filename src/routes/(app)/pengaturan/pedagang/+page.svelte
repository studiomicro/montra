<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { formatDayLabel, wibDateString } from '#lib/shared/dates';
	import { CATEGORY_KIND_LABELS, categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import SearchField from '#lib/ui/kit/SearchField.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-20 "Pedagang & aturan": what this space learned from category corrections. Every form posts without
	 * JavaScript; with it, a delete shows as done only after the server answered, then the list is read again.
	 */
	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	/** The action in flight ('' when none). */
	let busy = $state('');
	let clientError = $state('');
	let refreshing = $state(false);

	const deletedAll = $derived(page.url.searchParams.get('dihapus'));
	const banner = $derived(
		clientError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
	const loading = $derived(refreshing || navigating.to?.url.pathname === '/pengaturan/pedagang');

	const submit: SubmitFunction = ({ action }) => {
		busy = action.search;
		clientError = '';
		return async ({ result, update }) => {
			if (result.type === 'error')
				clientError = tr('Tidak bisa terhubung. Periksa koneksi lalu coba lagi.');
			else {
				await update();
				if (result.type === 'failure' && result.status === 409) await invalidateAll();
			}
			busy = '';
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

<svelte:head><title>{tr('Pedagang & aturan')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Pedagang & aturan')}
	subtitle={tr('Kategori yang diingat ruang ini dari koreksimu')}
/>

<div class="page">
	<FormBanner message={banner} />
	{#if form && 'done' in form && form.done === 'deleted'}
		<p class="ok" role="status">{tr('Aturan dihapus.')}</p>
	{/if}
	{#if deletedAll !== null && data.rules.length === 0 && !data.search}
		<p class="ok" role="status">{tr('Semua aturan di ruang ini sudah dihapus.')}</p>
	{/if}
	<p class="note">
		{tr(
			'Saat kamu mengganti kategori sebuah transaksi atau draf, ruang ini mengingatnya untuk pedagang itu. Hapus aturan kapan saja.'
		)}
	</p>

	<!-- Nothing to search while there are no rules (a search with no match keeps the field, to clear it). -->
	{#if data.rules.length > 0 || data.search}
		<form method="GET" class="search" role="search">
			<SearchField
				label={tr('Cari pedagang')}
				name="q"
				value={data.search}
				placeholder={tr('Cari pedagang')}
				maxlength={60}
			/>
		</form>
	{/if}

	{#if loading}
		<div aria-busy="true"><Skeleton rows={4} /></div>
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if data.rules.length === 0}
		<EmptyState
			text={data.search
				? tr('Tidak ada aturan yang cocok.')
				: tr('Belum ada aturan. Ganti kategori sebuah transaksi untuk mengajari ruang ini.')}
		/>
	{:else}
		<ul class="rules">
			{#each data.rules as rule (rule.id)}
				<li class="rule">
					<CategoryTile category={rule.category?.tileKey ?? 'lain'} size={36} />
					<div class="text">
						<span class="name">{rule.merchantName}</span>
						<span class="meta">
							{rule.category ? categoryLabel(rule.category, tr) : tr('Kategori tidak tersedia')}
							· {tr(CATEGORY_KIND_LABELS[rule.kind])}
						</span>
						<span class="meta">
							{trf('{n} koreksi', { n: rule.hits })} · {trf('Diperbarui {date}', {
								date: formatDayLabel(wibDateString(rule.updatedAt), locale)
							})}
						</span>
					</div>
					<form method="POST" action="?/hapus" use:enhance={submit}>
						<input type="hidden" name="id" value={rule.id} />
						<input type="hidden" name="updatedAt" value={rule.updatedAt} />
						<Button type="submit" variant="ghost" size="sm" disabled={busy !== ''}>
							{tr('Hapus')}
						</Button>
					</form>
				</li>
			{/each}
		</ul>

		<details class="confirm">
			<summary>{tr('Hapus semua aturan')}</summary>
			<form method="POST" action="?/hapusSemua" use:enhance={submit} class="confirm-form">
				<label class="check">
					<input type="checkbox" name="confirm" value="1" required />
					<span>{tr('Ya, hapus semua aturan di ruang ini.')}</span>
				</label>
				<Button type="submit" variant="destructive" disabled={busy !== ''}>
					{busy === '?/hapusSemua' ? tr('Menghapus…') : tr('Hapus semua aturan')}
				</Button>
			</form>
		</details>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 12px;
		margin-top: 8px;
	}
	.note,
	.ok {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.ok {
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.rules {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.rule {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 60px;
		padding: 8px 8px 8px 16px;
	}
	.rule + .rule::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 16px;
		border-top: 1px solid var(--line);
	}
	.text {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.name {
		overflow-wrap: anywhere;
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
	}
	.confirm-form {
		display: grid;
		gap: 12px;
		justify-items: start;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
	}
	.check input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--ink);
	}
</style>
