<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { budgetUsedPercent } from '#lib/shared/budget-progress';
	import { formatMonthName, formatShortDay, formatWeekdayDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { hasProLook } from '#lib/shared/pro-look';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import BudgetForm from '#lib/ui/budgets/BudgetForm.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import BarChart from '#lib/ui/kit/BarChart.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryBar from '#lib/ui/kit/CategoryBar.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import CompareLine from '#lib/ui/laporan/CompareLine.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import IconButton from '#lib/ui/kit/IconButton.svelte';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import MonthLines from '#lib/ui/kit/MonthLines.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import { richParts, type RichPart } from '#lib/ui/kit/rich';
	import { openFiturSheet } from '#lib/ui/shell/fitur.svelte';
	import PullToRefresh from '#lib/ui/shell/PullToRefresh.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import { dayClosedCelebrates } from '#lib/ui/mascot-moments';
	import { streakHop, WELCOME_WAVE_KEY, welcomeWaveDue } from '#lib/ui/motion';
	import { isStandalone } from '#lib/ui/pwa/install.svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { wibTodayString } from '#lib/shared/dates';
	import {
		rowKindLabel,
		rowMeta,
		rowShare,
		rowTitle,
		signedAmount
	} from '#lib/ui/transactions/row-text';

	let { data, form } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	const s = $derived(data.summary);
	type Summary = NonNullable<typeof data.summary>;

	// The budget form opens in a sheet with JavaScript; without it `?anggaran=1` (and a refused submission)
	// renders the same form inline, so both actions work as plain form posts.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let formKey = $state(0);
	/** The action in flight ('' when none): its button shows progress, both buttons are disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openBudget(event?: MouseEvent) {
		event?.preventDefault();
		actionError = '';
		formKey++;
		sheetOpen = true;
	}

	onMount(() => {
		hydrated = true;
		if (data.openBudget && data.summary) openBudget();
		// FN-51: Koko waves once per WIB day in the installed app (after hydration: never on the first paint).
		let lastShown: string | null;
		try {
			lastShown = localStorage.getItem(WELCOME_WAVE_KEY);
		} catch {
			// Storage blocked: nothing can be remembered, and waving on every open would be noise.
			return;
		}
		const today = wibTodayString();
		if (
			welcomeWaveDue({
				standalone: isStandalone(),
				reducedMotion: prefersReducedMotion.current,
				hidden: document.hidden,
				lastShown,
				today
			})
		) {
			welcome = true;
			try {
				localStorage.setItem(WELCOME_WAVE_KEY, today);
			} catch {
				// Storage blocked: shown this once.
			}
		}
	});

	/** FN-51: Koko's welcome-back wave beside the hero label (installed app, once per WIB day). */
	let welcome = $state(false);

	// FN-51: the streak chip hops once when the count grows while this page stays mounted (after "Tutup hari"),
	// never on first paint, on a decrease, under reduced motion or in a hidden tab.
	let hopKey = $state(0);
	let seenStreak: number | null = untrack(() => data.streak?.current ?? null);
	$effect(() => {
		const next = data.streak?.current ?? null;
		const reducedMotion = prefersReducedMotion.current;
		untrack(() => {
			if (streakHop(seenStreak, next, reducedMotion, document.hidden)) hopKey++;
			seenStreak = next;
		});
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('anggaran')) {
			url.searchParams.delete('anggaran');
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
				if (result.type === 'success') sheetOpen = false;
				else if (result.type === 'failure' && (result.status === 404 || result.status === 409)) {
					// Changed meanwhile: show the budget as it is now, in a fresh form.
					await invalidateAll();
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
		refreshing || (navigating.to?.url.pathname === '/' && navigating.from?.url.pathname === '/')
	);

	const savedText: Record<string, string> = {
		set: msg('Anggaran disimpan.'),
		deleted: msg('Anggaran dihapus.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const showInline = $derived(
		!hydrated &&
			s !== null &&
			(data.openBudget || (form !== null && 'action' in form && form.action === 'setBudget'))
	);

	let chart = $state('daily');
	const chartOptions = $derived([
		{ value: 'daily', label: tr('Batang harian') },
		{ value: 'category', label: tr('Per kategori') },
		{ value: 'lines', label: tr('Vs bulan lalu') }
	]);

	const monthName = $derived(s ? formatMonthName(s.month, locale) : '');
	const lastMonthName = $derived(s ? formatMonthName(s.lastMonth, locale) : '');
	const bars = $derived(
		s
			? s.bars.map((b) => ({
					label: formatShortDay(b.date, locale),
					minor: b.minor ?? 0,
					tick: String(Number(b.date.slice(8, 10)))
				}))
			: []
	);
	/** A figure of the chosen view is too large to show exactly: the chart is replaced by that notice. */
	const chartTooLarge = $derived(
		!!s &&
			(chart === 'daily'
				? s.bars.some((b) => b.minor === null)
				: chart === 'category'
					? s.categories.some((c) => c.minor === null)
					: [...s.lines.thisMonth, ...s.lines.lastMonth].some((v) => v === null))
	);
	/** Only read once chartTooLarge is false, so no value is null there. */
	const nums = (values: (number | null)[]) => values.map((v) => v ?? 0);
	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, currency, 'auto', locale));
	const compact = (minor: number, currency: string) =>
		shown(formatMoneyCompact(minor, currency, locale));
	const chartEmpty = $derived(
		!s ||
			(chart === 'daily'
				? s.bars.every((b) => b.minor === 0)
				: chart === 'category'
					? s.categories.length === 0
					: (s.lines.thisMonth.at(-1) ?? 0) === 0 && (s.lines.lastMonth.at(-1) ?? 0) === 0)
	);

	const budgetCurrency = $derived(s?.budget?.currency ?? s?.currency ?? 'IDR');
	const dayHref = (date: string) => `/riwayat?period=range&from=${date}&to=${date}`;
	const dayLink = (i: number) => {
		const date = s?.bars[i]?.date;
		return date
			? { href: dayHref(date), text: tr('Lihat transaksi') }
			: { href: '/riwayat', text: '' };
	};

	/** "dalam 2 hari" for a bill (0 = today, 1 = tomorrow). */
	function dueLabel(inDays: number): string {
		if (inDays === 0) return tr('Hari ini');
		if (inDays === 1) return tr('Besok');
		return trf('dalam {n} hari', { n: inDays });
	}

	const todayLine = $derived(formatWeekdayDay(data.today, locale));
	/** FN-34: the account's streak as a plain count (null when it could not be read: no chip, no close). */
	const streakText = $derived(
		!data.streak
			? ''
			: data.streak.current === 0
				? tr('0 hari berturut-turut')
				: data.streak.current === 1
					? tr('1 hari berturut-turut')
					: trf('{n} hari berturut-turut', { n: data.streak.current })
	);
	const spaceName = $derived(
		page.data.shell?.space
			? page.data.shell.space.kind === 'personal'
				? tr('Pribadi')
				: page.data.shell.space.name
			: ''
	);
</script>

<svelte:head><title>{tr('Beranda')}</title></svelte:head>

{#snippet rich(parts: RichPart[])}
	{#each parts as part, i (i)}{#if part.strong}<strong>{part.text}</strong
			>{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet budgetForm(summary: Summary)}
	{#key formKey}
		<BudgetForm
			setAction="?/setBudget"
			deleteAction="?/deleteBudget"
			currency={budgetCurrency}
			budget={summary.budget}
			label={tr('Anggaran per bulan')}
			hint={tr('Berlaku untuk setiap bulan sampai kamu mengubahnya.')}
			{busy}
			submit={track}
			typed={form &&
			'action' in form &&
			form.action === 'setBudget' &&
			'typed' in form &&
			typeof form.typed === 'string'
				? form.typed
				: undefined}
		/>
	{/key}
{/snippet}

<h1 class="sr-only">{tr('Beranda')}</h1>
<!-- FN-51: in the installed app, a pull from the top reloads the figures from the server. -->
<PullToRefresh onrefresh={() => invalidateAll()} />

<header class="topbar">
	<div class="when">
		<p class="date">{todayLine}</p>
		<!-- FN-34b: the chip opens /beruntun; the link's 44 px hit area hangs over the row (negative margins). -->
		{#if streakText}<a class="chip-link" href="/beruntun"
				>{#key hopKey}<span class="day-chip" class:hop={hopKey > 0}>{streakText}</span>{/key}</a
			>{/if}
	</div>
	<div class="top-actions">
		<IconButton icon="sparkle" label={tr('Tanya')} href="/tanya" />
		<IconButton icon="bell" label={tr('Notifikasi')} href="/kotak-masuk/notifikasi" />
		<IconButton icon="gear" label={tr('Pengaturan')} href="/pengaturan" />
		<a class="avatar" href="/ruang" aria-label={trf('Ganti ruang: {ruang}', { ruang: spaceName })}>
			<InitialsTile name={spaceName || '?'} size={40} round />
		</a>
	</div>
</header>

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if loading}
	<div class="loading" aria-busy="true">
		<Skeleton rows={2} />
		<Skeleton rows={3} />
	</div>
{:else if data.loadError || !s}
	<ErrorState
		text={tr(data.loadError ?? 'Beranda tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<div class="two-col">
		<div class="main-col">
			<HeroAmount
				label={trf('Pengeluaran {bulan}', { bulan: monthName })}
				amountMinor={s.spentMinor}
				currency={s.currency}
				fallback={tr(TOO_LARGE)}
				pro={hasProLook(data.shell.plan)}
			>
				{#snippet beside()}
					{#if welcome}
						<!-- FN-51: Koko waves hello once per WIB day in the installed app; no copy (Koko never speaks). -->
						<span class="welcome" data-welcome><Mascot pose="wave" size={32} /></span>
					{/if}
				{/snippet}
				<CompareLine
					currentMinor={s.spentMinor}
					diffMinor={s.diffMinor}
					monthName={lastMonthName}
				/>
				{#if s.otherCurrencies.length > 0}
					<p class="other num">
						{trf('Ditambah {jumlah} dalam mata uang lain', {
							jumlah: s.otherCurrencies.map((c) => money(c.outMinor, c.currency)).join(' + ')
						})}
					</p>
				{/if}
			</HeroAmount>

			{#if s.walletCount === 0}
				<!-- FN-40/FN-44: the very first screen, before any wallet exists — Koko waves hello. -->
				<section class="first-wallet" aria-labelledby="first-wallet-title">
					<Mascot pose="wave" size={88} />
					<div class="first-wallet-text">
						<h2 id="first-wallet-title">{tr('Belum ada dompet')}</h2>
						<p>{tr('Tambah dompet pertamamu supaya setiap transaksi punya tempat.')}</p>
						<a class="first-wallet-link" href="/dompet?tambah=1">{tr('Tambah dompet')}</a>
					</div>
				</section>
			{/if}

			<section class="charts" aria-labelledby="charts-title">
				<h2 id="charts-title" class="sr-only">{tr('Grafik pengeluaran')}</h2>
				<div class="chart-head">
					{#if s.avgPerDayMinor !== null}
						<p class="avg num">
							{@render rich(
								richParts(tr('rata-rata {jumlah}/hari'), {
									jumlah: compact(s.avgPerDayMinor, s.currency)
								})
							)}
						</p>
					{/if}
					<label class="picker">
						<span class="sr-only">{tr('Grafik pengeluaran')}</span>
						<select bind:value={chart}>
							{#each chartOptions as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
						<Icon name="chevron-down" size={14} />
					</label>
				</div>
				{#if chartTooLarge}
					<p class="muted">{tr(TOO_LARGE)}</p>
				{:else if chartEmpty}
					<p class="muted">{tr('Belum ada transaksi bulan ini.')}</p>
				{:else if chart === 'daily'}
					<BarChart
						days={bars}
						label={tr('Pengeluaran 14 hari terakhir')}
						currency={s.currency}
						today={bars.length - 1}
						{dayLink}
					/>
				{:else if chart === 'category'}
					<CategoryBar
						label={tr('Pengeluaran per kategori')}
						parts={s.categories.map((c) => ({ category: c.tileKey, minor: c.minor ?? 0 }))}
					/>
					<ul class="legend">
						{#each s.categories as c (c.key)}
							<li>
								<CategoryTile category={c.tileKey} size={36} />
								<span class="name">
									{c.name === null
										? tr('Tanpa kategori')
										: categoryLabel({ name: c.name, isPreset: c.isPreset }, tr)}
								</span>
								<span class="num">{money(c.minor, s.currency)}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<MonthLines
						label={tr('Bulan ini dibanding bulan lalu')}
						thisMonth={nums(s.lines.thisMonth)}
						lastMonth={nums(s.lines.lastMonth)}
					/>
					<p class="lines-key">
						<span class="key this">{monthName}</span>
						<span class="key last">{lastMonthName}</span>
					</p>
				{/if}
			</section>

			<div class="budget">
				{#if s.budget && s.safeToSpend}
					<ProgressBar
						percent={budgetUsedPercent(s.budget.amountMinor, s.safeToSpend)}
						label={tr('Anggaran terpakai')}
						tone={s.safeToSpend.kind === 'left' ? 'ink' : 'over'}
					/>
				{/if}
				{#if s.safeToSpend?.kind === 'left'}
					<p class="safe num">
						{@render rich(
							richParts(tr('{sisa} tersisa · {per_hari} sehari untuk {hari} hari'), {
								sisa: compact(s.safeToSpend.remainingMinor, budgetCurrency),
								per_hari: compact(s.safeToSpend.perDayMinor, budgetCurrency),
								hari: s.safeToSpend.days
							})
						)}
					</p>
				{:else if s.safeToSpend?.kind === 'spent'}
					<p class="safe over">{tr('Anggaran bulan ini sudah habis.')}</p>
				{:else if s.safeToSpend?.kind === 'over' && s.safeToSpend.overMinor === null}
					<p class="safe over">{tr('Sudah melebihi anggaran.')}</p>
				{:else if s.safeToSpend?.kind === 'over' && s.safeToSpend.overMinor !== null}
					<p class="safe over num">
						{trf('Sudah melebihi anggaran sebesar {jumlah}', {
							jumlah: compact(s.safeToSpend.overMinor, budgetCurrency)
						})}
					</p>
				{/if}
				<div class="budget-links">
					<a class="budget-link" href="/?anggaran=1" onclick={openBudget}>
						{s.budget ? tr('Ubah anggaran') : tr('Atur anggaran')}
					</a>
					<!-- The phone's way to the Anggaran page (the sidebar links it on desktop). -->
					<a class="budget-link" href="/anggaran">{tr('Lihat anggaran')}</a>
				</div>
			</div>

			{#if showInline}
				<section class="inline-form" aria-labelledby="budget-inline-title">
					<h2 id="budget-inline-title">{tr('Anggaran bulanan')}</h2>
					{@render budgetForm(s)}
					<a class="cancel" href="/">{tr('Batal')}</a>
				</section>
			{/if}

			<!-- FN-15: "Struk" opens the receipt reader when the AI Gateway is configured (the page itself asks for
			     the user's own key); otherwise it stays disabled with the reason (never a button that pretends to
			     work). Suara stays the primary action. -->
			<div class="capture">
				{#if data.receiptReady}
					<Button variant="secondary" size="lg" full icon="receipt" href="/riwayat/struk"
						>{tr('Struk')}</Button
					>
				{:else}
					<Button
						variant="secondary"
						size="lg"
						full
						disabled
						icon="receipt"
						describedby="capture-soon"
					>
						{tr('Struk')}
					</Button>
				{/if}
				<Button size="lg" full icon="mic" href="/riwayat/suara?mulai=1">{tr('Suara')}</Button>
			</div>
			{#if !data.receiptReady}
				<p id="capture-soon" class="soon">{tr('Pembacaan struk dengan AI belum dikonfigurasi.')}</p>
			{/if}
		</div>

		<div class="side-col">
			<section class="today card" aria-labelledby="today-title">
				<p class="eyebrow">{todayLine}</p>
				<h2 id="today-title">{tr('Hari ini')}</h2>
				{#if s.todayGroup}
					<!-- A day with only transfers or balance adjustments (FN-37) has no money: Rp 0 spent. -->
					{#each s.todayGroup.totals.length > 0 ? s.todayGroup.totals : [{ currency: s.currency, inMinor: 0, outMinor: 0 }] as total (total.currency)}
						<p class="today-line num">
							{tr('Pengeluaran hari ini')}
							<strong>
								{total.outMinor === null
									? tr(TOO_LARGE)
									: money(-Math.abs(total.outMinor), total.currency)}
							</strong>
							{#if total.inMinor !== null && total.inMinor > 0}
								· <span class="in"
									>{shown(formatMoney(total.inMinor, total.currency, 'signed', locale))}</span
								>
							{/if}
						</p>
					{/each}
					<p class="today-count">
						{trf('{n} transaksi tercatat hari ini', {
							n: s.todayGroup.rows.length + (s.todayHasMore ? '+' : '')
						})}
					</p>
				{:else}
					<p class="today-line">{tr('Belum ada transaksi hari ini.')}</p>
				{/if}
				{#if data.streak && !data.streak.closedToday}
					<!-- FN-34: closing needs nothing (owner decision B); the day's list stays one tap away. -->
					<a class="today-link" href={s.todayGroup ? dayHref(data.today) : '/riwayat/baru'}>
						{s.todayGroup ? tr('Lihat transaksi hari ini') : tr('Catat transaksi')}
					</a>
					<form method="POST" action="?/closeDay" use:enhance={track('close')}>
						<Button type="submit" size="lg" full disabled={busy !== ''}>
							{busy === 'close' ? tr('Menutup…') : tr('Tutup hari ini')}
						</Button>
					</form>
				{:else}
					{#if data.streak}
						<p class="closed" role="status">
							<!-- FN-44: Koko celebrates only right after the server closed the day, not on a later load. -->
							{#if dayClosedCelebrates(form)}<Mascot pose="celebrate" size={40} />{/if}
							<Icon name="check" size={18} />
							{trf('Hari ini ditutup · {berturut}', { berturut: streakText })}
						</p>
					{:else}
						<p class="today-count">{tr('Tutup hari belum bisa dimuat.')}</p>
					{/if}
					{#if s.todayGroup}
						<Button variant="secondary" full href={dayHref(data.today)}>
							{tr('Lihat transaksi hari ini')}
						</Button>
					{:else}
						<Button variant="secondary" full href="/riwayat/baru">{tr('Catat transaksi')}</Button>
					{/if}
				{/if}
			</section>

			<a class="features" href="/pengaturan/fitur" aria-haspopup="dialog" onclick={openFiturSheet}>
				<Icon name="grid" size={16} />{tr('Jelajahi fitur')}
			</a>

			<section class="list" aria-labelledby="recent-title">
				<div class="section-head">
					<h2 id="recent-title">{tr('Terbaru')}</h2>
					<a class="see-all" href="/riwayat">{tr('Lihat semua')}</a>
				</div>
				{#if data.lists === null}
					<p class="muted">{tr('Tidak bisa dimuat')}</p>
				{:else if data.lists.recent.length === 0}
					<p class="muted">{tr('Belum ada transaksi.')}</p>
				{:else}
					<GroupList records>
						{#each data.lists.recent as row (row.id)}
							<TransactionRow
								title={rowTitle(row, i18n)}
								meta={rowMeta(row, i18n, { withDate: true })}
								amountMinor={signedAmount(row)}
								currency={row.currency}
								category={row.category?.tileKey ?? 'lain'}
								kind={row.type}
								label={rowKindLabel(row, i18n)}
								status={row.isDemo ? tr('Data demo') : undefined}
								share={rowShare(row, i18n)}
								href="/riwayat/{row.id}/edit"
							/>
						{/each}
					</GroupList>
				{/if}
			</section>

			<section class="list" aria-labelledby="upcoming-title">
				<div class="section-head">
					<h2 id="upcoming-title">{tr('Akan datang')}</h2>
					<a class="see-all" href="/langganan">{tr('Lihat semua')}</a>
				</div>
				{#if data.lists === null}
					<p class="muted">{tr('Tidak bisa dimuat')}</p>
				{:else if data.lists.upcoming.length === 0}
					<p class="muted">{tr('Tidak ada tagihan dalam 7 hari ke depan.')}</p>
				{:else}
					<GroupList>
						{#each data.lists.upcoming as bill (bill.id)}
							<GroupRow href="/langganan">
								<BrandBadge name={bill.name} size={40} round />
								<span class="bill-text">
									<span class="bill-title">{bill.name}</span>
									<span class="bill-meta">
										{dueLabel(bill.inDays)} · {formatShortDay(bill.nextChargeOn, locale)}
									</span>
									{#if bill.isDemo}<StatusTag>{tr('Data demo')}</StatusTag>{/if}
								</span>
								<span class="bill-amount num">{money(-bill.amountMinor, bill.currency)}</span>
							</GroupRow>
						{/each}
					</GroupList>
				{/if}
			</section>
		</div>
	</div>
{/if}

<Sheet bind:open={sheetOpen} title={tr('Anggaran bulanan')} onclose={onSheetClose}>
	{#if sheetOpen && s}
		<FormBanner message={banner} />
		{@render budgetForm(s)}
	{/if}
</Sheet>

<style>
	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 0 8px;
	}
	.when {
		display: grid;
		justify-items: start;
		gap: 6px;
	}
	.date {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.chip-link {
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		min-height: 44px;
		margin-block: -10px;
		border-radius: var(--r-pill);
		text-decoration: none;
	}
	.chip-link:focus-visible {
		outline: none;
	}
	.chip-link:focus-visible .day-chip {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.day-chip {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 10px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		/* One line in the fixed-height pill (QA FN-34 #1): long counts or English cut with an ellipsis. */
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.top-actions {
		display: flex;
		gap: 8px;
	}
	.avatar {
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		border-radius: var(--r-pill);
	}
	/*
	 * Phone: the date and the four 44 px actions share the first row (the date may wrap), the streak chip gets
	 * its own full-width row so its text is never cut ("berturut-turut" fits at 360 px).
	 */
	@media (max-width: 600px) {
		.topbar {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: center;
			gap: 4px 12px;
		}
		.when {
			display: contents;
		}
		.date {
			grid-column: 1;
			grid-row: 1;
			min-width: 0;
		}
		.chip-link {
			grid-column: 1 / -1;
			grid-row: 2;
			justify-self: start;
		}
		.top-actions {
			grid-column: 2;
			grid-row: 1;
			gap: 4px;
		}
		.top-actions :global(.icon-btn) {
			width: 44px;
			height: 44px;
		}
	}
	/* The sidebar carries these on desktop. */
	@media (min-width: 1024px) {
		.top-actions {
			display: none;
		}
		.topbar {
			padding-top: 32px;
		}
	}
	.two-col {
		display: grid;
		gap: 28px;
	}
	.main-col,
	.side-col {
		display: grid;
		align-content: start;
		gap: 20px;
		min-width: 0;
	}
	@media (min-width: 1200px) {
		.two-col {
			grid-template-columns: minmax(0, 740px) minmax(300px, 420px);
			gap: 40px;
		}
	}
	.capture {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	/* Side by side at 360 px: a little less padding than the kit's large pill. */
	.capture :global(.btn) {
		gap: 6px;
		padding: 0 8px;
	}
	/* Not available is said in words (the line below), not by fading the label below AA contrast. */
	.capture :global(.btn:disabled) {
		opacity: 1;
		color: var(--muted);
	}
	.soon {
		margin: -12px 0 0;
		text-align: center;
		font-size: 13px;
		color: var(--muted);
	}
	.loading {
		display: grid;
		gap: 24px;
		padding: 24px 0;
	}
	.other {
		margin: 0;
	}
	.chart-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.avg {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.avg strong,
	.safe strong {
		color: var(--ink);
	}
	.picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin-left: auto;
		color: var(--ink);
	}
	.picker select {
		appearance: none;
		min-height: 36px;
		padding: 0 32px 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
		font-weight: 600;
		cursor: pointer;
	}
	@media (pointer: coarse) {
		.picker select {
			min-height: 44px;
		}
	}
	.picker :global(svg) {
		position: absolute;
		right: 12px;
		pointer-events: none;
	}
	.budget {
		display: grid;
		justify-items: start;
		gap: 6px;
	}
	.safe {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.over {
		color: var(--money-up);
		font-weight: 600;
	}
	.budget-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 20px;
	}
	/* One text-link look for every in-content link on this page: underlined, never bold like a heading. */
	.budget-link,
	.cancel,
	.today-link,
	.see-all {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 14px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.budget-link:hover,
	.cancel:hover,
	.today-link:hover,
	.see-all:hover {
		color: var(--ink);
	}
	.ok {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.inline-form {
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.inline-form h2 {
		margin: 0 0 12px;
	}
	.muted {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.muted {
		padding: 8px 4px;
	}
	.charts {
		display: grid;
		gap: 12px;
	}
	.first-wallet {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.first-wallet-text {
		display: grid;
		justify-items: start;
		gap: 4px;
		min-width: 0;
	}
	.first-wallet h2 {
		font-size: 17px;
	}
	.first-wallet p {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.first-wallet-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 4px;
		padding: 0 18px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-decoration: none;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.card {
		display: grid;
		gap: 6px;
		padding: 18px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	/* A grey button inside the grey card: one step darker so it stays visible. */
	.card :global(.btn.secondary) {
		background: var(--panel-2);
	}
	.eyebrow {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}
	.today-line {
		margin: 0;
		font-size: 15px;
		color: var(--ink-2);
	}
	.today-line strong {
		color: var(--ink);
	}
	.today-count {
		margin: 0 0 8px;
		font-size: 13px;
		color: var(--muted);
	}
	.in {
		color: var(--money-in);
	}
	.today-link {
		justify-self: start;
	}
	.closed {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 8px;
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}
	.closed :global(svg) {
		flex: none;
		color: var(--money-in);
	}
	.features {
		display: inline-flex;
		align-items: center;
		justify-self: center;
		gap: 6px;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
	}
	.list {
		display: grid;
		gap: 8px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	/* The meta line keeps wallet and category on a phone: two lines instead of an ellipsis. */
	@media (max-width: 600px) {
		.list :global(.meta) {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			white-space: normal;
		}
	}
	.bill-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.bill-title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.bill-meta {
		font-size: 13px;
		color: var(--muted);
	}
	.bill-amount {
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	.legend {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.legend .name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.lines-key {
		display: flex;
		gap: 16px;
		margin: 0;
		font-size: 14px;
	}
	.key::before {
		content: '';
		display: inline-block;
		width: 14px;
		height: 3px;
		margin-right: 6px;
		vertical-align: middle;
		border-radius: 2px;
	}
	.key.this::before {
		background: var(--accent);
	}
	.key.last {
		color: var(--muted);
	}
	.key.last::before {
		background: var(--faint);
	}
	/* FN-51: the streak chip hops once when the count grows on this page; Koko's welcome wave runs one cycle. */
	.welcome {
		display: grid;
		flex: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		.day-chip.hop {
			animation: chip-hop var(--duration-slow) var(--spring);
		}
		.welcome :global(.pose-wave .strip) {
			animation-iteration-count: 1;
		}
	}
	@keyframes chip-hop {
		50% {
			transform: translateY(-3px);
		}
	}
</style>
