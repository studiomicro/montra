<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import type { IconName } from '#lib/ui/icons';

	/**
	 * A GroupedList row with a 40 px round icon tile, a 15 px title, an optional grey second line and an
	 * optional right side (§ 3a rows); a chevron shows only when the row opens something (`href`).
	 */
	let {
		icon,
		title,
		hint,
		href,
		trailing
	}: {
		icon: IconName;
		title: string;
		hint?: string;
		href?: string;
		trailing?: Snippet;
	} = $props();
</script>

<GroupRow {href}>
	<span class="tile" aria-hidden="true"><Icon name={icon} size={20} /></span>
	<span class="text">
		<span class="title">{title}</span>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</span>
	{#if trailing}<span class="trailing">{@render trailing()}</span>{/if}
	{#if href}<span class="chevron" aria-hidden="true"><Icon name="chevron-right" size={18} /></span
		>{/if}
</GroupRow>

<style>
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.trailing {
		flex: none;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.chevron {
		display: grid;
		flex: none;
		color: var(--faint);
	}
</style>
