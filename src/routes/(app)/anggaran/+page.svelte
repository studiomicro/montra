<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatShortDate, formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import BudgetForm from '#lib/ui/budgets/BudgetForm.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import { richParts, type RichPart } from '#lib/ui/kit/rich';
	import { budgetSafeCelebrates } from '#lib/ui/mascot-moments';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	let { data, form } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const { tr, trf, locale } = useI18n();

	const s = $derived(data.summary);
	type Summary = NonNullable<typeof data.summary>;
	type Row = Summary['categories'][number];
	type Unbudgeted = Summary['unbudgeted'][number];
	/** What a category sheet edits: a budgeted row, or an unbudgeted category (no budget yet). */
	type Editing = {
		categoryId: string;
		name: string;
		budget: Row['budget'] | null;
		currency: string;
	};

	// With JavaScript the forms open in sheets; without it `?ubah=bulanan` / `?kategori=<id>` (and a refused
	// submission) render the same form inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let totalOpen = $state(false);
	let categoryOpen = $state(false);
	let editing = $state<Editing | null>(null);
	let formKey = $state(0);
	/** The action in flight ('' when none): its button shows progress, every button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	const compact = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoneyCompact(minor, currency, locale));
	const nameOf = (c: { name: string; isPreset: boolean }) => categoryLabel(c, tr);

	function editingFor(categoryId: string, summary: Summary): Editing | null {
		const row = summary.categories.find((c) => c.categoryId === categoryId);
		if (row)
			return {
				categoryId,
				name: nameOf(row),
				budget: row.budget,
				currency: row.budget.currency
			};
		const free = summary.unbudgeted.find((c) => c.categoryId === categoryId);
		return free
			? { categoryId, name: nameOf(free), budget: null, currency: summary.currency }
			: null;
	}

	function openTotal(event?: MouseEvent) {
		event?.preventDefault();
		actionError = '';
		formKey++;
		totalOpen = true;
	}
	function openCategory(categoryId: string, event?: MouseEvent) {
		if (!s) return;
		const next = editingFor(categoryId, s);
		if (!next) return;
		event?.preventDefault();
		editing = next;
		actionError = '';
		formKey++;
		categoryOpen = true;
	}

	onMount(() => {
		hydrated = true;
		if (data.open === 'total' && s) openTotal();
		else if (data.open) openCategory(data.open);
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('ubah') || url.searchParams.has('kategori')) {
			url.searchParams.delete('ubah');
			url.searchParams.delete('kategori');
			replaceState(url, {});
		}
	}

	/** Success only once the server confirmed the write; the figures are reloaded from the server either way. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update({ reset: false });
				if (result.type === 'success') {
					totalOpen = false;
					categoryOpen = false;
				} else if (result.type === 'failure' && (result.status === 404 || result.status === 409)) {
					// Changed or gone meanwhile: show the budget as it is now, in a fresh form.
					await invalidateAll();
					if (editing && data.summary) editing = editingFor(editing.categoryId, data.summary);
					if (!editing) categoryOpen = false;
					formKey++;
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

	const loading = $derived(
		refreshing ||
			(navigating.to?.url.pathname === '/anggaran' && navigating.from?.url.pathname === '/anggaran')
	);

	const savedText: Record<string, string> = {
		set: msg('Anggaran disimpan.'),
		deleted: msg('Anggaran dihapus.'),
		categorySet: msg('Anggaran kategori disimpan.'),
		categoryDeleted: msg('Anggaran kategori dihapus.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const sheetOpen = $derived(totalOpen || categoryOpen);

	/** The amount a refused `action` (for `categoryId`) posted, to show as typed; undefined otherwise. */
	function refusedTyped(action: string, categoryId?: string): string | undefined {
		if (!form || !('action' in form) || form.action !== action || !('typed' in form))
			return undefined;
		if (categoryId !== undefined && (!('categoryId' in form) || form.categoryId !== categoryId))
			return undefined;
		return typeof form.typed === 'string' ? form.typed : undefined;
	}

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by(() => {
		if (hydrated || !s) return null;
		const failed = form && 'action' in form ? form : null;
		if (failed?.action === 'setBudget' || (!failed && data.open === 'total'))
			return { kind: 'total' as const };
		const id =
			failed?.action === 'setCategoryBudget' &&
			'categoryId' in failed &&
			typeof failed.categoryId === 'string'
				? failed.categoryId
				: failed
					? null
					: data.open;
		const target = id ? editingFor(id, s) : null;
		return target ? { kind: 'category' as const, target } : null;
	});

	const period = $derived(
		s ? `${formatShortDay(s.from, locale)} – ${formatShortDate(s.to, locale)}` : ''
	);
	const subtitle = $derived(
		s
			? `${period} · ${
					s.daysLeft === 0
						? tr('hari terakhir')
						: s.daysLeft === 1
							? tr('1 hari lagi')
							: trf('{n} hari lagi', { n: s.daysLeft })
				}`
			: undefined
	);
	/** Categories with spending this month first; with none, all of them, so a first budget can still be set. */
	const noneSpent = $derived((s?.unbudgeted ?? []).every((c) => (c.spentMinor ?? 0) === 0));
	const unbudgetedShown = $derived.by(() => {
		const all = s?.unbudgeted ?? [];
		const spent = all.filter((c) => (c.spentMinor ?? 0) > 0);
		return spent.length > 0 ? spent : all;
	});
	const toneOf = (state: 'ok' | 'ahead' | 'over') =>
		state === 'over' ? 'over' : state === 'ahead' ? 'warn' : 'ink';
