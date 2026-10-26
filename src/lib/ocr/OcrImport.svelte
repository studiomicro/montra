<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { imageRunAssets, pdfRunAssets, type OcrAsset } from '#lib/shared/ocr/assets';
	import { pageUnclear } from '#lib/shared/ocr/confidence';
	import { formatDayLabel } from '#lib/shared/dates';
	import {
		checkOcrBatch,
		checkOcrFile,
		heicMetaBox,
		OCR_MAX_IMAGES,
		OCR_MAX_PDF_PAGES,
		sniffOcrFile,
		type OcrInput,
		type OcrInputRefusal
	} from '#lib/shared/ocr/image-kind';
	import type { OcrDocument } from '#lib/shared/ocr/lines';
	import { formatMoney } from '#lib/shared/money-format';
	import type { RowReview } from '#lib/shared/csv';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import PickerSheet from '#lib/ui/kit/PickerSheet.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import PickerField from '#lib/ui/impor/PickerField.svelte';
	import { downloadAssets, OcrDownloadError, totalBytes } from './download';
	import { coreVariant, ocrSupported } from './support';
	import type { PageCanvas } from './image';

	/**
	 * "Baca dari foto atau tangkapan layar" (FN-16g): a statement photo, scan or app screenshot is read on this
	 * device (Tesseract in a Web Worker; nothing of the image leaves it), the recognised words go to the server,
	 * which builds the rows itself, and the user reviews them before anything is imported. The camera and
	 * gallery picks are this block's own (a shared photo picker from FN-45 may replace them later).
	 */
	let {
		walletId,
		institutions
	}: {
		/** The page's shared wallet choice (picked above the format switch, FN-16i). */
		walletId: string;
		institutions: { id: string; label: string }[];
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	type Summary = {
		kind: 'statement' | 'screenshot';
		institution: { id: string; label: string };
		pages: number;
		balance: { status: 'pass' } | { status: 'gap'; gapMinor: number } | { status: 'omitted' };
		unclearPages: number;
		notCompleted: number;
		section: Section | null;
		sections: Section[];
	};
	type Section = {
		index: number;
		label: string;
		accountLast4: string | null;
		rows: number;
		importable: boolean;
	};
	type Row = {
		index: number;
		date: string;
		type: 'expense' | 'income';
		title: string;
		amountMinor: number;
		review: RowReview | null;
		included: boolean;
	};
	type Counts = {
		imported: number;
		skipped: number;
		already: number;
		possibleDuplicates: number;
		notProcessed: number;
	};

	type Phase =
		| { name: 'idle' }
		| { name: 'unsupported' }
		| { name: 'confirm_download' }
		| { name: 'downloading'; done: number; total: number }
		| { name: 'download_failed'; reason: 'not_installed' | 'failed' }
		| { name: 'reading'; page: number; pages: number }
		| { name: 'password' }
		| { name: 'previewing' }
		| { name: 'review' }
		| { name: 'importing' }
		| { name: 'imported'; counts: Counts }
		| {
				name: 'refused';
				error: string;
				counts: { pages: number; rows: number; gapMinor: number | null } | null;
		  };

	let hydrated = $state(false);
	let supported = $state(true);
	let cameraAvailable = $state(true);
	let phase = $state<Phase>({ name: 'idle' });
	/** One-line notes next to the phase: camera unavailable, input refused, cancelled, failed request. */
	let note = $state('');
	let announce = $state('');
	let galleryInput: HTMLInputElement | undefined = $state();
	let cameraInput: HTMLInputElement | undefined = $state();
	let galleryButton: HTMLButtonElement | undefined = $state();
	let resultHeading: HTMLElement | undefined = $state();
	let dragging = $state(false);

	// The run's material, in memory only.
	let pending: File[] = [];
	let pdfPassword = $state('');
	let doc = $state.raw<OcrDocument | null>(null);
	let pagesNotProcessed = $state(0);
	let unclear = $state(0);
	let controller: AbortController | null = null;

	// The reading the server sent back and the user's ticks.
	let summary = $state<Summary | null>(null);
	let rows = $state<Row[]>([]);
	let picked = $state<Record<number, boolean>>({});
	let duplicates = $state<Set<number>>(new Set());
	let totals = $state({ incomeMinor: 0, expenseMinor: 0 });
	let counts = $state<Counts | null>(null);
	let sections = $state<Section[]>([]);
	let section = $state<number | null>(null);
	let institution = $state('');
	let institutionPicker = $state(false);
	let needsInstitution = $state(false);
	let skipDuplicates = $state(true);
	let previewedKey = $state('');

	onMount(() => {
		hydrated = true;
		supported = ocrSupported();
		if (!supported) phase = { name: 'unsupported' };
		const devices = navigator.mediaDevices?.enumerateDevices?.();
		devices
			?.then((list) => (cameraAvailable = list.some((d) => d.kind === 'videoinput')))
			.catch(() => {});
		return () => controller?.abort();
	});

	const say = (text: string) => {
		announce = text;
	};
	const mb = (bytes: number) =>
		new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'id-ID', { maximumFractionDigits: 1 }).format(
			bytes / 1_000_000
		);

	const refusalText = (r: OcrInputRefusal) =>
		r === 'unsupported'
			? tr('Berkas ini bukan foto (JPG, PNG, WebP, HEIC) atau PDF.')
			: r === 'too_large'
				? tr('Berkas lebih dari 15 MB.')
				: r === 'too_many'
					? tr('Pilih paling banyak 5 gambar, atau satu PDF saja.')
					: r === 'too_many_pixels'
						? tr('Foto terlalu besar untuk dibaca di perangkat (lebih dari 64 megapiksel).')
						: r === 'too_big_to_decode'
							? tr(
									'Gambar PNG, WebP atau HEIC ini terlalu besar untuk dibaca di perangkat (lebih dari 24 megapiksel). Simpan sebagai JPG atau kecilkan, lalu coba lagi.'
								)
							: tr('Gambar rusak atau tidak lengkap.');

	function reset() {
		controller?.abort();
		controller = null;
		doc = null;
		summary = null;
		rows = [];
		picked = {};
		duplicates = new Set();
		counts = null;
		sections = [];
		section = null;
		needsInstitution = false;
		pagesNotProcessed = 0;
		unclear = 0;
		previewedKey = '';
		note = '';
	}

	function openCamera() {
		if (!cameraAvailable) {
			note = tr('Kamera tidak tersedia. Pilih foto dari galeri atau berkas.');
			say(note);
			galleryButton?.focus();
			return;
		}
		cameraInput?.click();
	}

	async function onFiles(list: FileList | null | undefined) {
		const files = [...(list ?? [])];
		if (galleryInput) galleryInput.value = '';
		if (cameraInput) cameraInput.value = '';
		// A cancelled chooser or camera is not an error.
		if (files.length === 0) return;
		reset();
		if (!supported) return;
		if (files.length > OCR_MAX_IMAGES) {
			note = refusalText('too_many');
			say(note);
			return;
		}
		pending = files;
		pdfPassword = '';
		const saveData =
			(navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
		if (saveData) {
			phase = { name: 'confirm_download' };
			say(tr('Koneksi hemat data aktif. Unduh mesin baca sekarang?'));
			return;
		}
		await run();
	}

	/** Checks the picks, downloads the engine, reads every page, then asks the server for the rows. */
	async function run() {
		const files = pending;
		const checked: { file: File; head: Uint8Array; input: OcrInput }[] = [];
		for (const file of files) {
			const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
			const meta =
				sniffOcrFile(head) === 'heic'
					? await heicMetaBox(
							async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
							file.size
						)
					: null;
			const result = checkOcrFile(head, file.size, meta);
			if ('refusal' in result) {
				phase = { name: 'idle' };
				note = refusalText(result.refusal);
				say(note);
				return;
			}
			checked.push({ file, head, input: result });
		}
		const batch = checkOcrBatch(checked.map((c) => c.input.kind));
		if (batch) {
			phase = { name: 'idle' };
			note = refusalText(batch);
			say(note);
			return;
		}
		const isPdf = checked[0]!.input.kind === 'pdf';
		const core = coreVariant();
		const assets: OcrAsset[] = [...imageRunAssets(core), ...(isPdf ? pdfRunAssets() : [])];
		controller = new AbortController();
		const signal = controller.signal;
		phase = { name: 'downloading', done: 0, total: totalBytes(assets) };
		say(
			trf('Mengunduh mesin baca (sekitar {size} MB, sekali saja)', { size: mb(totalBytes(assets)) })
		);
		try {
			await downloadAssets(assets, {
				signal,
				onProgress: (done, total) => {
					if (phase.name === 'downloading') phase = { name: 'downloading', done, total };
				}
			});
		} catch (e) {
			if (signal.aborted) return cancelled();
			const reason = e instanceof OcrDownloadError ? e.reason : 'failed';
			phase = { name: 'download_failed', reason };
			say(
				reason === 'not_installed'
					? tr('Mesin baca belum terpasang di server ini.')
					: tr('Gagal mengunduh mesin baca. Periksa sambungan lalu coba lagi.')
			);
			return;
		}

		const [{ startEngine }, { imagePage }, { runOcr, OcrRunStopped }] = await Promise.all([
			import('./engine'),
			import('./image'),
			import('./pipeline')
		]);
		let pages: (() => Promise<PageCanvas>)[];
		let closePdf: (() => Promise<void>) | null = null;
		if (isPdf) {
			const { openPdf } = await import('./pdf');
			const bytes = new Uint8Array(await checked[0]!.file.arrayBuffer());
			const opened = await openPdf(bytes, pdfPassword || null);
			if (!opened.ok) {
				if (opened.refusal === 'password_needed' || opened.refusal === 'password_wrong') {
					phase = { name: 'password' };
					note =
						opened.refusal === 'password_wrong'
							? tr('Sandi PDF salah. Periksa lalu coba lagi.')
							: tr(
									'PDF ini dikunci sandi. Isi sandi PDF lalu baca lagi. Sandi hanya dipakai di perangkat ini.'
								);
				} else {
					phase = { name: 'idle' };
					note =
						opened.refusal === 'has_text'
							? tr(
									'PDF ini berisi teks, jadi tidak perlu dibaca dari gambar. Impor lewat bagian "Impor mutasi (PDF/CSV)".'
								)
							: tr('PDF rusak atau tidak lengkap. Unduh ulang mutasi dari bank lalu coba lagi.');
				}
				say(note);
				return;
			}
			const pdf = opened.pdf;
			pagesNotProcessed = pdf.pagesNotProcessed;
			closePdf = () => pdf.close();
			pages = Array.from({ length: pdf.pages }, (_, i) => () => pdf.render(i + 1));
		} else pages = checked.map((c) => () => imagePage(c.file, c.head, c.input));

		phase = { name: 'reading', page: 1, pages: pages.length };
		try {
			doc = await runOcr(pages, () => startEngine(core), {
				signal,
				onPage: (page, total) => {
					phase = { name: 'reading', page, pages: total };
					say(
						trf('Membaca halaman {page} dari {pages} ({percent}%)', {
							page,
							pages: total,
							percent: Math.round((page / total) * 100)
						})
					);
				}
			});
		} catch (e) {
			if (signal.aborted) return cancelled();
			phase = { name: 'idle' };
			note =
				e instanceof OcrRunStopped && e.reason !== 'cancelled'
					? tr(
							'Membaca terlalu lama dan dihentikan. Coba gambar yang lebih kecil atau lebih sedikit halaman.'
						)
					: tr('Gambar tidak bisa dibaca di perangkat ini. Coba foto lain atau unggah PDF/CSV.');
			say(note);
			return;
		} finally {
			await closePdf?.().catch(() => {});
			controller = null;
		}
		unclear = doc.pages.filter(pageUnclear).length;
		await preview();
	}

	function cancelled() {
		reset();
		phase = { name: 'idle' };
		note = tr('Dibatalkan. Tidak ada yang dikirim.');
		say(note);
	}

	function cancel() {
		controller?.abort();
	}

	/** The choices a preview was made with: an import with other choices needs a fresh preview first. */
	const choiceKey = $derived(
		JSON.stringify([
			walletId,
			institution,
			section,
			skipDuplicates,
			rows.map((r) => picked[r.index] ?? r.included)
		])
	);
	const stale = $derived(phase.name === 'review' && choiceKey !== previewedKey);

	function form(): FormData {
		const body = new FormData();
		// Words and integer positions only: the line text is rebuilt by the server anyway.
		const wire = {
			pages: doc!.pages.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l, text: '' })) }))
		};
		body.set('ocr', JSON.stringify(wire));
		body.set('institution', institution);
		if (walletId) body.set('defaultWalletId', walletId);
		if (skipDuplicates) body.set('skipPossibleDuplicates', 'on');
		if (section !== null) body.set('statementSection', String(section));
		const include = rows.filter((r) => r.review && picked[r.index]).map((r) => r.index);
		const exclude = rows.filter((r) => !r.review && picked[r.index] === false).map((r) => r.index);
		body.set('include', JSON.stringify(include));
		body.set('exclude', JSON.stringify(exclude));
		return body;
	}

	async function post(action: 'previewOcr' | 'importOcr') {
		const response = await fetch(`/impor?/${action}`, {
			method: 'POST',
			body: form(),
			headers: { 'x-sveltekit-action': 'true', accept: 'application/json' }
		});
		return deserialize(await response.text());
	}

	function refusal(data: Record<string, unknown> | undefined) {
		const error =
			typeof data?.error === 'string' ? tr(data.error) : tr('Tidak bisa membaca. Coba lagi.');
		needsInstitution = data?.needsInstitution === true;
		if (Array.isArray(data?.sections)) sections = data.sections as Section[];
		phase = {
			name: 'refused',
			error,
			counts:
				(data?.counts as { pages: number; rows: number; gapMinor: number | null } | null) ?? null
		};
		say(error);
	}

	async function preview() {
		if (!doc) return;
		phase = { name: 'previewing' };
		note = '';
		let result;
		try {
			result = await post('previewOcr');
		} catch {
			phase = {
				name: 'refused',
				error: tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.'),
				counts: null
			};
			return;
		}
		if (result.type !== 'success')
			return refusal(result.type === 'failure' ? result.data : undefined);
		const data = result.data as {
			ocr: Summary;
			rows: Row[];
			duplicates: { line: number }[];
			totals: { incomeMinor: number; expenseMinor: number };
			counts: Counts;
		};
		summary = data.ocr;
		sections = data.ocr.sections;
		const keep = picked;
		rows = data.rows;
		picked = Object.fromEntries(data.rows.map((r) => [r.index, keep[r.index] ?? r.included]));
		duplicates = new Set(data.duplicates.map((d) => d.line - 1));
		totals = data.totals;
		counts = data.counts;
		phase = { name: 'review' };
		previewedKey = choiceKey;
		const review = data.rows.filter((r) => r.review).length;
		say(
			trf('{n} transaksi terbaca, {review} perlu ditinjau, {skipped} halaman dilewati', {
				n: data.rows.length,
				review,
				skipped: pagesNotProcessed
			})
		);
	}

	let submitting = false;
	async function importRows() {
		if (submitting || !doc) return;
		if (stale) return preview();
		submitting = true;
		phase = { name: 'importing' };
		try {
			const result = await post('importOcr');
			if (result.type !== 'success')
				return refusal(result.type === 'failure' ? result.data : undefined);
			const data = result.data as { counts: Counts };
			phase = { name: 'imported', counts: data.counts };
			doc = null;
			say(
				trf('Diimpor {imported} · Dilewati {skipped} · Sudah pernah diimpor {already}', data.counts)
			);
			await invalidateAll();
			await tick();
			resultHeading?.focus();
		} catch {
			phase = {
				name: 'refused',
				error: tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.'),
				counts: null
			};
		} finally {
			submitting = false;
		}
	}

	const reviewText = (r: RowReview) =>
		r === 'low_confidence'
			? tr('Angka kurang jelas terbaca')
			: r === 'no_balance_check'
				? tr('Saldo tidak tercetak, tidak bisa dicek')
				: r === 'direction_unknown'
					? tr('Tanda masuk/keluar tidak terbaca, dianggap pengeluaran')
					: r === 'year_assumed'
						? tr('Tahun tidak tercetak, dianggap tahun ini')
						: r === 'relative_date'
							? tr('Tanggal dari "Hari ini"/"Kemarin"')
							: r === 'balance_mismatch'
								? tr('Jumlah tidak cocok dengan saldo')
								: r === 'photo_unclear'
									? tr('Foto kurang jelas')
									: tr('Mungkin duplikat dari gambar sebelumnya');

	const readyRows = $derived(rows.filter((r) => !r.review));
	const reviewRows = $derived(rows.filter((r) => r.review));
	const chosen = $derived(rows.filter((r) => picked[r.index]).length);
	const institutionOptions = $derived([
		{ value: '', label: tr('Deteksi otomatis'), hint: tr('Dikenali dari isi gambar') },
		...institutions.map((i) => ({ value: i.id, label: tr(i.label) }))
	]);
	const institutionLabel = $derived(
		institutionOptions.find((o) => o.value === institution)?.label ?? tr('Deteksi otomatis')
	);
	const busy = $derived(
		['downloading', 'reading', 'previewing', 'importing', 'confirm_download'].includes(phase.name)
	);
	const percent = $derived(
		phase.name === 'downloading' && phase.total > 0
			? Math.floor((phase.done / phase.total) * 100)
			: 0
	);
	const balanceText = (b: Summary['balance']) =>
		b.status === 'pass'
			? tr('Saldo cocok')
			: b.status === 'gap'
				? trf('Saldo tidak cocok, selisih {gap}. Mungkin ada baris yang hilang.', {
						gap: formatMoney(b.gapMinor, 'IDR', 'auto', locale)
					})
				: tr('Saldo tidak diperiksa (tidak tercetak).');
