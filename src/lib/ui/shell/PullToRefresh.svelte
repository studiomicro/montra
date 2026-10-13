<script lang="ts">
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { isStandalone } from '#lib/ui/pwa/install.svelte';
	import { pullMayStart, pullProgress } from './pull-to-refresh';

	/**
	 * FN-51: dragging down from the top of Beranda or Riwayat in the installed app reloads the page's data
	 * (`onrefresh`, which resolves once the server answered). Browser tabs keep the browser's own gesture. The
	 * indicator follows the finger through a paused Web Animation (transform and opacity only, no inline style);
	 * under reduced motion nothing follows the finger and the indicator only appears, still, while the reload runs.
	 * A drag that starts scrolled down, moves up, or happens in a hidden tab or under an open sheet does nothing.
	 */
	let { onrefresh }: { onrefresh: () => Promise<unknown> } = $props();
	const { tr } = useI18n();

	let standalone = $state(false);
	let refreshing = $state(false);
	let pill: HTMLDivElement | undefined = $state();
	let startY: number | null = null;
	let follow: Animation | null = null;
	let progress = 0;

	function stopFollowing() {
		follow?.cancel();
		follow = null;
	}

	function onTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		startY = null;
		if (!touch) return;
		const may = pullMayStart({
			standalone,
			scrollY: window.scrollY,
			hidden: document.hidden,
			dialogOpen: document.querySelector('dialog[open]') !== null,
			refreshing
		});
		if (may) startY = touch.clientY;
	}

	function onTouchMove(event: TouchEvent) {
		const touch = event.touches[0];
		if (startY === null || !touch) return;
		progress = pullProgress(startY, touch.clientY, window.scrollY);
		if (prefersReducedMotion.current || !pill || document.hidden) return;
		// Nothing moves until the finger actually pulls down; a scroll-up leaves no animation behind.
		if (progress === 0) {
			stopFollowing();
			return;
		}
		if (!follow) {
			follow = pill.animate(
				[
					{ transform: 'translate(-50%, -48px)', opacity: 0 },
					{ transform: 'translate(-50%, 16px)', opacity: 1 }
				],
				{ duration: 1000, fill: 'both', easing: 'linear' }
			);
			follow.pause();
		}
		follow.currentTime = progress * 1000;
	}

	async function onTouchEnd() {
		if (startY === null) return;
		startY = null;
		const release = progress;
		progress = 0;
		stopFollowing();
		if (release < 1 || document.hidden) return;
		refreshing = true;
		try {
			await onrefresh();
		} finally {
			refreshing = false;
		}
	}

	function onCancel() {
		startY = null;
		progress = 0;
		stopFollowing();
	}

	onMount(() => {
		standalone = isStandalone();
		if (!standalone) return;
		const opts: AddEventListenerOptions = { passive: true };
		window.addEventListener('touchstart', onTouchStart, opts);
		window.addEventListener('touchmove', onTouchMove, opts);
		window.addEventListener('touchend', onTouchEnd, opts);
		window.addEventListener('touchcancel', onCancel, opts);
		document.addEventListener('visibilitychange', onCancel);
		return () => {
			window.removeEventListener('touchstart', onTouchStart);
			window.removeEventListener('touchmove', onTouchMove);
			window.removeEventListener('touchend', onTouchEnd);
			window.removeEventListener('touchcancel', onCancel);
			document.removeEventListener('visibilitychange', onCancel);
			stopFollowing();
		};
	});
</script>

{#if standalone}
	<div
		bind:this={pill}
		class="pull"
		class:on={refreshing}
		role="status"
		aria-busy={refreshing ? 'true' : undefined}
		data-pull-to-refresh
	>
		<Icon name="arrow-down" size={16} />
		<span class="text">{refreshing ? tr('Memuat…') : ''}</span>
	</div>
{/if}

<style>
	.pull {
		position: fixed;
		z-index: 50;
		top: var(--sai-top);
		left: 50%;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		box-shadow: var(--shadow-float);
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
		pointer-events: none;
		/* Parked above the top edge; the finger (a paused Web Animation) or `.on` brings it down. */
		transform: translate(-50%, -48px);
		opacity: 0;
	}
	.pull.on {
		transform: translate(-50%, 16px);
		opacity: 1;
	}
	.text:empty {
		display: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.pull {
			transition:
				transform var(--duration-base) var(--ease),
				opacity var(--duration-base) var(--ease);
		}
	}
</style>
