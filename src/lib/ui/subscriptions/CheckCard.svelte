<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	/**
	 * FN-26b: the subscription check card. Counts the candidates already loaded with the page (never invents
	 * one) and shows up to four of their tiles; "Jalankan pemeriksaan" is a plain link (`?periksa=1`) without
	 * JavaScript and opens the candidate sheet with it (`onopen`).
	 */
	let {
		candidates,
		onopen
	}: {
		candidates: { name: string; sourceRows: { id: string }[] }[];
		onopen?: (event: MouseEvent) => void;
	} = $props();
	const { tr, trf } = useI18n();

	const SHOWN = 4;
	const shown = $derived(candidates.slice(0, SHOWN));
	const more = $derived(candidates.length - shown.length);
</script>

<section class="check" aria-labelledby="check-title">
	<div class="head">
		<span class="icon"><Icon name="repeat" size={20} /></span>
		<h2 id="check-title">{tr('Pemeriksaan langganan')}</h2>
	</div>
	{#if candidates.length === 0}
		<p class="text">{tr('Belum ditemukan langganan baru')}</p>
	{:else}
		<p class="text">
			{trf('Ditemukan {n} kemungkinan langganan yang belum ada di daftar', {
				n: candidates.length
			})}
		</p>
		<ul class="badges" aria-hidden="true">
			{#each shown as c, i (c.sourceRows[0]?.id ?? i)}
				<li><BrandBadge name={c.name} size={36} /></li>
			{/each}
			{#if more > 0}<li class="more num">+{more}</li>{/if}
		</ul>
		<Button href="/langganan?periksa=1" onclick={onopen} full>{tr('Jalankan pemeriksaan')}</Button>
	{/if}
	<p class="note">
		{tr('Dari riwayat transaksi. Tidak ada yang ditambahkan tanpa persetujuanmu.')}
	</p>
</section>

<style>
	.check {
		display: grid;
		gap: 12px;
		margin-top: 16px;
		padding: 16px;
		border-radius: var(--r-m);
		background: var(--panel);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
	}
	h2 {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
	}
	.text,
	.note {
		margin: 0;
	}
	.text {
		font-size: 15px;
	}
	.note {
		font-size: 13px;
		color: var(--muted);
	}
	.badges {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.more {
		display: grid;
		place-items: center;
		min-width: 36px;
		height: 36px;
		padding: 0 8px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}
</style>