</script>

{#snippet rowItem(row: Row)}
	<li class="row">
		<label class="row-check">
			<input type="checkbox" bind:checked={picked[row.index]} />
			<span class="row-text">
				<span class="row-title">{row.title || tr('Tanpa judul')}</span>
				<span class="meta">
					{formatDayLabel(row.date, locale)}
					{#if row.review}· {reviewText(row.review)}{/if}
				</span>
			</span>
			<span class="row-side">
				<span class="num"
					>{formatMoney(
						row.type === 'income' ? row.amountMinor : -row.amountMinor,
						'IDR',
						'signed',
						locale
					)}</span
				>
				{#if duplicates.has(row.index)}<Badge>{tr('Mungkin duplikat')}</Badge>{/if}
			</span>
		</label>
	</li>
{/snippet}

<section class="panel" id="baca-foto" aria-labelledby="{uid}-title">
	<h3 id="{uid}-title">{tr('Baca dari foto atau tangkapan layar')}</h3>
	<p class="meta">
		{tr(
			'Foto mutasi kertas, PDF hasil pindai, atau tangkapan layar riwayat e-wallet dan m-banking. Gambar dibaca di perangkat ini dan tidak dikirim; hanya teks yang terbaca yang dikirim untuk diperiksa.'
		)}
	</p>
	<p class="sr-only" aria-live="polite" role="status">{announce}</p>

	{#if !hydrated}
		<p class="note">
			{tr('Membaca foto butuh JavaScript. Untuk sekarang, impor PDF atau CSV di atas.')}
		</p>
	{:else if phase.name === 'unsupported'}
		<p class="note" role="alert">
			{tr(
				'Peramban ini belum bisa membaca gambar di perangkat. Coba Chrome atau Safari terbaru, atau unggah PDF/CSV.'
			)}
		</p>
	{:else}
		<div class="pickers">
			<PickerField
				label={tr('Aplikasi atau bank')}
				value={institutionLabel}
				icon="file"
				ariaLabel={tr('Pilih aplikasi atau bank')}
				onclick={() => (institutionPicker = true)}
				disabled={busy}
			/>
		</div>

		<div
			class="capture"
			class:dragging
			role="group"
			aria-label={tr('Pilih gambar untuk dibaca')}
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={(event) => {
				event.preventDefault();
				dragging = false;
				if (!busy) void onFiles(event.dataTransfer?.files);
			}}
		>
			<button type="button" class="capture-btn" onclick={openCamera} disabled={busy}>
				<Icon name="camera" size={20} />
				{tr('Ambil foto')}
			</button>
			<button
				type="button"
				class="capture-btn secondary"
				bind:this={galleryButton}
				onclick={() => galleryInput?.click()}
				disabled={busy}
			>
				<Icon name="image" size={20} />
				{tr('Pilih dari galeri/berkas')}
			</button>
			<p class="meta center">
				{trf(
					'Paling banyak {images} gambar atau 1 PDF ({pages} halaman pertama), 15 MB per berkas.',
					{
						images: OCR_MAX_IMAGES,
						pages: OCR_MAX_PDF_PAGES
					}
				)}
			</p>
			<!-- Read on the device only: these inputs are never part of a form that posts to the server. The buttons
			     above open them; they are hidden from assistive tech so each action is announced once. -->
			<input
				bind:this={cameraInput}
				class="file"
				type="file"
				accept="image/*"
				capture="environment"
				tabindex="-1"
				aria-hidden="true"
				data-testid="ocr-camera"
				onchange={(event) => onFiles(event.currentTarget.files)}
			/>
			<input
				bind:this={galleryInput}
				class="file"
				type="file"
				accept="image/*,application/pdf"
				multiple
				tabindex="-1"
				aria-hidden="true"
				data-testid="ocr-gallery"
				onchange={(event) => onFiles(event.currentTarget.files)}
			/>
		</div>

		{#if note}<p class="note" role="status">{note}</p>{/if}

		<ol class="stepper" aria-label={tr('Langkah')}>
			<li class:on={phase.name === 'downloading' || phase.name === 'confirm_download'}>
				{tr('Unduh mesin')}
			</li>
			<li class:on={phase.name === 'reading'}>{tr('Baca')}</li>
			<li class:on={phase.name === 'review' || phase.name === 'previewing'}>{tr('Tinjau')}</li>
			<li class:on={phase.name === 'importing' || phase.name === 'imported'}>{tr('Masukkan')}</li>
		</ol>

		{#if phase.name === 'confirm_download'}
			<div class="status">
				<p>{tr('Koneksi hemat data aktif. Unduh mesin baca sekarang?')}</p>
				<div class="actions">
					<Button variant="secondary" onclick={() => (phase = { name: 'idle' })}
						>{tr('Batal')}</Button
					>
					<Button onclick={() => run()}>{tr('Unduh')}</Button>
				</div>
			</div>
		{:else if phase.name === 'downloading'}
			<div class="status" aria-busy="true">
				<p>
					{trf('Mengunduh mesin baca (sekitar {size} MB, sekali saja)', { size: mb(phase.total) })}
				</p>
				<progress max="100" value={percent} aria-label={tr('Unduhan mesin baca')}
					>{percent}%</progress
				>
				<p class="meta">
					{trf('{done} dari {total} MB ({percent}%)', {
						done: mb(phase.done),
						total: mb(phase.total),
						percent
					})}
				</p>
				<div class="actions">
					<Button variant="secondary" onclick={cancel}>{tr('Batal')}</Button>
				</div>
			</div>
		{:else if phase.name === 'download_failed'}
			<div class="status" role="alert">
				<p class="error">
					{phase.reason === 'not_installed'
						? tr('Mesin baca belum terpasang di server ini.')
						: tr('Gagal mengunduh mesin baca. Periksa sambungan lalu coba lagi.')}
				</p>
				{#if phase.reason === 'failed'}
					<div class="actions"><Button onclick={() => run()}>{tr('Coba lagi')}</Button></div>
				{/if}
			</div>
		{:else if phase.name === 'reading'}
			<div class="status" aria-busy="true">
				<p>
					{trf('Membaca halaman {page} dari {pages} ({percent}%)', {
						page: phase.page,
						pages: phase.pages,
						percent: Math.round((phase.page / phase.pages) * 100)
					})}
				</p>
				<progress max={phase.pages} value={phase.page - 1} aria-label={tr('Kemajuan membaca')}
				></progress>
				<div class="actions">
					<Button variant="secondary" onclick={cancel}>{tr('Batal')}</Button>
				</div>
			</div>
		{:else if phase.name === 'password'}
			<div class="status">
				<label class="field">
					<span class="picker-label">{tr('Sandi PDF')}</span>
					<input type="password" autocomplete="off" maxlength="128" bind:value={pdfPassword} />
				</label>
				<div class="actions">
					<Button onclick={() => run()} disabled={pdfPassword === ''}>{tr('Buka dan baca')}</Button>
				</div>
			</div>
		{:else if phase.name === 'previewing'}
			<p class="status" aria-busy="true">{tr('Memeriksa hasil bacaan…')}</p>
		{:else if phase.name === 'refused'}
			<div class="status" role="alert">
				<p class="error">{phase.error}</p>
				{#if phase.counts}
					<p class="meta">
						{trf('{pages} halaman, {rows} baris terbaca.', {
							pages: phase.counts.pages,
							rows: phase.counts.rows
						})}
						{#if phase.counts.gapMinor !== null}
							{trf('Selisih saldo {gap}.', {
								gap: formatMoney(phase.counts.gapMinor, 'IDR', 'auto', locale)
							})}
						{/if}
					</p>
				{/if}
				{#if sections.length > 1}
					<fieldset class="sections">
						<legend>{tr('Rekening dalam berkas ini')}</legend>
						{#each sections as choice (choice.index)}
							<label class="check">
								<input
									type="radio"
									name="{uid}-section"
									value={choice.index}
									disabled={!choice.importable}
									bind:group={section}
								/>
								<span
									>{choice.accountLast4
										? `${choice.label} ••${choice.accountLast4}`
										: choice.label}</span
								>
							</label>
						{/each}
					</fieldset>
				{/if}
				<div class="actions">
					<Button variant="secondary" onclick={openCamera}>{tr('Ambil ulang')}</Button>
					{#if needsInstitution}
						<Button variant="secondary" onclick={() => (institutionPicker = true)}
							>{tr('Pilih aplikasi atau bank')}</Button
						>
					{/if}
					{#if doc}<Button onclick={preview}>{tr('Periksa lagi')}</Button>{/if}
				</div>
			</div>
		{:else if (phase.name === 'review' || phase.name === 'importing') && summary}
			<div class="status">
				{#if unclear > 0}
					<p class="note" role="alert">
						{tr(
							'Foto kurang jelas. Coba lagi dengan cahaya cukup, kertas rata dan kamera lurus di atas kertas.'
						)}
					</p>
					<div class="actions">
						<Button variant="secondary" size="sm" onclick={openCamera}>{tr('Ambil ulang')}</Button>
					</div>
				{/if}
				<p class="summary">
					{trf('{institution} · {pages} halaman', {
						institution: tr(summary.institution.label),
						pages: summary.pages
					})}
					· {trf('{n} transaksi terbaca, {review} perlu ditinjau, {skipped} halaman dilewati', {
						n: rows.length,
						review: reviewRows.length,
						skipped: pagesNotProcessed
					})}
				</p>
				{#if pagesNotProcessed > 0}
					<p class="meta">
						{trf('{n} halaman tidak dibaca (batas 12 halaman per bacaan).', {
							n: pagesNotProcessed
						})}
					</p>
				{/if}
				{#if summary.notCompleted > 0}
					<p class="meta">
						{trf('{n} transaksi gagal, dibatalkan atau menunggu dilewati.', {
							n: summary.notCompleted
						})}
					</p>
				{/if}
				<p class="meta">
					{trf('Masuk {income} · Keluar {expense}', {
						income: formatMoney(totals.incomeMinor, 'IDR', 'auto', locale),
						expense: formatMoney(totals.expenseMinor, 'IDR', 'auto', locale)
					})}
					· {balanceText(summary.balance)}
					{#if counts && counts.possibleDuplicates > 0}· {trf('Mungkin duplikat: {n}', {
							n: counts.possibleDuplicates
						})}{/if}
					{#if counts && counts.already > 0}· {trf('Sudah pernah diimpor: {n}', {
							n: counts.already
						})}{/if}
				</p>

				{#if readyRows.length > 0}
					<h3>{tr('Siap dimasukkan')}</h3>
					<ul class="rows">
						{#each readyRows as row (row.index)}{@render rowItem(row)}{/each}
					</ul>
				{/if}
				{#if reviewRows.length > 0}
					<details class="review">
						<summary
							>{trf('Perlu ditinjau ({n}) — tidak dimasukkan kecuali dicentang', {
								n: reviewRows.length
							})}</summary
						>
						<ul class="rows">
							{#each reviewRows as row (row.index)}{@render rowItem(row)}{/each}
						</ul>
					</details>
				{/if}
				<Toggle bind:checked={skipDuplicates} label={tr('Lewati baris yang mungkin duplikat')} />
				<div class="actions">
					<Button
						variant="secondary"
						onclick={() => (reset(), (phase = { name: 'idle' }))}
						disabled={phase.name === 'importing'}
					>
						{tr('Batal')}
					</Button>
					<Button
						onclick={importRows}
						disabled={phase.name === 'importing' || (!stale && chosen === 0)}
					>
						{phase.name === 'importing'
							? tr('Mengimpor…')
							: stale
								? tr('Perbarui pratinjau')
								: trf('Masukkan {n} transaksi', { n: chosen })}
					</Button>
				</div>
			</div>
		{:else if phase.name === 'imported'}
			<div class="status ok" role="status">
				<h3 tabindex="-1" bind:this={resultHeading}>{tr('Hasil bacaan dimasukkan')}</h3>
				<p>
					{trf('Diimpor {imported} · Dilewati {skipped} · Sudah pernah diimpor {already}', {
						imported: phase.counts.imported,
						skipped: phase.counts.skipped,
						already: phase.counts.already
					})}
				</p>
				<p class="meta">{tr('Bisa diurungkan dari Riwayat impor di bawah.')}</p>
				<div class="actions">
					<Button href="/riwayat" variant="secondary">{tr('Lihat di Riwayat')}</Button>
				</div>
			</div>
		{/if}
	{/if}
</section>

<PickerSheet
	bind:open={institutionPicker}
	title={tr('Pilih aplikasi atau bank')}
	options={institutionOptions}
	value={institution}
	onselect={(v) => {
		institution = v;
		institutionPicker = false;
		if (doc && (phase.name === 'refused' || phase.name === 'review')) void preview();
	}}
/>

<style>
	/* One panel of the "Impor berkas" card on the page: no card of its own. */
	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	h3 {
		margin: 8px 0 0;
		font-size: 16px;
		font-weight: 700;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.center {
		text-align: center;
	}
	.note,
	.summary {
		margin: 0;
		font-size: 15px;
	}
	.error {
		margin: 0;
		color: var(--expense);
		font-weight: 600;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.pickers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}
	.capture {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		padding: 16px;
		border: 2px dashed var(--faint);
		border-radius: var(--r-group);
		background: var(--bg);
	}
	.capture.dragging {
		border-color: var(--ink);
	}
	.capture-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		min-height: 48px;
		padding: 0 16px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--action);
		color: var(--on-action);
		font: inherit;
		font-weight: 600;
		white-space: nowrap;
	}
	/* A panel pill on the --bg capture box (fills, not frames). */
	.capture-btn.secondary {
		background: var(--panel);
		color: var(--ink);
	}
	.capture-btn:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.capture-btn:disabled {
		opacity: 0.5;
	}
	.file {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* Two by two on a phone, one row from 560 px: a step and its number never split across lines. */
	.stepper {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 4px 12px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 13px;
		color: var(--muted);
		counter-reset: step;
	}
	.stepper li {
		counter-increment: step;
		white-space: nowrap;
	}
	@media (min-width: 560px) {
		.stepper {
			grid-template-columns: repeat(4, auto);
			justify-content: start;
			gap: 4px 20px;
		}
	}
	.stepper li::before {
		content: counter(step) '. ';
	}
	.stepper li.on {
		color: var(--ink);
		font-weight: 700;
	}
	.status {
		display: grid;
		gap: 8px;
		min-width: 0;
		margin: 0;
	}
	.status.ok h3 {
		margin: 0;
	}
	progress {
		width: 100%;
		height: 8px;
	}
	/* Secondary first, primary last; on a phone the buttons share the row. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.actions > :global(*) {
		flex: 1 1 140px;
	}
	@media (min-width: 560px) {
		.actions {
			justify-content: flex-end;
		}
		.actions > :global(*) {
			flex: 0 0 auto;
		}
	}
	.rows {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
		min-width: 0;
	}
	.row-check {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: 10px;
		min-height: 44px;
		padding: 8px 4px;
		border-bottom: 1px solid var(--faint);
	}
	.row-check input {
		width: 20px;
		height: 20px;
		margin-top: 2px;
		accent-color: var(--ink);
	}
	.row-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.row-title {
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	.row-side {
		display: grid;
		justify-items: end;
		gap: 4px;
		white-space: nowrap;
	}
	.num {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.review summary {
		min-height: 44px;
		display: flex;
		align-items: center;
		font-weight: 600;
		cursor: pointer;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
	}
	.check input {
		accent-color: var(--ink);
	}
	.sections {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field input {
		min-height: 44px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
	}
</style>
