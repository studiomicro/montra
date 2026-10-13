<script lang="ts">
	import type { Snippet } from 'svelte';
	/**
	 * `label`: the list's accessible name when no heading names it. `records`: a list of records (transactions,
	 * wallets, subscriptions, drafts) that, on a phone (up to 600 px), drops the panel for rows on the page with a
	 * 48 px rounded tile (phone layout v3).
	 */
	let {
		children,
		label,
		records = false
	}: { children: Snippet; label?: string; records?: boolean } = $props();
</script>

<!-- § 3a GroupedList: a panel fill, radius 20, no border, hairlines inset after the 40 px icon (16 px without one). -->
<ul class="group" class:records aria-label={label}>{@render children()}</ul>

<style>
	.group {
		list-style: none;
		margin: 0;
		padding: 0;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	/*
	 * FN-40: rows fade and slide in when the list appears; only the first 8 rows, 30 ms apart —
	 * a 500-row day adds no delay past the 8th row. Rows are keyed, so a re-render does not replay it.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.group > :global(li:nth-child(-n + 8)) {
			animation: row-in var(--duration-base) var(--ease) backwards;
		}
		.group > :global(li:nth-child(2)) {
			animation-delay: 30ms;
		}
		.group > :global(li:nth-child(3)) {
			animation-delay: 60ms;
		}
		.group > :global(li:nth-child(4)) {
			animation-delay: 90ms;
		}
		.group > :global(li:nth-child(5)) {
			animation-delay: 120ms;
		}
		.group > :global(li:nth-child(6)) {
			animation-delay: 150ms;
		}
		.group > :global(li:nth-child(7)) {
			animation-delay: 180ms;
		}
		.group > :global(li:nth-child(8)) {
			animation-delay: 210ms;
		}
	}
	@keyframes row-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	/* A row without a leading icon or tile (toggle and radio rows, plain text rows) starts its hairline at the gutter. */
	.group :global(li + li > .row)::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 16px;
		border-top: 1px solid var(--line);
	}
	/* With a leading tile or icon the hairline starts after it. */
	.group
		:global(
			li
				+ li
				> .row:has(
					> :is(.tile, .circle, .way-icon, img, [class*='icon']),
					> svg:first-child,
					> .check + svg
				)
		)::before {
		left: 68px;
	}

	/* Phone layout v3: rows sit on the page, 72 px high, the hairline starts after the 48 px tile. */
	@media (max-width: 600px) {
		.records {
			border-radius: 0;
			background: transparent;
			/* Stays hidden: it keeps a long title from widening the grid column the list sits in. */
			min-width: 0;
		}
		.records :global(.row) {
			gap: 16px;
			min-height: 72px;
			padding: 12px 0;
		}
		.records :global(.row .tile) {
			width: 48px;
			height: 48px;
			border-radius: 14px;
		}
		.records :global(.row .tile.emoji) {
			font-size: 24px;
		}
		.records :global(li + li > .row)::before {
			left: 0;
		}
		.records
			:global(
				li
					+ li
					> .row:has(
						> :is(.tile, .circle, .way-icon, img, [class*='icon']),
						> svg:first-child,
						> .check + svg
					)
			)::before {
			left: 64px;
		}
		/* Pills inside a row assumed a panel behind them; the rows now sit on the page colour. */
		.records :global(.row .badge),
		.records :global(.row .due:not(.soon)),
		.records :global(.row .pay),
		.records :global(.btn.secondary),
		.records :global(.btn.destructive) {
			background: var(--panel);
		}
	}
</style>
