<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';

	/**
	 * § 3a search: a full-width panel pill with a leading magnifier and no label above it (the label is the
	 * accessible name and the placeholder). Plain `<input type="search">`, so Enter submits its form without
	 * JavaScript.
	 */
	let {
		label,
		name,
		value = $bindable(''),
		placeholder,
		maxlength,
		oninput
	}: {
		label: string;
		name: string;
		value?: string;
		placeholder?: string;
		maxlength?: number;
		oninput?: (value: string) => void;
	} = $props();
	const id = $props.id();
</script>

<div class="search">
	<label class="icon" for={id}><Icon name="search" size={18} /></label>
	<input
		{id}
		{name}
		type="search"
		aria-label={label}
		placeholder={placeholder ?? label}
		autocomplete="off"
		enterkeyhint="search"
		{maxlength}
		bind:value
		oninput={() => oninput?.(value)}
	/>
</div>

<style>
	.search {
		position: relative;
		display: flex;
		align-items: center;
		min-width: 0;
	}
	.icon {
		position: absolute;
		left: 16px;
		display: grid;
		color: var(--muted);
		pointer-events: none;
	}
	input {
		width: 100%;
		min-width: 0;
		height: 44px;
		padding: 0 16px 0 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		/* Phone layout v3: the plain grey search pill, no hairline. */
		box-shadow: none;
		color: var(--ink);
		font: inherit;
		font-size: 16px;
	}
	input::placeholder {
		color: var(--muted);
	}
	input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
</style>
