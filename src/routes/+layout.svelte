<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { dev } from '$app/env';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { createTranslator } from '#lib/shared/i18n';
	import { SPLASH_LINKS } from '#lib/shared/splash';
	import { focusMain } from '#lib/ui/focus-main';
	import { setI18n } from '#lib/ui/i18n-context';
	import { provideAmountsHiddenAtLoad } from '#lib/ui/kit/amounts.svelte';
	import InAppBrowserNotice from '#lib/ui/kit/InAppBrowserNotice.svelte';
	import { PAGE_ENTER_OPTIONS, pageEnterKeyframes, pageFadeAllowed } from '#lib/ui/motion';
	import { captureInstallPrompt } from '#lib/ui/pwa/install.svelte';
	import UpdateBanner from '#lib/ui/pwa/UpdateBanner.svelte';
	import { pwaUpdate, startServiceWorker } from '#lib/ui/pwa/update.svelte';

	let { data, children } = $props();
	// Locale changes need a full reload (cookie + navigation), so reading it once is correct.
	// svelte-ignore state_referenced_locally
	setI18n(createTranslator(data.locale));
	// Every render starts with amounts shown (on the server the module state is shared between requests); only a
	// HeroAmount with the eye button applies this request's cookie choice (FN-25b red team 1).
	provideAmountsHiddenAtLoad(() => data.amountsHidden);

	/** sessionStorage key: the in-app-browser notice stays dismissed for this browser session only. */
	const NOTICE_DISMISSED = 'fin-in-app-notice-dismissed';
	let noticeDismissed = $state(false);

	onMount(() => {
		// Every child has mounted before this root onMount runs: the page is hydrated. The e2e helper
		// `waitForHydration` waits for this mark instead of `networkidle`; the server-rendered HTML never has it.
		document.documentElement.dataset.hydrated = '';
		try {
			noticeDismissed = sessionStorage.getItem(NOTICE_DISMISSED) === '1';
		} catch {
			// Storage blocked: the notice simply shows.
		}
		// The service worker (src/service-worker) is registered from this bundled code, never an inline
		// script, so the CSP needs no change; never under `vite dev` (no stale cached bundle while developing).
		const stopWorker = startServiceWorker(!dev);
		const stopPrompt = captureInstallPrompt();
		return () => {
			stopWorker();
			stopPrompt();
		};
	});

	// FN-42: the Tentang page shows the same banner inline, so it is not repeated above it there. FN-42b's
	// "Baru di Montra" notice (the (app) layout) sits below this banner, at the top of <main>.
	const showUpdate = $derived(
		pwaUpdate.available && !pwaUpdate.dismissed && page.url.pathname !== '/pengaturan/tentang'
	);

	// FN-40/FN-51: the new page fades in and rises 8 px after a client-side navigation (a transform/opacity Web
	// Animation on <main>, fill `none`: the page stays interactive throughout — no pointer-events change — and no
	// transform is left behind). Not the View Transitions API: while a view transition runs, Chromium drops taps on
	// the page (e2e/motion.spec.ts shows it), so a quick tap on the next page would be lost. Never under reduced
	// motion, in a hidden tab or on the first load.
	afterNavigate((navigation) => {
		const allowed = pageFadeAllowed({
			supported: typeof Element.prototype.animate === 'function',
			reducedMotion: prefersReducedMotion.current,
			hidden: document.hidden,
			from: navigation.from?.url.pathname,
			to: navigation.to?.url.pathname
		});
		if (!allowed) return;
		document.querySelector('main')?.animate(pageEnterKeyframes(), PAGE_ENTER_OPTIONS);
	});

	function dismissNotice() {
		noticeDismissed = true;
		try {
			sessionStorage.setItem(NOTICE_DISMISSED, '1');
		} catch {
			// Storage blocked: dismissed until the next page load.
		}
		focusMain();
	}

	function dismissUpdate() {
		pwaUpdate.dismissed = true;
		focusMain();
	}
</script>

<svelte:head>
	<!-- FN-13b: iOS launch images, only for Apple devices (about 7 KB of head the others never need). -->
	{#if data.appleDevice}
		{#each SPLASH_LINKS as link (link.href)}
			<link rel="apple-touch-startup-image" href={link.href} media={link.media} />
		{/each}
	{/if}
</svelte:head>
{#if data.inAppBrowser && !noticeDismissed}
	<InAppBrowserNotice app={data.inAppBrowser} os={data.mobileOs} ondismiss={dismissNotice} />
{/if}
{#if showUpdate}
	<div class="update-slot">
		<UpdateBanner ondismiss={dismissUpdate} />
	</div>
{/if}
{@render children()}

<style>
	.update-slot {
		margin: 12px max(16px, var(--sai-right)) 0 max(16px, var(--sai-left));
	}
</style>
