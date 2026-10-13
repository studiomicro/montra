<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';

	/** "Go to another page" entries inside a page's content: one grouped list of rows with a trailing chevron. */
	let { links }: { links: { href: string; label: string }[] } = $props();
</script>

<GroupList>
	{#each links as link (link.href)}
		<GroupRow href={link.href}>
			<span class="label">{link.label}</span>
			<span class="chev"><Icon name="chevron-right" size={18} /></span>
		</GroupRow>
	{/each}
</GroupList>

<style>
	.label {
		flex: 1;
		min-width: 0;
		font-weight: 600;
	}
	.chev {
		display: flex;
		color: var(--faint);
	}
</style>
