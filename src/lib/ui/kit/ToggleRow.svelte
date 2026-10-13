<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';
	import Toggle from './Toggle.svelte';

	/**
	 * § 2 toggle row (the Fitur sheet): an icon circle, the title with an optional "Beta" badge, a grey
	 * description and the switch on the right. The whole row is the switch's label (Toggle).
	 */
	let {
		icon,
		checked = $bindable(false),
		label,
		hint,
		badge,
		name,
		disabled = false,
		onchange
	}: {
		icon: IconName;
		checked?: boolean;
		label: string;
		hint?: string;
		badge?: string;
		name?: string;
		disabled?: boolean;
		onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
	} = $props();
</script>

<div class="toggle-row">
	<span class="circle" aria-hidden="true"><Icon name={icon} size={20} /></span>
	<Toggle bind:checked {label} {hint} {badge} {name} {disabled} {onchange} />
</div>

<style>
	.toggle-row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 8px 12px 8px 16px;
	}
	.circle {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
	}
</style>
