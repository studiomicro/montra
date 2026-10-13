<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';

	let {
		open = $bindable(false),
		title,
		onclose,
		children
	}: {
		open?: boolean;
		title: string;
		/** Called once the sheet has closed (close button, Escape, backdrop or `open = false`). */
		onclose?: () => void;
		children: Snippet;
	} = $props();

	const { tr } = useI18n();
	// Unique per instance: two sheets on one page (the add sheet and a screen's own) never share a title id.
	const titleId = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let opener: HTMLElement | null = null;

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	function handleClose() {
		open = false;
		opener?.focus();
		onclose?.();
	}

	function onclick(event: MouseEvent) {
		if (event.target === dialog) open = false;
	}
</script>

<dialog
	bind:this={dialog}
	class="sheet glass"
	aria-labelledby={titleId}
	onclose={handleClose}
	{onclick}
>
	<header class="sheet-head">
		<h2 id={titleId}>{title}</h2>
		<button type="button" class="close" aria-label={tr('Tutup')} onclick={() => (open = false)}>
			<Icon name="close" size={20} />
		</button>
	</header>
	<div class="sheet-body">
		{@render children()}
	</div>
</dialog>

<style>
	.sheet {
		margin: auto auto 0;
		width: 100%;
		max-width: 640px;
		border: 0;
		padding: 0;
		border-radius: var(--r-l) var(--r-l) 0 0;
		/* Glass tinted with the page colour, nearly opaque: the forms inside keep their panel fills. */
		--glass-fill: color-mix(in srgb, var(--bg) 86%, transparent);
		--glass-fallback: var(--bg);
		color: var(--ink);
		max-height: calc(100dvh - 24px - var(--sai-top));
		overflow: hidden;
	}
	.sheet::backdrop {
		background: var(--scrim);
	}
	/*
	 * The title row stays put and only the body scrolls: the header needs no fill of its own, so it is the same
	 * glass surface as the rest of the sheet, edge to edge and into the rounded corners (FN-40 QA).
	 */
	.sheet[open] {
		display: flex;
		flex-direction: column;
	}
	/*
	 * FN-40 motion: the sheet rises in and sinks out (the close keeps it in the top layer for the transition,
	 * where the browser supports transitioning `display`/`overlay`; elsewhere it closes at once). While it rises it
	 * takes no taps, nor does its scrim, so a quick second tap on the opener neither presses a faint button nor
	 * closes the sheet (red team L1): `pointer-events` switches back once the 300 ms rise is done. A closing sheet
	 * takes no taps at once. Nothing moves, and nothing is blocked, under reduced motion.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.sheet,
		.sheet::backdrop {
			transition:
				transform var(--duration-slow) var(--ease),
				opacity var(--duration-slow) var(--ease),
				overlay var(--duration-slow) allow-discrete,
				display var(--duration-slow) allow-discrete,
				pointer-events 0s linear var(--duration-slow) allow-discrete;
		}
		.sheet:not([open]),
		.sheet:not([open])::backdrop {
			transition:
				transform var(--duration-base) var(--ease),
				opacity var(--duration-base) var(--ease),
				overlay var(--duration-base) allow-discrete,
				display var(--duration-base) allow-discrete;
		}
		.sheet:not([open]) {
			transform: translateY(24px);
			opacity: 0;
			pointer-events: none;
		}
		.sheet:not([open])::backdrop {
			opacity: 0;
			pointer-events: none;
		}
		@starting-style {
			.sheet[open] {
				transform: translateY(24px);
				opacity: 0;
				pointer-events: none;
			}
			.sheet[open]::backdrop {
				opacity: 0;
				pointer-events: none;
			}
		}
	}
	.sheet-head {
		flex: none;
		padding: 8px max(20px, var(--sai-right)) 0 max(20px, var(--sai-left));
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 56px;
	}
	/* A tall form scrolls inside the sheet; the page behind never scrolls along. */
	.sheet-body {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 max(20px, var(--sai-right)) calc(20px + var(--sai-bottom)) max(20px, var(--sai-left));
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.close {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
	}
	/* FN-51: the body fades in just after the sheet (opacity only); the title row does not. */
	@media (prefers-reduced-motion: no-preference) {
		.sheet[open] .sheet-body {
			animation: body-in var(--duration-base) var(--ease) 40ms backwards;
		}
	}
	@keyframes body-in {
		from {
			opacity: 0;
		}
	}
	@media (min-width: 1024px) {
		.sheet {
			margin: auto;
			border-radius: var(--r-l);
			max-width: 480px;
			max-height: calc(100dvh - 48px);
		}
		/* FN-51: a centred dialog scales in (0.96 → 1) instead of rising; same timing and the same no-taps rule. */
		@media (prefers-reduced-motion: no-preference) {
			.sheet:not([open]) {
				transform: scale(0.96);
			}
			@starting-style {
				.sheet[open] {
					transform: scale(0.96);
				}
			}
		}
	}
</style>
