<script lang="ts">
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';

	// Red team N5 probe: a page that prints a figure before any HeroAmount, as a hero page does after the fix.
	applyAmountsHiddenAtLoad();
	const plain = shown('Rp 6.666');
</script>

<p class="before">{shown('Rp 9.999')}</p>
<p class="plain">{plain}</p>
