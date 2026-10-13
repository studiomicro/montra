<script lang="ts">
	import { brandById } from '#lib/shared/brands';

	/**
	 * FN-43: the monogram badge of the registry entry `id` (a statement parser's or quick pick's own id), or
	 * nothing for an id the registry does not know. MONTRA's own text in a tint of the badge hue, never a logo.
	 * A future `BrandEntry.logoAsset` (only after the owner holds brand-guideline permission) would switch this
	 * one branch to an image.
	 * Size 24 (a chip) shows the first character only; the larger tiles show the whole monogram.
	 */
	let {
		id,
		size = 40,
		round = false
	}: { id: string; size?: 24 | 36 | 40 | 44; round?: boolean } = $props();
	const entry = $derived(brandById(id));
	const text = $derived(entry ? (size === 24 ? entry.badgeText.slice(0, 1) : entry.badgeText) : '');
	const long = $derived(text.length === 4);
	const longest = $derived(text.length > 4);
</script>

{#if entry}
	<span class="tile s{size} b-{entry.id}" class:round class:long class:longest aria-hidden="true"
		>{text}</span
	>
{/if}

<style>
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		overflow: hidden;
		border-radius: var(--r-s);
		background: color-mix(in srgb, var(--c) 16%, var(--bg));
		color: var(--ink);
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1;
		white-space: nowrap;
	}
	.round {
		border-radius: var(--r-pill);
	}
	.s44 {
		width: 44px;
		height: 44px;
		font-size: 15px;
	}
	.s40 {
		width: 40px;
		height: 40px;
		font-size: 14px;
	}
	.s36 {
		width: 36px;
		height: 36px;
		font-size: 13px;
	}
	.s24 {
		width: 24px;
		height: 24px;
		font-size: 12px;
	}
	/* Four or five characters still fit inside the tile, a round one included. */
	.s44.long {
		font-size: 12px;
	}
	.s40.long {
		font-size: 11px;
	}
	.s36.long {
		font-size: 10px;
	}
	.s44.longest {
		font-size: 10.5px;
	}
	.s40.longest {
		font-size: 9.5px;
	}
	.s36.longest {
		font-size: 9px;
	}
	.b-bca {
		--c: var(--badge-bca);
	}
	.b-mandiri {
		--c: var(--badge-mandiri);
	}
	.b-bni {
		--c: var(--badge-bni);
	}
	.b-bri {
		--c: var(--badge-bri);
	}
	.b-bsi {
		--c: var(--badge-bsi);
	}
	.b-cimb {
		--c: var(--badge-cimb);
	}
	.b-permata {
		--c: var(--badge-permata);
	}
	.b-danamon {
		--c: var(--badge-danamon);
	}
	.b-btn {
		--c: var(--badge-btn);
	}
	.b-ocbc {
		--c: var(--badge-ocbc);
	}
	.b-jago {
		--c: var(--badge-jago);
	}
	.b-seabank {
		--c: var(--badge-seabank);
	}
	.b-blu {
		--c: var(--badge-blu);
	}
	.b-jenius {
		--c: var(--badge-jenius);
	}
	.b-allo {
		--c: var(--badge-allo);
	}
	.b-gopay {
		--c: var(--badge-gopay);
	}
	.b-ovo {
		--c: var(--badge-ovo);
	}
	.b-dana {
		--c: var(--badge-dana);
	}
	.b-shopeepay {
		--c: var(--badge-shopeepay);
	}
	.b-linkaja {
		--c: var(--badge-linkaja);
	}
	.b-astrapay {
		--c: var(--badge-astrapay);
	}
	.b-isaku {
		--c: var(--badge-isaku);
	}
	.b-gojek {
		--c: var(--badge-gojek);
	}
	.b-gofood {
		--c: var(--badge-gofood);
	}
	.b-grab {
		--c: var(--badge-grab);
	}
	.b-maxim {
		--c: var(--badge-maxim);
	}
	.b-shopeefood {
		--c: var(--badge-shopeefood);
	}
	.b-indrive {
		--c: var(--badge-indrive);
	}
</style>
