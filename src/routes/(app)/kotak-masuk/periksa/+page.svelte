<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { addDays, formatDayLabel } from '#lib/shared/dates';
	import { DRAFT_BATCH_MAX, draftToken, selectionKind } from '#lib/shared/drafts';
	import { CATEGORY_KIND_LABELS, categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import DraftSummary from '#lib/ui/drafts/DraftSummary.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	type Draft = (typeof data.drafts)[number];

	// Every pending draft starts selected (criterion 7). Without JavaScript the checkboxes post on their own.
	const selected = new SvelteSet<string>();
	let known = new Set<string>();
	$effect.pre(() => {
		// A draft that newly appears (another tab, a capture) starts selected; one that went is forgotten.
		const ids = new Set(data.drafts.map((d) => d.id));
		for (const id of ids) if (!known.has(id)) selected.add(id);
		for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
		known = ids;
	});

	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const chosen = $derived(data.drafts.filter((d) => selected.has(d.id)));
	const count = $derived(hydrated ? chosen.length : data.drafts.length);
	const kind = $derived(selectionKind(chosen.map((d) => d.type)));

	const walletName = (id: string | null) => data.wallets.find((w) => w.id === id)?.name ?? null;
	const categoryOf = (id: string | null) => data.categories.find((c) => c.id === id) ?? null;
	const liveWallets = $derived(data.wallets.filter((w) => !w.archived));
	const visibleCategories = $derived(data.categories.filter((c) => !c.isHidden));

	function dayLabel(date: string): string {
		if (date === data.today) return tr('Hari ini');
		if (date === addDays(data.today, -1)) return tr('Kemarin');
		return formatDayLabel(date, locale);
	}

	let categoryOpen = $state(false);
	let walletOpen = $state(false);
	/** A refusal decided on the device (nothing selected, mixed kinds); never a server answer. */
	let localError = $state('');
	/** The action in flight ('' when none). */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openCategory() {
		if (chosen.length === 0) localError = tr('Pilih minimal satu draf.');
		else if (kind === 'mixed')
			localError = tr('Pilih draf dengan jenis yang sama untuk mengatur kategori sekaligus');
		else {
			localError = '';
			categoryOpen = true;
		}
	}
	function openWallet() {
		if (chosen.length === 0) localError = tr('Pilih minimal satu draf.');
		else {
			localError = '';
			walletOpen = true;
		}
	}
	function selectAll() {
		for (const d of data.drafts) selected.add(d.id);
	}
	function clearSelection() {
		selected.clear();
	}
	function toggle(draft: Draft, on: boolean) {
		if (on) selected.add(draft.id);
		else selected.delete(draft.id);
	}

	/** Success is shown only after the server confirmed; a refused or stale request reloads the drafts. */
	const submit: SubmitFunction = ({ action }) => {
		busy = action.search;
		actionError = '';
		localError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			} else if (result.type === 'redirect') {
				await update();
			} else {
				await update({ reset: false });
				if (result.type === 'success') {
					categoryOpen = false;
					walletOpen = false;
				} else if (result.type === 'failure' && result.status === 409) await invalidateAll();
			}
			busy = '';
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
	const loading = $derived(refreshing || navigating.to?.url.pathname === '/kotak-masuk/periksa');

	const done = $derived.by(() => {
		if (!form || !('done' in form)) return [];
		const lines = [trf('{n} draf diperbarui.', { n: form.updated ?? 0 })];
		if (form.skipped)
			lines.push(
				trf('{n} draf dilewati karena mata uangnya berbeda dengan dompet.', { n: form.skipped })
			);
		return lines;
	});
	const banner = $derived(
		localError ||
			actionError ||
			(form && 'error' in form && form.error ? tr(form.error) : '') ||
			undefined
	);
</script>

<svelte:head><title>{tr('Periksa draf')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/kotak-masuk', label: tr('Kembali ke Kotak masuk') }}
	title={tr('Periksa draf')}
	subtitle={tr('Pilih draf, lengkapi kategori dan dompet, lalu simpan.')}
/>

{#snippet categoryOptions(kindFilter: 'expense' | 'income' | null)}
	<div class="options">
		{#each visibleCategories.filter((c) => !kindFilter || c.kind === kindFilter) as category (category.id)}
			<label class="option">
				<input type="radio" name="categoryId" value={category.id} />
				<CategoryTile category={category.tileKey} size={36} />
				<span>
					{categoryLabel(category, tr)}
					{#if !kindFilter}<span class="meta">· {tr(CATEGORY_KIND_LABELS[category.kind])}</span
						>{/if}
				</span>
			</label>
		{/each}
	</div>
{/snippet}

{#snippet walletOptions()}
	{#if liveWallets.length === 0}
		<p class="meta">{tr('Belum ada dompet. Tambah satu di Kekayaan.')}</p>
	{:else}
		<div class="options">
			{#each liveWallets as wallet (wallet.id)}
				<label class="option">
					<input type="radio" name="walletId" value={wallet.id} />
					<span>{wallet.name} <span class="meta">· {wallet.currency}</span></span>
				</label>
			{/each}
		</div>
	{/if}
{/snippet}

{#each done as line, i (i)}
	<p class="ok" role="status">{line}</p>
{/each}
{#if form && 'aiNotice' in form && form.aiNotice}
	<p class="hint" role="status">
		{tr(form.aiNotice)}
		<a href="/pengaturan/integrasi">{tr('Buka Integrasi')}</a>
	</p>
{/if}
<FormBanner message={banner} />

{#if loading}
	<div aria-busy="true"><Skeleton rows={4} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.drafts.length === 0}
	<EmptyState
		illustration="inbox"
		text={tr('Tidak ada draf yang menunggu.')}
		actionLabel={tr('Kembali ke Kotak masuk')}
		actionHref="/kotak-masuk"
	/>
{:else}
	<form method="POST" action="?/save" use:enhance={submit}>
		<div class="toolbar">
			<p class="count num" aria-live="polite">{trf('{n} dipilih', { n: count })}</p>
			{#if hydrated}
				<div class="select-actions">
					<Button variant="ghost" size="sm" onclick={selectAll}>{tr('Pilih semua')}</Button>
					<Button variant="ghost" size="sm" onclick={clearSelection}>
						{tr('Kosongkan pilihan')}
					</Button>
				</div>
			{/if}
		</div>
		{#if count > DRAFT_BATCH_MAX}
			<p class="meta">
				{trf('Satu kali simpan memproses {n} draf pertama; sisanya tetap dipilih.', {
					n: DRAFT_BATCH_MAX
				})}
			</p>
		{/if}

		<GroupList>
			<!-- Keyed by id and version: a changed draft re-renders closed, with its new category and reason. -->
			{#each data.drafts as draft (draftToken(draft))}
				<GroupRow
					selected={hydrated ? selected.has(draft.id) : true}
					onToggle={(on) => toggle(draft, on)}
					name="d"
					value={draftToken(draft)}
				>
					{#snippet extra()}
						<!-- One tap on a category posts ?/setCategory for this draft only (its own form below). -->
						<details class="row-pick">
							<summary>{tr('Ubah kategori')}</summary>
							<div class="row-options">
								{#each visibleCategories.filter((c) => c.kind === draft.type && c.id !== draft.categoryId) as category (category.id)}
									<button
										type="submit"
										form="row-{draft.id}"
										name="categoryId"
										value={category.id}
										disabled={busy !== ''}
									>
										<CategoryTile category={category.tileKey} size={36} />
										<span>{categoryLabel(category, tr)}</span>
									</button>
								{/each}
							</div>
						</details>
					{/snippet}
					<DraftSummary
						{draft}
						reason={data.reasons[draft.id]}
						category={categoryOf(draft.categoryId)}
						walletName={walletName(draft.walletId)}
						dateLabel={dayLabel(draft.occurredOn)}
					/>
				</GroupRow>
			{/each}
		</GroupList>

		{#if data.drafts.some((d) => !d.categoryId)}
			<div class="suggest">
				<Button type="submit" variant="secondary" formaction="?/suggest" disabled={busy !== ''}>
					{busy === '?/suggest' ? tr('Memproses…') : tr('Isi kategori otomatis')}
				</Button>
				<p class="meta">
					{tr('Dari aturanmu, riwayat ruang ini, daftar pedagang, lalu AI dengan kuncimu sendiri.')}
				</p>
			</div>
		{/if}

		{#if hydrated}
			<div class="bulk">
				<Button variant="secondary" disabled={busy !== ''} onclick={openCategory}>
					{tr('Atur kategori')}
				</Button>
				<Button variant="secondary" disabled={busy !== ''} onclick={openWallet}>
					{tr('Atur dompet')}
				</Button>
			</div>
		{:else}
			<!-- Without JavaScript the pickers sit in the page and post the checked drafts with them. -->
			<details class="picker">
				<summary>{tr('Atur kategori')}</summary>
				{@render categoryOptions(null)}
				<Button type="submit" variant="secondary" formaction="?/setCategory">
					{tr('Terapkan kategori')}
				</Button>
			</details>
			<details class="picker">
				<summary>{tr('Atur dompet')}</summary>
				{@render walletOptions()}
				<Button type="submit" variant="secondary" formaction="?/setWallet">
					{tr('Terapkan dompet')}
				</Button>
			</details>
		{/if}

		<div class="save">
			<Button type="submit" size="lg" full disabled={busy !== '' || count === 0}>
				{busy === '?/save' ? tr('Menyimpan…') : trf('Simpan {n} transaksi', { n: count })}
			</Button>
		</div>

		<!-- The sheets live inside the form: their choice posts with the checked drafts. -->
		<Sheet bind:open={categoryOpen} title={tr('Atur kategori')}>
			{#if categoryOpen}
				<div class="sheet-form">
					{@render categoryOptions(kind === 'income' ? 'income' : 'expense')}
					<Button type="submit" size="lg" full formaction="?/setCategory" disabled={busy !== ''}>
						{busy === '?/setCategory'
							? tr('Memproses…')
							: trf('Terapkan ke {n} draf', { n: chosen.length })}
					</Button>
				</div>
			{/if}
		</Sheet>
		<Sheet bind:open={walletOpen} title={tr('Atur dompet')}>
			{#if walletOpen}
				<div class="sheet-form">
					{@render walletOptions()}
					<Button
						type="submit"
						size="lg"
						full
						formaction="?/setWallet"
						disabled={busy !== '' || liveWallets.length === 0}
					>
						{busy === '?/setWallet'
							? tr('Memproses…')
							: trf('Terapkan ke {n} draf', { n: chosen.length })}
					</Button>
				</div>
			{/if}
		</Sheet>
	</form>
	<!-- Per-row category forms sit outside the bulk form (forms do not nest); the row's buttons point at them. -->
	{#each data.drafts as draft (draft.id)}
		<form id="row-{draft.id}" method="POST" action="?/setCategory" use:enhance={submit}>
			<input type="hidden" name="d" value={draftToken(draft)} />
		</form>
	{/each}
{/if}

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 12px;
		margin: 8px 0;
	}
	.count {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.select-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.meta {
		margin: 0 0 8px;
		font-size: 13px;
		color: var(--muted);
	}
	.option .meta {
		margin: 0;
	}
	.ok {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.hint {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink-2);
	}
	.hint a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.suggest {
		display: grid;
		justify-items: start;
		gap: 4px;
		margin-top: 16px;
	}
	.suggest .meta {
		margin: 0;
	}
	.bulk {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 16px;
	}
	.save {
		margin-top: 16px;
	}
	.picker {
		margin-top: 16px;
	}
	.picker summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
	}
	.picker[open] {
		display: grid;
		gap: 12px;
	}
	.row-pick {
		padding: 0 16px 6px 68px;
	}
	.row-pick summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink-2);
		cursor: pointer;
	}
	.row-options {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding-bottom: 8px;
	}
	.row-options button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 4px 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		cursor: pointer;
	}
	.row-options button:disabled {
		opacity: 0.5;
	}
	.sheet-form {
		display: grid;
		gap: 16px;
		padding-bottom: 8px;
	}
	.options {
		display: grid;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 52px;
		padding: 4px 16px;
		cursor: pointer;
	}
	.option {
		position: relative;
	}
	.option + .option::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 16px;
		border-top: 1px solid var(--line);
	}
	.option input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--ink);
	}
</style>
