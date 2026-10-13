<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion, Tween } from 'svelte/motion';
	import { moneyParts } from '#lib/shared/money-format';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { countUpDuration, interpolateMinor } from '#lib/ui/motion';
	import { HIDDEN_AMOUNT } from './amount-visibility';
	import {
		amounts,
		amountsHiddenAtLoad,
		loadAmountsHidden,
		setAmountsHidden
	} from './amounts.svelte';

	let {
		label,
		amountMinor,
		currency = 'IDR',
		fallback = '',
		hideToggle = true,
		pro = false,
		children,
		beside
	}: {
		label: string;
		/** Null when the figure cannot be shown exactly: `fallback` is shown instead (never a rounded number). */
		amountMinor: number | null;
		currency?: string;
		fallback?: string;
		/** The eye button that hides every amount on this page (remembered per device). */
		hideToggle?: boolean;
		/**
		 * FN-46: Beranda's premium frame for an account with the Pro look (a soft gold card behind the figure). A
		 * background only: the label, figure, size and context line are the same as without it.
		 */
		pro?: boolean;
		/** The one grey line of context under the number. */
		children?: Snippet;
		/** FN-51: a small decoration beside the label (Beranda's Koko welcome); never text. */
		beside?: Snippet;
	} = $props();

	const { tr, locale } = useI18n();
	// FN-40: when the figure changes on this page (after a save), it counts from the old to the new amount in
	// whole minor units and settles on the exact figure. It starts at the server's figure, so the server-rendered
	// page, hydration and a page without JavaScript show the final digits at once (no layout shift).
	const count = new Tween(
		untrack(() => amountMinor ?? 0),
		{ interpolate: interpolateMinor, easing: cubicOut }
	);
	let countedCurrency = untrack(() => currency);
	$effect(() => {
		const to = amountMinor;
		const toCurrency = currency;
		const reducedMotion = prefersReducedMotion.current;
		if (to === null) return;
		untrack(() => {
			const from = count.current;
			if (from === to && count.target === to) return;
			const sameCurrency = toCurrency === countedCurrency;
			countedCurrency = toCurrency;
			// FN-51: a save that finishes in a hidden tab shows the new figure at once when the tab returns.
			void count.set(to, {
				duration: countUpDuration({
					from,
					to,
					sameCurrency,
					reducedMotion,
					hidden: document.hidden
				})
			});
		});
	});
	// Symbol (raised, grey) and figure of "Rp 1.264.000".
	const parts = $derived(amountMinor === null ? null : moneyParts(count.current, currency, locale));

	/** The figure's length class (`n8` … `n22`): the CSS shrinks a long figure to fit the column (no inline style: CSP). */
	const lengthClass = $derived(
		`n${Math.min(22, Math.max(8, amounts.hidden ? 8 : (parts?.figure.length ?? 8)))}`
	);

	// The stored choice applies to the page this hero leads; other pages always show their amounts. Its cookie
	// (read by the root layout) masks the server render and the hydration alike, so nothing flashes (FN-25b red
	// team 1); the device's stored choice then wins on mount.
	// svelte-ignore state_referenced_locally
	if (hideToggle) amounts.hidden = amountsHiddenAtLoad();
	onMount(() => {
		if (hideToggle) loadAmountsHidden();
		return () => {
			amounts.hidden = false;
		};
	});
</script>

<section class="hero" class:pro>
	<div class="top">
		<p class="label">{label}</p>
		{@render beside?.()}
		{#if hideToggle}
			<button
				type="button"
				class="eye"
				aria-pressed={amounts.hidden}
				aria-label={tr('Sembunyikan nominal')}
				onclick={() => setAmountsHidden(!amounts.hidden)}
			>
				<Icon name={amounts.hidden ? 'eye-off' : 'eye'} size={18} />
			</button>
		{/if}
	</div>
	{#if parts === null}
		<p class="too-large">{fallback}</p>
	{:else}
		<p class="figure num {lengthClass}">
			{#if amounts.hidden}
				<span class="cur">{parts.symbol}</span>{HIDDEN_AMOUNT}
			{:else}
				<span class="cur">{parts.symbol}</span>{parts.figure}
			{/if}
		</p>
	{/if}
	{#if children}<div class="context">{@render children()}</div>{/if}
</section>

<style>
	.hero {
		display: grid;
		justify-items: start;
		gap: 6px;
		padding: 8px 0 4px;
		/* Container units size the figure to this column (see .figure). */
		container-type: inline-size;
	}
	/*
	 * FN-46: the Pro frame. A gradient between two tested surfaces (--pro-soft and --panel, both AA for --ink and
	 * --muted in every theme, test/contrast.test.ts); no blur, so the glass budget is untouched. Mono's --pro-soft is
	 * grey, so the frame stays achromatic there.
	 */
	.hero.pro {
		padding: 16px 18px 14px;
		border: 1px solid color-mix(in srgb, var(--pro) 32%, transparent);
		border-radius: var(--r-l);
		background: linear-gradient(135deg, var(--pro-soft), var(--panel));
	}
	.top {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.label {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
		font-weight: 500;
	}
	.eye {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
	}
	@media (pointer: coarse) {
		.eye {
			width: 44px;
			height: 44px;
		}
	}
	.eye:hover {
		background: var(--panel);
		color: var(--ink);
	}
	.figure {
		margin: 0;
		/* 56 px, but never wider than a 360 px phone holds: "Rp 12.319.000" stays on one line there. */
		font-size: min(56px, 12.5vw);
		line-height: 1.05;
		font-weight: 700;
		letter-spacing: -0.045em;
		overflow-wrap: anywhere;
	}
	/*
	 * A long figure ("1.265.429.500") shrinks to stay on one line instead of dropping its last digit to a second
	 * line: about 0.52 em per character plus the "Rp" (--n is the figure's length).
	 */
	.figure {
		font-size: min(56px, 12.5vw, calc(100cqw / (var(--n, 8) * 0.52 + 0.8)));
	}
	.n8 {
		--n: 8;
	}
	.n9 {
		--n: 9;
	}
	.n10 {
		--n: 10;
	}
	.n11 {
		--n: 11;
	}
	.n12 {
		--n: 12;
	}
	.n13 {
		--n: 13;
	}
	.n14 {
		--n: 14;
	}
	.n15 {
		--n: 15;
	}
	.n16 {
		--n: 16;
	}
	.n17 {
		--n: 17;
	}
	.n18 {
		--n: 18;
	}
	.n19 {
		--n: 19;
	}
	.n20 {
		--n: 20;
	}
	.n21 {
		--n: 21;
	}
	.n22 {
		--n: 22;
	}
	@media (min-width: 1024px) {
		.figure {
			font-size: min(52px, calc(100cqw / (var(--n, 8) * 0.52 + 0.8)));
		}
	}
	.cur {
		margin-right: 0.12em;
		font-size: 0.42em;
		vertical-align: 0.9em;
		color: var(--muted);
		letter-spacing: 0;
	}
	.too-large {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
	}
	.context {
		display: grid;
		justify-items: start;
		gap: 8px;
		color: var(--muted);
		font-size: 14px;
	}
</style>