</script>

<svelte:head><title>{tr('Anggaran')}</title></svelte:head>

{#snippet rich(parts: RichPart[])}
	{#each parts as part, i (i)}{#if part.strong}<strong>{part.text}</strong
			>{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet totalForm(summary: Summary)}
	{@const typed = refusedTyped('setBudget')}
	{#key formKey}
		<BudgetForm
			setAction="?/setBudget"
			deleteAction="?/deleteBudget"
			currency={summary.currency}
			budget={summary.budget}
			label={tr('Anggaran per bulan')}
			hint={tr('Berlaku untuk setiap bulan sampai kamu mengubahnya.')}
			{busy}
			submit={track}
			{typed}
		/>
	{/key}
{/snippet}

{#snippet categoryForm(target: Editing)}
	{@const typed = refusedTyped('setCategoryBudget', target.categoryId)}
	{#key formKey}
		<BudgetForm
			setAction="?/setCategoryBudget"
			deleteAction="?/deleteCategoryBudget"
			currency={target.currency}
			budget={target.budget}
			categoryId={target.categoryId}
			label={trf('Anggaran {kategori} per bulan', { kategori: target.name })}
			hint={tr('Berlaku untuk setiap bulan sampai kamu mengubahnya.')}
			{busy}
			submit={track}
			{typed}
		/>
	{/key}
{/snippet}

<ScreenTitle title={tr('Anggaran')} {subtitle}>
	{#snippet actions()}
		<Button variant="secondary" href="/anggaran?ubah=bulanan" onclick={openTotal}>
			{tr('Ubah anggaran')}
		</Button>
	{/snippet}
</ScreenTitle>
<p class="period-why">
	{tr('Periode anggaran mengikuti bulan kalender, mulai tanggal 1.')}
</p>

{#if saved}
	<p class="ok" role="status">
		<!-- FN-44: the monthly budget is saved and the server's recomputed safe-to-spend is positive. -->
		{#if budgetSafeCelebrates(form, s?.safeToSpend)}<Mascot pose="celebrate" size={40} />{/if}
		{saved}
	</p>
{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if inline && s}
	<section class="inline-form" aria-labelledby="inline-title">
		{#if inline.kind === 'total'}
			<h2 id="inline-title">{tr('Anggaran bulanan')}</h2>
			{@render totalForm(s)}
		{:else}
			<h2 id="inline-title">{inline.target.name}</h2>
			{@render categoryForm(inline.target)}
		{/if}
		<a class="cancel" href="/anggaran">{tr('Batal')}</a>
	</section>
{/if}

{#if loading}
	<div class="two-col" aria-busy="true">
		<Skeleton rows={2} />
		<Skeleton rows={4} />
	</div>
{:else if data.loadError || !s}
	<ErrorState
		text={tr(data.loadError ?? 'Anggaran tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<div class="two-col">
		<div class="main-col">
			{#if s.total && s.budget}
				{@const total = s.total}
				<HeroAmount
					label={total.state === 'over' ? tr('Melebihi anggaran') : tr('Sisa untuk dibelanjakan')}
					amountMinor={total.remainingMinor === null ? null : Math.abs(total.remainingMinor)}
					currency={s.currency}
					fallback={tr(TOO_LARGE)}
				>
					{#if s.safeToSpend?.kind === 'left'}
						<p class="num">
							{@render rich(
								richParts(tr('{per_hari} sehari sampai {tanggal}'), {
									per_hari: compact(s.safeToSpend.perDayMinor, s.currency),
									tanggal: formatShortDay(s.to, locale)
								})
							)}
						</p>
					{:else if s.safeToSpend?.kind === 'spent'}
						<p>{tr('Anggaran bulan ini sudah habis.')}</p>
					{:else}
						<p class="over-text">{tr('Sudah melebihi anggaran.')}</p>
					{/if}
				</HeroAmount>
				<div class="total-bar">
					<ProgressBar
						percent={total.usedPercent}
						label={tr('Anggaran terpakai')}
						tone={toneOf(total.state)}
						marker={s.pace}
					/>
					<p class="total-line num">
						{@render rich(
							richParts(tr('{terpakai} terpakai dari {anggaran}'), {
								terpakai: compact(total.spentMinor, s.currency),
								anggaran: compact(s.budget.amountMinor, s.currency)
							})
						)}
						{#if total.projectedMinor !== null}
							·
							<span class:warn-text={total.state === 'ahead'}>
								{@render rich(
									richParts(tr('diperkirakan {jumlah} di akhir periode'), {
										jumlah: compact(total.projectedMinor, s.currency)
									})
								)}
							</span>
						{/if}
					</p>
				</div>
			{:else}
				<section class="no-budget" aria-labelledby="no-budget-title">
					<h2 id="no-budget-title">{tr('Belum ada anggaran bulanan')}</h2>
					<p>
						{tr(
							'Tetapkan satu angka untuk sebulan. Sisanya dibagi rata ke hari yang tersisa, jadi kamu tahu berapa yang aman dibelanjakan hari ini.'
						)}
					</p>
					<Button href="/anggaran?ubah=bulanan" onclick={openTotal}>{tr('Atur anggaran')}</Button>
				</section>
			{/if}

			{#if s.categories.length > 0}
				<section aria-labelledby="per-category-title">
					<div class="section-head">
						<h2 id="per-category-title">{tr('Per kategori')}</h2>
						<p class="section-sub">{tr('Anggaran bulanan untuk kategori tertentu')}</p>
					</div>
					<GroupList>
						{#each s.categories as row (row.categoryId)}
							{@const p = row.progress}
							<GroupRow>
								<a
									class="cat-row"
									href="/anggaran?kategori={row.categoryId}"
									onclick={(event) => openCategory(row.categoryId, event)}
								>
									<CategoryTile category={row.tileKey} />
									<span class="cat-body">
										<span class="cat-top">
											<span class="cat-name">{nameOf(row)}</span>
											<span
												class="cat-left num"
												class:over-text={p.state === 'over'}
												class:warn-text={p.state === 'ahead'}
											>
												{#if p.remainingMinor === null}
													{tr(TOO_LARGE)}
												{:else if p.remainingMinor < 0}
													{trf('{jumlah} melebihi', {
														jumlah: compact(-p.remainingMinor, row.budget.currency)
													})}
												{:else}
													{trf('{jumlah} tersisa', {
														jumlah: compact(p.remainingMinor, row.budget.currency)
													})}
												{/if}
											</span>
										</span>
										<ProgressBar
											percent={p.usedPercent}
											label={trf('Anggaran {kategori} terpakai', { kategori: nameOf(row) })}
											tone={toneOf(p.state)}
											marker={s.pace}
										/>
										<span class="cat-bottom num">
											<span>
												{money(p.spentMinor, row.budget.currency)} / {money(
													row.budget.amountMinor,
													row.budget.currency
												)}
											</span>
											{#if p.state === 'ahead'}
												<span class="warn-text">{tr('Lebih cepat dari jadwal')}</span>
											{:else if p.state === 'over'}
												<span class="over-text">{tr('Melebihi anggaran')}</span>
											{/if}
										</span>
									</span>
								</a>
							</GroupRow>
						{/each}
					</GroupList>
				</section>
			{/if}
		</div>

		<div class="side-col">
			<section aria-labelledby="unbudgeted-title">
				<div class="section-head">
					<h2 id="unbudgeted-title">{tr('Belum ada anggaran')}</h2>
					<p class="section-sub">{tr('Kategori pengeluaran tanpa anggaran')}</p>
				</div>
				{#if s.unbudgeted.length === 0}
					<EmptyState
						illustration="budget"
						text={tr('Semua kategori pengeluaran sudah punya anggaran.')}
					/>
				{:else}
					<!-- No spending yet: one muted line instead of the same sentence on every row (POLISH_AUDIT B6). -->
					{#if noneSpent}<p class="none-spent">{tr('Belum ada pengeluaran bulan ini')}</p>{/if}
					<GroupList>
						{#each unbudgetedShown as c (c.categoryId)}
							{@render unbudgetedRow(c)}
						{/each}
					</GroupList>
				{/if}
			</section>
			<p class="note">
				{tr(
					'Garis tipis di setiap batang menandai seberapa jauh bulan ini sudah berjalan. Batang yang melewatinya berarti pengeluaran lebih cepat dari jadwal dan bisa melebihi anggaran sebelum akhir bulan.'
				)}
			</p>
		</div>
	</div>
{/if}

{#snippet unbudgetedRow(c: Unbudgeted)}
	<GroupRow>
		<a
			class="cat-row"
			href="/anggaran?kategori={c.categoryId}"
			onclick={(event) => openCategory(c.categoryId, event)}
		>
			<CategoryTile category={c.tileKey} />
			<span class="cat-body">
				<span class="cat-name">{nameOf(c)}</span>
				{#if c.spentMinor !== 0}
					<span class="cat-meta num">
						{trf('{jumlah} bulan ini', { jumlah: money(c.spentMinor, s?.currency ?? 'IDR') })}
					</span>
				{/if}
			</span>
			<Icon name="chevron-right" size={18} />
		</a>
	</GroupRow>
{/snippet}

<Sheet bind:open={totalOpen} title={tr('Anggaran bulanan')} onclose={onSheetClose}>
	{#if totalOpen && s}
		<FormBanner message={banner} />
		{@render totalForm(s)}
	{/if}
</Sheet>

<Sheet bind:open={categoryOpen} title={editing?.name ?? ''} onclose={onSheetClose}>
	{#if categoryOpen && editing}
		<FormBanner message={banner} />
		{@render categoryForm(editing)}
	{/if}
</Sheet>

<style>
	.period-why {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
	.two-col {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		margin-top: 8px;
	}
	.main-col,
	.side-col {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: 24px;
		min-width: 0;
	}
	/* The tablet tier (860 – 1023 px, no sidebar; app +layout.svelte) and the full desktop width. */
	@media (min-width: 860px) and (max-width: 1023.98px), (min-width: 1200px) {
		.two-col {
			grid-template-columns: minmax(0, 740px) minmax(300px, 420px);
			gap: 40px;
		}
	}
	.total-bar {
		display: grid;
		gap: 10px;
	}
	.total-line {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.total-line :global(strong),
	.cat-bottom :global(strong) {
		color: var(--ink);
	}
	.warn-text {
		color: var(--warn-text);
	}
	.warn-text :global(strong) {
		color: var(--warn-text);
	}
	.over-text {
		color: var(--money-up);
	}
	.no-budget {
		display: grid;
		justify-items: start;
		gap: 12px;
		padding: 20px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.no-budget p {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.section-head {
		margin-bottom: 12px;
	}
	.section-sub {
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--muted);
	}
	.none-spent {
		margin: 0 0 12px;
		font-size: 14px;
		color: var(--muted);
	}
	.cat-row {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.cat-body {
		display: grid;
		flex: 1;
		gap: 6px;
		min-width: 0;
	}
	.cat-bottom {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 2px 12px;
	}
	/* The name gives way (ellipsis) so "Rp645 rb tersisa" always stays right on the name's row (POLISH_AUDIT B7). */
	.cat-top {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 12px;
	}
	.cat-name {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.cat-left {
		font-size: 15px;
		font-weight: 700;
	}
	.cat-bottom {
		font-size: 13px;
		color: var(--muted);
	}
	/* A category without a budget: the meta stays on one line (the chevron says it opens). */
	.cat-meta {
		font-size: 13px;
		color: var(--muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.note {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.inline-form {
		margin: 8px 0 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.inline-form h2 {
		margin-bottom: 12px;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.ok {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
