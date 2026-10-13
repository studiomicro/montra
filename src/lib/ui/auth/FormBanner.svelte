<script lang="ts">
	let { message }: { message: string | undefined } = $props();
</script>

<!-- Form-level error (wrong credentials, throttled, server refusal); announced to screen readers. -->
<div class="banner" role="alert">
	{#if message}<p>{message}</p>{/if}
</div>

<style>
	.banner:empty {
		display: none;
	}
	.banner p {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-size: 15px;
	}
</style>
