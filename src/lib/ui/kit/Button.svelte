<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';

	let {
		variant = 'primary',
		size = 'md',
		type = 'button',
		disabled = false,
		full = false,
		formaction,
		href,
		icon,
		describedby,
		onclick,
		children
	}: {
		variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
		size?: 'lg' | 'md' | 'sm';
		type?: 'button' | 'submit';
		disabled?: boolean;
		full?: boolean;
		/** A submit button that posts its form to another action (`?/name`), with or without JavaScript. */
		formaction?: string;
		/** Renders the pill as a link (a page action such as "+ Tambah transaksi" or "Ekspor CSV"). */
		href?: string;
		/** Leading icon. */
		icon?: IconName;
		/** The id of the text that explains the button, e.g. why it is disabled. */
		describedby?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

{#if href}
	<a {href} {onclick} aria-describedby={describedby} class="btn {variant} {size}" class:full>
		{#if icon}<Icon name={icon} size={18} />{/if}
		{@render children()}
	</a>
{:else}
	<button
		{type}
		{disabled}
		{onclick}
		{formaction}
		aria-describedby={describedby}
		class="btn {variant} {size}"
		class:full
	>
		{#if icon}<Icon name={icon} size={18} />{/if}
		{@render children()}
	</button>
{/if}

<style>
	/* § 3a: ink is the only action colour; fills, never borders. The panel fills below add a 1px inset hairline. */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 0;
		border-radius: var(--r-pill);
		font: inherit;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition:
			transform 0.15s var(--ease),
			background 0.2s var(--ease),
			opacity 0.2s var(--ease);
	}
	.btn:active:not(:disabled) {
		transform: scale(var(--press-scale));
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.lg {
		height: 52px;
		padding: 0 24px;
		font-size: 16px;
	}
	.md {
		height: 44px;
		padding: 0 20px;
		font-size: 15px;
	}
	.sm {
		height: 40px;
		padding: 0 16px;
		font-size: 14px;
	}
	/* Touch: the same small pill, a 44 px target (e.g. Riwayat "Ekspor CSV"). */
	@media (pointer: coarse) {
		.sm {
			height: 44px;
		}
	}
	.full {
		width: 100%;
	}
	.primary {
		background: var(--ink);
		color: var(--bg);
	}
	.primary:hover:not(:disabled) {
		opacity: 0.88;
	}
	/* The hairline keeps a panel pill readable on a --panel card (same ring as the global field rule in app.css). */
	.secondary {
		background: var(--panel);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
		color: var(--ink);
	}
	.secondary:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.ghost {
		background: transparent;
		color: var(--ink);
	}
	.ghost:hover:not(:disabled) {
		background: var(--panel);
	}
	.destructive {
		background: var(--panel);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
		color: var(--money-up);
	}
</style>
