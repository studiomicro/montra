<script lang="ts">
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { NET_WORTH_CLASS_LABELS, type NetWorthClass } from '#lib/shared/net-worth';
	import type { Allocation } from '#lib/shared/wealth';
	import { useI18n } from '#lib/ui/i18n-context';
	import { HIDDEN_AMOUNT } from '#lib/ui/kit/amount-visibility';
	import { amounts, shown } from '#lib/ui/kit/amounts.svelte';
	import { stackSegments } from '#lib/ui/kit/chart-scale';

	// FN-25b: where the assets sit, as one stacked bar with a chip per class (name, amount, share of all assets).
	// Figures and percentages arrive computed (allocationOf, server-side); this only draws them. Debts (and an
	// overdrawn class) are never a segment: each is its own minus line under the bar (owner decision 1), in ink: red
	// is only for "more than" and errors (DESIGN_SYSTEM § Colour, POLISH_AUDIT B5). While
	// amounts are hidden the shares hide too, and the bar is one plain segment (owner decision 2026-10-13: hiding
	// covers everything that reveals an amount).
	let { allocation }: { allocation: Allocation } = $props();
	const { tr, locale } = useI18n();

	const segments = $derived(
		stackSegments(
			allocation.slices.map((s) => s.minor),
			100
		)
	);
	const name = (cls: NetWorthClass) => tr(NET_WORTH_CLASS_LABELS[cls]);
	const pctText = (pct: number) => (amounts.hidden ? HIDDEN_AMOUNT : pct === 0 ? '<1%' : `${pct}%`);
	const tooLarge = () => tr('Total terlalu besar untuk ditampilkan');
	const barLabel = $derived(
		allocation.slices.map((s) => `${name(s.cls)} ${pctText(s.pct)}`).join(', ')
	);
</script>

<div class="allocation">
	{#if allocation.slices.length > 0}
		<svg
			class="bar"
			viewBox="0 0 100 10"
			preserveAspectRatio="none"
			role="img"
			aria-label={barLabel}
		>
			{#if amounts.hidden}
				<rect x="0" y="0" width="100" height="10" class="masked" />
			{:else}
				{#each segments as s, i (i)}
					<rect x={s.x} y="0" width={s.width} height="10" class="c-{allocation.slices[i]?.cls}" />
				{/each}
			{/if}
		</svg>
		<ul class="chips">
			{#each allocation.slices as s (s.cls)}
				<li class="chip">
					<span class="dot c-{s.cls}" aria-hidden="true"></span>
					<span class="name">{name(s.cls)}</span>
					<span class="share num"
						>{shown(formatMoneyCompact(s.minor, 'IDR', locale))} · {pctText(s.pct)}</span
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if allocation.outside.length > 0}
		<ul class="outside">
			{#each allocation.outside as o (o.cls)}
				<li>
					<span>{name(o.cls)}</span>
					<span class="num"
						>{o.minor === null
							? tooLarge()
							: shown(formatMoney(o.minor, 'IDR', 'auto', locale))}</span
					>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.allocation {
		display: grid;
		gap: 12px;
	}
	.bar {
		display: block;
		width: 100%;
		height: 12px;
		border-radius: var(--r-pill);
		background: var(--chart-track);
		overflow: hidden;
	}
	/* FN-51: segments fade in 30 ms apart, the first 8 only (no width animation). */
	@media (prefers-reduced-motion: no-preference) {
		rect:nth-child(-n + 8) {
			animation: seg-in var(--duration-base) var(--ease) backwards;
		}
		rect:nth-child(2) {
			animation-delay: 30ms;
		}
		rect:nth-child(3) {
			animation-delay: 60ms;
		}
		rect:nth-child(4) {
			animation-delay: 90ms;
		}
		rect:nth-child(5) {
			animation-delay: 120ms;
		}
		rect:nth-child(6) {
			animation-delay: 150ms;
		}
		rect:nth-child(7) {
			animation-delay: 180ms;
		}
		rect:nth-child(8) {
			animation-delay: 210ms;
		}
	}
	@keyframes seg-in {
		from {
			opacity: 0;
		}
	}
	/* A thin gap between segments (the page colour), so neighbouring classes stay apart in every theme. */
	rect {
		stroke: var(--bg);
		stroke-width: 2;
		vector-effect: non-scaling-stroke;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		padding: 4px 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		font-size: 13px;
	}
	.chip .name {
		font-weight: 600;
	}
	.chip .share {
		color: var(--muted);
	}
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}
	.outside {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 14px;
	}
	.outside li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-weight: 600;
	}
	.masked {
		fill: var(--line);
	}
	.c-wallets {
		fill: var(--nw-wallets);
		background: var(--nw-wallets);
	}
	.c-cash {
		fill: var(--nw-cash);
		background: var(--nw-cash);
	}
	.c-investment {
		fill: var(--nw-investment);
		background: var(--nw-investment);
	}
	.c-crypto {
		fill: var(--nw-crypto);
		background: var(--nw-crypto);
	}
	.c-gold {
		fill: var(--nw-gold);
		background: var(--nw-gold);
	}
	.c-property {
		fill: var(--nw-property);
		background: var(--nw-property);
	}
</style>
