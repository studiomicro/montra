<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';

	const { tr } = useI18n();
</script>

<svelte:head><title>{tr('Akun dihapus')}</title></svelte:head>

<h1>{tr('Akun dihapus')}</h1>
<p>
	{tr(
		'Akunmu dan data yang tersimpan di server sudah dihapus. Catatan di ruang bersama tetap ada untuk anggota lain.'
	)}
</p>
<a class="action" href="/daftar">{tr('Buat akun baru')}</a>

<style>
	h1 {
		margin: 0 0 8px;
		font-size: 28px;
		line-height: 1.1;
		font-weight: 800;
		letter-spacing: -0.03em;
	}
	p {
		margin: 0 0 24px;
		font-size: 15px;
		color: var(--muted);
	}
	@media (min-width: 1024px) {
		h1 {
			font-size: 34px;
		}
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
</style>
