<script lang="ts">
	import { page } from '$app/state';
	import { dropDeviceKey } from '#lib/ui/account-key/device';
	import { useI18n } from '#lib/ui/i18n-context';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';

	const { tr } = useI18n();
	// A 401 means the session ended (elsewhere): the opened account key goes with it (FN-21).
	$effect(() => {
		if (page.status === 401) dropDeviceKey();
	});
</script>

{#if page.status === 404}
	<EmptyState
		mascot="sad"
		text={tr('Halaman tidak ditemukan.')}
		actionLabel={tr('Kembali ke Beranda')}
		actionHref="/"
	/>
{:else}
	<!-- Error state with retry: reloads the same page (works without JavaScript). -->
	<EmptyState
		mascot="sad"
		text={tr('Terjadi kesalahan. Coba lagi.')}
		actionLabel={tr('Coba lagi')}
		actionHref={page.url.pathname + page.url.search}
	/>
{/if}
