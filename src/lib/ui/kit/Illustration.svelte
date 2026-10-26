<script lang="ts" module>
	import { grid, guides, nodes } from './illustrations/iso';

	/**
	 * The blueprint floor every scene stands on (owner request 2026-10-14), built once: a faint ground grid, dashed
	 * construction lines along both axes through the scene's footprint, and diamond handles at its corners.
	 */
	const FLOOR = grid(44, 8);
	const F = 30;
	const GUIDES = guides([
		[
			[-F, -46, 0],
			[-F, 46, 0]
		],
		[
			[F, -46, 0],
			[F, 46, 0]
		],
		[
			[-46, -F, 0],
			[46, -F, 0]
		],
		[
			[-46, F, 0],
			[46, F, 0]
		]
	]);
	const NODES = nodes([
		[-F, -F, 0],
		[F, -F, 0],
		[F, F, 0],
		[-F, F, 0]
	]);
</script>

<script lang="ts">
	import { SCENES, type IllustrationName } from './illustrations';
	// The five tones and the line details, shared with Beranda's HeroScene (FN-54).
	import './illustrations/tones.css';

	let {
		name,
		size = 160,
		alt
	}: {
		/** The scene; a later Rive file can stand in for a name without changing any call site. */
		name: IllustrationName;
		/** Width in px; the scenes are 4:3. */
		size?: number;
		/** Only for an illustration that carries meaning. Without it the art is decorative and hidden from
		 * assistive technology: the text beside it says everything. */
		alt?: string;
	} = $props();

	const Scene = $derived(SCENES[name]);
</script>

<!-- FN-40 Part 3: inline SVG coloured only through the classes below (theme tokens), so it repaints in light,
     dark and mono; a slow float that stops under reduced motion. Blueprint floor since 2026-10-14. -->
<svg
	class="illustration iso-art"
	width={size}
	height={Math.round((size * 3) / 4)}
	viewBox="0 0 160 120"
	role={alt ? 'img' : undefined}
	aria-label={alt}
	aria-hidden={alt ? undefined : 'true'}
	focusable="false"
>
	<g transform="translate(80 72)">
		<path class="grid" d={FLOOR} />
		<path class="guide" d={GUIDES} />
		<path class="node" d={NODES} />
	</g>
	<g class="float">
		<g transform="translate(80 72)"><Scene /></g>
	</g>
</svg>

<style>
	.illustration {
		display: block;
		flex: none;
		max-width: 100%;
		height: auto;
		overflow: visible;
		/* Decoration only: never a tap target and never in the way of one. */
		pointer-events: none;
		/* Details drawn with currentColor (lines on paper). */
		color: var(--muted);
	}
	/*
	 * A slow float above the floor: three gentle cycles after the scene appears, then it rests — nothing keeps
	 * moving on an idle page. Still under reduced motion.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.float {
			animation: float 3s var(--ease-in-out) 6 alternate;
		}
	}
	@keyframes float {
		to {
			transform: translateY(-4px);
		}
	}
</style>
