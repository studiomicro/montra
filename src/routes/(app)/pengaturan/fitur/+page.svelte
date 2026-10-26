<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { MODULE_LABELS, MODULES, type Module } from '#lib/shared/feature-flags';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Icon from '#lib/ui/Icon.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import FeatureChip from '#lib/ui/kit/FeatureChip.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import { featureItem, MODULE_NAV } from '#lib/ui/shell/nav';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	// What the switches show: the server's flags. A flipped switch is submitted at once, then shows the
	// server's state again (old value while saving, the new one once the write is confirmed and reloaded).
	let shown = $derived({ ...data.flags });
	/** The module being saved (null when none): every switch is disabled meanwhile. */
	let busy = $state<Module | null>(null);
	let actionError = $state('');
	let refreshing = $state(false);
	// Without JavaScript each row has a Simpan button; with it the switch submits its own form.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const save =
		(module: Module): SubmitFunction =>
		() => {
			shown = { ...data.flags };
			busy = module;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				} else {
					await update({ reset: false });
				}
				busy = null;
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

	const saved = $derived(!busy && form && 'saved' in form && form.saved);
	const banner = $derived(
		actionError || (form && 'error' in form && form.error ? tr(form.error) : undefined)
	);
</script>

<svelte:head><title>{tr('Fitur')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Fitur')}
/>

<p class="intro">
	{tr(
		'Sembunyikan menu yang tidak kamu pakai. Hanya tampilanmu yang berubah: anggota ruang lain tidak terpengaruh dan semua angka tetap dihitung.'
	)}
</p>

{#if saved}<p class="ok" role="status">{tr('Perubahan disimpan.')}</p>{/if}
<FormBanner message={banner} />

{#if refreshing}
	<Skeleton rows={5} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else}
	<GroupList>
		{#each MODULES as module (module)}
			{@const item = featureItem(MODULE_NAV[module] ?? '')}
			<GroupRow>
				<!-- FN-54: the module's chip from the feature registry; Ruang bersama has no menu entry, so a plain circle. -->
				{#if item}
					<FeatureChip icon={item.icon} tone={item.tone} size={40} />
				{:else}
					<span class="circle" aria-hidden="true"><Icon name="user" size={20} /></span>
				{/if}
				<form method="POST" action="?/setFlag" class="row-form" use:enhance={save(module)}>
					<input type="hidden" name="module" value={module} />
					<!-- A module with no menu entry has nothing to hide: its switch stays off the table, with the reason. -->
					<Toggle
						name="enabled"
						label={tr(MODULE_LABELS[module])}
						hint={busy === module
							? tr('Menyimpan…')
							: MODULE_NAV[module]
								? undefined
								: tr('Belum ada menu untuk disembunyikan')}
						bind:checked={() => shown[module], (v) => (shown = { ...shown, [module]: v })}
						disabled={busy !== null || !MODULE_NAV[module]}
						onchange={(event) => event.currentTarget.form?.requestSubmit()}
					/>
					{#if !hydrated && MODULE_NAV[module]}
						<Button type="submit" variant="secondary" size="sm">{tr('Simpan')}</Button>
					{/if}
				</form>
			</GroupRow>
		{/each}
	</GroupList>
{/if}

<style>
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.row-form {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.circle {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
