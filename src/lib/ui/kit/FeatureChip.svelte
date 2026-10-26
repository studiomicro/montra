<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';
	import type { ChipTone } from '#lib/ui/shell/nav';

	/**
	 * FN-54: a feature's glyph on a round chip tinted with its category hue, the category tile's recipe
	 * (`color-mix(--c 16%, --bg)`, DESIGN_SYSTEM.md § Category tiles) with the glyph in --ink-2. Decorative: the
	 * label beside it names the feature. The hue comes from the registry in nav.ts; mono turns every chip grey.
	 */
	let { icon, tone, size = 40 }: { icon: IconName; tone: ChipTone; size?: 28 | 36 | 40 } = $props();
	const glyph = $derived(size === 28 ? 16 : 20);
</script>

<span class="chip s{size} t-{tone}" aria-hidden="true"><Icon name={icon} size={glyph} /></span>

<style>
	.chip {
		--c: var(--cat-lain);
		display: grid;
		flex: none;
		place-items: center;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--c) 16%, var(--bg));
		color: var(--ink-2);
	}
	.s28 {
		width: 28px;
		height: 28px;
	}
	.s36 {
		width: 36px;
		height: 36px;
	}
	.s40 {
		width: 40px;
		height: 40px;
	}
	.t-pendidikan {
		--c: var(--cat-pendidikan);
	}
	.t-makan {
		--c: var(--cat-makan);
	}
	.t-hiburan {
		--c: var(--cat-hiburan);
	}
	.t-gaji {
		--c: var(--cat-gaji);
	}
	.t-belanja {
		--c: var(--cat-belanja);
	}
	.t-tempat-tinggal {
		--c: var(--cat-tempat-tinggal);
	}
	.t-freelance {
		--c: var(--cat-freelance);
	}
	.t-bunga {
		--c: var(--cat-bunga);
	}
	.t-tagihan {
		--c: var(--cat-tagihan);
	}
	.t-kopi {
		--c: var(--cat-kopi);
	}
	.t-hadiah {
		--c: var(--cat-hadiah);
	}
	.t-ojek-online {
		--c: var(--cat-ojek-online);
	}
	.t-pajak {
		--c: var(--cat-pajak);
	}
	.t-tarik-tunai {
		--c: var(--cat-tarik-tunai);
	}
	.t-kartu-kredit {
		--c: var(--cat-kartu-kredit);
	}
	.t-transfer {
		--c: var(--cat-transfer);
	}
</style>
