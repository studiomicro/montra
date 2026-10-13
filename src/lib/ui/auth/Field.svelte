<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		id,
		label,
		error,
		hint,
		...input
	}: { id: string; label: string; error?: string; hint?: string } & HTMLInputAttributes = $props();
	const describedBy = $derived(
		[error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id}>{label}</label>
	<input {id} {...input} aria-invalid={error ? 'true' : undefined} aria-describedby={describedBy} />
	{#if hint}<p id="{id}-hint" class="hint">{hint}</p>{/if}
	{#if error}<p id="{id}-error" class="error">{error}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 6px;
	}
	label {
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}
	/* § 3a inputs: 48 px, radius 12, panel fill, no border; an invalid field gets a red inner ring. */
	input {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
	input[aria-invalid='true'] {
		box-shadow: inset 0 0 0 1.5px var(--money-up);
	}
	.hint,
	.error {
		margin: 0;
		font-size: 13px;
	}
	.hint {
		color: var(--muted);
	}
	.error {
		color: var(--money-up);
	}
</style>
