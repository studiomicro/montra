<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { actionsFitTitleRow } from './screen-title';

	/**
	 * The page header row (APP_PARITY § 1, § 3a type scale): H1 (28 px phone, 34 px / 800 desktop) with an
	 * optional one-line grey subtitle, page actions right-aligned (wrapping under the title on a phone). The
	 * title sticks to the top and shrinks once the page scrolls. A sub-page passes `back` (its parent route and
	 * the translated accessible name, "Kembali ke Pengaturan"): a 44 px chevron link left of the title.
	 */
	let {
		title,
		subtitle,
		actions,
		back
	}: {
		title: string;
		subtitle?: string;
		actions?: Snippet;
		back?: { href: string; label: string };
	} = $props();
	let top: HTMLElement | undefined = $state();
	let far: HTMLElement | undefined = $state();
	let compact = $state(false);
	let header: HTMLElement | undefined = $state();
	let heading: HTMLElement | undefined = $state();
	let actionsBox: HTMLElement | undefined = $state();
	/** Phone: the actions did not fit beside the title, so they follow the subtitle (A1, POLISH_AUDIT). */
	let stacked = $state(false);

	$effect(() => {
		if (!header || !heading || !actionsBox) return;
		const row = header;
		const h1 = heading;
		const box = actionsBox;
		const measure = () => {
			const left = row.getBoundingClientRect().left;
			stacked = !actionsFitTitleRow(
				h1.getBoundingClientRect().right - left,
				box.getBoundingClientRect().width,
				row.clientWidth
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		observer.observe(h1);
		observer.observe(box);
		return () => observer.disconnect();
	});

	/*
	 * Hysteresis: shrinking the title changes the page height, and scroll anchoring then moves the page by about
	 * as much. One sentinel flipped on every frame near the top (a header that never settles). Both sentinels sit
	 * above the header, so its size never moves them: it shrinks once `far` (64 px down) leaves the
	 * viewport and grows again only when `top` is back in view.
	 */
	$effect(() => {
		if (!top || !far) return;
		let topSeen = true;
		let farSeen = true;
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.target === top) topSeen = entry.isIntersecting;
				else farSeen = entry.isIntersecting;
			}
			if (!farSeen) compact = true;
			else if (topSeen) compact = false;
		});
		observer.observe(top);
		observer.observe(far);
		return () => observer.disconnect();
	});
</script>

<div class="sentinel" bind:this={top} aria-hidden="true">
	<div class="far" bind:this={far}></div>
</div>
<header class="screen-title glass glass-soft" class:compact class:stacked bind:this={header}>
	<div class="lead">
		{#if back}
			<a class="back" href={back.href} aria-label={back.label} data-testid="screen-back">
				<Icon name="chevron-left" size={24} />
			</a>
		{/if}
		<div class="titles">
			<h1 bind:this={heading}>{title}</h1>
			{#if subtitle}<p class="subtitle num">{subtitle}</p>{/if}
		</div>
	</div>
	{#if actions}<div class="actions" bind:this={actionsBox}>{@render actions()}</div>{/if}
</header>

<style>
	.sentinel {
		position: relative;
		height: 1px;
		margin-bottom: -1px;
	}
	/* 64 px: more than the title shrinks by (about 30 px on a phone, 17 px on a desktop). */
	.far {
		position: absolute;
		top: 64px;
		width: 1px;
		height: 1px;
		pointer-events: none;
	}
	.screen-title {
		position: sticky;
		top: var(--sai-top);
		z-index: 10;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 8px 16px;
		padding: 12px 0 8px;
	}
	/* Content scrolls under the title, not through the gap a top inset leaves above it (FN-13b). */
	.screen-title::before {
		content: '';
		position: absolute;
		right: 0;
		bottom: 100%;
		left: 0;
		height: var(--sai-top);
		background: var(--bg);
	}
	.lead {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}
	/* The chevron's glyph lines up with the page gutter; the rest of the 44 px target hangs into it. */
	.back {
		display: inline-flex;
		flex: none;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		margin-left: -10px;
		border-radius: var(--r-s);
		color: var(--ink);
		transition: background-color var(--duration-fast) var(--ease);
	}
	.back:hover {
		background: var(--panel);
	}
	.titles {
		min-width: 0;
	}
	h1 {
		margin: 0;
		font-size: 28px;
		line-height: 1.1;
		font-weight: 800;
		letter-spacing: -0.03em;
		transition: font-size 0.2s var(--ease);
	}
	.subtitle {
		margin: 4px 0 0;
		font-size: 15px;
		color: var(--muted);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	@media (min-width: 1024px) {
		.screen-title {
			padding: 24px 0 16px;
		}
		h1 {
			font-size: 34px;
		}
	}
	/*
	 * Phone layout v3 (owner request 2026-10-10): the big title left with a small underlined text link on its
	 * right and the grey subtitle on its own line under both. `.titles` dissolves so the three parts reorder; if
	 * the actions are too wide for the title row (`stacked`, measured above) they follow the subtitle on a line of
	 * their own, so title and subtitle stay together.
	 */
	@media (max-width: 600px) {
		.screen-title {
			align-items: center;
			justify-content: flex-start;
			gap: 4px 12px;
		}
		.lead,
		.titles {
			display: contents;
		}
		.back {
			order: 0;
			margin-right: -6px;
		}
		h1 {
			order: 1;
			min-width: 0;
		}
		.actions {
			order: 2;
			flex-wrap: wrap;
			justify-content: flex-end;
			align-items: center;
			gap: 4px 12px;
			margin-left: auto;
		}
		.subtitle {
			order: 3;
			flex: 1 0 100%;
			margin: -2px 0 0;
		}
		.stacked .subtitle {
			order: 2;
		}
		.stacked .actions {
			order: 3;
			justify-content: flex-start;
			margin-left: 0;
		}
		/* A secondary page action (a link or a form's submit button) is a small underlined text link. */
		.actions :global(.btn.secondary) {
			height: auto;
			min-height: 44px;
			padding: 0 2px;
			background: transparent;
			box-shadow: none;
			font-size: 15px;
			text-decoration: underline;
			text-underline-offset: 3px;
		}
		.actions :global(.btn.secondary:hover:not(:disabled)) {
			background: transparent;
		}
		.actions :global(.btn.secondary svg) {
			display: none;
		}
		/* A primary add action with an icon becomes the square outlined "+" (its text stays the accessible name). */
		.actions :global(.btn.primary:has(svg)) {
			gap: 0;
			width: 44px;
			height: 44px;
			padding: 0;
			border-radius: 14px;
			background: transparent;
			box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent);
			color: var(--ink);
			font-size: 0;
		}
		.actions :global(.btn.primary:has(svg) svg) {
			width: 22px;
			height: 22px;
		}
	}
	.compact h1 {
		font-size: 19px;
		letter-spacing: -0.012em;
	}
	.compact .subtitle {
		display: none;
	}
</style>
