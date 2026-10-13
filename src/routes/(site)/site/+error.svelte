<script lang="ts">
	import { page } from '$app/state';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import { useI18n } from '#lib/ui/i18n-context';

	const { tr, locale } = useI18n();
</script>

<svelte:head><meta name="robots" content="noindex" /></svelte:head>
<p class="error">
	{page.status === 404 ? tr('Halaman tidak ditemukan.') : tr('Terjadi kesalahan. Coba lagi.')}
	<a href={localizedSitePath(locale, '/')}>{tr('Kembali ke beranda situs')}</a>
</p>

<style>
	.error {
		padding: 64px 0;
		text-align: center;
	}
	.error a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
	}
</style>
