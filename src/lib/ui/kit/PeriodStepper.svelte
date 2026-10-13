<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';

	/**
	 * ‹ label › on a panel pill. Steps are links, so they work without JavaScript; `nextHref` null (the future)
	 * leaves the next step visibly disabled.
	 */
	let {
		label,
		prevHref,
		nextHref
	}: { label: string; prevHref: string | null; nextHref: string | null } = $props();
	const { tr } = useI18n();
</script>

<div class="stepper">
	{#if prevHref}
		<a class="step" href={prevHref} aria-label={tr('Periode sebelumnya')}>
			<Icon name="chevron-left" size={16} />
		</a>
	{:else}
		<span class="step off" aria-hidden="true"><Icon name="chevron-left" size={16} /></span>
	{/if}
	<span class="label num" aria-live="polite">{label}</span>
	{#if nextHref}
		<a class="step" href={nextHref} aria-label={tr('Periode berikutnya')}>
			<Icon name="chevron-right" size={16} />
		</a>
	{:else}
		<span class="step off" aria-hidden="true"><Icon name="chevron-right" size={16} /></span>
	{/if}
</div>

<style>
	.stepper {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		border-radius: var(--r-pill);
		background: var(--panel);
	}
	.label {
		padding: 0 6px;
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}
	.step {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		color: var(--ink);
	}
	a.step:hover {
		background: var(--panel-2);
	}
	@media (pointer: coarse) {
		.step {
			width: 44px;
			height: 44px;
		}
	}
	.off {
		color: var(--faint);
	}
</style>
