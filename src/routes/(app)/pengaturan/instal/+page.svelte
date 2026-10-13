<script lang="ts">
	import { onMount } from 'svelte';
	import { msg } from '#lib/shared/i18n';
	import { hasProLook } from '#lib/shared/pro-look';
	import { detectIosBrowser, type IosBrowser } from '#lib/shared/user-agent';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import { installPrompt, isStandalone, promptInstall } from '#lib/ui/pwa/install.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * What only the app's own origin can do: the browser's install prompt and the "already installed" state.
	 * The steps per platform and the QR code are the public guide's (/pasang on the site host, FN-32). iPhone and
	 * iPad Safari have no install prompt, so their steps are written here, with no need for the site host (FN-13b).
	 */
	let { data } = $props();
	const { tr } = useI18n();

	/** Same wording as the public guide (`/pasang`), so each phrase has one English entry. */
	const IOS_STEPS = [
		msg('Buka aplikasinya di Safari.'),
		msg('Ketuk tombol Bagikan (kotak dengan panah ke atas).'),
		msg('Pilih Tambah ke Layar Utama.'),
		msg('Jika ada pilihan Buka sebagai App Web, biarkan aktif.'),
		msg('Ketuk Tambah.')
	];

	let standalone = $state(false);
	let prompting = $state(false);
	/** Refined in the browser: iPadOS sends a desktop Mac agent the server cannot tell from a Mac. */
	let browserIos = $state<IosBrowser | null | undefined>();
	onMount(() => {
		standalone = isStandalone();
		browserIos = detectIosBrowser(navigator.userAgent, navigator.maxTouchPoints);
	});
	const iosBrowser = $derived(browserIos === undefined ? data.iosBrowser : browserIos);

	const installed = $derived(standalone || installPrompt.installed);
	// In-app browsers cannot install a web app: no button there (the root layout explains instead).
	const canPrompt = $derived(!data.inAppBrowser && installPrompt.event !== null);

	async function install() {
		prompting = true;
		try {
			await promptInstall();
		} finally {
			prompting = false;
		}
	}
</script>

<svelte:head><title>{tr('Pasang aplikasi')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Pasang aplikasi')}
/>

<!-- FN-46 (owner decision 4): a home-screen icon is fixed when the app is installed; the Pro icon never swaps in. -->
{#if hasProLook(data.shell.plan)}
	<p class="pro-icon" role="note" data-testid="pro-icon-note">
		<ProBadge />
		<span>{tr('Ikon Pro terlihat saat kamu memasang ulang aplikasi dari layar utama.')}</span>
	</p>
{/if}

{#if installed}
	<p class="installed" role="status">
		<Icon name="check" size={20} />{tr('Sudah terpasang')}
	</p>
	<p class="note">{tr('Buka aplikasi dari ikonnya di layar utama. Pembaruan masuk sendiri.')}</p>
{:else}
	<p class="intro">
		{tr(
			'Pasang aplikasi ke layar utama agar terbuka seperti aplikasi biasa, tanpa toko aplikasi. Pembaruan masuk sendiri.'
		)}
	</p>

	{#if iosBrowser}
		<section class="ios" aria-labelledby="ios-steps-title">
			{#if iosBrowser !== 'safari'}
				<p class="safari" role="note">{tr('Untuk memasang, buka halaman ini di Safari.')}</p>
				<p class="note">
					{tr(
						'Beberapa browser lain juga punya Tambah ke Layar Utama, tapi Safari yang paling pasti.'
					)}
				</p>
			{/if}
			<h2 id="ios-steps-title">{tr('iPhone dan iPad (Safari)')}</h2>
			<ol>
				{#each IOS_STEPS as step, i (i)}
					<li>{tr(step)}</li>
				{/each}
			</ol>
			<p class="note">{tr('Setelah terpasang, masuk sekali lagi di aplikasi.')}</p>
		</section>
	{/if}

	{#if canPrompt}
		<div class="prompt">
			<Button size="lg" full disabled={prompting} onclick={install}>
				{prompting ? tr('Menunggu browser…') : tr('Instal aplikasi')}
			</Button>
		</div>
	{/if}

	{#if data.guideUrl}
		<a class="guide" href={data.guideUrl} rel="noopener noreferrer"
			>{tr('Lihat panduan pemasangan')}</a
		>
		<p class="note">
			{tr('Langkah untuk iPhone, iPad dan Android, dengan kode QR untuk membukanya di ponsel.')}
		</p>
	{:else}
		<p class="note">
			<strong>{tr('Belum dikonfigurasi')}</strong> · {tr(
				'Panduan pemasangan ada di situs publik, yang belum dihubungkan ke alamat ini.'
			)}
		</p>
	{/if}
{/if}

<style>
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.installed {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 16px 0 0;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		color: var(--money-in);
		font-weight: 600;
	}
	.prompt {
		margin-bottom: 16px;
	}
	.pro-icon {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 4px 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-group);
		background: var(--pro-soft);
		color: var(--ink);
		font-size: 14px;
	}
	.guide {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		padding: 0 24px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.ios {
		margin-bottom: 16px;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.ios h2 {
		margin: 0 0 8px;
		font-size: 17px;
		font-weight: 700;
	}
	.ios ol {
		margin: 0;
		padding-left: 22px;
	}
	.ios li + li {
		margin-top: 6px;
	}
	.safari {
		margin: 0 0 4px;
		font-weight: 700;
	}
	.note {
		margin: 8px 0 0;
		font-size: 14px;
		color: var(--muted);
	}
</style>
