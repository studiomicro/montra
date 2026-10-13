<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { formatDayLabel } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import {
		countLines,
		mappableTabs,
		roleOptions,
		sheetAnswer,
		sheetError,
		skipLines,
		skipReasonLabel,
		statusLabel
	} from './sheet-view';

	/**
	 * "Impor spreadsheet (.xlsx)" on /impor (FN-17), one panel of the "Impor berkas" card: choose a wallet and a
	 * workbook, read it on the server, confirm or change how each tab's columns map, review the counts, import.
	 * Plain form posts (works without JavaScript); with it, the file stays chosen between steps and is read as
	 * soon as it is picked. The wallet is the page's shared PickerSheet choice (a native select without JavaScript).
	 */
	let {
		form,
		wallets,
		walletId
	}: {
		form: unknown;
		wallets: { id: string; name: string; isFavourite: boolean }[];
		/** The page's shared wallet choice (picked above the format switch, FN-16i). */
		walletId: string;
	} = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const answer = $derived(sheetAnswer(form));
	const read = $derived(answer && answer.step !== 'imported' ? answer : null);
	const imported = $derived(answer?.step === 'imported' ? answer : null);
	const serverError = $derived(sheetError(form));
	const roles = $derived(roleOptions({ tr, trf }));

	let fileInput: HTMLInputElement | undefined = $state();
	let readButton: HTMLButtonElement | undefined = $state();
	let resultBox: HTMLElement | undefined = $state();
	let fileName = $state('');
	let localError = $state('');
	/** The shown mapping belongs to the file it was read from: picking another file hides it until read. */
	let stale = $state(false);
	let busy = $state('');
	let networkError = $state('');

	const defaultWallet = $derived((wallets.find((w) => w.isFavourite) ?? wallets[0])?.id ?? '');
	const chosenWallet = $derived(read?.walletId ?? defaultWallet);

	function onFile(event: Event & { currentTarget: HTMLInputElement }) {
		const file = event.currentTarget.files?.[0];
		fileName = file?.name ?? '';
		localError = '';
		stale = true;
		if (!file) return;
		if (/\.(?:csv|tsv|txt)$/i.test(file.name)) {
			localError = tr(
				'Ini berkas CSV. Impor lewat bagian Impor mutasi (CSV) atau Impor mutasi (PDF/CSV).'
			);
			return;
		}
		readButton?.click();
	}

	const submit: SubmitFunction = ({ submitter, action }) => {
		const step = submitter?.getAttribute('value') ?? '';
		busy = action.search.includes('importSheet')
			? 'import'
			: action.search.includes('suggestMapping')
				? 'ai'
				: step === 'apply'
					? 'apply'
					: 'read';
		networkError = '';
		return async ({ result, update }) => {
			if (result.type === 'error')
				networkError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			else {
				// Never reset: the chosen file and options stay for the next step.
				await update({ reset: false });
				stale = false;
				if (busy === 'import' && result.type === 'success' && fileInput) {
					fileInput.value = '';
					fileName = '';
				}
			}
			busy = '';
			await tick();
			resultBox?.focus();
		};
	};

	const error = $derived(networkError || localError || (serverError ? tr(serverError) : ''));
	const showLayout = $derived(!!read && !stale);
</script>

