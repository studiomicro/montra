<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { storyMayOpen, storySeenCookie, type StoryCard } from '#lib/shared/daily-story';
	import { formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { focusMain } from '#lib/ui/focus-main';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Illustration from '#lib/ui/kit/Illustration.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	/**
	 * FN-54 Part D: the once-a-day greeting, a short story of the user's own figures. It opens only after hydration
	 * (never on first paint or without JavaScript), never in a hidden tab, never over another open dialog. Steps move
	 * only on "Berikutnya" (no timer: WCAG 2.2.1). Closing it in any way (close button, Escape, backdrop, "Selesai")
	 * stores today's WIB date (the server's `today`) in the device cookie, so it shows once per day; "Matikan sapaan
	 * harian" posts the Tampilan action and closes only once the server wrote the off cookie (`onoff`).
	 */
	let { cards, today, onoff }: { cards: StoryCard[]; today: string; onoff: () => void } = $props();
	const { tr, trf, locale } = useI18n();

	let open = $state(false);
	let step = $state(0);
	let busy = $state(false);
	let failure = $state('');
	const card = $derived(cards[step]);
	const last = $derived(step === cards.length - 1);

	onMount(() => {
		if (
			storyMayOpen({
				cards: cards.length,
				hidden: document.hidden,
				dialogOpen: document.querySelector('dialog[open]') !== null
			})
		)
			open = true;
	});

	function markSeen() {
		document.cookie = storySeenCookie(today, location.protocol === 'https:');
	}

	function onclose() {
		markSeen();
		// The sheet opened by itself, so focus goes back to the page's content, not to a button that never had it.
		focusMain();
	}

	const switchOff: SubmitFunction = () => {
		busy = true;
		failure = '';
		return async ({ result }) => {
			busy = false;
			if (result.type === 'success') {
				open = false;
				onoff();
			} else failure = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
		};
	};

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	const compactDue = (inDays: number) =>
		inDays === 0
			? tr('Hari ini')
			: inDays === 1
				? tr('Besok')
				: trf('dalam {n} hari', { n: inDays });
</script>

<Sheet bind:open title={tr('Sapaan harian')} {onclose}>
	{#if open && card}
		<div class="story">
			<ol class="progress" aria-hidden="true">
				{#each cards as c, i (i)}<li class:done={i <= step} data-kind={c.kind}></li>{/each}
			</ol>
			<p class="sr-only" aria-live="polite">
				{trf('Langkah {n} dari {total}', { n: step + 1, total: cards.length })}
			</p>

			{#if card.kind === 'kemarin'}
				<Illustration name="budget" size={132} />
				<h3>{tr('Kemarin')}</h3>
				{#if card.minor === 0}
					<p class="lead">{tr('Tidak ada pengeluaran tercatat kemarin.')}</p>
				{:else}
					<p class="lead">{tr('Pengeluaranmu kemarin')}</p>
					<p class="figure num">{money(card.minor, card.currency)}</p>
				{/if}
				<p class="muted">{formatShortDay(card.date, locale)}</p>
			{:else if card.kind === 'hari-ini'}
				<Illustration name="calendar" size={132} />
				<h3>{tr('Hari ini')}</h3>
				{#if card.perDay}
					<p class="lead num">
						{trf('{per_hari} sehari untuk {hari} hari', {
							per_hari: shown(
								formatMoneyCompact(card.perDay.perDayMinor, card.perDay.currency, locale)
							),
							hari: card.perDay.days
						})}
					</p>
				{/if}
				{#if card.bills.length > 0}
					<p class="muted">{tr('Tagihan dalam 7 hari ke depan')}</p>
					<ul class="bills">
						{#each card.bills as bill (bill.id)}
							<li>
								<span class="bill-name">{bill.name}</span>
								<span class="muted">{compactDue(bill.inDays)}</span>
								{#if bill.isDemo}<StatusTag>{tr('Data demo')}</StatusTag>{/if}
								<span class="bill-amount num">{money(-bill.amountMinor, bill.currency)}</span>
							</li>
						{/each}
					</ul>
				{/if}
			{:else}
				{@const entry = card.entry}
				<Illustration name="history" size={132} />
				<h3>{trf('Pada hari ini, {tahun}', { tahun: entry.year })}</h3>
				<p class="lead">{entry.headline[locale]}</p>
				<p>{entry.body[locale]}</p>
				<p class="muted sources">
					{tr('Sumber:')}
					{#each entry.sources as source, i (i)}{#if i > 0},
						{/if}<a href={source.url} target="_blank" rel="noopener noreferrer">{source.label}</a
						>{/each}
				</p>
			{/if}

			{#if failure}<p class="failure" role="alert">{failure}</p>{/if}

			<div class="actions">
				{#if last}
					<Button full onclick={() => (open = false)}>{tr('Selesai')}</Button>
					<form method="POST" action="/pengaturan/tampilan?/sapaan" use:enhance={switchOff}>
						<button type="submit" class="off" disabled={busy}>
							{busy ? tr('Mematikan…') : tr('Matikan sapaan harian')}
						</button>
					</form>
				{:else}
					<Button full onclick={() => step++}>{tr('Berikutnya')}</Button>
				{/if}
			</div>
		</div>
	{/if}
</Sheet>

<style>
	.story {
		display: grid;
		justify-items: center;
		gap: 10px;
		padding-bottom: 8px;
		text-align: center;
	}
	.progress {
		display: grid;
		grid-auto-columns: 1fr;
		grid-auto-flow: column;
		gap: 4px;
		width: 100%;
		margin: 0 0 8px;
		padding: 0;
		list-style: none;
	}
	.progress li {
		height: 4px;
		border-radius: var(--r-pill);
		background: var(--chart-track);
	}
	.progress li.done {
		background: var(--ink);
	}
	h3 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	p {
		margin: 0;
	}
	.lead {
		font-size: 17px;
		font-weight: 600;
	}
	.figure {
		font-size: 34px;
		font-weight: 800;
		letter-spacing: -0.03em;
	}
	.muted {
		color: var(--muted);
		font-size: 14px;
	}
	.bills {
		display: grid;
		gap: 6px;
		width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
		text-align: left;
	}
	.bills li {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.bill-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.bill-amount {
		font-weight: 700;
		white-space: nowrap;
	}
	.sources a {
		color: var(--ink-2);
	}
	.failure {
		color: var(--money-up);
	}
	.actions {
		display: grid;
		gap: 4px;
		width: 100%;
		margin-top: 8px;
	}
	.off {
		width: 100%;
		min-height: 44px;
		border: 0;
		background: transparent;
		color: var(--ink-2);
		font: inherit;
		font-size: 14px;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
