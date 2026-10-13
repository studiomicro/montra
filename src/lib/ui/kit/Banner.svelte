<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';

	let {
		icon,
		source,
		when,
		title,
		text
	}: { icon: IconName; source: string; when: string; title: string; text: string } = $props();
</script>

<div class="banner glass" role="status">
	<span class="icon"><Icon name={icon} size={20} /></span>
	<span class="body">
		<span class="top">{source} · {when}</span>
		<span class="title">{title}</span>
		<span class="text">{text}</span>
	</span>
</div>

<style>
	.banner {
		display: flex;
		gap: 12px;
		padding: 12px 14px;
		border-radius: 22px;
	}
	.icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 38px;
		height: 38px;
		border-radius: 28%;
		background: var(--ink);
		color: var(--bg);
	}
	.body {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.top {
		font-size: 12px;
		color: var(--muted);
	}
	.title {
		font-weight: 600;
	}
	.text {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 14px;
	}
</style>