<section class="panel" id="spreadsheet" aria-labelledby="{uid}-title">
	<h3 id="{uid}-title">{tr('Impor spreadsheet (.xlsx)')}</h3>
	<p class="meta">
		{tr('Dari Google Sheets: Berkas > Unduh > Microsoft Excel (.xlsx) atau CSV.')}
		{tr(
			'Angka dan tanggal disalin apa adanya dari berkas. Kategori yang tidak cocok menjadi Tanpa kategori; tidak ada kategori atau dompet baru.'
		)}
	</p>

	<form
		method="POST"
		action="?/previewSheet"
		enctype="multipart/form-data"
		class="stack"
		use:enhance={submit}
	>
		{#if wallets.length === 0}
			<p class="meta">{tr('Belum ada dompet IDR. Tambahkan dompet dulu di Dompet.')}</p>
		{:else if hydrated}
			<input type="hidden" name="walletId" value={walletId} />
		{:else}
			<div class="field">
				<label for="{uid}-wallet">{tr('Dompet tujuan')}</label>
				<select id="{uid}-wallet" name="walletId">
					{#each wallets as wallet (wallet.id)}
						<option value={wallet.id} selected={wallet.id === chosenWallet}>{wallet.name}</option>
					{/each}
				</select>
			</div>
		{/if}

		<label class="drop" for="{uid}-file">
			<span class="drop-icon" aria-hidden="true"><Icon name="upload" size={24} /></span>
			<span class="drop-title">{tr('Pilih berkas .xlsx')}</span>
			<span class="drop-text" id="{uid}-file-text">
				{tr('Dibaca di server lalu dibuang, tidak disimpan. Batas 5 MB dan 5.000 baris.')}
			</span>
			{#if fileName}<span class="file-name">{fileName}</span>{/if}
			<input
				bind:this={fileInput}
				id="{uid}-file"
				class="file"
				type="file"
				name="file"
				accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				aria-describedby="{uid}-file-text"
				onchange={onFile}
			/>
			<span class="choose" aria-hidden="true">{tr('Pilih file')}</span>
		</label>

		{#if error}<p class="error" role="alert">{error}</p>{/if}

		<div class="actions">
			<button
				bind:this={readButton}
				type="submit"
				name="step"
				value="read"
				class="btn secondary"
				disabled={busy !== ''}
			>
				{busy === 'read' ? tr('Membaca…') : tr('Baca berkas')}
			</button>
		</div>

		<div class="results" tabindex="-1" bind:this={resultBox}>
			{#if imported}
				<div class="result ok" role="status">
					{#each countLines(true, imported.counts, { tr, trf }) as line, i (i)}<p>{line}</p>{/each}
					{#each skipLines(imported.skips, { tr, trf }) as line, i (i)}<p class="meta">
							{line}
						</p>{/each}
				</div>
				<div class="actions">
					<Button href="/riwayat" variant="secondary">{tr('Lihat di Riwayat')}</Button>
				</div>
			{:else if read && showLayout}
				{#if !hydrated}
					<p class="note">{tr('Pilih berkas yang sama lagi sebelum menekan tombol berikutnya.')}</p>
				{/if}
				<p class="meta">{trf('Berkas: {name}', { name: read.filename })}</p>
				{#each read.layout.tabs.filter((t) => t.status === 'skipped') as tab (tab.tab)}
					<p class="meta">
						{trf('Tab {name} dilewati: {reason}', {
							name: tab.name,
							reason: skipReasonLabel(tab.reason, { tr, trf })
						})}
					</p>
				{/each}
				{#each mappableTabs(read.layout) as tab (tab.tab)}
					<fieldset class="tab">
						<legend>
							<span class="tab-name">{tab.name}</span>
							<Badge>{statusLabel(tab.status, { tr, trf })}</Badge>
						</legend>
						<Toggle name="tab.{tab.tab}.use" checked={tab.use} label={tr('Impor tab ini')} />
						{#if tab.rows !== null}
							<p class="meta">{trf('{n} baris terbaca di tab ini', { n: tab.rows })}</p>
						{/if}
						<div class="grid2">
							<div class="field">
								<label for="{uid}-h{tab.tab}">{tr('Baris judul kolom')}</label>
								<select id="{uid}-h{tab.tab}" name="tab.{tab.tab}.header">
									{#each tab.headerChoices as r (r)}
										<option value={r} selected={r === tab.headerRow}>
											{r === 0 ? tr('Tanpa baris judul') : trf('Baris {n}', { n: r })}
										</option>
									{/each}
								</select>
							</div>
							<div class="field">
								<label for="{uid}-k{tab.tab}">{tr('Jenis transaksi')}</label>
								<select id="{uid}-k{tab.tab}" name="tab.{tab.tab}.kind">
									<option value="auto" selected={tab.kind === 'auto'}>{tr('Otomatis')}</option>
									<option value="expense" selected={tab.kind === 'expense'}
										>{tr('Pengeluaran')}</option
									>
									<option value="income" selected={tab.kind === 'income'}>{tr('Pemasukan')}</option>
								</select>
							</div>
							<div class="field">
								<label for="{uid}-m{tab.tab}">{tr('Bulan (untuk tanggal tanpa bulan)')}</label>
								<input
									id="{uid}-m{tab.tab}"
									type="month"
									name="tab.{tab.tab}.month"
									value={tab.month ?? ''}
									placeholder={tab.titleMonth ?? ''}
								/>
							</div>
						</div>
						<ul class="columns">
							{#each tab.columns as col (col.index)}
								<li class="column">
									<label class="column-label" for="{uid}-c{tab.tab}-{col.index}">
										<span class="column-name">
											{trf('Kolom {letter}', { letter: col.letter })}{col.header
												? ` · ${col.header}`
												: ''}
										</span>
										{#if col.samples.some((s) => s !== '')}
											<span class="meta samples"
												>{col.samples.filter((s) => s !== '').join(' · ')}</span
											>
										{/if}
									</label>
									<select id="{uid}-c{tab.tab}-{col.index}" name="tab.{tab.tab}.col.{col.index}">
										{#each roles as option (option.value)}
											<option value={option.value} selected={option.value === col.role}
												>{option.label}</option
											>
										{/each}
									</select>
								</li>
							{/each}
						</ul>
						{#if read.layout.unmapped.includes(tab.tab)}
							<div class="ai">
								{#if !read.ai.configured}
									<p class="meta">
										{trf('Saran AI: {state}', { state: tr('Belum dikonfigurasi') })}
									</p>
								{:else if !read.ai.hasKey}
									<Button href="/pengaturan/integrasi" variant="secondary" size="sm">
										{tr('Tambahkan kunci Anthropic di Pengaturan › Integrasi AI')}
									</Button>
								{:else}
									<button
										type="submit"
										formaction="?/suggestMapping"
										name="aiTab"
										value={tab.tab}
										class="btn secondary"
										disabled={busy !== ''}
									>
										<Icon name="sparkle" size={18} />
										{busy === 'ai' ? tr('Meminta saran…') : tr('Sarankan pemetaan dengan AI')}
									</button>
									<p class="meta">
										{tr(
											'Hanya judul kolom dan paling banyak 5 baris contoh yang dikirim, dengan kunci Anthropic-mu sendiri. Angka tetap disalin dari berkas.'
										)}
									</p>
								{/if}
								{#if read.aiTab === tab.tab && read.aiError}
									<p class="error" role="alert">{tr(read.aiError)}</p>
								{/if}
							</div>
						{/if}
					</fieldset>
				{/each}
				<Toggle
					name="fillDown"
					checked={read.layout.fillDown}
					label={tr('Isi tanggal kosong dari baris atas')}
				/>
				<div class="actions">
					<button
						type="submit"
						name="step"
						value="apply"
						class="btn {read.review ? 'secondary' : 'primary'}"
						disabled={busy !== ''}
					>
						{busy === 'apply' ? tr('Memeriksa…') : tr('Pakai pemetaan ini')}
					</button>
				</div>

				{#if read.review}
					<div class="result" role="status">
						{#each countLines(false, read.review.counts, { tr, trf }) as line, i (i)}<p>
								{line}
							</p>{/each}
						<p class="num">
							{trf('Di berkas: pemasukan {income} · pengeluaran {expense}', {
								income: formatMoney(read.review.fileTotals.incomeMinor, 'IDR'),
								expense: formatMoney(read.review.fileTotals.expenseMinor, 'IDR')
							})}
						</p>
						{#each skipLines(read.review.skips, { tr, trf }) as line, i (i)}
							<p class="meta">{line}</p>
						{/each}
					</div>
					{#if read.review.categories.length > 0}
						<h3>{tr('Kategori')}</h3>
						<ul class="cats">
							{#each read.review.categories as cat, i (i)}
								<li>
									{cat.name || tr('(kosong)')} → {cat.target
										? tr(cat.target)
										: tr('Tanpa kategori')}
									<span class="meta">· {trf('{n} baris', { n: cat.rows })}</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if read.review.duplicates.length > 0}
						<GroupList>
							{#each read.review.duplicates as dup, i (i)}
								<GroupRow>
									<span class="dup">
										<span class="dup-text">
											<span class="dup-title">{dup.title || tr('Tanpa judul')}</span>
											<span class="meta">
												{trf('{tab}, baris {n}', { tab: dup.tabName, n: dup.row })} · {formatDayLabel(
													dup.date,
													locale
												)}
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
					{/if}
					<Toggle
						name="skipPossibleDuplicates"
						checked={read.skipPossibleDuplicates}
						label={tr('Lewati baris yang mungkin duplikat')}
					/>
					<div class="actions">
						<button
							type="submit"
							formaction="?/importSheet"
							class="btn primary"
							disabled={busy !== '' || wallets.length === 0}
						>
							{busy === 'import' ? tr('Mengimpor…') : tr('Impor')}
						</button>
					</div>
				{/if}
			{/if}
		</div>
	</form>
</section>

<style>
	/* One panel of the "Impor berkas" card on the page: no card of its own. */
	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
	}
	.results h3 {
		margin: 8px 0 0;
	}
	.stack,
	.results {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}
	.results:focus {
		outline: none;
	}
	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.field label {
		font-size: 15px;
		font-weight: 600;
	}
	select,
	input[type='month'] {
		width: 100%;
		min-width: 0;
		min-height: 48px;
		box-sizing: border-box;
		padding: 10px 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
	}
	.drop {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 24px 16px;
		border: 2px dashed var(--faint);
		border-radius: var(--r-group);
		background: var(--bg);
		text-align: center;
		cursor: pointer;
	}
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
	.drop-text,
	.file-name {
		max-width: 420px;
		font-size: 14px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
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
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
	.meta {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.note {
		margin: 0;
		font-size: 15px;
	}
	.error {
		margin: 0;
		color: var(--money-up);
		font-size: 15px;
	}
	.tab {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		min-width: 0;
		margin: 0;
		padding: 16px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
	}
	.tab legend {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 0;
		font-weight: 700;
		float: left;
		width: 100%;
	}
	.tab-name {
		overflow-wrap: anywhere;
	}
	.grid2 {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 12px;
	}
	.columns,
	.cats {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.column {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
	}
	.column-label {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.column-name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.samples {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.ai {
		display: grid;
		justify-items: start;
		gap: 6px;
	}
	.result {
		display: grid;
		gap: 4px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--bg);
	}
	.result p {
		margin: 0;
	}
	.ok {
		color: var(--money-in);
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
	/* The kit Button look for the submit buttons that carry a name/value (the step the server reads). */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 44px;
		padding: 0 20px;
		border: 0;
		border-radius: var(--r-pill);
		font: inherit;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
	}
	.btn.secondary {
		background: var(--panel);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent);
		color: var(--ink);
	}
	.btn.primary {
		background: var(--ink);
		color: var(--bg);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.dup {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.dup-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.dup-title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.dup-side {
		display: grid;
		justify-items: end;
		gap: 4px;
	}
</style>
