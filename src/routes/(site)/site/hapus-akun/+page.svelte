<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	let { data } = $props();
	const { tr } = useI18n();
	const mailto = $derived(
		data.supportEmail
			? `mailto:${data.supportEmail}?subject=${encodeURIComponent(tr('Permintaan hapus akun'))}`
			: null
	);
</script>

<SiteHead
	title={tr('Hapus akun')}
	description={tr(
		'Cara menghapus akun dan semua datanya, dari aplikasi atau lewat permintaan e-mail.'
	)}
	path="/hapus-akun"
/>
<article class="legal">
	<h1>{tr('Hapus akun')}</h1>
	<p>
		{tr(
			'Cara tercepat: masuk ke aplikasi, buka Pengaturan › Akun, lalu pilih Hapus akun. Akun, ruang pribadi dan semua sesi masuk langsung dihapus dari server.'
		)}
	</p>
	<a class="action" href="{data.appOrigin}/pengaturan/akun">{tr('Buka Pengaturan › Akun')}</a>

	<h2>{tr('Tidak bisa masuk?')}</h2>
	<p>
		{tr(
			'Kirim permintaan dari alamat e-mail akunmu. Kami memeriksa bahwa permintaan datang dari pemilik akun sebelum menghapusnya.'
		)}
	</p>
	{#if mailto}
		<a class="action quiet" href={mailto}>{tr('Kirim permintaan lewat e-mail')}</a>
	{:else}
		<p class="muted">{tr('Alamat dukungan belum dikonfigurasi.')}</p>
	{/if}
</article>

<style>
	.legal {
		max-width: 680px;
		padding: 48px 0;
	}
	h1 {
		margin: 0 0 16px;
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	h2 {
		margin: 40px 0 8px;
		font-size: 22px;
		font-weight: 700;
	}
	p {
		color: var(--ink-2);
	}
	.muted {
		color: var(--muted);
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
	.quiet {
		background: var(--panel);
		color: var(--ink);
	}
</style>
