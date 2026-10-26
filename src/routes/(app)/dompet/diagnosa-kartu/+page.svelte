<script lang="ts">
	import { onMount } from 'svelte';
	import { diagnoseCard, type CardInfo, type Diagnosis } from '#lib/shared/emoney/diagnose';
	import { formatMoney } from '#lib/shared/money-format';
	import { nfcBridge, send, type NfcBridge } from '#lib/ui/emoney/nfc';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-58 "Diagnosa kartu": tap an e-money card on the Android app and record how it answers the standard read
	 * probes, so the owner can send the log for an issuer's reader to be checked. The reading and masking live in
	 * diagnose.ts; this page only starts and stops the reader and renders the log. Read-only (the bridge refuses
	 * anything else), nothing is saved, and the log is masked before it is shown or copied.
	 */
	const { tr, locale } = useI18n();

	let hydrated = $state(false);
	let bridge = $state<NfcBridge | null>(null);
	let nfcOff = $state(false);
	/** Waiting for a tap, from "Mulai membaca" until a card is read. */
	let reading = $state(false);
	/** A tapped card is being probed; a second tap meanwhile is ignored. */
	let probing = false;
	/** The page has gone: a probe still running stops sending and its result is dropped. */
	let disposed = false;
	let log = $state<Diagnosis | null>(null);
	let copied = $state(false);
	let copyFailed = $state(false);

	onMount(() => {
		hydrated = true;
		const found = nfcBridge();
		bridge = found;
		let removeListener: (() => Promise<void>) | undefined;
		void (async () => {
			if (!found) return;
			try {
				const state = await found.isAvailable();
				nfcOff = !state.available || !state.enabled;
				const listener = await found.addListener('card', (info) => void probe(found, info));
				// Left before the listener was registered: remove it now, or it would outlive the page.
				if (disposed) void listener.remove();
				else removeListener = () => listener.remove();
			} catch {
				nfcOff = true;
			}
		})();
		return () => {
			disposed = true;
			void removeListener?.().catch(() => {});
			if (found) void found.stopReading().catch(() => {});
		};
	});

	async function start() {
		if (!bridge) return;
		log = null;
		copied = false;
		copyFailed = false;
		// Set before the call: the bridge may report a card before its startReading answer reaches the page.
		reading = true;
		try {
			await bridge.startReading();
		} catch {
			reading = false;
			nfcOff = true;
		}
	}

	async function probe(found: NfcBridge, card: CardInfo) {
		// Only the first tap after "Mulai membaca" counts; a tap while one is probed would reset its connection.
		if (!reading || probing || disposed) return;
		probing = true;
		try {
			const result = await diagnoseCard(card, (tech, hex) => {
				if (disposed) return Promise.reject(new Error('stopped'));
				return send(found, tech, hex);
			});
			if (disposed) return;
			log = result;
			reading = false;
			await found.stopReading().catch(() => {});
		} finally {
			probing = false;
		}
	}

	const logText = $derived(log ? JSON.stringify({ app: 'montra-android', ...log }, null, 2) : '');

	async function copy() {
		try {
			await navigator.clipboard.writeText(logText);
			copied = true;
			copyFailed = false;
		} catch {
			copyFailed = true;
		}
	}
</script>

<svelte:head><title>{tr('Diagnosa kartu')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/dompet', label: tr('Kembali ke Dompet') }}
	title={tr('Diagnosa kartu')}
/>

<p class="lead">
	{tr(
		'Tempelkan kartu e-money ke bagian belakang ponsel. Montra hanya membaca jawaban kartu, tidak pernah mengubah saldo atau isi kartu, dan tidak menyimpan apa pun.'
	)}
</p>

{#if !hydrated}
	<p class="note">{tr('Memuat…')}</p>
{:else if !bridge}
	<p class="note">{tr('Membaca kartu lewat NFC hanya bisa di aplikasi Montra untuk Android.')}</p>
{:else if nfcOff}
	<p class="note">
		{tr('NFC mati atau tidak ada di ponsel ini. Nyalakan NFC di pengaturan ponsel.')}
	</p>
{:else}
	<div class="actions">
		<Button size="lg" full disabled={reading} onclick={start}>
			{reading ? tr('Tempelkan kartu sekarang…') : tr('Mulai membaca')}
		</Button>
	</div>
{/if}

{#if log}
	<section class="section" aria-labelledby="log-title">
		<h2 id="log-title">{tr('Hasil')}</h2>
		{#if log.kmt?.ok}
			<!-- The card holds whole rupiah; formatMoney takes minor units (sen), hence × 100. -->
			<p class="balance">
				{tr('Saldo KMT')}
				<strong class="num">{formatMoney(log.kmt.balance * 100, 'IDR', 'auto', locale)}</strong>
			</p>
			<p class="note">
				{tr('Cocokkan dengan saldo di mesin stasiun. Pembacaan KMT masih diuji.')}
			</p>
		{/if}
		<p class="note">
			{tr(
				'Kirim log ini hanya ke tim Montra. Angka panjang sudah disamarkan, tetapi log tetap berisi data kartumu.'
			)}
		</p>
		<pre class="log">{logText}</pre>
		<Button variant="secondary" size="md" onclick={copy}>
			{copied ? tr('Tersalin') : tr('Salin log')}
		</Button>
		{#if copyFailed}
			<p class="note" role="alert">{tr('Tidak bisa menyalin. Salin log secara manual.')}</p>
		{/if}
	</section>
{/if}

<style>
	.lead,
	.note {
		margin: 0 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.actions {
		margin: 8px 0 24px;
	}
	.section {
		display: grid;
		gap: 12px;
		justify-items: start;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	.balance {
		display: grid;
		gap: 4px;
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	.balance strong {
		color: var(--ink);
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.03em;
	}
	.log {
		width: 100%;
		max-height: 360px;
		margin: 0;
		padding: 12px;
		overflow: auto;
		border-radius: var(--r-s);
		background: var(--panel);
		font: 12px/1.5 var(--font-mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
