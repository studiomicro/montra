<script lang="ts">
	import { page } from '$app/state';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { activeHref, TABS } from './nav';

	/** `open`: whether the Tambah sheet is open (FN-51: the "+" turns 45° to say so). */
	let { onadd, open = false }: { onadd: () => void; open?: boolean } = $props();
	const current = $derived(activeHref(TABS, page.url.pathname));
	const { tr } = useI18n();
</script>

<!--
	Phone layout v3 (owner request 2026-10-10): a compact floating pill at the bottom-left holding the four tabs as
	icons only (each named by `aria-label`), and a separate round ink "+" at the bottom-right that opens Tambah.
-->
<nav class="tabbar glass" aria-label={tr('Navigasi utama')}>
	{#each TABS as tab (tab.href)}
		<a
			href={tab.href}
			class="tab"
			aria-label={tr(tab.label)}
			aria-current={current === tab.href ? 'page' : undefined}
		>
			<Icon name={tab.icon} size={24} />
		</a>
	{/each}
</nav>
<button
	type="button"
	class="fab"
	aria-haspopup="dialog"
	aria-expanded={open}
	aria-label={tr('Tambah')}
	onclick={onadd}
>
	<span class="plus"><Icon name="plus" size={26} /></span>
</button>

<style>
	/* Both sit above the home indicator and clear of the side insets (landscape notch). */
	.tabbar {
		position: fixed;
		left: max(16px, var(--sai-left));
		bottom: calc(16px + var(--sai-bottom));
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 4px;
		height: var(--tabbar-h);
		padding: 0 8px;
		border-radius: var(--r-pill);
	}
	.tab {
		display: grid;
		place-items: center;
		width: 52px;
		height: 52px;
		min-width: 44px;
		min-height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
		text-decoration: none;
		transition:
			transform 0.15s var(--ease),
			box-shadow 0.15s var(--ease),
			color 0.2s var(--ease);
	}
	.tab:active {
		transform: scale(var(--press-scale));
	}
	/* Glass press lift (FN-40): the pressed tab rises off the bar; never under reduced motion. */
	@media (prefers-reduced-motion: no-preference) {
		.tab:active {
			box-shadow: var(--glass-shadow);
		}
	}
	/*
	 * The current tab is the --action icon (FN-57: blue in light, ink in dark), the others stay grey, `--muted` for
	 * 3:1 icon contrast (colour is not the only cue: aria-current).
	 */
	.tab[aria-current='page'] {
		background: var(--on-glass-active);
		color: var(--action);
	}
	.tab[aria-current='page'] :global(svg) {
		stroke-width: 2.4;
	}
	/* Tambah: a round --action button (FN-57), bottom-right, solid (not glass: one blurred layer fewer). */
	.fab {
		position: fixed;
		right: max(16px, var(--sai-right));
		bottom: calc(16px + var(--sai-bottom));
		z-index: 20;
		display: grid;
		place-items: center;
		width: var(--tabbar-h);
		height: var(--tabbar-h);
		padding: 0;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--action);
		color: var(--on-action);
		box-shadow: var(--shadow-float);
		transition: transform 0.15s var(--ease);
	}
	.fab:active {
		transform: scale(var(--press-scale));
	}
	/* FN-51: the "+" is turned 45° while the sheet is open (state); the turn itself is motion, so it is gated. */
	.plus {
		display: grid;
		place-items: center;
	}
	.fab[aria-expanded='true'] .plus {
		transform: rotate(45deg);
	}
	@media (prefers-reduced-motion: no-preference) {
		.plus {
			transition: transform var(--duration-base) var(--ease);
		}
	}
	/* Scrolling to a field or button (focus, find, anchors) stops above the floating bar (WCAG 2.4.11). */
	@media (max-width: 1023.98px) {
		:global(html:has(nav.tabbar)) {
			scroll-padding-bottom: calc(var(--tabbar-h) + 32px + var(--sai-bottom));
		}
	}
	@media (min-width: 1024px) {
		.tabbar,
		.fab {
			display: none;
		}
	}
</style>
