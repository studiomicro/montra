<script lang="ts">
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import {
		ASCII_DESKTOP_GRID,
		ASCII_PHONE_GRID,
		ASCII_STATIC_T,
		asciiFrame,
		type AsciiFrame
	} from '#lib/shared/ascii-field';
	import { createAsciiPlayer } from './ascii-playback';

	/**
	 * FN-56: the decorative ASCII field of /masuk and /daftar. Both grids are server-rendered with the still frame;
	 * CSS shows one (a band below 1024 px, a tall card from 1024 px, none on a screen shorter than 600 px). Each
	 * grid animates only while it is on screen (a grid hidden by CSS never intersects), the tab is visible and
	 * motion is allowed, and freezes after a minute of play. Three stacked <pre>s carry the brightness tiers, so
	 * there is no per-character element and no inline style (CSP).
	 */
	const grids = [ASCII_PHONE_GRID, ASCII_DESKTOP_GRID] as const;
	const still = (i: 0 | 1) => asciiFrame(ASCII_STATIC_T, grids[i].cols, grids[i].rows);
	let frames = $state.raw<[AsciiFrame, AsciiFrame]>([still(0), still(1)]);
	let boxes: (HTMLElement | undefined)[] = $state([undefined, undefined]);
	let players: ReturnType<typeof createAsciiPlayer>[] = [];
	let mounted = $state(false);

	onMount(() => {
		const observing = typeof IntersectionObserver === 'function';
		players = ([0, 1] as const).map((i) =>
			createAsciiPlayer({
				requestFrame: (callback) => requestAnimationFrame(callback),
				cancelFrame: (handle) => cancelAnimationFrame(handle),
				draw: (playedMs) => {
					const next = asciiFrame(ASCII_STATIC_T + playedMs, grids[i].cols, grids[i].rows);
					frames = i === 0 ? [next, frames[1]] : [frames[0], next];
				},
				// Without an observer the grid counts as on screen.
				onScreen: !observing,
				hidden: document.hidden
			})
		);
		const observer = observing
			? new IntersectionObserver((entries) => {
					for (const entry of entries) {
						const i = boxes.indexOf(entry.target as HTMLElement);
						if (i >= 0) players[i]?.setOnScreen(entry.isIntersecting);
					}
				})
			: null;
		for (const box of boxes) if (box) observer?.observe(box);
		const onVisibility = () => {
			for (const player of players) player.setHidden(document.hidden);
		};
		document.addEventListener('visibilitychange', onVisibility);
		mounted = true;
		return () => {
			observer?.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			for (const player of players) player.destroy();
			players = [];
		};
	});

	$effect(() => {
		const reduce = prefersReducedMotion.current;
		if (!mounted) return;
		for (const player of players) player.setReducedMotion(reduce);
	});
</script>

<div class="ascii-field" aria-hidden="true" data-testid="ascii-field">
	{#each frames as frame, i (i)}
		<div class={i === 0 ? 'phone grid' : 'desktop grid'} bind:this={boxes[i]}>
			<pre class="edge">{frame.tiers[0].join('\n')}</pre>
			<pre class="mid">{frame.tiers[1].join('\n')}</pre>
			<pre class="core">{frame.tiers[2].join('\n')}</pre>
		</div>
	{/each}
</div>

<style>
	/* The box is fixed in CSS and the text clipped: a font swap or a fallback monospace moves nothing. */
	.ascii-field {
		width: 100%;
		max-width: 400px;
		height: 140px;
		overflow: hidden;
		border-radius: var(--r-group);
		background: var(--brand-surface);
		pointer-events: none;
		user-select: none;
		-webkit-user-select: none;
	}
	.grid {
		position: relative;
		width: 100%;
		height: 100%;
	}
	.desktop {
		display: none;
	}
	pre {
		position: absolute;
		/*
		 * Off the rounded corners, whole rows and whole columns only: 140 − 2 × 5 = 13 rows of 10 px; the width is
		 * rounded down to whole characters (1ch, whatever monospace loaded), so no glyph is cut at the right edge.
		 */
		top: 5px;
		bottom: 5px;
		left: 14px;
		width: calc(100% - 28px);
		width: round(down, 100% - 28px, 1ch);
		margin: 0;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 8px;
		line-height: 10px;
		letter-spacing: 0;
		white-space: pre;
		color: var(--on-brand-surface);
	}
	/* Three brightness tiers of the one glyph colour: fainter at a blob's edge, full in its core. */
	.edge {
		opacity: 0.4;
	}
	.mid {
		opacity: 0.7;
	}
	@media (min-width: 1024px) {
		.ascii-field {
			width: 360px;
			max-width: none;
			height: 560px;
			border-radius: var(--r-l);
		}
		.phone {
			display: none;
		}
		/* 560 − 2 × 10 = 54 rows; 360 − 2 × 14 = 332 px, about 69 columns of 4.8 px. */
		pre {
			top: 10px;
			bottom: 10px;
		}
		.desktop {
			display: block;
		}
	}
	/* A landscape phone or a short window keeps the form where it was. */
	@media (max-height: 599.98px) {
		.ascii-field {
			display: none;
		}
	}
	@media print {
		.ascii-field {
			display: none;
		}
	}
</style>
