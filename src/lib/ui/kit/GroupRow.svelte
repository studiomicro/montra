<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { TransitionConfig } from 'svelte/transition';
	let {
		href,
		selected,
		onToggle,
		radio = false,
		name,
		value,
		children,
		extra,
		highlight = false,
		exit
	}: {
		href?: string;
		/**
		 * Set (true/false) to render the row as a checkbox row: the whole row is the label, the leading checkbox
		 * posts `name`=`value` with its form (so it works without JavaScript) and calls `onToggle` when changed.
		 */
		selected?: boolean;
		onToggle?: (selected: boolean) => void;
		/** With `selected`: a radio (one of a group sharing `name`) instead of a checkbox. */
		radio?: boolean;
		name?: string;
		value?: string;
		children: Snippet;
		/** With `selected`: content under the row (outside the label), e.g. a per-row control that must not toggle it. */
		extra?: Snippet;
		/** FN-51: replays the row's enter animation once (the row an action result names). */
		highlight?: boolean;
		/** FN-51: an exit transition for a row removed in place (`rowOut` from `#lib/ui/motion`). */
		exit?: (node: Element) => TransitionConfig;
	} = $props();
</script>

{#snippet inner()}
	{#if selected !== undefined}
		<label class="row selectable">
			<input
				type={radio ? 'radio' : 'checkbox'}
				class="check"
				{name}
				{value}
				checked={selected}
				onchange={(event) => onToggle?.(event.currentTarget.checked)}
			/>
			{@render children()}
		</label>
		{@render extra?.()}
	{:else if href}
		<!-- FN-13b: a link to another origin (the public site) never hands this page to it. -->
		<a
			class="row tappable"
			{href}
			rel={/^[a-z][a-z0-9+.-]*:/i.test(href) ? 'noopener noreferrer' : undefined}
			>{@render children()}</a
		>
	{:else}
		<div class="row">{@render children()}</div>
	{/if}
{/snippet}

{#if exit}
	<li class:fresh={highlight} out:exit>{@render inner()}</li>
{:else}
	<li class:fresh={highlight}>{@render inner()}</li>
{/if}

<style>
	.row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 60px;
		padding: 10px 16px;
		color: var(--ink);
		text-decoration: none;
	}
	.tappable {
		transition:
			transform 0.15s var(--ease),
			background 0.2s var(--ease);
	}
	.tappable:hover {
		background: var(--panel-2);
	}
	.tappable:active {
		transform: scale(var(--press-scale));
	}
	.selectable {
		cursor: pointer;
	}
	/* FN-40: a checkbox/radio row presses like a link row. */
	@media (prefers-reduced-motion: no-preference) {
		.selectable {
			transition: transform var(--duration-fast) var(--ease);
		}
		.selectable:active {
			transform: scale(var(--press-scale));
		}
		/* FN-51: the row an action result names replays its enter animation once (GroupList's row-in). */
		.fresh {
			animation: row-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes row-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	/* FN-51: desktop hover/focus lift on tappable rows — the hover colour everywhere, the 1 px rise only with motion. */
	@media (min-width: 1024px) and (hover: hover) and (pointer: fine) {
		.tappable:focus-visible,
		.selectable:hover,
		.selectable:focus-within {
			background: var(--panel-2);
		}
		/* `:not(:active)`: a press keeps its scale (the lift would otherwise override it on desktop). */
		@media (prefers-reduced-motion: no-preference) {
			.tappable:hover:not(:active),
			.tappable:focus-visible:not(:active),
			.selectable:hover:not(:active),
			.selectable:focus-within:not(:active) {
				transform: translateY(-1px);
			}
		}
	}
	.check {
		flex: none;
		width: 22px;
		height: 22px;
		margin: 0;
		accent-color: var(--action);
	}
</style>
