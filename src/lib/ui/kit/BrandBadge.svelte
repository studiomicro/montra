<script lang="ts">
	import { matchBrand } from '#lib/shared/brands';
	import BrandBadgeById from './BrandBadgeById.svelte';
	import InitialsTile from './InitialsTile.svelte';

	/**
	 * FN-43: a wallet's or subscription's tile. A name that names a bank, e-wallet or ride/food service ("Tabungan
	 * BCA", "GoPay Plus") gets that service's monogram badge; any other name keeps its InitialsTile unchanged.
	 * Decorative: the row's own text stays its accessible name.
	 */
	let {
		name,
		size = 40,
		round = false
	}: { name: string; size?: 36 | 40 | 44; round?: boolean } = $props();
	const entry = $derived(matchBrand(name));
</script>

{#if entry}
	<BrandBadgeById id={entry.id} {size} {round} />
{:else}
	<InitialsTile {name} {size} {round} />
{/if}
