<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-22 "Ingatan asisten": the stored Tanya messages of this space and the action that deletes them. The count
	 * shown is the server's, read again after the delete.
	 */
	let { data, form } = $props();
	const { tr, trf } = useI18n();

	let deleting = $state(false);
	let clientError = $state('');
	let refreshing = $state(false);

	const deleted = $derived(page.url.searchParams.get('dihapus') === '1');
	const banner = $derived(
		clientError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);

	const remove: SubmitFunction = () => {
		deleting = true;
		clientError = '';
		return async ({ result, update }) => {
			if (result.type === 'error')
				clientError = tr('Tidak bisa terhubung. Periksa koneksi lalu coba lagi.');
			else await update();
			deleting = false;
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

<svelte:head><title>{tr('Ingatan asisten')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Ingatan asisten')}
	subtitle={tr('Percakapanmu dengan Tanya')}
/>

{#if refreshing}
	<Skeleton rows={3} />
{:else if data.loadError || data.count === null}
	<ErrorState
		text={tr(data.loadError ?? 'Percakapan tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#if data.count === 0}
			{#if deleted}<p class="done" role="status">
					{tr('Semua percakapan di ruang ini sudah dihapus.')}
				</p>{/if}
			<div data-testid="tanya-count">
				<EmptyState text={tr('Tidak ada percakapan tersimpan di ruang ini.')} />
			</div>
		{:else}
			<p class="count" data-testid="tanya-count">
				{trf('{n} pesan tersimpan di ruang ini.', { n: data.count })}
			</p>
		{/if}
		<p class="note">
			{tr(
				'Pertanyaan dan jawaban Tanya disimpan 30 hari supaya percakapan bisa dilanjutkan, lalu dihapus otomatis. Hanya kamu yang bisa melihatnya.'
			)}
		</p>
		<!-- Nothing stored, nothing to delete: the button appears only when there is something to remove. -->
		{#if data.count > 0}
			<form method="POST" action="?/hapus" use:enhance={remove}>
				<Button type="submit" variant="destructive" disabled={deleting}>
					{deleting ? tr('Menghapus…') : tr('Hapus semua percakapan')}
				</Button>
			</form>
		{/if}
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: 12px;
		margin-top: 8px;
	}
	.count {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
	}
	.note,
	.done {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
