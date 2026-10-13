<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { msg } from '#lib/shared/i18n';
	import { hasProLook } from '#lib/shared/pro-look';
	import { THEME_LABELS } from '#lib/shared/theme';
	import Icon from '#lib/ui/Icon.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	const OPTIONS = [
		{ value: 'system', label: THEME_LABELS.system, hint: msg('Ikut terang atau gelap perangkat') },
		{ value: 'light', label: THEME_LABELS.light, hint: msg('Latar putih, selalu') },
		{ value: 'dark', label: THEME_LABELS.dark, hint: msg('Latar gelap, selalu') },
		{
			value: 'mono',
			label: THEME_LABELS.mono,
			hint: msg(
				'Hanya abu-abu, ikut terang atau gelap perangkat. Uang masuk dan keluar tetap berwarna.'
			)
		},
		{
			value: 'gold',
			label: THEME_LABELS.gold,
			hint: msg('Hangat keemasan, ikut terang atau gelap perangkat'),
			pro: true
		},
		{
			value: 'emerald',
			label: THEME_LABELS.emerald,
			hint: msg('Hijau tua yang tenang, ikut terang atau gelap perangkat'),
			pro: true
		}
	] as const;

	/**
	 * FN-46: the Pro themes are choices only while the server says a paid plan is in force (`shell.plan`, from
	 * hooks.server.ts); otherwise each is a link to Paket. The form action refuses a forged post either way.
	 */
	const proLook = $derived(hasProLook(data.shell.plan));

	// What the radios show: the server's choice. A picked option is submitted at once (with JavaScript) and the
	// page follows the server once the cookie write is confirmed; a refusal puts the radios back.
	let shown = $derived<string>(data.theme);
	let busy = $state(false);
	let actionError = $state('');
	let formEl: HTMLFormElement | undefined = $state();
	// Without JavaScript the list has a Simpan button; with it a picked row submits its own form.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const save: SubmitFunction = ({ formData }) => {
		shown = String(formData.get('theme') ?? data.theme);
		busy = true;
		actionError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			} else {
				// The cookie is written: repaint now (the server sets <html data-theme> only on a full load).
				if (result.type === 'success' && typeof result.data?.saved === 'string')
					document.documentElement.dataset.theme = result.data.saved;
				await update({ reset: false });
			}
			// The server answered: show its choice (the new one after a save, the old one after a refusal).
			shown = data.theme;
			busy = false;
		};
	};

	const saved = $derived(!busy && form && 'saved' in form && form.saved);
	const banner = $derived(
		actionError || (form && 'error' in form && form.error ? tr(form.error) : undefined)
	);
</script>

<svelte:head><title>{tr('Tampilan')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Tampilan')}
/>

<p class="intro">{tr('Berlaku di perangkat ini saja.')}</p>

{#if saved}<p class="ok" role="status">{tr('Perubahan disimpan.')}</p>{/if}
<FormBanner message={banner} />

<form method="POST" bind:this={formEl} use:enhance={save}>
	<fieldset disabled={busy}>
		<legend class="sr-only">{tr('Tampilan')}</legend>
		<GroupList>
			{#each OPTIONS as option (option.value)}
				{#if 'pro' in option && !proLook}
					<GroupRow href="/pengaturan/paket">
						<span class="lock" aria-hidden="true"><Icon name="lock" size={18} /></span>
						<span class="text" data-testid="locked-{option.value}">
							<span class="title">{tr(option.label)}</span>
							<span class="hint">{tr('Perlu paket Pro atau Agen')}</span>
						</span>
						<ProBadge />
					</GroupRow>
				{:else}
					<GroupRow
						radio
						name="theme"
						value={option.value}
						selected={shown === option.value}
						onToggle={(on) => on && formEl?.requestSubmit()}
					>
						<span class="text">
							<span class="title">{tr(option.label)}</span>
							<span class="hint"
								>{busy && shown === option.value ? tr('Menyimpan…') : tr(option.hint)}</span
							>
						</span>
						{#if 'pro' in option}<ProBadge />{/if}
					</GroupRow>
				{/if}
			{/each}
		</GroupList>
	</fieldset>
	{#if !hydrated}
		<div class="actions"><Button type="submit">{tr('Simpan')}</Button></div>
	{/if}
</form>

<style>
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.lock {
		display: grid;
		flex: none;
		place-items: center;
		width: 22px;
		color: var(--muted);
	}
	.title {
		font-size: 15px;
		font-weight: 600;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.actions {
		margin-top: 16px;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
