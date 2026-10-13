<script lang="ts">
	import { onMount } from 'svelte';
	import { useI18n } from '#lib/ui/i18n-context';

	/**
	 * FN-50: the Cloudflare Turnstile widget, Managed mode, `size: 'flexible'` (Owner decision 2), rendered
	 * explicitly into this container once the page is interactive. The script tag is in the page's <head> only
	 * while the check is configured (the parent renders this component only then). A token is single-use: the
	 * parent bumps `resetKey` after a refused submit so a fresh one is issued without a reload. Without
	 * JavaScript nothing renders here and the <noscript> line below explains.
	 */
	let {
		siteKey,
		action,
		resetKey = 0
	}: {
		siteKey: string;
		action: 'sign-in' | 'sign-up';
		resetKey?: number;
	} = $props();
	const { tr, locale } = useI18n();

	interface TurnstileApi {
		render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
		reset: (widgetId?: string) => void;
		remove: (widgetId?: string) => void;
	}
	type TurnstileWindow = Window & {
		turnstile?: TurnstileApi;
		onloadTurnstileCallback?: () => void;
	};

	let container: HTMLDivElement | undefined = $state();
	let widgetId: string | undefined;
	let lastReset = 0;

	/** The widget follows the page's resolved theme (`<html data-theme>`): light, dark, or Cloudflare's auto. */
	function widgetTheme(): 'light' | 'dark' | 'auto' {
		const theme = document.documentElement.dataset.theme;
		return theme === 'dark' || theme === 'light' ? theme : 'auto';
	}

	function render(api: TurnstileApi) {
		if (!container || widgetId !== undefined) return;
		widgetId = api.render(container, {
			sitekey: siteKey,
			action,
			theme: widgetTheme(),
			language: locale,
			size: 'flexible',
			'response-field': true,
			'response-field-name': 'cf-turnstile-response'
		});
	}

	onMount(() => {
		const w = window as TurnstileWindow;
		if (w.turnstile) render(w.turnstile);
		else w.onloadTurnstileCallback = () => w.turnstile && render(w.turnstile);
		// Leaving the page (client navigation) removes the widget, so a later visit renders a fresh one.
		return () => {
			if (widgetId !== undefined) w.turnstile?.remove(widgetId);
			widgetId = undefined;
		};
	});

	$effect(() => {
		if (resetKey === lastReset) return;
		lastReset = resetKey;
		const w = window as TurnstileWindow;
		if (widgetId !== undefined) w.turnstile?.reset(widgetId);
	});
</script>

<div
	class="turnstile"
	data-action={action}
	data-testid="turnstile"
	role="group"
	aria-label={tr('Pemeriksaan keamanan')}
>
	<div bind:this={container}></div>
	<noscript>
		<p class="noscript">
			{tr('Verifikasi keamanan membutuhkan JavaScript. Aktifkan JavaScript lalu muat ulang.')}
		</p>
	</noscript>
</div>

<style>
	.turnstile {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	/* `size: 'flexible'` fills the column (300 px minimum per Cloudflare); the container never overflows it. */
	.turnstile > div {
		width: 100%;
		min-width: 0;
		overflow: hidden;
	}
	.noscript {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-size: 15px;
	}
</style>
