<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import {
		CSV_MAX_BYTES,
		readCsv,
		summarizeReading,
		type CsvFormat,
		type CsvSummary
	} from '#lib/shared/csv';
	import { matchBrand } from '#lib/shared/brands';
	import type { StatementAlternative } from '#lib/shared/statements/catalogue';
	import { formatDateTimeWib, formatDayLabel, formatShortDate } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import type { StatementHints } from '#lib/shared/statements/detect';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import { highlightedBatchId } from '#lib/ui/motion';
	import PickerSheet from '#lib/ui/kit/PickerSheet.svelte';
	import type { PickerOption } from '#lib/ui/kit/picker';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import OcrImport from '#lib/ocr/OcrImport.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import PickerField from '#lib/ui/impor/PickerField.svelte';
	import SpreadsheetImport from '#lib/ui/impor/SpreadsheetImport.svelte';
	import { sheetAnswer, sheetError } from '#lib/ui/impor/sheet-view';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	// Without JavaScript every control is shown and both buttons post the form; with it, the file is read on
	// the device for an instant summary and the server preview (duplicates) is requested right away.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	let format = $state<'' | CsvFormat>('');
	let reading = $state(false);
	let fileError = $state('');
	let summary = $state<CsvSummary | null>(null);
	let detected = $state<CsvFormat | null>(null);
	let notProcessed = $state(0);
	let fileText = $state('');
	let csvForm: HTMLFormElement | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();

	const formatOptions = $derived([
		{ value: '', label: tr('Otomatis') },
		{ value: 'template', label: tr('Template') },
		{ value: 'money_manager', label: 'Money Manager' }
	]);

	/** Requests the server preview by pressing the form's own "Pratinjau" submit button. */
	function previewCsv() {
		csvForm?.querySelector<HTMLButtonElement>('button[formaction="?/preview"]')?.click();
	}

	/**
	 * One card, one source at a time. The choice is a native radio group, so the CSS below shows the matching
	 * panel with or without JavaScript; the anchors other pages link to (#mutasi, #spreadsheet, #baca-foto, #csv)
	 * pick their source here.
	 */
	// A plain form post (no JavaScript) answers with a whole page: it opens on the source that was posted.
	const postedSource = $derived(
		form && 'section' in form && form.section === 'statement'
			? 'pdf'
			: sheetAnswer(form) || sheetError(form)
				? 'xlsx'
				: 'csv'
	);
	let pickedSource = $state<string | null>(null);
	const source = $derived(pickedSource ?? postedSource);
	const sourceOptions = $derived([
		{ value: 'csv', label: 'CSV' },
		{ value: 'xlsx', label: tr('Spreadsheet') },
		{ value: 'pdf', label: tr('Mutasi bank') },
		{ value: 'foto', label: tr('Foto') }
	]);
	const sourceByHash: Record<string, string> = {
		'#csv': 'csv',
		'#spreadsheet': 'xlsx',
		'#mutasi': 'pdf',
		'#baca-foto': 'foto'
	};
	$effect(() => {
		const hash = page.url.hash;
		const next = sourceByHash[hash];
		if (!next) return;
		pickedSource = next;
		void tick().then(() => document.getElementById(hash.slice(1))?.scrollIntoView());
	});

	/** The device's own reading (the same shared parser as the server); the server re-reads the file anyway. */
	function summarize() {
		if (!fileText) return;
		const read = readCsv(fileText, format || null);
		if (!read.ok) {
			summary = null;
			fileError =
				read.error === 'unterminated_quote'
					? tr('Berkas CSV rusak: ada tanda kutip yang tidak ditutup.')
					: read.error === 'too_many_columns'
						? tr('Berkas CSV punya lebih dari 50 kolom.')
						: read.error === 'format_mismatch'
							? tr('Kolom berkas tidak cocok dengan format yang dipilih.')
							: tr('Berkas CSV kosong.');
			return;
		}
		fileError = '';
		detected = read.reading.detected;
		notProcessed = read.reading.notProcessed;
		summary = format || detected ? summarizeReading(read.reading) : null;
	}

	async function onFile(event: Event & { currentTarget: HTMLInputElement }) {
		await readFile(event.currentTarget.files?.[0]);
	}

	/** A file dropped on the drop zone goes into the same file input, so the form posts it as if picked. */
	let dragging = $state(false);
	async function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const files = event.dataTransfer?.files;
		if (!files || files.length === 0 || !fileInput) return;
		fileInput.files = files;
		await readFile(files[0]);
	}

	async function readFile(file: File | undefined) {
		fileText = '';
		summary = null;
		detected = null;
		fileError = '';
		if (!file) return;
		if (file.size > CSV_MAX_BYTES) {
			fileError = tr('Berkas lebih dari 5 MB. Pisahkan menjadi beberapa berkas.');
			return;
		}
		reading = true;
		try {
			fileText = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
			summarize();
		} catch {
			fileError = tr(
				'Berkas tidak bisa dibaca sebagai teks UTF-8. Simpan ulang sebagai CSV UTF-8.'
			);
		} finally {
			reading = false;
		}
		if (!fileError && (format || detected)) previewCsv();
	}

	function onFormat(next: string) {
		format = next as '' | CsvFormat;
		summarize();
		if (fileText && !fileError && (format || detected)) previewCsv();
	}

	const needsFormat = $derived(
		(hydrated && fileText !== '' && !fileError && !format && !detected) ||
			(!!form && 'needsFormat' in form && form.needsFormat === true)
	);
	// With JavaScript the wallet and the template are chosen in PickerSheets (APP_PARITY § 3); their values post
	// through hidden fields. Without it the native select and radios post them. The wallet is picked once, above
	// the format switch, for whichever panel is shown (FN-16i); every panel's form posts the same choice.
	let walletId = $state('');
	$effect.pre(() => {
		if (!walletId || !data.wallets.some((w) => w.id === walletId))
			walletId = (data.wallets.find((w) => w.isFavourite) ?? data.wallets[0])?.id ?? '';
	});
	let walletPicker = $state(false);
	let formatPicker = $state(false);
	const walletOptions = $derived(
		data.wallets.map((w) => ({
			value: w.id,
			label: w.name,
			hint: w.isFavourite ? tr('Favorit') : undefined,
			// FN-43: the wallet's brand badge when its name names one ("Tunai" keeps the plain row).
			brand: matchBrand(w.name)?.id
		}))
	);
	// The CSV import uses it only for rows that name no wallet; the other formats put every row in it.
	const walletLabel = $derived(
		source === 'csv' ? tr('Dompet untuk baris tanpa dompet') : tr('Dompet tujuan')
	);
	const walletName = $derived(data.wallets.find((w) => w.id === walletId)?.name ?? '');
	const templateOptions = $derived([
		{ value: '', label: tr('Deteksi otomatis'), hint: tr('Dikenali dari judul kolom') },
		{
			value: 'template',
			label: tr('Template Montra'),
			hint: tr('Dari tombol Unduh template CSV')
		},
		{
			value: 'money_manager',
			label: 'Money Manager',
			hint: tr('Ekspor CSV aplikasi Money Manager')
		}
	]);
	const templateLabel = $derived(
		templateOptions.find((o) => o.value === format)?.label ?? tr('Deteksi otomatis')
	);

	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	const track: SubmitFunction = ({ action }) => {
		const name = action.search.includes('previewStatement')
			? 'statementPreview'
			: action.search.includes('importStatement')
				? 'statementImport'
				: action.search.includes('preview')
					? 'preview'
					: action.search.includes('undo')
						? 'undo'
						: action.search.includes('move')
							? 'move'
							: action.search.includes('closeGap')
								? 'closeGap'
								: 'import';
		busy = name;
		actionError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			} else {
				// The form is never reset (that would also clear the options); a confirmed import clears only the
				// chosen file, so the same file is not sent twice by accident. The list reloads from the server.
				await update({ reset: false });
				if (name === 'import' && result.type === 'success') {
					if (fileInput) fileInput.value = '';
					fileText = '';
					summary = null;
					detected = null;
				}
				if (name === 'statementPreview' || name === 'statementImport') sectionsStale = false;
				if (name === 'statementImport' && result.type === 'success') {
					if (statementInput) statementInput.value = '';
					statementFileName = '';
				}
			}
			busy = '';
		};
	};

	let exporting = $state(false);
	let exportError = $state('');
	/** With JavaScript the download runs through fetch, so the button shows progress; a refusal navigates. */
	async function onExport(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
		event.preventDefault();
		const params = new URLSearchParams(
			new FormData(event.currentTarget) as unknown as Record<string, string>
		);
		const url = `/impor/ekspor?${params.toString()}`;
		exporting = true;
		exportError = '';
		try {
			const response = await fetch(url);
			if (response.redirected || !response.ok) {
				await goto(response.redirected ? response.url : url);
				return;
			}
			const name =
				/filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
				'montra.csv';
			const href = URL.createObjectURL(await response.blob());
			const link = document.createElement('a');
			link.href = href;
			link.download = name;
			link.click();
			URL.revokeObjectURL(href);
		} catch {
			exportError = tr('Ekspor gagal. Periksa koneksi lalu coba lagi.');
		} finally {
			exporting = false;
		}
	}

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const loading = $derived(refreshing || navigating.to?.url.pathname === '/impor');

	type Counts = {
		imported: number;
		skipped: number;
		already: number;
		foreignCurrency: number;
		possibleDuplicates: number;
		notProcessed: number;
	};
	/** The server's counts as lines: an import's result, or what a preview would import. */
	function countLines(imported: boolean, c: Counts) {
		const lines = imported
			? [
					trf('Diimpor {imported} · Dilewati {skipped} · Sudah pernah diimpor {already}', {
						imported: c.imported,
						skipped: c.skipped,
						already: c.already
					})
				]
			: [
					trf('Siap diimpor {ready} · Dilewati {skipped} · Sudah pernah diimpor {already}', {
						ready: c.imported,
						skipped: c.skipped,
						already: c.already
					})
				];
		if (c.foreignCurrency > 0)
			lines.push(trf('Mata uang selain IDR dilewati: {n}', { n: c.foreignCurrency }));
		if (c.possibleDuplicates > 0)
			lines.push(trf('Mungkin duplikat: {n}', { n: c.possibleDuplicates }));
		if (c.notProcessed > 0)
			lines.push(
				trf(
					'{n} baris belum diproses (batas 5.000 baris per impor). Pisahkan berkas lalu impor sisanya.',
					{ n: c.notProcessed }
				)
			);
		return lines;
	}
	const resultLines = $derived(
		form &&
			'counts' in form &&
			form.counts &&
			(form.done === 'previewed' || form.done === 'imported')
			? countLines(form.done === 'imported', form.counts)
			: []
	);
	const duplicates = $derived(
		form && 'duplicates' in form && Array.isArray(form.duplicates) ? form.duplicates : []
	);
	const done = $derived.by(() => {
		if (!form || !('done' in form)) return '';
		if (form.done === 'undone')
			return form.transferKept
				? tr(
						'Impor diurungkan. Transfer hasil Cocokkan transfer yang kamu ubah tetap seperti yang kamu simpan; periksa di Riwayat.'
					)
				: tr('Impor diurungkan.');
		if (form.done === 'moved')
			return form.skipped > 0
				? trf(
						'{moved} transaksi dipindahkan ke {wallet}, {skipped} dilewati (transfer ke dompet yang sama).',
						{ moved: form.moved, skipped: form.skipped, wallet: form.walletName }
					)
				: trf('{n} transaksi dipindahkan ke {wallet}.', { n: form.moved, wallet: form.walletName });
		if (form.done === 'gapClosed')
			return tr('Penyesuaian saldo dicatat. Bisa dihapus kapan saja dari Riwayat.');
		if (form.done === 'already' && 'message' in form && form.message) return tr(form.message);
		return '';
	});
	const statementForm = $derived(
		form && 'section' in form && form.section === 'statement' ? form : null
	);
	// A statement refusal is shown in its own section, not in the page banner.
	const banner = $derived(
		actionError ||
			(form && !statementForm && 'error' in form && form.error ? tr(form.error) : '') ||
			undefined
	);

	// Statement import (FN-16a): read on the server only (no PDF reader is shipped to the phone).
	let statementInput: HTMLInputElement | undefined = $state();
	let statementFileName = $state('');
	let statementDragging = $state(false);
	let institution = $state('');
	let institutionPicker = $state(false);
	/** What to use today for a bank or e-wallet no statement reader handles yet (FN-16i). */
	const alternativeHint = (alternative: StatementAlternative) =>
		alternative === 'brimo_screenshot'
			? tr('pakai Foto (tangkapan layar BRImo) atau CSV/Spreadsheet')
			: alternative === 'app_screenshot'
				? tr('pakai Foto (tangkapan layar aplikasi)')
				: tr('belum didukung — pakai CSV atau Spreadsheet, atau nanti AI dengan kuncimu sendiri');
	// Every institution is named: the readable ones are choosable, the rest shown disabled with the way in today.
	const institutionOptions: PickerOption<string>[] = $derived([
		{ value: '', label: tr('Deteksi otomatis'), hint: tr('Dikenali dari isi berkas') },
		...data.statementCatalogue.map((row) => ({
			value: row.id,
			label: row.id === 'other' ? tr('Lainnya') : row.label,
			brand: row.brand ?? undefined,
			...(row.supported ? {} : { hint: alternativeHint(row.alternative), disabled: true })
		}))
	]);
	/** Without JavaScript only a readable institution can be posted: the disabled ones are left out. */
	const selectableInstitutions = $derived(institutionOptions.filter((o) => !o.disabled));
	const institutionLabel = $derived(
		selectableInstitutions.find((o) => o.value === institution)?.label ?? tr('Deteksi otomatis')
	);
	function onStatementDrop(event: DragEvent) {
		event.preventDefault();
		statementDragging = false;
		const files = event.dataTransfer?.files;
		if (!files || files.length === 0 || !statementInput) return;
		statementInput.files = files;
		statementFileName = files[0]?.name ?? '';
		sectionsStale = true;
	}
	const statementResult = $derived(
		statementForm &&
			'counts' in statementForm &&
			statementForm.counts &&
			'statement' in statementForm
			? {
					imported: statementForm.done === 'statementImported',
					lines: countLines(statementForm.done === 'statementImported', statementForm.counts),
					summary: statementForm.statement
				}
			: null
	);
	const statementDuplicates = $derived(
		statementForm && 'duplicates' in statementForm && Array.isArray(statementForm.duplicates)
			? statementForm.duplicates
			: []
	);
	const statementError = $derived(
		statementForm && 'error' in statementForm && statementForm.error ? tr(statementForm.error) : ''
	);
	const statementHints = $derived(
		statementForm && 'hints' in statementForm && statementForm.hints
			? (statementForm.hints as StatementHints)
			: null
	);
	const needsAi = $derived(
		!!statementForm && 'needsAi' in statementForm && statementForm.needsAi === true
	);
	// A statement holding several accounts (FN-16e): the server lists them; one is picked and imported at a time.
	type SectionChoice = {
		index: number;
		label: string;
		accountLast4: string | null;
		rows: number;
		importable: boolean;
	};
	/** The listed accounts belong to the file they were read from: choosing another file hides them. */
	let sectionsStale = $state(false);
	const statementSections = $derived.by((): SectionChoice[] => {
		if (!statementForm || sectionsStale) return [];
		if ('sections' in statementForm && Array.isArray(statementForm.sections))
			return statementForm.sections;
		if ('statement' in statementForm && statementForm.statement)
			return statementForm.statement.sections;
		return [];
	});
	const pickedSection = $derived(
		statementForm && 'statement' in statementForm && statementForm.statement?.section
			? statementForm.statement.section.index
			: null
	);
	const sectionLabel = (s: { label: string; accountLast4: string | null }) =>
		s.accountLast4 ? trf('{label} ••{last4}', { label: s.label, last4: s.accountLast4 }) : s.label;
	const readFormatLabel = (f: 'pdf_text' | 'csv') => (f === 'pdf_text' ? tr('PDF teks') : 'CSV');
	function balanceLine(
		b: { status: 'pass' } | { status: 'gap'; gapMinor: number } | { status: 'omitted' }
	) {
		if (b.status === 'pass') return tr('Saldo cocok');
		if (b.status === 'gap')
			return trf('Saldo tidak cocok, selisih {gap}. Mungkin ada baris yang hilang.', {
				gap: formatMoney(b.gapMinor, 'IDR')
			});
		return tr('Saldo awal atau akhir tidak tercetak, saldo tidak diperiksa.');
	}
	/** FN-48 Part B: whether the statement's Saldo Awal connects (nothing when no claim is made). */
	type ContinuityView =
		| { status: 'none' }
		| { status: 'overlap' }
		| { status: 'pass'; against: 'wallet' | 'statement' }
		| {
				status: 'gap';
				against: 'wallet' | 'statement';
				periodFrom: string;
				previousPeriodTo: string | null;
				openingMinor: number;
				expectedMinor: number;
				gapMinor: number;
				adjustOn: string;
		  };
	const money = (minor: number) => formatMoney(minor, 'IDR', 'auto', locale);
	function continuityLine(c: ContinuityView) {
		if (c.status === 'pass')
			return c.against === 'wallet'
				? tr('Saldo awal tersambung dengan saldo dompet sebelumnya.')
				: tr('Saldo awal tersambung dengan saldo akhir mutasi sebelumnya.');
		if (c.status === 'overlap')
			return tr(
				'Tanggal mutasi ini bertumpuk dengan mutasi lain di dompet yang sama, jadi saldonya tidak dibandingkan.'
			);
		if (c.status === 'gap') return gapLine(c);
		return '';
	}
	function gapLine(c: Extract<ContinuityView, { status: 'gap' }>) {
		const values = {
			opening: money(c.openingMinor),
			expected: money(c.expectedMinor),
			gap: formatMoney(c.gapMinor, 'IDR', 'signed', locale)
		};
		return c.against === 'statement' && c.previousPeriodTo
			? trf(
					'Saldo awal {opening} tidak menyambung dengan saldo akhir mutasi sampai {previous} ({expected}). Selisih {gap}.',
					{ ...values, previous: formatShortDate(c.previousPeriodTo, locale) }
				)
			: trf(
					'Saldo awal {opening} tidak sama dengan saldo dompet sebelum {date} ({expected}). Selisih {gap}.',
					{ ...values, date: formatShortDate(c.periodFrom, locale) }
				);
	}
	const uploadSub = tr('Berkas dibaca dulu, lalu hasilnya kamu periksa sebelum disimpan.');
	const formatLabel = (f: CsvFormat | null) =>
		f === 'money_manager' ? 'Money Manager' : f === 'template' ? tr('Template') : '';
