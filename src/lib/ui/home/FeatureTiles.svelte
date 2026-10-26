<script lang="ts">
	import type { Module } from '#lib/shared/feature-flags';
	import { useI18n } from '#lib/ui/i18n-context';
	import FeatureChip from '#lib/ui/kit/FeatureChip.svelte';
	import { openFiturSheet } from '#lib/ui/shell/fitur.svelte';
	import { featureTiles } from '#lib/ui/shell/nav';

	/**
	 * FN-54 A4: Beranda's "Fitur" grid. One link per feature page in sidebar order (hidden modules have none, FN-12),
	 * each with its chip, name and static hint from the registry; no figures (owner decision 12). "Kelola fitur"
	 * opens the Fitur sheet with JavaScript and /pengaturan/fitur without.
	 */
	let { hidden }: { hidden: readonly Module[] } = $props();
	const { tr } = useI18n();
	const tiles = $derived(featureTiles(hidden));
</script>

<section class="fitur" aria-labelledby="fitur-title">
	<div class="head">
		<h2 id="fitur-title">{tr('Fitur')}</h2>
		<a class="manage" href="/pengaturan/fitur" aria-haspopup="dialog" onclick={openFiturSheet}
			>{tr('Kelola fitur')}</a
		>
	</div>
	<ul class="tiles">
		{#each tiles as tile (tile.href)}
			<li>
				<a class="tile" href={tile.href}>
					<FeatureChip icon={tile.icon} tone={tile.tone} size={36} />
					<span class="name">{tr(tile.label)}</span>
					{#if tile.hint}<span class="hint">{tr(tile.hint)}</span>{/if}
				</a>
			</li>
		{/each}
	</ul>
</section>

<style>
	.fitur {
		display: grid;
		gap: 8px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.manage {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 14px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.manage:hover {
		color: var(--ink);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.tile {
		display: grid;
		align-content: start;
		justify-items: start;
		gap: 4px;
		min-height: 44px;
		height: 100%;
		padding: 12px;
		border-radius: var(--r-group);
		background: var(--panel);
		color: var(--ink);
		text-decoration: none;
	}
	.tile:hover {
		background: var(--panel-2);
	}
	.tile:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.tile :global(.chip) {
		margin-bottom: 4px;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.hint {
		color: var(--muted);
		font-size: 13px;
		line-height: 1.35;
	}
</style>
