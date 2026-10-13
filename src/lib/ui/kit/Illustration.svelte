<script lang="ts">
	import { SCENES, type IllustrationName } from './illustrations';

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
     dark and mono; a slow float that stops under reduced motion. -->
<svg
	class="illustration"
	width={size}
	height={Math.round((size * 3) / 4)}
	viewBox="0 0 160 120"
	role={alt ? 'img' : undefined}
	aria-label={alt}
	aria-hidden={alt ? undefined : 'true'}
	focusable="false"
>
	<ellipse class="shadow" cx="80" cy="84" rx="58" ry="20" />
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
		/*
		 * Three faces per solid, lit from the top left: top lightest, right darkest. light-dark() follows the
		 * theme's color-scheme (mono included); the first value is the light one for browsers without it.
		 */
		--n-t: color-mix(in srgb, var(--ink) 8%, var(--panel));
		--n-t: light-dark(
			color-mix(in srgb, var(--ink) 8%, var(--panel)),
			color-mix(in srgb, var(--ink) 24%, var(--panel))
		);
		--n-l: light-dark(
			color-mix(in srgb, var(--ink) 17%, var(--panel)),
			color-mix(in srgb, var(--ink) 14%, var(--panel))
		);
		--n-r: light-dark(
			color-mix(in srgb, var(--ink) 28%, var(--panel)),
			color-mix(in srgb, var(--ink) 6%, var(--panel))
		);
		--a-t: light-dark(color-mix(in srgb, var(--accent) 42%, var(--bg)), var(--accent));
		--a-l: color-mix(in srgb, var(--accent) 74%, var(--bg));
		--a-r: light-dark(
			color-mix(in srgb, var(--accent) 82%, var(--ink)),
			color-mix(in srgb, var(--accent) 46%, var(--bg))
		);
		--g-t: light-dark(color-mix(in srgb, var(--cat-belanja) 50%, var(--bg)), var(--cat-belanja));
		--g-l: color-mix(in srgb, var(--cat-belanja) 80%, var(--bg));
		--g-r: light-dark(
			color-mix(in srgb, var(--cat-belanja) 80%, var(--ink)),
			color-mix(in srgb, var(--cat-belanja) 50%, var(--bg))
		);
		--p-t: light-dark(var(--panel), color-mix(in srgb, var(--ink) 78%, var(--bg)));
		--p-l: light-dark(
			color-mix(in srgb, var(--ink) 7%, var(--panel)),
			color-mix(in srgb, var(--ink) 64%, var(--bg))
		);
		--p-r: light-dark(
			color-mix(in srgb, var(--ink) 14%, var(--panel)),
			color-mix(in srgb, var(--ink) 48%, var(--bg))
		);
		--d-t: color-mix(in srgb, var(--ink) 70%, var(--bg));
		--d-l: color-mix(in srgb, var(--ink) 86%, var(--bg));
		--d-r: var(--ink);
	}
	.illustration :global(.n-t) {
		fill: var(--n-t);
	}
	.illustration :global(.n-l) {
		fill: var(--n-l);
	}
	.illustration :global(.n-r) {
		fill: var(--n-r);
	}
	.illustration :global(.a-t) {
		fill: var(--a-t);
	}
	.illustration :global(.a-l) {
		fill: var(--a-l);
	}
	.illustration :global(.a-r) {
		fill: var(--a-r);
	}
	.illustration :global(.g-t) {
		fill: var(--g-t);
	}
	.illustration :global(.g-l) {
		fill: var(--g-l);
	}
	.illustration :global(.g-r) {
		fill: var(--g-r);
	}
	.illustration :global(.p-t) {
		fill: var(--p-t);
	}
	.illustration :global(.p-l) {
		fill: var(--p-l);
	}
	.illustration :global(.p-r) {
		fill: var(--p-r);
	}
	.illustration :global(.d-t) {
		fill: var(--d-t);
	}
	.illustration :global(.d-l) {
		fill: var(--d-l);
	}
	.illustration :global(.d-r) {
		fill: var(--d-r);
	}
	/* Faces meet without a hairline gap. */
	.illustration :global(path),
	.illustration :global(circle) {
		stroke-linejoin: round;
	}
	.illustration :global(.ink),
	.illustration :global(.mark) {
		fill: none;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.illustration :global(.ink) {
		stroke: currentColor;
	}
	.illustration :global(.ink.strong) {
		stroke: var(--ink-2);
		stroke-width: 2.2;
	}
	.illustration :global(.mark) {
		stroke: var(--bg);
	}
	/*
	 * A soft ground shadow: dark on a light page. On a dark page a darker-than-bg ellipse reads as a hole, so the
	 * floor there is a faint lift of --ink instead (lighter than --bg and --panel).
	 */
	.shadow {
		fill: color-mix(in srgb, var(--dark) 8%, transparent);
		fill: light-dark(
			color-mix(in srgb, var(--dark) 8%, transparent),
			color-mix(in srgb, var(--ink) 7%, transparent)
		);
	}
	/*
	 * A slow float (the shadow breathes with it): three gentle cycles after the scene appears, then it rests —
	 * nothing keeps moving on an idle page. Still under reduced motion.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.float {
			animation: float 3s var(--ease-in-out) 6 alternate;
		}
		.shadow {
			transform-box: fill-box;
			transform-origin: center;
			animation: breathe 3s var(--ease-in-out) 6 alternate;
		}
	}
	@keyframes float {
		to {
			transform: translateY(-4px);
		}
	}
	@keyframes breathe {
		to {
			transform: scale(0.94);
		}
	}
</style>
