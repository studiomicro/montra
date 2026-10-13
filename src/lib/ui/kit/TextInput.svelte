<script lang="ts">
	let {
		label,
		value = $bindable(''),
		name,
		type = 'text',
		autocomplete
	}: {
		label: string;
		value?: string;
		name?: string;
		type?: 'text' | 'email' | 'search';
		autocomplete?: HTMLInputElement['autocomplete'];
	} = $props();
	const id = $props.id();
</script>

<label class="field" for={id}>
	<span class="label">{label}</span>
	<input {id} {name} {type} {autocomplete} bind:value class="input" />
</label>

<style>
	.field {
		display: grid;
		gap: 6px;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.005em;
	}
	.input {
		height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
	}
	.input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
</style>
