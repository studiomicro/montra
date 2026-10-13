<script lang="ts">
	import { tick } from 'svelte';
	import { applyAction, deserialize, type ActionResult, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import type { ReceiptReview } from '#lib/shared/receipts';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { QUEUE_NETWORK } from '#lib/ui/offline-queue/view';
	import PhotoPicker from '#lib/ui/photos/PhotoPicker.svelte';
	import { holdPhoto } from '#lib/ui/receipts/held-photo';
	import ReceiptReviewForm from '#lib/ui/receipts/ReceiptReviewForm.svelte';
	import { reencodeReceiptPhoto } from '#lib/ui/receipts/reencode';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-15 Struk: pick → read → review → saved, on one page without a reload. The re-encoded photo lives only in
	 * this page's memory; without JavaScript every step is a plain form post (the photo is picked again to save).
	 */
	let { data, form } = $props();
	const { tr, trf } = useI18n();
	const uid = $props.id();

	/** Longest the page waits for a read (upload plus the server's own 45 s provider timeout). */
	const READ_CLIENT_TIMEOUT_MS = 180_000;

	let photo = $state<File | null>(null);
	let preview = $state<string | null>(null);
	let preparing = $state(false);
	/** '' idle; 'upload' while the photo is sent; 'read' once it arrived and the server is reading it. */
	let progress = $state<'' | 'upload' | 'read'>('');
	let saving = $state(false);
	let clientError = $state('');
	/** The last successful read's checks (a refused save keeps showing them). */
	let lastReview = $state<ReceiptReview | null>(null);
	/** Remounts the review form with fresh values after each successful read. */
	let reviewKey = $state(0);
	let refreshing = $state(false);

	const readResult = $derived(
		form && form.action === 'read' && 'review' in form && form.review ? form.review : null
	);
	const saveRefusal = $derived(
		form && form.action === 'save' && 'values' in form && form.values ? form : null
	);
	const saved = $derived(form && form.action === 'save' && 'saved' in form ? form.saved : null);
	const readFailed = $derived(form && form.action === 'read' && 'error' in form ? form : null);
	const noKey = $derived(
		!data.hasKey || Boolean(readFailed && 'noKey' in readFailed && readFailed.noKey)
	);
	const canRead = $derived(data.configured && !noKey);
	const review = $derived(readResult ?? (saveRefusal ? lastReview : null));
	const reviewValues = $derived(
		saveRefusal && saveRefusal.values ? saveRefusal.values : readResult?.values
	);
	const banner = $derived(
		clientError ||
			(form && 'error' in form && form.error && !readFailed ? tr(form.error) : '') ||
			undefined
	);

	$effect(() => {
		if (readResult) lastReview = readResult;
	});

	/** The picker's one file (FN-45: camera or gallery, HEIC already handled), re-encoded for the read. */
	async function onpick(picked: File) {
		clientError = '';
		preparing = true;
		try {
			// One photo per receipt: a second pick replaces the first.
			const encoded = await reencodeReceiptPhoto(picked);
			photo = encoded.file;
			preview = encoded.preview;
		} finally {
			preparing = false;
		}
	}

	/** POSTs `body` to `action` with upload progress (fetch has none): "Mengunggah…" then "Membaca strukmu…". */
	function postAction(action: string, body: FormData): Promise<ActionResult | null> {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', action);
			xhr.setRequestHeader('accept', 'application/json');
			xhr.setRequestHeader('x-sveltekit-action', 'true');
			xhr.timeout = READ_CLIENT_TIMEOUT_MS;
			xhr.upload.onload = () => (progress = 'read');
			xhr.onload = () => {
				try {
					resolve(deserialize(xhr.responseText));
				} catch {
					resolve(null);
				}
			};
			xhr.onerror = () => resolve(null);
			xhr.ontimeout = () => resolve(null);
			xhr.send(body);
		});
	}

	/** "Baca struk" and "Baca lagi": the held photo, read again from scratch. */
	async function readReceipt() {
		if (progress) return;
		if (!photo) {
			clientError = tr('Pilih foto struk dulu.');
			return;
		}
		clientError = '';
		progress = 'upload';
		const body = new FormData();
		body.set('photo', photo);
		const result = await postAction('?/read', body);
		progress = '';
		// No answer, or an error page instead of the action's answer (offline, a proxy, a refused body).
		if (!result || result.type === 'error') {
			clientError = tr(QUEUE_NETWORK);
			return;
		}
		await applyAction(result);
		if (result.type === 'success') reviewKey++;
		await tick();
		document.getElementById(`${uid}-state`)?.focus();
	}

	function onreadsubmit(event: SubmitEvent) {
		// With JavaScript the held (re-encoded) photo is sent; without it the form posts the picked file.
		event.preventDefault();
		void readReceipt();
	}

	/** "Lampirkan fotonya saja": the held photo goes to the manual form; any read result is dropped. */
	async function attachOnly() {
		if (photo) holdPhoto({ file: photo, preview });
		await goto('/riwayat/baru?foto=1');
	}

	const saveSubmit: SubmitFunction = ({ formData, cancel }) => {
		clientError = '';
		if (photo) formData.set('photo', photo);
		else if (!(formData.get('photo') instanceof File)) {
			cancel();
			clientError = tr('Pilih foto struk dulu.');
			return;
		}
		saving = true;
		return async ({ result, update }) => {
			saving = false;
			if (result.type === 'error') {
				clientError = tr(QUEUE_NETWORK);
				return;
			}
			// A refusal before the form was read (busy, too large) carries no values: the review stays as it is.
			if (result.type === 'failure' && !(result.data && 'values' in result.data)) {
				const error = result.data?.error;
				clientError = typeof error === 'string' ? tr(error) : tr(QUEUE_NETWORK);
				return;
			}
			await update({ reset: false });
			await tick();
			document.getElementById(`${uid}-state`)?.focus();
		};
	};

	async function readAnother() {
		photo = null;
		preview = null;
		lastReview = null;
		await goto('/riwayat/struk', { invalidateAll: true });
	}

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head><title>{tr('Struk')}</title></svelte:head>
<ScreenTitle back={{ href: '/riwayat', label: tr('Kembali ke Riwayat') }} title={tr('Struk')} />

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.wallets.length === 0}
	<EmptyState
		illustration="wallet"
		text={tr('Tambah dompet rupiah dulu supaya struk punya tempat.')}
		actionLabel={tr('Tambah dompet')}
		actionHref="/dompet?tambah=1"
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#if saved}
			<section class="done" aria-labelledby="{uid}-state">
				<h2 id="{uid}-state" tabindex="-1">{tr('Struk tersimpan')}</h2>
				<p role="status">
					{saved.count === 1
						? tr('1 transaksi tersimpan.')
						: trf('{n} transaksi tersimpan.', { n: saved.count })}
					{#if saved.photo}{tr('Foto struk disimpan sebagai bukti.')}{/if}
				</p>
				<div class="ways">
					<Button href="/riwayat" size="lg">{tr('Lihat di Riwayat')}</Button>
					<Button
						href="/riwayat/struk"
						variant="secondary"
						size="lg"
						onclick={(event) => {
							event.preventDefault();
							void readAnother();
						}}>{tr('Baca struk lain')}</Button
					>
				</div>
			</section>
		{:else if reviewValues}
			<span id="{uid}-state" tabindex="-1"></span>
			{#key reviewKey}
				<ReceiptReviewForm
					values={reviewValues}
					{review}
					errors={saveRefusal && 'errors' in saveRefusal && saveRefusal.errors
						? (saveRefusal.errors as Record<string, string>)
						: {}}
					wallets={data.wallets}
					categories={data.categories}
					today={data.today}
					heldPhoto={photo !== null}
					canReadAgain={canRead}
					{saving}
					submit={saveSubmit}
					onreadagain={readReceipt}
					onattachonly={attachOnly}
				/>
			{/key}
		{:else}
			<form
				method="POST"
				action="?/read"
				enctype="multipart/form-data"
				class="picker"
				onsubmit={onreadsubmit}
				aria-labelledby="{uid}-state"
			>
				<h2 id="{uid}-state" class="sr-only" tabindex="-1">{tr('Foto struk')}</h2>
				{#if !data.configured}
					<p class="note">{tr('Pembacaan struk dengan AI belum dikonfigurasi.')}</p>
				{:else if noKey}
					<p class="note">
						{tr('Struk dibaca AI dengan kunci Anthropic-mu sendiri.')}
						<a href="/pengaturan/integrasi"
							>{tr('Tambahkan kunci Anthropic di Pengaturan › Integrasi')}</a
						>
					</p>
				{/if}
				<div class="field">
					<PhotoPicker
						id="{uid}-photo"
						name="photo"
						label={tr('Pilih atau ambil foto struk')}
						describedby="{uid}-photo-hint"
						{onpick}
					/>
					<p id="{uid}-photo-hint" class="meta">
						{tr(
							'Satu foto per struk, JPEG, PNG atau WebP. Lokasi dan data kamera dihapus sebelum dikirim.'
						)}
					</p>
				</div>
				{#if preview}
					<img class="preview" src={preview} alt={tr('Pratinjau foto struk')} />
				{/if}
				{#if preparing}
					<p class="meta" role="status">{tr('Menyiapkan foto…')}</p>
				{/if}
				{#if readFailed && !('noKey' in readFailed && readFailed.noKey)}
					<p class="error" role="alert">{tr(readFailed.error ?? '')}</p>
				{/if}
				{#if progress}
					<p class="progress" role="status">
						{progress === 'upload' ? tr('Mengunggah…') : tr('Membaca strukmu…')}
					</p>
				{/if}
				{#if canRead}
					<p class="meta">
						{tr(
							'Foto dikirim ke Anthropic lewat AI Gateway Montra dan dibaca dengan kuncimu sendiri. Montra hanya menyimpannya bila kamu memilih menyimpan foto sebagai bukti.'
						)}
					</p>
					<Button type="submit" size="lg" full disabled={preparing || progress !== ''}>
						{readFailed ? tr('Baca lagi') : tr('Baca struk')}
					</Button>
				{:else if data.configured}
					<Button href="/pengaturan/integrasi" size="lg" full
						>{tr('Tambahkan kunci Anthropic di Pengaturan › Integrasi')}</Button
					>
				{/if}
				<Button
					href="/riwayat/baru"
					variant="secondary"
					size="lg"
					full
					onclick={(event) => {
						event.preventDefault();
						void attachOnly();
					}}>{tr('Lampirkan fotonya saja')}</Button
				>
			</form>
		{/if}
		<a class="cancel" href="/riwayat">{tr('Batal')}</a>
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: 16px;
		max-width: 560px;
		margin-top: 8px;
	}
	.picker,
	.done {
		display: grid;
		gap: 14px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
	}
	h2:focus,
	span[tabindex='-1']:focus {
		outline: none;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.preview {
		max-width: 100%;
		max-height: 320px;
		justify-self: start;
		border-radius: var(--r-s);
		object-fit: contain;
		background: var(--panel);
	}
	.note {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		font-size: 15px;
	}
	.note a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.progress {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 15px;
		color: var(--money-up);
	}
	.ways {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		justify-self: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
