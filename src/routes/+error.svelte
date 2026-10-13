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

<EmptyState
	mascot="sad"
	text={page.status === 404 ? tr('Halaman tidak ditemukan.') : tr('Terjadi kesalahan. Coba lagi.')}
	actionLabel={tr('Kembali ke Beranda')}
	actionHref="/"
/>
