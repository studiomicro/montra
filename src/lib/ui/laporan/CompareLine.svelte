<script lang="ts">
	import { compareState } from '#lib/shared/compare';
	import { useI18n } from '#lib/ui/i18n-context';
	import ComparePill from '#lib/ui/kit/ComparePill.svelte';

	/** The comparison pill, or a neutral "no data" line when the compared period has none (never "lebih boros"). */
	let {
		currentMinor,
		diffMinor,
		monthName
	}: { currentMinor: number | null; diffMinor: number | null; monthName: string } = $props();

	const { trf } = useI18n();
	const state = $derived(compareState(currentMinor, diffMinor));
</script>

{#if state === 'pill' && diffMinor !== null}
	<ComparePill {currentMinor} {diffMinor} {monthName} />
{:else if state === 'no-previous'}
	<p class="none">{trf('Belum ada data {bulan}', { bulan: monthName })}</p>
{/if}

<style>
	.none {
		display: inline-flex;
		margin: 0;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
	}
</style>
