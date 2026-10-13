<script lang="ts">
	/**
	 * AI helpers that are not configured yet (no AI key): each shown as a visible, disabled button with one
	 * "Belum dikonfigurasi" hint. No handler, no request.
	 */
	let { id, labels, hint }: { id: string; labels: readonly string[]; hint: string } = $props();
</script>

<div class="ai">
	<div class="buttons">
		{#each labels as label, i (i)}
			<button type="button" class="ai-button" disabled aria-describedby={id}>{label}</button>
		{/each}
	</div>
	<p {id} class="meta">{hint}</p>
</div>

<style>
	.ai {
		display: grid;
		gap: 6px;
		justify-items: start;
	}
	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.ai-button {
		min-height: 44px;
		padding: 0 16px;
		border: 1px dashed var(--line);
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
		cursor: not-allowed;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
</style>
