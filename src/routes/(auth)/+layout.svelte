<script lang="ts">
	import { onMount } from 'svelte';
	import { appName } from '#lib/shared/sanity';
	import { dropDeviceKey } from '#lib/ui/account-key/device';

	let { children } = $props();
	// Reaching sign-in, sign-up or the deletion page means no session: no account key stays open (FN-21).
	onMount(dropDeviceKey);
</script>

<!-- Sign-in, sign-up and the deletion confirmation: no tab bar, one narrow column. -->
<div class="auth">
	<div class="top"><a class="brand" href="/">{appName()}</a></div>
	<main class="card">
		{@render children()}
	</main>
</div>

<style>
	.auth {
		display: grid;
		justify-items: center;
		gap: 24px;
		min-height: calc(100dvh - var(--sai-top));
		padding: 40px max(20px, var(--sai-right)) calc(40px + var(--sai-bottom))
			max(20px, var(--sai-left));
		box-sizing: border-box;
		align-content: start;
	}
	/* The wordmark starts on the form's left edge (the same 400 px column as .card). */
	.top {
		width: 100%;
		max-width: 400px;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-size: 19px;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: var(--ink);
		text-decoration: none;
	}
	.card {
		width: 100%;
		max-width: 400px;
	}
	/* Desktop: the narrow column sits a little lower, never in a framed card (§ 3a fills, not frames). */
	@media (min-width: 1024px) {
		.auth {
			gap: 40px;
			padding-top: 10vh;
		}
	}
</style>
