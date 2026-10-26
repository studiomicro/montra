<script lang="ts">
	import { onMount } from 'svelte';
	import { maskLongDigitRuns, PROBES } from '#lib/shared/emoney/commands';
	import {
		idmFromPolling,
		kmtBalanceFrame,
		kmtPollingFrame,
		parseKmtBalance,
		type KmtBalance
	} from '#lib/shared/emoney/kmt';
	import { formatMoney } from '#lib/shared/money-format';
	import { cardTech, nfcBridge, send, type CardInfo, type NfcBridge } from '#lib/ui/emoney/nfc';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-58 "Diagnosa kartu": tap an e-money card on the Android app and record how it answers the standard read
	 * probes (commands.ts), so the owner can send the log for an issuer's reader to be checked. Read-only (the bridge
	 * refuses anything else), nothing is saved, and long digit runs are masked before the log is shown or copied.
	 */
	const { tr, locale } = useI18n();

	type Answer = { name: string; command: string; response: string };
	type Log = { card: CardInfo; kmt: KmtBalance | null; answers: Answer[] };

	let hydrated = $state(false);
	let bridge = $state<NfcBridge | null>(null);
	let nfcOff = $state(false);
	let reading = $state(false);
	let log = $state<Log | null>(null);
	let copied = $state(false);

	onMount(() => {
		hydrated = true;
		bridge = nfcBridge();
		let remove: (() => Promise<void>) | undefined;
		void (async () => {
			if (!bridge) return;
			const state = await bridge.isAvailable();
			nfcOff = !state.available || !state.enabled;
			remove = (await bridge.addListener('card', (info) => void probe(info))).remove;
		})();
		return () => {
			void remove?.();
			void bridge?.stopReading();
		};
	});

	async function start() {
		if (!bridge) return;
		log = null;
		copied = false;
		try {
			await bridge.startReading();
			reading = true;
		} catch {
			nfcOff = true;
		}
	}

	async function probe(card: CardInfo) {
		if (!bridge) return;
		const tech = cardTech(card);
		const answers: Answer[] = [];
		for (const p of PROBES.filter((p) => p.tech === tech)) {
			let response: string;
			try {
				response = await send(bridge, p.tech, p.hex);
			} catch (error) {
				response = error instanceof Error ? error.message : 'error';
			}
			answers.push({ name: p.name, command: p.hex, response });
		}
		// KMT (FeliCa system 90B7): the reader's own two reads, so one log both identifies and checks it.
		let kmt: KmtBalance | null = null;
		let idm: string | null = null;
		if (tech === 'nfcf') {
			try {
				const poll = await send(bridge, 'nfcf', kmtPollingFrame());
				answers.push({ name: 'KMT Polling (90B7)', command: kmtPollingFrame(), response: poll });
				idm = idmFromPolling(poll);
				if (idm) {
					const read = await send(bridge, 'nfcf', kmtBalanceFrame(idm));
					answers.push({
						name: 'KMT balance (1017)',
						command: kmtBalanceFrame(idm),
						response: read
					});
					kmt = parseKmtBalance(read);
				}
			} catch (error) {
				answers.push({
					name: 'KMT',
					command: '',
					response: error instanceof Error ? error.message : 'error'
				});
			}
		}
		// The card's IDm is a unique identifier: only its last 2 bytes stay in the log.
		const mask = (hex: string) =>
			maskLongDigitRuns(
				idm ? hex.toUpperCase().replaceAll(idm, '••••••••••••' + idm.slice(-4)) : hex
			);
		log = {
			card,
			kmt,
			answers: answers.map((a) => ({ ...a, command: mask(a.command), response: mask(a.response) }))
		};
		reading = false;
		await bridge.stopReading();
	}

	const logText = $derived(log ? JSON.stringify({ app: 'montra-android', ...log }, null, 2) : '');

	async function copy() {
		await navigator.clipboard.writeText(logText);
		copied = true;
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
