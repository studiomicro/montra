<script lang="ts">
	import { enhance } from '$app/forms';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf } = useI18n();
	let joining = $state(false);
</script>

<svelte:head><title>{tr('Undangan ruang')}</title></svelte:head>
<ScreenTitle title={tr('Undangan ruang')} />

{#if data.state === 'invalid'}
	<EmptyState
		text={tr('Tautan tidak ditemukan atau sudah tidak berlaku.')}
		actionLabel={tr('Kembali ke Beranda')}
		actionHref="/"
	/>
{:else if data.state === 'full'}
	<EmptyState
		text={`${data.spaceName} · ${tr('Ruang ini sudah penuh.')}`}
		actionLabel={tr('Kembali ke Beranda')}
		actionHref="/"
	/>
{:else}
	<p class="lead">
		{data.state === 'member'
			? trf('Kamu sudah anggota {ruang}.', { ruang: data.spaceName ?? '' })
			: trf('Kamu diundang ke ruang {ruang}.', { ruang: data.spaceName ?? '' })}
	</p>
	{#if data.state === 'open'}
		<p class="note">
			{tr(
				'Anggota ruang melihat dan mengubah dompet, transaksi dan anggaran ruang ini. Ruang pribadimu tetap milikmu sendiri.'
			)}
		</p>
	{/if}
	<form
		method="POST"
		action="?/accept"
		class="form"
		use:enhance={() => {
			joining = true;
			return async ({ update }) => {
				await update();
				joining = false;
			};
		}}
	>
		<FormBanner message={form?.error ? tr(form.error) : undefined} />
		<Button type="submit" size="lg" full disabled={joining}>
			{joining
				? tr('Memproses…')
				: data.state === 'member'
					? tr('Buka ruang')
					: tr('Gabung ke ruang')}
		</Button>
	</form>
{/if}

<style>
	.lead {
		margin: 16px 0 0;
		font-size: 20px;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.note {
		margin: 8px 0 0;
		color: var(--muted);
	}
	.form {
		display: grid;
		gap: 16px;
		max-width: 560px;
		margin-top: 24px;
	}
</style>
