<script lang="ts">
	/**
	 * An on/off switch for a persisted setting: a real `<input type="checkbox" role="switch">` inside its own
	 * label, so the label text toggles it, assistive tech reads it as a switch with its checked state, and an
	 * enclosing `<form>` submits `name=on` (checked) or nothing (unchecked) with or without JavaScript. The one
	 * switch primitive of the app (FN-12; FN-13's device-notification switch reuses it).
	 */
	let {
		checked = $bindable(false),
		label,
		hint,
		name,
		disabled = false,
		badge,
		onchange
	}: {
		checked?: boolean;
		label: string;
		/** A small pill after the label ("Beta"). */
		badge?: string;
		/** A line under the label, announced as the switch's description. */
		hint?: string;
		name?: string;
		disabled?: boolean;
		onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
	} = $props();

	const id = $props.id();
</script>

<label class="toggle" class:disabled for="{id}-input">
	<span class="text">
		<span class="label"
			>{label}{#if badge}<span class="badge">{badge}</span>{/if}</span
		>
		{#if hint}<span class="hint" id="{id}-hint">{hint}</span>{/if}
	</span>
	<span class="switch">
		<input
			id="{id}-input"
			type="checkbox"
			role="switch"
			{name}
			bind:checked
			{disabled}
			aria-describedby={hint ? `${id}-hint` : undefined}
			{onchange}
		/>
		<span class="track" aria-hidden="true"></span>
	</span>
</label>

<style>
	.toggle {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		cursor: pointer;
	}
	.toggle.disabled {
		cursor: not-allowed;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.label {
		color: var(--ink);
	}
	.badge {
		display: inline-flex;
		align-items: center;
		height: 20px;
		margin-left: 8px;
		padding: 0 8px;
		border-radius: var(--r-pill);
		background: var(--panel-2);
		color: var(--ink-2);
		font-size: 11px;
		font-weight: 700;
		vertical-align: 2px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.switch {
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		width: 52px;
		height: 44px;
	}
	/* The real checkbox covers the whole switch: it takes the click, the focus and the form value. */
	input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}
	.track {
		position: relative;
		width: 51px;
		height: 31px;
		border-radius: var(--r-pill);
		background: var(--muted);
		transition: background 0.2s var(--ease);
		pointer-events: none;
	}
	.track::after {
		content: '';
		position: absolute;
		top: 2px;
		left: 2px;
		width: 27px;
		height: 27px;
		border-radius: var(--r-pill);
		background: var(--bg);
		box-shadow: var(--shadow-float);
		transition: transform 0.2s var(--ease);
	}
	input:checked + .track {
		background: var(--ink);
	}
	input:checked + .track::after {
		transform: translateX(20px);
	}
	input:focus-visible + .track {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	input:disabled + .track {
		opacity: 0.5;
	}
	@media (prefers-reduced-motion: reduce) {
		.track,
		.track::after {
			transition: none;
		}
	}
</style>
