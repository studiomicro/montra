<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';

	/** § 3a icon button: a 40 px round panel button or link, named by `label`. */
	let {
		icon,
		label,
		href,
		pressed,
		onclick
	}: {
		icon: IconName;
		label: string;
		href?: string;
		/** A toggle (theme, hide amounts): announced with its pressed state. */
		pressed?: boolean;
		onclick?: (event: MouseEvent) => void;
	} = $props();
</script>

{#if href}
	<a class="icon-btn" {href} aria-label={label} title={label}><Icon name={icon} size={20} /></a>
{:else}
	<button
		type="button"
		class="icon-btn"
		aria-label={label}
		title={label}
		aria-pressed={pressed}
		{onclick}
	>
		<Icon name={icon} size={20} />
	</button>
{/if}

<style>
	.icon-btn {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		transition: background 0.2s var(--ease);
	}
	.icon-btn:hover {
		background: var(--panel-2);
	}
	@media (pointer: coarse) {
		.icon-btn {
			width: 44px;
			height: 44px;
		}
	}
</style>
