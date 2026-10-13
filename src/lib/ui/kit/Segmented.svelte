<script lang="ts">
	let {
		options,
		value = $bindable(),
		label,
		name,
		onchange
	}: {
		/** `disabled`: shown but not selectable (the reason is said next to the control). */
		options: { value: string; label: string; disabled?: boolean }[];
		value: string;
		label: string;
		/** Form field name: set it and the choice is submitted with a plain form, JavaScript or not. */
		name?: string;
		onchange?: (value: string) => void;
	} = $props();

	// Native radios: one tab stop for the group, arrow keys move and select (roving focus by the browser),
	// and the checked option posts with the form without JavaScript.
	const uid = $props.id();
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
	{#each options as option (option.value)}
		<label class="segment">
			<input
				type="radio"
				name={name ?? uid}
				value={option.value}
				disabled={option.disabled}
				bind:group={value}
				onchange={() => onchange?.(option.value)}
			/>
			<span>{option.label}</span>
		</label>
	{/each}
</div>

<style>
	/*
	 * § 2/§ 3a: a panel track with the glass edge (FN-40; no blur — it sits in the page, not over it); the
	 * selected option is a raised glass pill with the one shadow of the control.
	 */
	.segmented {
		display: inline-flex;
		max-width: 100%;
		gap: 2px;
		padding: 3px;
		border-radius: var(--r-pill);
		background: var(--panel);
		box-shadow: inset 0 0 0 1px var(--glass-border);
	}
	.segment {
		position: relative;
		display: inline-flex;
		align-items: center;
		flex: 0 1 auto;
		justify-content: center;
		min-width: 0;
		min-height: 36px;
		padding: 0 14px;
		border-radius: var(--r-pill);
		color: var(--muted);
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition:
			background 0.2s var(--ease),
			color 0.2s var(--ease);
	}
	@media (pointer: coarse) {
		.segment {
			min-height: 44px;
		}
	}
	input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.segment:has(input:checked) {
		background: var(--raised);
		color: var(--ink);
		box-shadow:
			inset 0 0 0 1px var(--glass-border),
			var(--glass-shadow);
	}
	.segment:has(input:disabled) {
		cursor: not-allowed;
		text-decoration: line-through;
	}
	input:disabled {
		cursor: not-allowed;
	}
	.segment:has(input:focus-visible) {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
</style>
