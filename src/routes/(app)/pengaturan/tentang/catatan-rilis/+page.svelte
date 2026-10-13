<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import ReleaseNote from '#lib/ui/pwa/ReleaseNote.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-42b "Catatan rilis": every release, newest first, server-rendered (works without JavaScript). Reached
	 * from Tentang's "Lihat semua" and the "Baru di Montra" notice; no navigation entry of its own.
	 */
	let { data } = $props();
	const { tr, trf } = useI18n();
</script>

<svelte:head><title>{tr('Catatan rilis')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/tentang', label: tr('Kembali ke Tentang Montra') }}
	title={tr('Catatan rilis')}
	subtitle={data.notes.length > 0 ? trf('{n} rilis', { n: data.notes.length }) : undefined}
/>

{#if data.notes.length === 0}
	<p class="note">{tr('Belum ada catatan rilis.')}</p>
{:else}
	<div class="list">
		{#each data.notes as note (note.version)}
			<ReleaseNote {note} level={2} current={note.version === data.version} />
		{/each}
	</div>
{/if}

<style>
	.list {
		display: grid;
		gap: 12px;
		margin-top: 8px;
	}
	.note {
		margin: 8px 0 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
