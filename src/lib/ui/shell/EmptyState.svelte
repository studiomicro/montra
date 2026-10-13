<script lang="ts">
	import Illustration from '#lib/ui/kit/Illustration.svelte';
	import type { IllustrationName } from '#lib/ui/kit/illustrations';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import type { MascotPose } from '#lib/ui/kit/mascot/poses';

	let {
		text,
		illustration,
		mascot = 'sleep',
		actionLabel,
		actionHref,
		onaction
	}: {
		text: string;
		/** A decorative scene above the text (FN-40); the text stays the whole message. */
		illustration?: IllustrationName;
		/** Koko above the text when there is no `illustration` (FN-44): asleep by default, `false` for text only.
		 * Never both: a scene wins over Koko. */
		mascot?: MascotPose | false;
		actionLabel?: string;
		actionHref?: string;
		/** With JavaScript, runs instead of following `actionHref` (which stays the no-JavaScript path). */
		onaction?: (event: MouseEvent) => void;
	} = $props();

	function onclick(event: MouseEvent) {
		if (!onaction) return;
		event.preventDefault();
		onaction(event);
	}
</script>

<div class="empty" class:illustrated={!!illustration || !!mascot}>
	{#if illustration}<Illustration name={illustration} size={168} />
	{:else if mascot}<Mascot pose={mascot} size={120} />{/if}
	<p>{text}</p>
	{#if actionLabel && actionHref}
		<a class="action" href={actionHref} {onclick}>{actionLabel}</a>
	{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 48px 0;
		text-align: center;
	}
	.illustrated {
		padding-top: 24px;
	}
	p {
		margin: 0;
		max-width: 32ch;
		color: var(--muted);
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
</style>
