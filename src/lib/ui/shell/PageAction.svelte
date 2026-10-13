<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import type { IconName } from '#lib/ui/icons';

	/**
	 * A page's primary action (§ 3a): an ink pill in the header row on desktop (`at="header"`, inside
	 * ScreenTitle's actions) and full-width at the bottom of the page on a phone (`at="bottom"`). Render both;
	 * each shows only at its own width, so the action exists once for assistive tech and tests.
	 */
	let {
		at,
		href,
		icon,
		type = 'button',
		disabled = false,
		onclick,
		children
	}: {
		at: 'header' | 'bottom';
		href?: string;
		icon?: IconName;
		type?: 'button' | 'submit';
		disabled?: boolean;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	} = $props();
</script>

<div class="page-action {at}">
	<Button
		{href}
		{icon}
		{type}
		{disabled}
		{onclick}
		size={at === 'header' ? 'sm' : 'lg'}
		full={at === 'bottom'}
	>
		{@render children()}
	</Button>
</div>

<style>
	.header {
		display: none;
	}
	.bottom {
		margin-top: 24px;
	}
	@media (min-width: 1024px) {
		.header {
			display: contents;
		}
		.bottom {
			display: none;
		}
	}
</style>
