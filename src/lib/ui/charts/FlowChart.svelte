<script lang="ts">
	import { FLOW_BAR, flowLayout } from './geometry';
	import './series.css';

	/**
	 * One node: `name` and `amount` are drawn, `label` is the full text for assistive technology and the tooltip;
	 * `series` is a category tile key (its hue) or 'accent' (wallets); `href` opens its list.
	 */
	interface Node {
		key: string;
		name: string;
		amount: string;
		label: string;
		value: number;
		series: string;
		href: string | null;
	}

	let {
		columns: allColumns,
		links,
		heads: allHeads = [],
		label
	}: {
		/** Income categories, wallets, expense categories; each largest first. */
		columns: Node[][];
		/** A ribbon takes its source node's colour; `label` names it for assistive technology. */
		links: {
			from: string;
			to: string;
			value: number;
			label: string;
			href: string | null;
		}[];
		/** Column titles drawn above the bars (decorative: the list under the chart names everything). */
		heads?: string[];
		label: string;
	} = $props();

	// A column with no node (no income this month) is left out, with its title: it would only waste width.
	const columns = $derived(allColumns.filter((c) => c.length > 0));
	const heads = $derived(allHeads.filter((_, i) => (allColumns[i]?.length ?? 0) > 0));

	// The SVG is drawn at the width it is shown at (1 unit = 1 px), so text stays its real size at 360 px and on a
	// desktop. Before hydration (and without JavaScript) it is drawn for a phone and scaled to the container.
	let width = $state(360);
	const W = $derived(Math.max(300, Math.round(width)));
	/** Room for the column titles above the bars. */
	const TOP = $derived(heads.length > 0 ? 28 : 0);
	const layout = $derived(
		flowLayout(
			columns.map((c) => c.map((n) => ({ key: n.key, value: n.value }))),
			links.map((l) => ({ from: l.from, to: l.to, value: l.value })),
			W
		)
	);
	const byKey = $derived(new Map(columns.flat().map((n) => [n.key, n])));
	/** Characters of 12 px text that fit in `px` (bold names are wider than the amounts). */
	const clip = (text: string, px: number, perChar: number) => {
		const fit = Math.max(3, Math.floor(px / perChar));
		return text.length > fit ? `${text.slice(0, fit - 1)}…` : text;
	};
	/** Each title over its bar: the first ends at its bar, the last starts at its bar, the others centred. */
	const headX = (i: number) =>
		i === 0
			? (layout.barX[0] ?? 0) + FLOW_BAR
			: i === heads.length - 1
				? (layout.barX[i] ?? W)
				: (layout.barX[i] ?? 0) + FLOW_BAR / 2;
	const headAnchor = (i: number) => (i === 0 ? 'end' : i === heads.length - 1 ? 'start' : 'middle');
</script>

<figure class="flow" bind:clientWidth={width}>
	<svg viewBox="0 0 {W} {Math.max(1, layout.height + TOP)}" role="group" aria-label={label}>
		{#if heads.length > 0}
			<g aria-hidden="true">
				{#each heads as head, i (i)}
					<text class="head" x={headX(i)} y="12" text-anchor={headAnchor(i)}>{head}</text>
				{/each}
			</g>
		{/if}
		<g transform="translate(0 {TOP})">
			{#each layout.bands as b (b.index)}
				{@const link = links[b.index]}
				{#if link}
					{@const series = byKey.get(link.from)?.series ?? 'other'}
					{#if link.href}
						<a href={link.href} aria-label={link.label}>
							<path class="band series-{series}" d={b.d} />
						</a>
					{:else}
						<path class="band series-{series}" d={b.d} role="img" aria-label={link.label} />
					{/if}
				{/if}
			{/each}
			{#each layout.nodes as rect (rect.key)}
				{@const node = byKey.get(rect.key)}
				{#if node}
					{#snippet body(n: Node)}
						<title>{n.label}</title>
						<rect
							class="area"
							x={rect.x}
							y={rect.y}
							width={rect.width}
							height={rect.height}
							rx="8"
						/>
						<rect
							class="bar series-{n.series}"
							x={rect.bar.x}
							y={rect.bar.y}
							width={rect.bar.width}
							height={rect.bar.height}
							rx="2"
						/>
						<text class="name" x={rect.label.x} y={rect.label.y - 3} text-anchor={rect.label.anchor}
							>{clip(n.name, rect.label.width, 7.4)}</text
						>
						<text
							class="amount num"
							x={rect.label.x}
							y={rect.label.y + 13}
							text-anchor={rect.label.anchor}>{clip(n.amount, rect.label.width, 6.8)}</text
						>
					{/snippet}
					{#if node.href}
						<a class="hit" href={node.href} aria-label={node.label}>
							{@render body(node)}
						</a>
					{:else}
						<g role="img" aria-label={node.label}>{@render body(node)}</g>
					{/if}
				{/if}
			{/each}
		</g>
	</svg>
</figure>

<style>
	.flow {
		margin: 0;
		width: 100%;
		min-width: 0;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		overflow: visible;
	}
	/* A ribbon is its source's colour at 35 % in both themes; brighter while pointed at or focused. */
	.band {
		fill: var(--c);
		fill-opacity: 0.35;
		transition: fill-opacity 0.15s var(--ease);
	}
	a:hover .band,
	a:focus-visible .band {
		fill-opacity: 0.6;
	}
	a:focus-visible .band {
		stroke: var(--ink);
		stroke-width: 1.5;
	}
	.area {
		fill: transparent;
	}
	.hit:hover .area {
		fill: var(--panel);
		fill-opacity: 0.7;
	}
	.hit:focus-visible .area {
		stroke: var(--ink);
		stroke-width: 2;
	}
	.bar {
		fill: var(--c);
	}
	/* FN-40: when the chart appears the bars grow and the ribbons fade in after them (keyed: not on a resize). */
	@media (prefers-reduced-motion: no-preference) {
		.bar {
			transform-box: fill-box;
			transform-origin: 50% 50%;
			animation: bar-grow var(--duration-base) var(--ease) backwards;
		}
		.band {
			animation: band-in var(--duration-slow) var(--ease) var(--duration-fast) backwards;
		}
	}
	@keyframes bar-grow {
		from {
			transform: scaleY(0);
		}
	}
	@keyframes band-in {
		from {
			opacity: 0;
		}
	}
	.series-accent {
		--c: var(--accent);
	}
	.head {
		fill: var(--muted);
		font-size: 12px;
		font-weight: 600;
	}
	/* Labels may sit over a ribbon (the middle column): a halo in the page colour keeps them legible. */
	.name,
	.amount {
		font-size: 12px;
		paint-order: stroke;
		stroke: var(--bg);
		stroke-width: 4px;
		stroke-linejoin: round;
	}
	.name {
		fill: var(--ink);
		font-weight: 600;
	}
	.amount {
		fill: var(--ink-2);
	}
	/* On a touch screen a thin ribbon is no target: the nodes (≥ 44 px) and the list under the chart are. */
	@media (pointer: coarse) {
		.band {
			pointer-events: none;
		}
	}
</style>
