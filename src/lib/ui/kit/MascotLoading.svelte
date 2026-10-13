<script lang="ts">
	import { useI18n } from '#lib/ui/i18n-context';
	import Mascot from './Mascot.svelte';

	/** True only while work is outstanding (the app layout: a client-side navigation in flight). */
	let { active }: { active: boolean } = $props();
	const { tr } = useI18n();
</script>

<!-- FN-44 Part 4: the one pose that keeps moving, and only while it is in the DOM. With motion Koko walks and the
     text is for screen readers; under reduced motion (or without the media feature) only the text shows — a
     still "loading" pose would read as a broken image. -->
{#if active}
	<div class="nav-loading">
		<span class="art"><Mascot pose="loading" size={32} /></span>
		<span class="text">{tr('Memuat…')}</span>
	</div>
{/if}

<style>
	.nav-loading {
		position: fixed;
		z-index: 50;
		top: calc(var(--sai-top) + 8px);
		left: 50%;
		display: flex;
		align-items: center;
		padding: 6px 14px;
		border-radius: var(--r-pill);
		background: var(--panel);
		box-shadow: var(--shadow-float);
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
		transform: translateX(-50%);
		pointer-events: none;
	}
	.art {
		display: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.nav-loading {
			padding: 4px 10px;
			/* A quick navigation finishes before Koko shows: no flash on every tap. */
			animation: appear 0.15s 0.2s both;
		}
		.art {
			display: block;
		}
		.art :global(.strip) {
			animation: walk 0.5s steps(1) infinite;
		}
		.text {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
	@keyframes appear {
		from {
			opacity: 0;
		}
	}
	/* The two walking frames, left foot then right foot. */
	@keyframes walk {
		50% {
			transform: translateX(-24px);
		}
	}
</style>
