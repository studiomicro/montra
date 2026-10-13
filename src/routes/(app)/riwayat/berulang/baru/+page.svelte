<script lang="ts">
	import type { SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import RecurringForm from '#lib/ui/recurring/RecurringForm.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	let busy = $state(false);
	let networkError = $state('');
	let formKey = $state(0);
	let refreshing = $state(false);

	/** Success is the redirect to the list, which happens only after the server wrote the series. */
	const submit: SubmitFunction = () => {
		busy = true;
		networkError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				networkError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				busy = false;
				return;
			}
			await update({ reset: false });
			if (result.type === 'failure') formKey++;
			busy = false;
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

	const values = $derived(form && 'values' in form && form.values ? form.values : data.values);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
</script>

<svelte:head><title>{tr('Tambah transaksi berulang')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/riwayat/berulang', label: tr('Kembali ke Transaksi berulang') }}
	title={tr('Tambah transaksi berulang')}
/>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError || !values}
	<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
{:else if data.wallets.length === 0}
	<EmptyState
		illustration="wallet"
		text={tr('Tambah dompet dulu supaya transaksi punya tempat.')}
		actionLabel={tr('Tambah dompet')}
		actionHref="/dompet?tambah=1"
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#key formKey}
			<RecurringForm
				action="?/create"
				{values}
				{errors}
				wallets={data.wallets}
				categories={data.categories}
				{busy}
				{submit}
			/>
		{/key}
		<a class="cancel" href="/riwayat/berulang">{tr('Batal')}</a>
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: 16px;
		max-width: 560px;
		margin-top: 8px;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		justify-self: center;
		text-decoration: none;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
