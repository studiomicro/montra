<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { applyAction, enhance, type ActionResult, type SubmitFunction } from '$app/forms';
	import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { wibTodayString } from '#lib/shared/dates';
	import { QUEUE_FULL, type QueueSummary } from '#lib/shared/offline-queue';
	import { msg } from '#lib/shared/i18n';
	import { MERCHANT_REASON_LABELS, type MerchantReason } from '#lib/shared/merchants/resolve';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		CATEGORY_KIND_LABELS,
		CATEGORY_KINDS,
		TRANSACTION_TYPE_LABELS,
		categoryLabel
	} from '#lib/shared/transactions';
	import {
		highlightMoney,
		parseVoiceSentence,
		VOICE_BATCH_MAX,
		type VoiceDraftCandidate
	} from '#lib/shared/voice-parse';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import TextInput from '#lib/ui/kit/TextInput.svelte';
	import { formPayload, voiceSummary } from '#lib/ui/offline-queue/form-item';
	import { fetchSuggestions, type MerchantSuggestion } from '#lib/ui/transactions/merchant-suggest';
	import { browserOffline, enqueueOffline } from '#lib/ui/offline-queue/runtime.svelte';
	import { QUEUE_QUEUED_HERE } from '#lib/ui/offline-queue/view';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import {
		listen,
		shouldAutoStart,
		speechRecognitionCtor,
		type RecognitionFailure
	} from '#lib/ui/voice/recognition';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	/** One review row; `key` is generated once when the row is built (never the title or merchant text). */
	interface Row {
		key: string;
		type: string;
		amountMinor: number | null;
		title: string;
		categoryId: string;
		walletId: string;
		/** FN-20: why the category was chosen, while it is still the one `reasonFor` names (a chip). */
		reason?: MerchantReason;
		reasonFor?: string;
	}

	const newKey = () => crypto.randomUUID();
	const currencyOf = (walletId: string) =>
		data.wallets.find((w) => w.id === walletId)?.currency ?? 'IDR';

	function fromCandidate(c: VoiceDraftCandidate, resolved?: MerchantSuggestion): Row {
		const walletId =
			c.walletHint && data.wallets.some((w) => w.id === c.walletHint)
				? c.walletHint
				: data.defaultWalletId;
		const category = c.categoryHint
			? data.categories.find((k) => k.tileKey === c.categoryHint && k.kind === c.type)
			: undefined;
		const row: Row = {
			key: newKey(),
			type: c.type,
			amountMinor: c.amountMinor,
			title: c.title,
			categoryId: category?.id ?? '',
			walletId
		};
		if (resolved) applyResolution(row, resolved);
		return row;
	}

	/** FN-20: the resolver's cleaned merchant and category (one of this space's, of the row's kind). */
	function applyResolution(row: Row, r: MerchantSuggestion) {
		if (r.merchant) row.title = r.merchant;
		const category = r.categoryId
			? data.categories.find((k) => k.id === r.categoryId && k.kind === row.type)
			: undefined;
		if (category && r.reason !== 'none') {
			row.categoryId = category.id;
			row.reason = r.reason;
			row.reasonFor = category.id;
		}
	}

	/** Asks /riwayat/saran for the rows just read; a failure leaves them as the parser made them. */
	async function resolveRows(added: Row[]) {
		const keys = added.map((r) => r.key);
		const answers = await fetchSuggestions(
			added.map((r) => ({ title: r.title, type: r.type === 'income' ? 'income' : 'expense' }))
		);
		if (!answers) return;
		keys.forEach((k, i) => {
			const row = [...rows, ...queue].find((r) => r.key === k);
			const answer = answers[i];
			// Only rows the user has not touched since: same title, no category of their own.
			if (row && answer && row.title === added[i]?.title) applyResolution(row, answer);
		});
	}

	/** Zero amounts read: one row with the sentence as its title and an empty amount to type ("Ketik manual"). */
	const manualRow = (sentence: string): Row => ({
		key: newKey(),
		type: 'expense',
		amountMinor: null,
		title: Array.from(sentence).slice(0, 80).join(''),
		categoryId: '',
		walletId: data.defaultWalletId
	});

	/** What a no-JavaScript action returned (every action's fields, all optional). */
	interface ActionState {
		action?: string;
		candidates?: VoiceDraftCandidate[];
		resolved?: MerchantSuggestion[];
		sentence?: string;
		key?: string;
		remaining?: number;
		rows?: { type: string; amount: string; walletId: string; categoryId: string; title: string }[];
		rowErrors?: Partial<Record<string, string>>[];
		saved?: number;
		recorded?: { id: string; updatedAt: number };
		undone?: boolean;
		error?: string;
	}
	const posted = $derived((form ?? null) as ActionState | null);

	// No-JavaScript round trips (parse, a refused save) render their rows on the server; with JavaScript the
	// sentence is parsed here and the server only ever sees the reviewed rows.
	function initialRows(f: ActionState | null): { rows: Row[]; key: string; zero: boolean } {
		if (f?.action === 'parse' && f.candidates) {
			const rows = f.candidates.map((c, i) => fromCandidate(c, f.resolved?.[i]));
			const text = f.sentence ?? '';
			const zero = rows.length === 0 && text !== '';
			return { rows: zero ? [manualRow(text)] : rows, key: f.key ?? '', zero };
		}
		if (f?.action === 'save' && f.rows) {
			const rows = f.rows.map((v) => ({
				key: newKey(),
				type: v.type === 'income' ? 'income' : 'expense',
				amountMinor: typedAmountMinor(v.amount, currencyOf(v.walletId), locale),
				title: v.title,
				categoryId: v.categoryId,
				walletId: v.walletId
			}));
			return { rows, key: f.key ?? '', zero: false };
		}
		return { rows: [], key: '', zero: false };
	}

	const first = untrack(() => posted);
	const start0 = untrack(() => initialRows(first));
	let rows = $state<Row[]>(start0.rows);
	/** Rows past VOICE_BATCH_MAX, shown after the current ones are saved (owner decision B). */
	let queue = $state<Row[]>([]);
	let key = $state(start0.key);
	let zero = $state(start0.zero);
	let rowErrors = $state<Partial<Record<string, string>>[]>(first?.rowErrors ?? []);
	let savedCount = $state(first?.action === 'save' ? (first.saved ?? 0) : 0);
	const noJsRemaining = $derived(posted?.remaining ?? 0);
	let toast = $state<{ id: string; updatedAt: number } | null>(first?.recorded ?? null);
	let undone = $state(first?.undone === true);
	let actionError = $state('');
	let busy = $state<'' | 'save' | 'again' | 'undo'>('');
	let sentence = $state(first?.action === 'parse' ? (first.sentence ?? '') : '');
	let heard = $state(first?.action === 'parse' ? (first.sentence ?? '') : '');
	let refreshing = $state(false);

	// Speech: unknown until mounted (the server cannot know), then feature-detected.
	let speech = $state<'unknown' | 'unsupported' | 'ready'>('unknown');
	let recording = $state(false);
	let failure = $state<RecognitionFailure | null>(null);
	let lang = $state('id-ID');
	let session: { stop: () => void; abort: () => void } | null = null;
	let generation = 0;
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function ingest(text: string) {
		const candidates = parseVoiceSentence(text, { wallets: data.wallets });
		savedCount = 0;
		undone = false;
		actionError = '';
		heard = text;
		if (rows.length === 0 && queue.length === 0) key = newKey();
		const added =
			candidates.length > 0
				? candidates.map((c) => fromCandidate(c))
				: text.trim() !== ''
					? [manualRow(text.trim())]
					: [];
		zero = candidates.length === 0 && added.length > 0;
		const all = [...rows, ...queue, ...added];
		rows = all.slice(0, VOICE_BATCH_MAX);
		queue = all.slice(VOICE_BATCH_MAX);
		if (candidates.length > 0) void resolveRows(added);
	}

	function startRecording() {
		const Ctor = speechRecognitionCtor(window);
		if (!Ctor) return;
		session?.abort();
		const gen = ++generation;
		failure = null;
		heard = '';
		try {
			session = listen(Ctor, lang, {
				onText: (t) => {
					if (gen === generation) heard = t;
				},
				onFinal: (t) => {
					if (gen === generation) ingest(t);
				},
				onFailure: (f) => {
					if (gen === generation) failure = f;
				},
				onEnd: () => {
					if (gen !== generation) return;
					recording = false;
					session = null;
				}
			});
			recording = true;
		} catch {
			failure = 'failed';
			recording = false;
		}
	}

	function toggleRecording() {
		if (recording) session?.stop();
		else startRecording();
	}

	function onLangChange() {
		if (recording) startRecording();
	}

	onMount(() => {
		speech = speechRecognitionCtor(window) ? 'ready' : 'unsupported';
		return () => {
			generation++;
			session?.abort();
			clearTimeout(toastTimer);
		};
	});

	// The Tambah sheet and Beranda's Suara pill open `?mulai=1`: recording starts at once, but only after an
	// in-app navigation (red team L2) — a link from another site is a full page load and waits for a tap.
	afterNavigate(({ from, to }) => {
		const url = to?.url;
		if (!url?.searchParams.has('mulai')) return;
		const start = shouldAutoStart(from?.url ?? null, url);
		const clean = new URL(url);
		clean.searchParams.delete('mulai');
		replaceState(clean, {});
		if (start && speechRecognitionCtor(window)) startRecording();
	});

	const parseHere: SubmitFunction = ({ cancel, formData }) => {
		cancel();
		ingest(String(formData.get('sentence') ?? ''));
		sentence = '';
	};

	function removeRow(rowKey: string) {
		rows = rows.filter((r) => r.key !== rowKey);
		rowErrors = [];
		if (rows.length === 0) zero = false;
	}

	function onTypeChange(row: Row, next: string) {
		const chosen = data.categories.find((c) => c.id === row.categoryId);
		if (chosen && chosen.kind !== next) row.categoryId = '';
	}

	const NETWORK = msg('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');

	/** Shared result handling: a refusal shows its message; a redirect (signed out) is followed. */
	async function settle(result: ActionResult) {
		if (result.type === 'error') actionError = tr(NETWORK);
		else if (result.type === 'failure') {
			const message = result.data?.error;
			actionError = typeof message === 'string' ? tr(message) : tr(NETWORK);
		} else if (result.type === 'redirect') await applyAction(result);
	}

	/** A write of this page waits in the offline queue (FN-02): "Menunggu koneksi", never "tersimpan". */
	let queuedHere = $state(false);

	/**
	 * FN-02: offline, or no answer came back. The write is queued with the date it was made on (WIB) and its own
	 * dedupe key (`key`), so an attempt that did reach the server is never written twice. `ok` clears what the
	 * user was working on; anything else leaves it in place with the reason.
	 */
	async function queueVoice(
		kind: 'voice.save' | 'voice.recordAgain' | 'transaction.delete',
		formData: FormData,
		summary: QueueSummary,
		target?: { id: string; updatedAt: number }
	): Promise<boolean> {
		const spaceId = data.queue?.spaceId;
		const result = spaceId
			? await enqueueOffline({
					clientId: newKey(),
					spaceId,
					spaceName: data.queue?.spaceName ?? '',
					kind,
					payload: kind === 'transaction.delete' ? [] : formPayload(formData),
					locale,
					...(kind === 'transaction.delete'
						? { targetId: target?.id, expectedUpdatedAt: target?.updatedAt }
						: { occurredOn: wibTodayString() }),
					summary
				})
			: 'unavailable';
		if (result === 'queued') queuedHere = true;
		else actionError = tr(result === 'full' ? QUEUE_FULL : NETWORK);
		return result === 'queued';
	}

	/** The rows were queued: the review list moves on as after a save, without claiming they are saved. */
	function rowsQueued() {
		rows = queue.slice(0, VOICE_BATCH_MAX);
		queue = queue.slice(VOICE_BATCH_MAX);
		rowErrors = [];
		zero = false;
		heard = '';
		key = newKey();
	}

	/** No status: fetch failed or the answer was not the server's (offline, a proxy page). */
	const unanswered = (result: ActionResult) =>
		result.type === 'error' && result.status === undefined;

	/** Success only once the server confirmed every row; the list then clears (or shows the next batch). */
	const saveSubmit: SubmitFunction = ({ formData, cancel }) => {
		actionError = '';
		queuedHere = false;
		if (browserOffline()) {
			cancel();
			void queueVoice('voice.save', formData, voiceSummary(formData, data.wallets, locale)).then(
				(ok) => ok && rowsQueued()
			);
			return;
		}
		busy = 'save';
		return async ({ result }) => {
			try {
				if (unanswered(result)) {
					if (
						await queueVoice('voice.save', formData, voiceSummary(formData, data.wallets, locale))
					)
						rowsQueued();
				} else if (result.type === 'success' && typeof result.data?.saved === 'number') {
					savedCount = result.data.saved;
					rows = queue.slice(0, VOICE_BATCH_MAX);
					queue = queue.slice(VOICE_BATCH_MAX);
					rowErrors = [];
					zero = false;
					heard = '';
					key = newKey();
					await invalidateAll();
				} else {
					if (result.type === 'failure' && Array.isArray(result.data?.rowErrors))
						rowErrors = result.data.rowErrors as Partial<Record<string, string>>[];
					await settle(result);
				}
			} finally {
				busy = '';
			}
		};
	};

	function showToast(recorded: { id: string; updatedAt: number }) {
		toast = recorded;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 8000);
	}

	const againSubmit: SubmitFunction = ({ formData, cancel }) => {
		formData.set('key', newKey());
		actionError = '';
		queuedHere = false;
		undone = false;
		savedCount = 0;
		const f = data.frequent.find((x) => x.id === formData.get('id'));
		const summary: QueueSummary = {
			title: f?.title ?? '',
			amountMinor: f?.amountMinor ?? null,
			currency: f?.currency ?? 'IDR',
			count: 1
		};
		if (browserOffline()) {
			cancel();
			void queueVoice('voice.recordAgain', formData, summary);
			return;
		}
		busy = 'again';
		return async ({ result }) => {
			try {
				const recorded = result.type === 'success' ? result.data?.recorded : null;
				if (unanswered(result)) await queueVoice('voice.recordAgain', formData, summary);
				else if (recorded && typeof recorded === 'object') {
					showToast(recorded as { id: string; updatedAt: number });
					await invalidateAll();
				} else await settle(result);
			} finally {
				busy = '';
			}
		};
	};

	const undoSubmit: SubmitFunction = ({ formData, cancel }) => {
		actionError = '';
		queuedHere = false;
		const target = toast;
		const summary: QueueSummary = { title: '', amountMinor: null, currency: 'IDR', count: 1 };
		const queueUndo = async () => {
			clearTimeout(toastTimer);
			toast = null;
			await queueVoice('transaction.delete', formData, summary, target ?? undefined);
		};
		if (target && browserOffline()) {
			cancel();
			void queueUndo();
			return;
		}
		busy = 'undo';
		return async ({ result }) => {
			try {
				clearTimeout(toastTimer);
				toast = null;
				if (target && unanswered(result)) await queueUndo();
				else if (result.type === 'success') {
					undone = true;
					await invalidateAll();
				} else await settle(result);
			} finally {
				busy = '';
			}
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

	const serverError = $derived(posted?.error ? tr(posted.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const failureText: Record<RecognitionFailure, string> = {
		denied: msg('Izin mikrofon ditolak. Aktifkan di pengaturan browser.'),
		'no-speech': msg('Tidak ada suara yang terdengar. Coba lagi.'),
		failed: msg('Pengenalan suara berhenti. Coba lagi atau ketik kalimatnya.')
	};
	const typeOptions = $derived(
		(['expense', 'income'] as const).map((t) => ({
			value: t,
			label: tr(TRANSACTION_TYPE_LABELS[t])
		}))
	);
	const frequentLabel = (f: (typeof data.frequent)[number]) =>
		`${f.title ?? categoryLabel(f.category, tr)} · ${formatMoney(f.amountMinor, f.currency)}`;
</script>

<svelte:head><title>{tr('Suara')}</title></svelte:head>
<ScreenTitle back={{ href: '/riwayat', label: tr('Kembali ke Riwayat') }} title={tr('Suara')} />

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.wallets.length === 0}
	<EmptyState
		illustration="wallet"
		text={tr('Tambah dompet dulu supaya transaksi punya tempat.')}
		actionLabel={tr('Tambah dompet')}
		actionHref="/dompet?tambah=1"
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#if savedCount > 0}
			<p class="ok" role="status">
				{trf('{n} transaksi tersimpan.', { n: savedCount })}
				<a href="/riwayat">{tr('Lihat di Riwayat')}</a>
			</p>
		{/if}
		{#if undone}
			<p class="ok" role="status">{tr('Dibatalkan. Transaksinya sudah dihapus.')}</p>
		{/if}
		{#if queuedHere}
			<p class="ok" role="status">{tr(QUEUE_QUEUED_HERE)}</p>
		{/if}

		<section class="capture" aria-labelledby="say-title">
			<h2 id="say-title">{tr('Ucapkan transaksimu')}</h2>
			{#if speech === 'ready'}
				<div class="mic-row">
					<button
						type="button"
						class="mic"
						class:recording
						aria-pressed={recording}
						onclick={toggleRecording}
					>
						<Icon name="mic" size={28} />
						<span class="sr-only">{recording ? tr('Berhenti merekam') : tr('Mulai merekam')}</span>
					</button>
					<div class="mic-text">
						<p class="hint" aria-live="polite">
							{recording ? tr('Mendengarkan…') : tr('Ketuk mikrofon untuk mulai')}
						</p>
						<Segmented
							label={tr('Bahasa yang diucapkan')}
							bind:value={lang}
							onchange={onLangChange}
							options={[
								{ value: 'id-ID', label: 'ID' },
								{ value: 'en-US', label: 'EN' }
							]}
						/>
					</div>
				</div>
			{:else if speech === 'unsupported'}
				<p class="note">{tr('Pengenalan suara tidak tersedia di browser ini')}</p>
			{/if}
			{#if failure}
				<p class="warn" role="alert">{tr(failureText[failure])}</p>
			{/if}
			{#if heard}
				<p class="transcript" aria-live="polite">
					{#each highlightMoney(heard) as part, i (i)}{#if part.mark}<mark>{part.text}</mark
							>{:else}{part.text}{/if}{/each}
				</p>
			{/if}

			<p class="note">
				{tr(
					'Suara diubah menjadi teks oleh browser-mu; sebagian browser mengirim rekamannya ke server pembuat browser. Mengetik tidak mengirim apa pun.'
				)}
			</p>
			<form method="POST" action="?/parse" use:enhance={parseHere} class="typed">
				<TextInput
					label={tr('Atau ketik satu kalimat')}
					name="sentence"
					bind:value={sentence}
					autocomplete="off"
				/>
				<p class="example">{tr('Contoh: kopi 25rb dan parkir goceng')}</p>
				<Button type="submit" variant="secondary">{tr('Baca kalimat')}</Button>
			</form>
		</section>

		{#if data.frequent.length > 0}
			<section class="again" aria-labelledby="again-title">
				<h2 id="again-title">{tr('Catat lagi')}</h2>
				<ul>
					{#each data.frequent as f (f.id)}
						<li>
							<form method="POST" action="?/catatLagi" use:enhance={againSubmit}>
								<input type="hidden" name="id" value={f.id} />
								<input type="hidden" name="key" value={data.tapKey} />
								<button type="submit" class="again-chip" disabled={busy !== ''}>
									{frequentLabel(f)}
								</button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if rows.length > 0}
			<section class="review" aria-labelledby="review-title">
				<h2 id="review-title">{tr('Periksa sebelum menyimpan')}</h2>
				{#if zero}
					<p class="warn" role="alert">{tr('Tidak bisa membaca jumlahnya. Ketik manual.')}</p>
				{/if}
				{#if queue.length > 0}
					<p class="note">
						{trf('{n} transaksi lagi menunggu. Simpan yang ini dulu.', { n: queue.length })}
					</p>
				{:else if noJsRemaining > 0}
					<p class="note">
						{trf('{n} transaksi lagi tidak ikut. Simpan yang ini dulu, lalu ketik sisanya.', {
							n: noJsRemaining
						})}
					</p>
				{/if}
				<form method="POST" action="?/save" use:enhance={saveSubmit} class="rows" novalidate>
					<input type="hidden" name="key" value={key} />
					<input type="hidden" name="count" value={rows.length} />
					{#each rows as row, i (row.key)}
						{@const err = rowErrors[i] ?? {}}
						<fieldset class="row">
							<legend>{trf('Transaksi {n}', { n: i + 1 })}</legend>
							<Segmented
								name="type.{i}"
								label={tr('Jenis transaksi')}
								bind:value={row.type}
								onchange={(next) => onTypeChange(row, next)}
								options={typeOptions}
							/>
							{#if err.type}<p class="error">{tr(err.type)}</p>{/if}
							<div class="field">
								<AmountInput
									label={tr('Jumlah')}
									name="amount.{i}"
									bind:valueMinor={row.amountMinor}
									currency={currencyOf(row.walletId)}
								/>
								{#if err.amountMinor}<p class="error">{tr(err.amountMinor)}</p>{/if}
							</div>
							<TextInput
								label={tr('Judul')}
								name="title.{i}"
								bind:value={row.title}
								autocomplete="off"
							/>
							<label class="field">
								<span class="label">{tr('Kategori')}</span>
								<select
									name="categoryId.{i}"
									bind:value={row.categoryId}
									aria-invalid={err.categoryId ? 'true' : undefined}
								>
									<option value="">{tr('Tanpa kategori')}</option>
									{#each CATEGORY_KINDS as kind (kind)}
										<optgroup label={tr(CATEGORY_KIND_LABELS[kind])}>
											{#each data.categories.filter((c) => c.kind === kind) as c (c.id)}
												<option value={c.id}>{categoryLabel(c, tr)}</option>
											{/each}
										</optgroup>
									{/each}
								</select>
								{#if err.categoryId}<span class="error">{tr(err.categoryId)}</span>{/if}
								{#if row.reason && row.reasonFor === row.categoryId}
									<span class="reason">{tr(MERCHANT_REASON_LABELS[row.reason])}</span>
								{/if}
							</label>
							<label class="field">
								<span class="label">{tr('Dompet')}</span>
								<select
									name="walletId.{i}"
									bind:value={row.walletId}
									aria-invalid={err.walletId ? 'true' : undefined}
								>
									{#each data.wallets as w (w.id)}
										<option value={w.id}>{w.name} · {w.currency}</option>
									{/each}
								</select>
								{#if err.walletId}<span class="error">{tr(err.walletId)}</span>{/if}
							</label>
							<div class="row-foot">
								<span class="ai">
									<button
										type="button"
										class="ai-chip"
										disabled
										aria-describedby="ai-note-{row.key}"
									>
										<Icon name="sparkle" size={16} />{tr('Periksa dengan AI')}
									</button>
									<span class="ai-note" id="ai-note-{row.key}">{tr('Belum dikonfigurasi')}</span>
								</span>
								{#if speech !== 'unknown'}
									<button type="button" class="remove" onclick={() => removeRow(row.key)}>
										{tr('Hapus baris')}
									</button>
								{/if}
							</div>
						</fieldset>
					{/each}
					<Button type="submit" size="lg" full disabled={busy !== ''}>
						{busy === 'save' ? tr('Menyimpan…') : trf('Simpan {n} transaksi', { n: rows.length })}
					</Button>
				</form>
			</section>
		{/if}

		<a class="cancel" href="/riwayat">{tr('Batal')}</a>
	</div>

	{#if toast}
		<div class="toast" role="status">
			<!-- FN-44: the toast exists only once the server recorded the row (its id comes back); a new row hops anew. -->
			{#key toast.id}<Mascot pose="hop" size={40} />{/key}
			<span>{tr('Dicatat')}</span>
			<form method="POST" action="?/urungkan" use:enhance={undoSubmit}>
				<input type="hidden" name="id" value={toast.id} />
				<input type="hidden" name="updatedAt" value={toast.updatedAt} />
				<button type="submit" class="undo" disabled={busy !== ''}>{tr('Urungkan')}</button>
			</form>
		</div>
	{/if}
{/if}

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		margin-top: 8px;
		padding-bottom: 96px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	section {
		display: grid;
		gap: 12px;
		min-width: 0;
	}
	.mic-row {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.mic {
		display: grid;
		flex: none;
		place-items: center;
		width: 72px;
		height: 72px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		cursor: pointer;
	}
	.mic.recording {
		box-shadow: 0 0 0 6px var(--panel-2);
		animation: pulse 1.4s ease-in-out infinite;
	}
	.mic:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 3px;
	}
	@keyframes pulse {
		50% {
			box-shadow: 0 0 0 12px var(--panel);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.mic.recording {
			animation: none;
		}
	}
	.mic-text {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	.hint,
	.note,
	.example {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.warn {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-size: 15px;
	}
	.transcript {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		font-size: 17px;
		overflow-wrap: anywhere;
	}
	mark {
		padding: 0 2px;
		border-radius: var(--r-xs);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
	.typed {
		display: grid;
		gap: 8px;
		justify-items: start;
	}
	.typed > :global(label) {
		justify-self: stretch;
	}
	.again ul {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.again form {
		margin: 0;
	}
	.again-chip {
		min-height: 44px;
		max-width: 100%;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
		overflow-wrap: anywhere;
		cursor: pointer;
	}
	.again-chip:disabled,
	.undo:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.rows {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}
	.row {
		display: grid;
		gap: 14px;
		min-width: 0;
		margin: 0;
		padding: 16px;
		border: 0;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	/* Fields inside the panel row take the page colour so they stay visible (§ 3a fills, not frames). */
	.row :global(.input) {
		background: var(--bg);
	}
	legend {
		float: left;
		padding: 0;
		font-weight: 600;
	}
	.row > :global(.segmented) {
		clear: both;
		justify-self: start;
	}
	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
	}
	select {
		min-height: 48px;
		min-width: 0;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	select[aria-invalid='true'] {
		box-shadow: inset 0 0 0 1.5px var(--money-up);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
	.reason {
		font-size: 13px;
		color: var(--ink-2);
	}
	.row-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.ai {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.ai-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink-2);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		cursor: not-allowed;
	}
	.ai-note {
		font-size: 13px;
		color: var(--muted);
	}
	.remove,
	.undo {
		min-height: 44px;
		padding: 0 12px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
	}
	.ok {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.ok a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-left: 8px;
		color: var(--ink);
		font-weight: 600;
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
	/* The page's own title is the H1; this heading is a lead-in line, lighter than it. */
	.capture h2 {
		font-size: 15px;
		font-weight: 500;
		letter-spacing: 0;
		color: var(--muted);
	}
	.toast {
		position: fixed;
		left: 50%;
		bottom: calc(var(--tabbar-h) + 24px + var(--sai-bottom));
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 8px;
		max-width: calc(100% - 32px - var(--sai-left) - var(--sai-right));
		padding: 4px 8px 4px 10px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		box-shadow: var(--shadow-float);
		transform: translateX(-50%);
	}
	.toast form {
		margin: 0;
	}
	.toast .undo {
		color: var(--bg);
	}
</style>
