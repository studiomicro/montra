<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { TANYA_CHIPS, TANYA_QUESTION_MAX } from '#lib/shared/tanya';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import TanyaCard from '#lib/ui/tanya/TanyaCard.svelte';

	/**
	 * FN-22 Tanya: the conversation, suggested questions and the composer. Without JavaScript every step is a plain
	 * form post (the answer page loads after it); with it, the same posts run in place. Nothing is shown as answered
	 * before the server saved it: the list always comes from the server's `load`.
	 */
	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	/** The question being written; a refused question keeps its text (criterion 16). */
	// FN-54: or the question Beranda's ask field brought along (`?q=`, cleaned by the load).
	const refusedText = () =>
		form && 'q' in form && typeof form.q === 'string' ? form.q : data.prefill;
	let text = $state(refusedText());
	/**
	 * FN-54 red team L2: a question that arrived in the address (Beranda's ask field, or any link) is marked as a
	 * suggestion until it is changed or sent: nothing is sent before Kirim, and a link cannot ask in the user's name.
	 */
	const fromLink = $derived(data.prefill !== '' && text === data.prefill);
	// FN-54 red team L1: once the composer holds it, the question leaves the URL (and so the history entry). Without
	// JavaScript it stays in the URL; the GET form is the no-JavaScript path.
	onMount(() => {
		if (!page.url.searchParams.has('q')) return;
		const url = new URL(page.url.href);
		url.searchParams.delete('q');
		replaceState(url, page.state);
	});
	/** '' idle; 'ask' while a question is answered; 'clear' while the conversation is deleted. */
	let pending = $state<'' | 'ask' | 'clear'>('');
	let clientError = $state('');
	let refreshing = $state(false);
	let composer = $state<HTMLTextAreaElement>();

	const ready = $derived(data.ready === 'ok');
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const failure = $derived(clientError || serverError);
	const empty = $derived(data.messages.length === 0);

	const submit =
		(kind: 'ask' | 'clear'): SubmitFunction =>
		({ formData, cancel }) => {
			if (pending) {
				cancel();
				return;
			}
			if (kind === 'ask' && !String(formData.get('q') ?? '').trim()) {
				cancel();
				clientError = tr('Tulis pertanyaanmu dulu.');
				return;
			}
			if (kind === 'ask') text = String(formData.get('q') ?? '');
			pending = kind;
			clientError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					clientError = tr('Tidak bisa terhubung. Periksa koneksi lalu coba lagi.');
				} else {
					await update({ reset: false });
					if (result.type === 'redirect' && kind === 'ask') text = '';
				}
				pending = '';
				await tick();
				composer?.focus();
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>{tr('Tanya')}</title></svelte:head>
<ScreenTitle title={tr('Tanya')} subtitle={tr('Asisten yang menjawab dari catatanmu sendiri.')}>
	{#snippet actions()}
		{#if !empty}
			<form method="POST" action="?/clear" use:enhance={submit('clear')}>
				<Button type="submit" variant="secondary" size="sm" disabled={pending !== ''}>
					{tr('Percakapan baru')}
				</Button>
			</form>
		{/if}
	{/snippet}
</ScreenTitle>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else}
	<div class="page">
		<h2 class="sr-only" id="{uid}-thread">{tr('Percakapan')}</h2>
		<ol class="thread" aria-live="polite" aria-labelledby="{uid}-thread">
			{#each data.messages as message (message.id)}
				<li class="message {message.role}">
					<p class="who">
						{message.role === 'user' ? tr('Kamu') : tr('Tanya')}
						<span class="when">{formatDateTimeWib(message.createdAt, locale)}</span>
					</p>
					<p class="body">{message.body}</p>
					{#if message.cards.length > 0}
						<div class="cards">
							{#each message.cards as card, i (i)}
								<TanyaCard {card} />
							{/each}
						</div>
					{/if}
				</li>
			{/each}
			{#if pending === 'ask'}
				<li class="message user pending">
					<p class="body">{text}</p>
				</li>
				<li class="message assistant pending">
					<p class="body" role="status">{tr('Tanya sedang menjawab…')}</p>
				</li>
			{/if}
		</ol>

		{#if empty && ready && pending === ''}
			<section class="chips" aria-labelledby="{uid}-chips">
				<h2 id="{uid}-chips">{tr('Coba tanyakan')}</h2>
				<form method="POST" action="?/ask" use:enhance={submit('ask')} class="chip-list">
					<input type="hidden" name="askId" value={data.askId} />
					{#each TANYA_CHIPS as chip, i (i)}
						<button class="chip" type="submit" name="q" value={tr(chip)}>{tr(chip)}</button>
					{/each}
				</form>
			</section>
		{/if}

		{#if failure}
			<div class="failure" role="alert">
				<p>{failure}</p>
			</div>
		{/if}

		<form
			method="POST"
			action="?/ask"
			class="composer"
			class:off={!ready}
			use:enhance={submit('ask')}
			aria-labelledby="{uid}-label"
		>
			<input type="hidden" name="askId" value={data.askId} />
			<div class="fields" class:dim={!ready}>
				<label id="{uid}-label" for="{uid}-q">{tr('Pertanyaanmu')}</label>
				{#if fromLink}
					<p class="note" id="{uid}-link">
						<Icon name="info" size={18} />
						<span>{tr('Pertanyaan ini diisi dari tautan. Belum ada yang dikirim.')}</span>
					</p>
				{/if}
				<textarea
					id="{uid}-q"
					name="q"
					rows="3"
					maxlength={TANYA_QUESTION_MAX}
					bind:value={text}
					bind:this={composer}
					disabled={!ready}
					aria-describedby="{uid}-count{ready ? '' : ` ${uid}-why`}"
					placeholder={tr('Misalnya: Bulan lalu habis berapa buat kopi?')}></textarea>
				<div class="send">
					<span class="count" id="{uid}-count">
						{trf('{n}/{m} karakter', { n: text.length, m: TANYA_QUESTION_MAX })}
					</span>
					<Button type="submit" disabled={!ready || pending !== ''}>
						{pending === 'ask' ? tr('Menjawab…') : failure && text ? tr('Coba lagi') : tr('Kirim')}
					</Button>
				</div>
			</div>
			{#if data.ready === 'no_gateway'}
				<p class="note" id="{uid}-why">
					<Icon name="info" size={18} />
					<span>{tr('Asisten AI belum dikonfigurasi.')}</span>
				</p>
			{:else if data.ready === 'no_key'}
				<p class="note" id="{uid}-why">
					<Icon name="info" size={18} />
					<span>
						{tr('Tanya menjawab dengan kunci Anthropic-mu sendiri.')}
						<a href="/pengaturan/integrasi"
							>{tr('Tambahkan kunci Anthropic di Pengaturan › Integrasi')}</a
						>
					</span>
				</p>
			{/if}
			<p class="disclaimer">
				{tr('Informasi dari catatanmu, bukan saran keuangan, pajak, atau hukum.')}
			</p>
		</form>
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: 16px;
		margin-top: 8px;
		min-width: 0;
	}
	.thread {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.thread:empty {
		display: none;
	}
	.message {
		display: grid;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
	}
	.message.user {
		justify-self: end;
		max-width: min(100%, 520px);
	}
	.who {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
	}
	.message.user .who {
		text-align: right;
	}
	.when {
		margin-left: 6px;
		font-weight: 400;
	}
	.body {
		margin: 0;
		padding: 10px 14px;
		border-radius: var(--r-group);
		background: var(--panel);
		font-size: 15px;
		line-height: 1.45;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.message.user .body {
		background: var(--ink);
		color: var(--bg);
	}
	.pending .body {
		color: var(--muted);
	}
	.message.user.pending .body {
		opacity: 0.7;
		color: var(--bg);
	}
	.cards {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.chips {
		display: grid;
		gap: 8px;
	}
	h2 {
		margin: 0 4px;
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	.chip-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.chip {
		min-height: 44px;
		padding: 8px 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.chip:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.failure p {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-size: 15px;
	}
	.composer {
		display: grid;
		gap: 8px;
	}
	label {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
	}
	textarea {
		width: 100%;
		min-height: 88px;
		padding: 12px 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
		resize: vertical;
		box-sizing: border-box;
	}
	textarea::placeholder {
		color: var(--muted);
		opacity: 1;
	}
	/* Not configured: one dimmed card (field, count and Kirim together); the note below stays at full strength. */
	.composer.off {
		padding: 12px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.composer.off textarea {
		background: var(--bg);
	}
	.fields {
		display: grid;
		gap: 8px;
	}
	.fields.dim {
		opacity: 0.6;
	}
	/* The card is dimmed as a whole: the disabled pill keeps its own full strength inside it (no double dimming). */
	.fields.dim :global(.btn:disabled) {
		opacity: 1;
	}
	.send {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.count,
	.note,
	.disclaimer {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		line-height: 1.4;
	}
	.note :global(svg) {
		flex: none;
		margin-top: 1px;
	}
	.note a {
		color: var(--ink);
		font-weight: 600;
	}
</style>
