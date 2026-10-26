<script lang="ts" generics="T extends string">
	// Wrapping row of native radios styled as pills (Jenis in the wallet and net-worth forms). Native radios keep
	// the arrow keys, the single tab stop and the plain form post without JavaScript.
	let {
		options,
		name,
		value = $bindable(),
		onchange
	}: {
		options: { value: T; label: string }[];
		/** Form field name: the checked option is submitted under it. */
		name: string;
		value: T;
		onchange?: (value: T) => void;
	} = $props();
</script>

<div class="pills">
	{#each options as option (option.value)}
		<label class="pill">
			<input
				type="radio"
				{name}
				value={option.value}
				checked={value === option.value}
				onchange={() => {
					value = option.value;
					onchange?.(option.value);
				}}
			/>
			<span>{option.label}</span>
		</label>
	{/each}
</div>

<style>
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pill {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 16px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}
	.pill input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.pill:has(input:checked) {
		background: var(--action);
		color: var(--on-action);
	}
	.pill:has(input:focus-visible) {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
</style>
