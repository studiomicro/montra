<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { appName } from '#lib/shared/sanity';
	import { dropDeviceKey } from '#lib/ui/account-key/device';
	import AsciiField from '#lib/ui/auth/AsciiField.svelte';

	/** FN-56: the pages that show the ASCII field (owner decision 4); /akun-dihapus stays plain. */
	const ASCII_FIELD_PATHS = new Set(['/masuk', '/daftar']);

	let { children } = $props();
	const withArt = $derived(ASCII_FIELD_PATHS.has(page.url.pathname));
	// Reaching sign-in, sign-up or the deletion page means no session: no account key stays open (FN-21).
	onMount(dropDeviceKey);
</script>

<!-- Sign-in, sign-up and the deletion confirmation: no tab bar, one narrow column (the ASCII field beside it from
     1024 px on sign-in and sign-up). -->
<div class="auth" class:with-art={withArt}>
	<div class="top"><a class="brand" href="/">{appName()}</a></div>
	{#if withArt}<div class="art"><AsciiField /></div>{/if}
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
	.art {
		display: flex;
		justify-content: center;
		width: 100%;
		max-width: 400px;
	}
	/* A short screen hides the field (AsciiField.svelte); its grid cell then takes no gap either. */
	@media (max-height: 599.98px) {
		.art {
			display: none;
		}
	}
	/* Desktop: the narrow column sits a little lower, never in a framed card (§ 3a fills, not frames). */
	@media (min-width: 1024px) {
		.auth {
			gap: 40px;
			padding-top: 10vh;
		}
		/* FN-56: the 360 x 560 field on the left, spanning the wordmark and form rows; the form keeps 400 px. */
		.auth.with-art {
			grid-template-columns: 360px 400px;
			grid-template-areas: 'art top' 'art card';
			grid-template-rows: auto 1fr;
			justify-content: center;
			column-gap: 56px;
		}
		.with-art .top {
			grid-area: top;
		}
		.with-art .card {
			grid-area: card;
		}
		.art {
			grid-area: art;
			align-self: start;
			max-width: none;
		}
	}
</style>
