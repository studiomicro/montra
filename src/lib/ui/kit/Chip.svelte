<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';
	import BrandBadgeById from './BrandBadgeById.svelte';

	let {
		selected = false,
		count,
		href,
		icon,
		brand,
		popup = false,
		onclick,
		children
	}: {
		selected?: boolean;
		count?: number;
		/** A filter link (works without JavaScript); the selected one is marked `aria-current`. */
		href?: string;
		/** Leading icon (the Kategori and Dompet picker chips). */
		icon?: IconName;
		/** Leading brand badge (FN-43): a registry id from `#lib/shared/brands` (the e-wallet quick picks). */
		brand?: string;
		/** Opens a picker: announced as a dialog opener and drawn with a trailing chevron. */
		popup?: boolean;
		/** With `href`, runs before the link is followed (a picker chip opens its sheet and prevents it). */
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

{#snippet body()}
	{#if brand}<BrandBadgeById id={brand} size={24} round />{/if}
	{#if icon}<Icon name={icon} size={16} />{/if}
	{@render children()}
	{#if count !== undefined}<span class="count num">{count}</span>{/if}
	{#if popup}<Icon name="chevron-down" size={14} />{/if}
{/snippet}

{#if href}
	<a
		class="chip"
		class:branded={!!brand}
		{href}
		{onclick}
		aria-current={selected ? 'true' : undefined}
		aria-haspopup={popup ? 'dialog' : undefined}
	>
		{@render body()}
	</a>
{:else}
	<button
		type="button"
		class="chip"
		class:branded={!!brand}
		aria-pressed={popup ? undefined : selected}
		aria-haspopup={popup ? 'dialog' : undefined}
		{onclick}
	>
		{@render body()}
	</button>
{/if}

<style>
	.chip {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		text-decoration: none;
		transition:
			background 0.2s var(--ease),
			box-shadow 0.15s var(--ease),
			transform var(--duration-fast) var(--ease);
	}
	/* The round badge sits close to the pill's edge, as the pill's own curve. */
	.chip.branded {
		padding-left: 4px;
	}
	.chip:hover {
		background: var(--panel-2);
	}
	/* Touch: the same pill, a 44 px target. */
	@media (pointer: coarse) {
		.chip {
			min-height: 44px;
			padding: 0 14px;
		}
		.chip.branded {
			padding-left: 10px;
		}
	}
	/* Phone layout v3: the active chip is filled ink, the others are outlined (the row scrolls, never wraps). */
	@media (max-width: 600px) {
		.chip:not([aria-pressed='true'], [aria-current='true']) {
			background: transparent;
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
		}
	}
	.chip[aria-pressed='true'],
	.chip[aria-current='true'] {
		background: var(--ink);
		color: var(--bg);
		/* The glass edge (FN-40): a specular top highlight on the selected pill. */
		box-shadow: inset 0 1px 0 var(--glass-border);
	}
	/* Glass press lift (FN-40): the pressed chip rises; never under reduced motion. */
	@media (prefers-reduced-motion: no-preference) {
		.chip:active {
			box-shadow:
				inset 0 1px 0 var(--glass-border),
				var(--glass-shadow);
			/* FN-40 Part 2: the same press scale as Button, TabBar and GroupRow. */
			transform: scale(var(--press-scale));
		}
	}
	.count {
		opacity: 0.7;
	}
</style>
