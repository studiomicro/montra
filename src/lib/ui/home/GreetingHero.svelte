<script lang="ts">
	import type { Snippet } from 'svelte';
	import { formatWeekdayDay } from '#lib/shared/dates';
	import { GREETINGS, type GreetingPeriod } from '#lib/shared/greeting';
	import { TANYA_QUESTION_MAX } from '#lib/shared/tanya';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import HeroScene from './HeroScene.svelte';

	/**
	 * FN-54 B2: the first card of Beranda. Top to bottom: the WIB date, the greeting (a paragraph: the page keeps its
	 * one h1), one honest line about today, the month figure (`children`: the unchanged HeroAmount with its chips),
	 * the ask field and the scene strip with Koko resting at its right end (no speech, no copy). Everything comes
	 * from the server's load (`today`, `period`), so the server render and hydration agree. Flat: no blur, no shadow;
	 * the Pro frame (FN-46) is drawn here once, so the figure inside sets `pro={false}`.
	 */
	let {
		today,
		period,
		stateLine,
		askReady,
		pro = false,
		children
	}: {
		today: string;
		period: GreetingPeriod;
		stateLine: string;
		/** The AI Gateway is configured: the ask field prefills Tanya (it never sends anything itself). */
		askReady: boolean;
		pro?: boolean;
		children: Snippet;
	} = $props();
	const { tr, locale } = useI18n();
	const uid = $props.id();
</script>

<section class="greeting" class:pro aria-labelledby="{uid}-hello">
	<div class="text">
		<p class="date">{formatWeekdayDay(today, locale)}</p>
		<p class="hello" id="{uid}-hello">{tr(GREETINGS[period])}</p>
		<p class="state">{stateLine}</p>
	</div>

	{@render children()}

	<!-- B4: a plain GET form. Tanya opens with the question in its composer; nothing is sent until "Kirim" there. -->
	<form class="ask" method="GET" action="/tanya" role="search" aria-label={tr('Tanya')}>
		<label class="sr-only" for="{uid}-q">{tr('Pertanyaanmu')}</label>
		<input
			id="{uid}-q"
			name="q"
			type="text"
			maxlength={TANYA_QUESTION_MAX}
			autocomplete="off"
			placeholder={tr('Tanya apa saja soal uangmu')}
			disabled={!askReady}
			aria-describedby={askReady ? undefined : `${uid}-why`}
		/>
		<button
			type="submit"
			class="send"
			aria-label={tr('Buka di Tanya')}
			disabled={!askReady}
			aria-describedby={askReady ? undefined : `${uid}-why`}
		>
			<Icon name="arrow-up" size={18} />
		</button>
	</form>
	{#if !askReady}<p class="why" id="{uid}-why">{tr('Asisten AI belum dikonfigurasi.')}</p>{/if}

	<div class="strip">
		<HeroScene {period} />
		<span class="koko"><Mascot pose="idle" size={48} /></span>
	</div>
</section>

<style>
	.greeting {
		display: grid;
		gap: 12px;
		padding: 18px 18px 0;
		overflow: hidden;
		border-radius: var(--r-l);
		background: var(--panel);
	}
	/*
	 * FN-46: the Pro frame, moved from HeroAmount to the card (one frame, never two). The same tested surfaces:
	 * text on --pro-soft and --panel meets AA in every theme (test/contrast.test.ts).
	 */
	.greeting.pro {
		border: 1px solid color-mix(in srgb, var(--pro) 32%, transparent);
		background: linear-gradient(135deg, var(--pro-soft), var(--panel));
	}
	/* The figure's own padding is the card's now; its pills sit on the card, so they take the page colour. */
	.greeting :global(.hero) {
		padding: 0;
	}
	.greeting :global(.hero .pill),
	.greeting :global(.hero .none) {
		background: var(--bg);
	}
	.text {
		display: grid;
		gap: 4px;
	}
	.date {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
	}
	.hello {
		margin: 0;
		font-size: 28px;
		font-weight: 800;
		line-height: 1.15;
		letter-spacing: -0.03em;
	}
	@media (min-width: 1024px) {
		.hello {
			font-size: 34px;
		}
	}
	.state {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	.ask {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 48px;
		padding: 2px 2px 2px 16px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.ask:focus-within {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		/* 16 px: iOS never zooms the page on focus. */
		font-size: 16px;
		outline: none;
		/* QA FN-54 #3: the pill is the field; the app's global input frame would draw a box inside it. */
		box-shadow: none;
		border-radius: 0;
	}
	input::placeholder {
		color: var(--muted);
	}
	input:disabled {
		cursor: not-allowed;
	}
	.send {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--action);
		color: var(--on-action);
	}
	/* Unavailable is said in words (the line below), not only by the look. */
	.send:disabled {
		background: var(--panel-2);
		color: var(--muted);
		cursor: not-allowed;
	}
	.why {
		margin: -4px 0 0;
		color: var(--muted);
		font-size: 13px;
	}
	/* A fixed height from the first paint (96 px, 120 px from 1024 px): the card never shifts once hydrated. */
	.strip {
		position: relative;
		height: 96px;
		margin: 0 -18px;
	}
	@media (min-width: 1024px) {
		.strip {
			height: 120px;
		}
	}
	.koko {
		position: absolute;
		right: 14px;
		bottom: 6px;
	}
</style>