</script>

{#snippet duplicateList(items: typeof duplicates)}
	<GroupList>
		{#each items as dup (dup.line)}
			<GroupRow>
				<span class="dup">
					<span class="dup-text">
						<span class="dup-title">{dup.title || tr('Tanpa judul')}</span>
						<span class="meta">
							{trf('Baris {n}', { n: dup.line })} · {formatDayLabel(dup.date, locale)}
						</span>
					</span>
					<span class="dup-side">
						<span class="num">{formatMoney(dup.amountMinor, 'IDR')}</span>
						<Badge>{tr('Mungkin duplikat')}</Badge>
					</span>
				</span>
			</GroupRow>
		{/each}
	</GroupList>
{/snippet}

<svelte:head><title>{tr('Impor')}</title></svelte:head>
<ScreenTitle title={tr('Impor')} subtitle={uploadSub}>
	{#snippet actions()}
		<Button variant="secondary" size="sm" icon="download" href="/impor/templat">
			{tr('Unduh template CSV')}
		</Button>
	{/snippet}
</ScreenTitle>

<FormBanner message={banner} />
{#if done}<p class="ok" role="status">{done}</p>{/if}

<div class="two-col">
	<div class="main-col">
		<section class="card import o-main" aria-labelledby="{uid}-import">
			<div class="card-head">
				<h2 id="{uid}-import">{tr('Impor berkas')}</h2>
				<p class="meta">{tr('Pilih dompet tujuan dulu, lalu berkasnya.')}</p>
			</div>
			{#if data.wallets.length === 0}
				<p class="meta">{tr('Belum ada dompet IDR. Baris tanpa dompet akan dilewati.')}</p>
			{:else if hydrated}
				<PickerField
					label={walletLabel}
					value={walletName}
					icon="wallet"
					onclick={() => (walletPicker = true)}
				/>
			{/if}
			<div class="source">
				<Segmented
					options={sourceOptions}
					value={source}
					onchange={(next) => (pickedSource = next)}
					label={tr('Jenis berkas')}
					name="source"
				/>
			</div>

			<div class="panel panel-csv" id="csv">
				<h3>{tr('Berkas CSV')}</h3>
				<p class="meta">
					{tr(
						'Template Montra atau ekspor Money Manager. Transfer dilewati; kategori dan dompet baru dibuat otomatis.'
					)}
				</p>
				<form
					bind:this={csvForm}
					method="POST"
					action="?/import"
					enctype="multipart/form-data"
					class="stack"
					use:enhance={track}
				>
					{#if hydrated}
						<input type="hidden" name="format" value={format} />
						{#if walletId}<input type="hidden" name="defaultWalletId" value={walletId} />{/if}
						<div class="pickers">
							<PickerField
								label={tr('Template berkas')}
								value={templateLabel}
								icon="file"
								onclick={() => (formatPicker = true)}
							/>
						</div>
					{/if}

					<label
						class="drop"
						class:dragging
						for="{uid}-file"
						ondragover={(event) => {
							event.preventDefault();
							dragging = true;
						}}
						ondragleave={() => (dragging = false)}
						ondrop={onDrop}
					>
						<span class="drop-icon" aria-hidden="true"><Icon name="upload" size={24} /></span>
						<span class="drop-title">{tr('Pilih berkas CSV')}</span>
						<span class="drop-text" id="{uid}-drop-text">
							{tr(
								'Tarik berkas ke sini atau pilih dari perangkat. Berkas dibaca lalu dibuang, tidak disimpan.'
							)}
						</span>
						<Badge>CSV</Badge>
						<input
							bind:this={fileInput}
							id="{uid}-file"
							class="file"
							aria-label={tr('Pilih berkas CSV')}
							aria-describedby="{uid}-drop-text"
							type="file"
							name="file"
							accept=".csv,text/csv"
							onchange={onFile}
						/>
						<span class="choose" aria-hidden="true">{tr('Pilih file')}</span>
					</label>
					<div class="ai">
						<Button variant="secondary" disabled describedby="{uid}-ai-why" icon="sparkle">
							{tr('Baca dengan AI')}
						</Button>
						<p class="meta" id="{uid}-ai-why">
							{tr('Pembacaan mutasi dengan AI belum dikonfigurasi. Untuk sekarang gunakan CSV.')}
						</p>
					</div>

					{#if reading}
						<div aria-busy="true"><Skeleton rows={1} /></div>
					{:else if fileError}
						<p class="error" role="alert">{fileError}</p>
					{:else if summary}
						<p class="summary" role="status">
							{trf('{rows} baris · format {format}', {
								rows: summary.rows,
								format: formatLabel(format || detected)
							})}
							· {trf('{n} siap', { n: summary.ready })}
							{#if summary.transfers > 0}· {trf('{n} transfer dilewati', {
									n: summary.transfers
								})}{/if}
							{#if summary.invalid > 0}· {trf('{n} tidak terbaca', { n: summary.invalid })}{/if}
							{#if summary.foreignCurrency > 0}
								· {trf('{n} bukan IDR', { n: summary.foreignCurrency })}
							{/if}
							{#if notProcessed > 0}
								· {trf('{n} baris lewat batas', { n: notProcessed })}
							{/if}
						</p>
					{/if}

					{#if needsFormat}
						<p class="error" role="alert">{tr('Format tidak terdeteksi, pilih manual')}</p>
					{/if}
					{#if !hydrated}
						<div class="field format">
							<span class="label">{tr('Format')}</span>
							<Segmented
								options={formatOptions}
								value={format}
								label={tr('Format')}
								name="format"
								onchange={onFormat}
							/>
						</div>
						<div class="field">
							<label for="{uid}-wallet">{tr('Dompet untuk baris tanpa dompet')}</label>
							{#if data.wallets.length > 0}
								<select id="{uid}-wallet" name="defaultWalletId">
									{#each data.wallets as wallet (wallet.id)}
										<option value={wallet.id} selected={wallet.isFavourite}>{wallet.name}</option>
									{/each}
								</select>
							{:else}
								<p class="meta">
									{tr('Belum ada dompet IDR. Baris tanpa dompet akan dilewati.')}
								</p>
							{/if}
						</div>
					{/if}
					<Toggle
						name="skipPossibleDuplicates"
						checked
						label={tr('Lewati baris yang mungkin duplikat')}
					/>

					{#if form && 'done' in form && form.done === 'previewed'}
						<div class="result" role="status">
							{#each resultLines as line, i (i)}<p>{line}</p>{/each}
						</div>
						{#if duplicates.length > 0}{@render duplicateList(duplicates)}{/if}
					{:else if form && 'done' in form && form.done === 'imported'}
						<div class="result ok" role="status">
							{#each resultLines as line, i (i)}<p>{line}</p>{/each}
						</div>
					{/if}

					<div class="actions">
						<Button type="submit" variant="secondary" formaction="?/preview" disabled={busy !== ''}>
							{busy === 'preview' ? tr('Memeriksa…') : tr('Pratinjau')}
						</Button>
						<Button type="submit" disabled={busy !== '' || reading || fileError !== ''}>
							{busy === 'import' ? tr('Mengimpor…') : tr('Impor')}
						</Button>
					</div>
				</form>
			</div>

			<div class="panel-wrap panel-xlsx">
				<SpreadsheetImport {form} wallets={data.wallets} {walletId} />
			</div>

			<div class="panel panel-pdf" id="mutasi">
				<h3>{tr('Impor mutasi (PDF/CSV)')}</h3>
				<p class="meta">
					{tr(
						'Mutasi rekening dari bank: PDF yang berisi teks, atau CSV. Dibaca di server lalu dibuang, tidak disimpan.'
					)}
				</p>
				{#if data.statementInstitutions.length === 0}
					<p class="note">
						{tr(
							'Belum ada format bank yang didukung. Format bank ditambahkan setelah diuji dengan contoh mutasi asli.'
						)}
					</p>
				{:else}
					<p class="meta">
						{trf('Didukung: {list}', {
							list: data.statementInstitutions.map((i) => i.label).join(', ')
						})}
					</p>
				{/if}
				<form
					method="POST"
					action="?/importStatement"
					enctype="multipart/form-data"
					class="stack"
					use:enhance={track}
				>
					{#if hydrated}
						<input type="hidden" name="institution" value={institution} />
						{#if walletId}<input type="hidden" name="defaultWalletId" value={walletId} />{/if}
						{#if data.statementInstitutions.length > 0}
							<div class="pickers">
								<PickerField
									label={tr('Pilih institusi')}
									ariaLabel={tr('Pilih institusi')}
									value={institutionLabel}
									icon="file"
									onclick={() => (institutionPicker = true)}
								/>
							</div>
						{/if}
					{/if}

					<label
						class="drop"
						class:dragging={statementDragging}
						for="{uid}-st-file"
						ondragover={(event) => {
							event.preventDefault();
							statementDragging = true;
						}}
						ondragleave={() => (statementDragging = false)}
						ondrop={onStatementDrop}
					>
						<span class="drop-icon" aria-hidden="true"><Icon name="upload" size={24} /></span>
						<span class="drop-title">{statementFileName || tr('Pilih berkas mutasi')}</span>
						<span class="drop-text" id="{uid}-st-drop-text">
							{tr('PDF atau CSV, paling besar 15 MB dan 200 halaman.')}
						</span>
						<span class="badges"><Badge>PDF</Badge><Badge>CSV</Badge></span>
						<input
							bind:this={statementInput}
							id="{uid}-st-file"
							class="file"
							aria-label={tr('Pilih berkas mutasi')}
							aria-describedby="{uid}-st-drop-text"
							type="file"
							name="file"
							accept=".pdf,.csv,.xls,.xlsx,application/pdf,text/csv"
							onchange={(event) => {
								statementFileName = event.currentTarget.files?.[0]?.name ?? '';
								sectionsStale = true;
							}}
						/>
						<span class="choose" aria-hidden="true">{tr('Pilih file')}</span>
					</label>

					<Field
						id="{uid}-pdf-password"
						name="pdfPassword"
						type="password"
						autocomplete="off"
						maxlength={128}
						label={tr('Sandi PDF (jika ada)')}
						hint={tr(
							'Dipakai sekali untuk membuka berkas ini, tidak disimpan. OCBC: tanggal lahirmu, mis. 05Jan1990.'
						)}
					/>

					{#if !hydrated}
						{#if data.statementInstitutions.length > 0}
							<div class="field">
								<label for="{uid}-inst">{tr('Pilih institusi')}</label>
								<select id="{uid}-inst" name="institution">
									{#each selectableInstitutions as option (option.value)}
										<option value={option.value}>{option.label}</option>
									{/each}
								</select>
							</div>
						{/if}
						<div class="field">
							<label for="{uid}-st-wallet">{tr('Dompet untuk mutasi')}</label>
							{#if data.wallets.length > 0}
								<select id="{uid}-st-wallet" name="defaultWalletId">
									{#each data.wallets as wallet (wallet.id)}
										<option value={wallet.id} selected={wallet.isFavourite}>{wallet.name}</option>
									{/each}
								</select>
							{:else}
								<p class="meta">
									{tr('Belum ada dompet IDR. Baris tanpa dompet akan dilewati.')}
								</p>
							{/if}
						</div>
					{/if}
					<Toggle
						name="skipPossibleDuplicates"
						checked
						label={tr('Lewati baris yang mungkin duplikat')}
					/>

					{#if statementSections.length > 1}
						<fieldset class="sections">
							<legend>{tr('Rekening dalam berkas ini')}</legend>
							{#each statementSections as choice (choice.index)}
								<label class="check">
									<input
										type="radio"
										name="statementSection"
										value={String(choice.index)}
										checked={pickedSection === choice.index}
										disabled={!choice.importable}
									/>
									<span>
										{sectionLabel(choice)}
										<span class="meta">
											· {choice.importable
												? trf('{n} transaksi', { n: choice.rows })
												: tr('tidak bisa diimpor')}
										</span>
									</span>
								</label>
							{/each}
						</fieldset>
					{/if}
					{#if statementError}
						<div class="error-block" role="alert">
							<p class="error">{statementError}</p>
							{#if statementHints}
								<p class="meta">
									{statementHints.format === 'pdf_text'
										? trf('Terbaca sebagai PDF teks, {pages} halaman.', {
												pages: statementHints.pages ?? 0
											})
										: trf('Terbaca sebagai CSV, {columns} kolom.', {
												columns: statementHints.columns ?? 0
											})}
								</p>
							{/if}
						</div>
					{/if}
					{#if statementResult}
						<div class="result" class:ok={statementResult.imported} role="status">
							<p>
								{trf('{institution} · {format}', {
									institution: statementResult.summary.institution.label,
									format: readFormatLabel(statementResult.summary.format)
								})}
							</p>
							{#if statementResult.summary.section}
								<p>
									{trf('Rekening: {account}', {
										account: sectionLabel(statementResult.summary.section)
									})}
								</p>
							{/if}
							{#each statementResult.lines as line, i (i)}<p>{line}</p>{/each}
							<p>{balanceLine(statementResult.summary.balance)}</p>
							{#if continuityLine(statementResult.summary.continuity)}
								<p>{continuityLine(statementResult.summary.continuity)}</p>
							{/if}
							{#if statementResult.summary.continuity.status === 'gap'}
								<p>
									{statementResult.imported
										? tr('Baris mutasi tetap diimpor. Catat selisihnya di Kesinambungan saldo.')
										: tr(
												'Impor tetap bisa dilanjutkan. Setelah impor, selisihnya bisa dicatat sebagai penyesuaian saldo.'
											)}
								</p>
							{/if}
							{#if statementResult.summary.pagesNotProcessed > 0}
								<p>
									{trf('{n} halaman tidak dibaca (batas 200 halaman per impor).', {
										n: statementResult.summary.pagesNotProcessed
									})}
								</p>
							{/if}
						</div>
						{#if !statementResult.imported && statementDuplicates.length > 0}
							{@render duplicateList(statementDuplicates)}
						{/if}
					{/if}

					<div class="actions">
						<Button
							type="submit"
							variant="secondary"
							formaction="?/previewStatement"
							disabled={busy !== ''}
						>
							{busy === 'statementPreview' ? tr('Membaca…') : tr('Pratinjau')}
						</Button>
						<Button type="submit" disabled={busy !== ''}>
							{busy === 'statementImport' ? tr('Mengimpor…') : tr('Impor')}
						</Button>
					</div>
				</form>
			</div>

			<div class="panel-wrap panel-foto">
				<OcrImport {walletId} institutions={data.ocrInstitutions} />
			</div>
		</section>

		{#if data.continuity.length > 0}
			<!-- FN-48 Part B: only when a statement's Saldo Awal does not connect (a true empty state otherwise). -->
			<section class="card o-continuity" id="kesinambungan" aria-labelledby="{uid}-continuity">
				<h2 id="{uid}-continuity">{tr('Kesinambungan saldo')}</h2>
				<p class="meta">
					{tr(
						'Saldo awal tiap mutasi harus sama dengan saldo akhir mutasi sebelumnya di dompet yang sama.'
					)}
				</p>
				<GroupList>
					{#each data.continuity as item (item.batchId)}
						<GroupRow>
							<span class="batch">
								<span class="batch-text">
									<span class="batch-title">
										{item.walletName}
										{#if item.status === 'gap'}<Badge>{tr('Ada selisih')}</Badge>{/if}
									</span>
									<span class="meta">
										{trf('Mutasi {from} – {to}', {
											from: formatShortDate(item.periodFrom, locale),
											to: formatShortDate(item.periodTo, locale)
										})}
									</span>
									<span class="meta num">{continuityLine(item)}</span>
								</span>
								{#if item.status === 'gap'}
									<details class="confirm">
										<summary>{tr('Catat selisihnya')}</summary>
										<form method="POST" action="?/closeGap" use:enhance={track}>
											<input type="hidden" name="id" value={item.batchId} />
											<input type="hidden" name="gap" value={String(item.gapMinor)} />
											<p>
												{trf(
													'Satu baris Penyesuaian saldo {gap} tanggal {date} akan ditambahkan ke {wallet}. Bisa dihapus kapan saja dari Riwayat.',
													{
														gap: formatMoney(item.gapMinor, 'IDR', 'signed', locale),
														date: formatShortDate(item.adjustOn, locale),
														wallet: item.walletName
													}
												)}
											</p>
											<Button type="submit" size="sm" disabled={busy !== ''}>
												{busy === 'closeGap' ? tr('Menyimpan…') : tr('Ya, catat penyesuaian')}
											</Button>
										</form>
									</details>
								{/if}
							</span>
						</GroupRow>
					{/each}
				</GroupList>
			</section>
		{/if}

		{#if data.cleanupCount > 0}
			<!-- FN-48: only when the space has rows still in a fallback category (a true empty state otherwise). -->
			<section class="card o-cleanup" aria-labelledby="{uid}-cleanup">
				<h2 id="{uid}-cleanup">{tr('Rapikan kategori')}</h2>
				<p class="meta">
					{trf('{n} transaksi impor masih di Lainnya atau Pemasukan Lain.', {
						n: data.cleanupCount
					})}
				</p>
				<div>
					<Button variant="secondary" size="sm" href="/impor/rapikan-kategori">
						{navigating.to?.url.pathname === '/impor/rapikan-kategori'
							? tr('Memuat…')
							: tr('Tinjau dan rapikan')}
					</Button>
				</div>
			</section>
		{/if}

		{#if data.transferMatchCount > 0}
			<!-- FN-48 Part C: only when the space has own-transfer pairs to confirm (a true empty state otherwise). -->
			<section class="card o-cleanup" aria-labelledby="{uid}-transfer-match">
				<h2 id="{uid}-transfer-match">{tr('Cocokkan transfer')}</h2>
				<p class="meta">
					{trf('{n} pasangan transfer antar dompetmu sendiri mungkin terbaca dua kali.', {
						n: data.transferMatchCount
					})}
				</p>
				<div>
					<Button variant="secondary" size="sm" href="/impor/cocokkan-transfer">
						{navigating.to?.url.pathname === '/impor/cocokkan-transfer'
							? tr('Memuat…')
							: tr('Tinjau dan cocokkan')}
					</Button>
				</div>
			</section>
		{/if}

		<section class="card o-history" aria-labelledby="{uid}-history">
			<h2 id="{uid}-history">{tr('Riwayat impor')}</h2>
			{#if loading}
				<div aria-busy="true"><Skeleton rows={3} /></div>
			{:else if data.loadError}
				<ErrorState text={tr(data.loadError)} onretry={retry} />
			{:else if data.batches.length === 0}
				<EmptyState illustration="history" text={tr('Belum ada impor.')} />
			{:else}
				<GroupList>
					{#each data.batches as batch (batch.id)}
						<!-- FN-51: only the batch the last action named replays its enter animation. -->
						<GroupRow highlight={batch.id === highlightedBatchId(form)}>
							<span class="batch">
								<span class="batch-text">
									<span class="batch-title">
										{batch.filename ||
											(batch.source === 'statement' ? tr('Berkas mutasi') : tr('Berkas CSV'))}
										{#if batch.undoneAt !== null}<Badge>{tr('Diurungkan')}</Badge>{/if}
									</span>
									<span class="meta">
										{formatDateTimeWib(batch.createdAt, locale)} · {batch.source === 'statement'
											? tr('Mutasi')
											: batch.source === 'spreadsheet'
												? tr('Spreadsheet')
												: formatLabel(batch.format)}
									</span>
									<span class="meta num">
										{trf(
											'Diimpor {imported} · Dilewati {skipped} · Sudah pernah diimpor {already}',
											{
												imported: batch.importedCount,
												skipped: batch.skippedCount,
												already: batch.alreadyImportedCount
											}
										)}
									</span>
								</span>
								{#if batch.undoneAt === null}
									{#if batch.moveBlocked === 'mixed_wallets'}
										<p class="meta move-note">
											{tr(
												'Transaksi di impor ini ada di lebih dari satu dompet — tidak bisa dipindahkan sekaligus.'
											)}
										</p>
									{:else if batch.moveBlocked === 'nothing_to_move'}
										<p class="meta move-note">
											{tr('Tidak ada transaksi aktif di impor ini untuk dipindahkan.')}
										</p>
									{:else if batch.moveBlocked === 'transfer_linked'}
										<p class="meta move-note">
											{tr(
												'Ada transfer dari impor ini yang sudah dicocokkan. Urungkan pencocokan transfer itu dulu untuk memindahkan impor ini.'
											)}
										</p>
									{:else}
										{@const from = data.moveWallets.find((w) => w.id === batch.fromWalletId)}
										{@const targets = data.moveWallets.filter(
											(w) => w.id !== batch.fromWalletId && w.currency === (from?.currency ?? 'IDR')
										)}
										{#if targets.length === 0}
											<p class="meta move-note">
												{tr(
													'Belum ada dompet lain dengan mata uang yang sama. Tambahkan dompet dulu untuk memindahkan impor ini.'
												)}
											</p>
										{:else}
											<details class="confirm">
												<summary>{tr('Pindahkan ke dompet lain')}</summary>
												<form method="POST" action="?/move" class="move-form" use:enhance={track}>
													<input type="hidden" name="id" value={batch.id} />
													<input type="hidden" name="updatedAt" value={batch.updatedAt} />
													<label class="move-field">
														<span>{tr('Dompet tujuan')}</span>
														<select name="walletId" required>
															{#each targets as w (w.id)}
																<option value={w.id}>{w.name}</option>
															{/each}
														</select>
													</label>
													<p>
														{from
															? trf(
																	'Semua transaksi aktif dari impor ini pindah dari {wallet} ke dompet tujuan, termasuk yang sudah diubah.',
																	{ wallet: from.name }
																)
															: tr(
																	'Semua transaksi aktif dari impor ini pindah ke dompet tujuan, termasuk yang sudah diubah.'
																)}
													</p>
													<Button type="submit" size="sm" disabled={busy !== ''}>
														{busy === 'move' ? tr('Memindahkan…') : tr('Ya, pindahkan')}
													</Button>
												</form>
											</details>
										{/if}
									{/if}
									<details class="confirm">
										<summary>{tr('Urungkan')}</summary>
										<form method="POST" action="?/undo" use:enhance={track}>
											<input type="hidden" name="id" value={batch.id} />
											<input type="hidden" name="updatedAt" value={batch.updatedAt} />
											<p>
												{trf('Semua {n} transaksi dari impor ini akan dihapus.', {
													n: batch.importedCount
												})}
											</p>
											<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
												{busy === 'undo' ? tr('Memproses…') : tr('Ya, urungkan')}
											</Button>
										</form>
									</details>
								{/if}
							</span>
						</GroupRow>
					{/each}
				</GroupList>
			{/if}
		</section>

		<section class="card o-export" id="ekspor" aria-labelledby="{uid}-export">
			<h2 id="{uid}-export">{tr('Ekspor CSV')}</h2>
			<p class="meta">
				{tr('Pemasukan dan pengeluaran, tanpa transfer. Paling lama 1 tahun per ekspor.')}
			</p>
			{#if data.exportRange.error}
				<p class="error" role="alert">{tr(data.exportRange.error)}</p>
			{:else if data.exportRange.notice === 'cut'}
				<p class="note" role="status">
					{tr('Rentang lebih dari 1 tahun dipotong menjadi 1 tahun. Ekspor lagi untuk sisanya.')}
				</p>
			{/if}
			{#if exportError}<p class="error" role="alert">{exportError}</p>{/if}
			<form method="GET" action="/impor/ekspor" class="stack" onsubmit={onExport}>
				<div class="range">
					<Field
						id="{uid}-from"
						name="from"
						type="date"
						required
						label={tr('Dari tanggal')}
						value={data.exportRange.from}
					/>
					<Field
						id="{uid}-to"
						name="to"
						type="date"
						required
						label={tr('Sampai tanggal')}
						value={data.exportRange.to}
					/>
				</div>
				<div class="actions">
					<Button type="submit" variant="secondary" disabled={exporting}>
						{exporting ? tr('Mengekspor…') : tr('Ekspor CSV')}
					</Button>
				</div>
			</form>
		</section>
	</div>

	<div class="side-col">
		<section class="o-other" aria-labelledby="{uid}-other">
			<h2 id="{uid}-other">{tr('Cara lain memasukkan data')}</h2>
			<GroupList>
				<GroupRow href="#ekspor">
					<span class="way-icon" aria-hidden="true"><Icon name="download" size={20} /></span>
					<span class="way-text">
						<span class="way-title">{tr('Impor/ekspor CSV')}</span>
						<span class="meta">{tr('Unduh transaksimu, atau template untuk diisi')}</span>
					</span>
					<Icon name="chevron-right" size={18} />
				</GroupRow>
				<GroupRow href="/riwayat/struk">
					<span class="way-icon" aria-hidden="true"><Icon name="receipt" size={20} /></span>
					<span class="way-text">
						<span class="way-title">{tr('Pindai struk')}</span>
						<span class="meta"
							>{tr('Foto struk belanja, dibaca jadi transaksi untuk kamu periksa')}</span
						>
					</span>
					<Icon name="chevron-right" size={18} />
				</GroupRow>
				<GroupRow href="/kotak-masuk">
					<span class="way-icon" aria-hidden="true"><Icon name="mail" size={20} /></span>
					<span class="way-text">
						<span class="way-title">{tr('Gmail')}</span>
						<span class="meta">{tr('Struk dan bukti bayar dari e-mail masuk ke Kotak masuk')}</span>
					</span>
					<Icon name="chevron-right" size={18} />
				</GroupRow>
				<!-- Owner decision 2026-10-11: no phone-shortcut integration yet, so the row says so and does nothing. -->
				<GroupRow>
					<span class="way-icon" aria-hidden="true"><Icon name="link" size={20} /></span>
					<span class="way-text">
						<span class="way-title">{tr('Pintasan')}</span>
						<span class="meta">{tr('Catat dari pintasan ponsel · Segera hadir')}</span>
					</span>
				</GroupRow>
			</GroupList>
		</section>

		<section class="card o-jobs" aria-labelledby="{uid}-jobs">
			<h2 id="{uid}-jobs">{tr('Pekerjaan membaca terbaru')}</h2>
			{#if needsAi}
				<p class="note" role="status">
					{tr(
						'PDF ini berupa gambar (hasil pindai). Baca di perangkat lewat bagian "Baca dari foto atau tangkapan layar".'
					)}
				</p>
			{:else}
				<EmptyState
					text={tr(
						'Belum ada pekerjaan membaca. Mutasi PDF dan gambar akan dibaca di sini setelah pembacaan AI dikonfigurasi.'
					)}
				/>
			{/if}
		</section>
	</div>
</div>

<PickerSheet
	bind:open={walletPicker}
	title={walletLabel}
	options={walletOptions}
	value={walletId || null}
	onselect={(value) => (walletId = value)}
/>
<PickerSheet
	bind:open={institutionPicker}
	title={tr('Pilih institusi')}
	options={institutionOptions}
	value={institution}
	onselect={(value) => (institution = value)}
/>
<PickerSheet
	bind:open={formatPicker}
	title={tr('Template berkas')}
	options={templateOptions}
	value={format}
	onselect={(value) => onFormat(value)}
/>

<style>
	.two-col {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 8px;
	}
	/*
	 * Phone: one flow, in the order the .o-* rules give (the import card, history, "Cara lain memasukkan data",
	 * the reading jobs, then export). Desktop: the two columns, same relative order inside each (left: import,
	 * history, export; right: other ways, reading jobs).
	 */
	.main-col,
	.side-col {
		display: contents;
	}
	.o-main,
	.o-continuity,
	.o-cleanup {
		order: 1;
	}
	.o-history {
		order: 2;
	}
	.o-other {
		order: 3;
	}
	.o-jobs {
		order: 4;
	}
	.o-export {
		order: 5;
	}
	@media (min-width: 1200px) {
		.two-col {
			grid-template-columns: minmax(0, 740px) minmax(300px, 420px);
			gap: 40px;
		}
		.main-col,
		.side-col {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-content: start;
			gap: 24px;
			min-width: 0;
		}
	}
	/* § 3a: cards are panel fills, radius 20, no border. */
	.card {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		padding: 20px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	h2 {
		margin: 0 0 4px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.side-col h2 {
		margin-bottom: 12px;
	}
	.card h2 {
		margin: 0;
	}
	.card-head {
		display: grid;
		gap: 4px;
	}
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
	}
	/* One card, one source: the checked "Jenis berkas" radio shows its panel (works without JavaScript). */
	.import {
		gap: 16px;
	}
	.source :global(.segmented) {
		display: flex;
		width: 100%;
		box-sizing: border-box;
	}
	.source :global(.segment) {
		flex: 1 1 auto;
		padding: 0 8px;
	}
	.panel,
	.panel-wrap {
		display: none;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	.import :global(.panel) {
		scroll-margin-top: 96px;
	}
	.import:has(:global(input[name='source'][value='csv']:checked)) .panel-csv,
	.import:has(:global(input[name='source'][value='xlsx']:checked)) .panel-xlsx,
	.import:has(:global(input[name='source'][value='pdf']:checked)) .panel-pdf,
	.import:has(:global(input[name='source'][value='foto']:checked)) .panel-foto {
		display: grid;
	}
	.pickers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 12px;
	}
	.drop {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 28px 16px;
		border: 2px dashed var(--faint);
		border-radius: var(--r-group);
		background: var(--bg);
		text-align: center;
		cursor: pointer;
	}
	.drop.dragging,
	.drop:hover {
		border-color: var(--ink);
	}
	.drop:focus-within {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.drop-icon {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		border-radius: var(--r-pill);
		background: var(--panel);
	}
	.drop-title {
		font-size: 17px;
		font-weight: 700;
	}
	.drop-text {
		max-width: 420px;
		font-size: 14px;
		color: var(--muted);
	}
	/* The native input stays in the page for keyboards, assistive tech and form posts; the zone is its face. */
	.file {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.choose {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 4px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
	.badges {
		display: flex;
		gap: 6px;
	}
	.error-block {
		display: grid;
		gap: 4px;
	}
	.ai {
		display: grid;
		justify-items: start;
		gap: 6px;
	}
	.way-icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.way-text {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.way-title {
		font-size: 15px;
		font-weight: 600;
	}
	.stack {
		display: grid;
		gap: 16px;
	}
	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.field label,
	.label {
		font-size: 15px;
		font-weight: 600;
	}
	select {
		min-height: 48px;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.sections {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.sections legend {
		padding: 0;
		font-weight: 600;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
	}
	.check input {
		width: 22px;
		height: 22px;
		accent-color: var(--ink);
	}
	.meta {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.summary,
	.note {
		margin: 0;
		font-size: 15px;
	}
	.error {
		margin: 0;
		color: var(--money-up);
		font-size: 15px;
	}
	.result p {
		margin: 0;
	}
	.result,
	.ok {
		display: grid;
		gap: 4px;
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.ok {
		color: var(--money-in);
	}
	/* Secondary first, primary last; on a phone the buttons share the row, from 560 px they sit at the right. */
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
	.range {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 8px;
	}
	.range :global(input) {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	/* Three choices on a 360 px phone: the segments share the row and may wrap their label. */
	.format :global(.segmented) {
		display: flex;
		width: 100%;
		box-sizing: border-box;
	}
	.format :global(.segment) {
		flex: 1 1 0;
		padding: 0 6px;
		white-space: normal;
		text-align: center;
	}
	.dup,
	.batch {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.dup-text,
	.batch-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.dup-title,
	.batch-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.dup-side {
		display: grid;
		justify-items: end;
		gap: 4px;
	}
	.confirm summary {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
	}
	.confirm p {
		margin: 4px 0 8px;
		font-size: 14px;
	}
	.move-note {
		margin: 0;
		flex-basis: 100%;
	}
	.move-form,
	.move-field {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.move-field span {
		font-size: 14px;
		font-weight: 600;
	}
	.move-field select {
		min-height: 48px;
		max-width: 100%;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
	}
</style>
