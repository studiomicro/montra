<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';

	/**
	 * A labelled picker button for /impor (wallet, template, bank): the label above, the current choice with a
	 * chevron inside, and the PickerSheet it opens owned by the page. With `ariaLabel` the button is named for what
	 * it does and the current choice is its description; without it the choice is the name.
	 */
	let {
		label,
		value,
		icon,
		onclick,
		disabled = false,
		ariaLabel
	}: {
		label: string;
		value: string;
		icon: IconName;
		onclick: () => void;
		disabled?: boolean;
		ariaLabel?: string;
	} = $props();
	const uid = $props.id();
</script>

<div class="picker">
	<span class="picker-label" id="{uid}-label">{label}</span>
	<button
		type="button"
		class="pick"
		aria-haspopup="dialog"
		aria-label={ariaLabel}
		aria-describedby={ariaLabel ? `${uid}-label ${uid}-value` : `${uid}-label`}
		{onclick}
		{disabled}
	>
		<Icon name={icon} size={18} />
		<span class="pick-text" id="{uid}-value">{value}</span>
		<Icon name="chevron-down" size={16} />
	</button>
</div>

<style>
	.picker {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.picker-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	/* Same ring as the global field rule (app.css): a --bg pill alone is too faint on a --panel card. */
	.pick {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
		text-align: left;
	}
	.pick-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.pick:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.pick:disabled {
		opacity: 0.5;
	}
</style>
