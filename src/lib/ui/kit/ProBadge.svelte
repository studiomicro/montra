<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import { CROWN } from './mascot/poses';

	/**
	 * FN-46: the Pro look's badge, beside the account's name (sidebar, Pengaturan, Akun) and on the Paket card.
	 * Montra's own mark — Koko's 8 × 3 pixel crown and the word "Pro" — the same on Pro and Agen (owner decision 5).
	 * The caller shows it only when the server-derived plan has the Pro look; it is never an access decision.
	 */
	const { tr } = useI18n();
	const PIXELS = CROWN.flatMap((row, y) =>
		[...row].flatMap((p, x) => (p === 'k' ? [{ x, y }] : []))
	);
</script>

<span class="pro-badge" data-testid="pro-badge">
	<svg
		class="crown"
		width="16"
		height="6"
		viewBox="0 0 {CROWN[0]!.length} {CROWN.length}"
		aria-hidden="true"
		focusable="false"
	>
		{#each PIXELS as p, i (i)}<rect x={p.x} y={p.y} width="1" height="1" />{/each}
	</svg>
	<span>{tr('Pro')}</span>
</span>

<style>
	.pro-badge {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding: 0 8px;
		border-radius: var(--r-pill);
		background: var(--pro-soft);
		color: var(--pro-text);
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.01em;
		line-height: 1;
		white-space: nowrap;
	}
	.crown {
		display: block;
		fill: var(--pro);
		shape-rendering: crispEdges;
	}
</style>
