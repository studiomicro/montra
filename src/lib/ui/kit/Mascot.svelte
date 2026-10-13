<script module lang="ts">
	import {
		crown,
		GRID,
		MASCOT_POSES,
		POSES,
		runs,
		type CrownRun,
		type MascotPose,
		type Pixel,
		type Run
	} from './mascot/poses';

	/** Each pose's frames as rects, computed once. */
	const STRIPS = Object.fromEntries(
		MASCOT_POSES.map((pose) => [pose, POSES[pose].map(runs)])
	) as Record<MascotPose, Run[][]>;
	/** FN-46: the crown of each frame, computed once. */
	const CROWNS = Object.fromEntries(
		MASCOT_POSES.map((pose) => [pose, POSES[pose].map(crown)])
	) as Record<MascotPose, CrownRun[][]>;

	/** The colour classes; the stylesheet maps each to a theme token. */
	const CLASS: Record<Pixel, string> = {
		o: 'k-ink',
		b: 'k-body',
		l: 'k-lit',
		c: 'k-cut',
		s: 'k-shade',
		e: 'k-eye',
		g: 'k-glint',
		p: 'k-cheek'
	};
</script>

<script lang="ts">
	import { proLookGetter } from './pro-look-context';

	let {
		pose = 'idle',
		size = 120,
		alt,
		pro
	}: {
		pose?: MascotPose;
		/** Width and height in px. */
		size?: number;
		/** Only when Koko itself carries meaning. Without it Koko is decorative and hidden from assistive
		 * technology: the text beside it says everything. */
		alt?: string;
		/**
		 * FN-46: the Pro look's crown. Omitted, it follows the (app) layout's plan (pro-look-context.ts); outside
		 * that layout Koko has no crown.
		 */
		pro?: boolean;
	} = $props();
	const layoutPro = proLookGetter();
	const crowned = $derived(pro ?? layoutPro?.() ?? false);
</script>

<!-- FN-44: Koko (v2) on a 24×24 grid, one rect per run of same-coloured pixels, coloured only through the classes
     below (theme tokens). The frames sit side by side; the strip cuts between them and comes to rest on frame 0. -->
<svg
	class="mascot pose-{pose}"
	width={size}
	height={size}
	viewBox="0 0 {GRID} {GRID}"
	role={alt ? 'img' : undefined}
	aria-label={alt}
	aria-hidden={alt ? undefined : 'true'}
	focusable="false"
>
	<g class="strip">
		{#each STRIPS[pose] as frame, i (i)}
			<g transform={i === 0 ? undefined : `translate(${i * GRID} 0)`}>
				{#each frame as r, j (j)}
					<rect class={CLASS[r.pixel]} x={r.x} y={r.y} width={r.w} height="1" />
				{/each}
				{#if crowned}
					{#each CROWNS[pose][i] as r, j (j)}
						<rect class="k-crown" x={r.x} y={r.y} width={r.w} height="1" />
					{/each}
				{/if}
			</g>
		{/each}
	</g>
</svg>

<style>
	.mascot {
		display: block;
		flex: none;
		max-width: 100%;
		height: auto;
		/* Only the current frame shows; the others wait to the right of it. */
		overflow: hidden;
		shape-rendering: crispEdges;
		/* Decoration only: never a tap target and never in the way of one. */
		pointer-events: none;
	}
	/*
	 * Light that reads on the body in every theme (the page in light themes, the ink in dark ones), and the eyes:
	 * dark with a light glint, except in mono light, whose body is dark, so its eyes turn light.
	 */
	.mascot {
		--k-light: light-dark(var(--bg), var(--ink));
		--k-eye: light-dark(var(--ink), var(--bg));
		--k-glint: var(--k-light);
	}
	:global(:root[data-theme='mono']) .mascot {
		--k-eye: var(--bg);
		--k-glint: var(--ink);
	}
	.k-ink {
		fill: var(--ink);
	}
	.k-body {
		fill: var(--accent);
	}
	.k-cut {
		fill: var(--k-light);
	}
	.k-shade {
		fill: var(--ink-2);
	}
	.k-lit {
		fill: color-mix(in srgb, var(--accent) 55%, var(--k-light));
	}
	.k-eye {
		fill: var(--k-eye);
	}
	.k-glint {
		fill: var(--k-glint);
	}
	/* FN-46: the Pro look's crown (gold; grey in Hitam-putih, like every mono surface). */
	.k-crown {
		fill: var(--pro);
	}
	.k-cheek {
		fill: color-mix(in srgb, var(--cat-hadiah) 55%, var(--k-light));
	}
	/*
	 * Frame cuts (steps(1): an instant change, pixel art never blurs), a few cycles after Koko appears, then it
	 * rests on frame 0. Nothing moves under reduced motion. `loading` has no motion of its own here: only
	 * MascotLoading walks it, and only while a navigation is in flight.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.pose-idle .strip {
			animation: idle 3.2s steps(1) 0.6s 2;
		}
		.pose-wave .strip {
			animation: wave 1s steps(1) 3;
		}
		.pose-hop .strip {
			animation: hop 0.8s steps(1) 2;
		}
		.pose-celebrate .strip {
			animation: celebrate 1.4s steps(1) 2;
		}
		.pose-sad .strip {
			animation: idle 4s steps(1) 0.8s 2;
		}
		.pose-sleep .strip {
			animation: sleep 2.4s steps(1) 3;
		}
	}
	/* Blink: open, a short shut (frame 1), open. */
	@keyframes idle {
		86% {
			transform: translateX(-24px);
		}
		92% {
			transform: none;
		}
	}
	@keyframes wave {
		25% {
			transform: translateX(-24px);
		}
		50% {
			transform: none;
		}
		75% {
			transform: translateX(-24px);
		}
	}
	/* Crouch, up in the air, crouch, stand. */
	@keyframes hop {
		0% {
			transform: translateX(-24px);
		}
		15% {
			transform: translateX(-48px);
		}
		65% {
			transform: translateX(-24px);
		}
		80% {
			transform: none;
		}
	}
	/* A spin (front, squeezed, edge-on, squeezed, front), then the sparkles. */
	@keyframes celebrate {
		0% {
			transform: translateX(-24px);
		}
		12% {
			transform: translateX(-48px);
		}
		24% {
			transform: translateX(-72px);
		}
		36% {
			transform: translateX(-48px);
		}
		48% {
			transform: translateX(-24px);
		}
		60% {
			transform: none;
		}
	}
	/* The z's rise one by one. */
	@keyframes sleep {
		0% {
			transform: translateX(-48px);
		}
		33% {
			transform: translateX(-24px);
		}
		66% {
			transform: none;
		}
	}
</style>
