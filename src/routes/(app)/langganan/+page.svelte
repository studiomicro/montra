<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { minorToAmountText } from '#lib/shared/amount-input';
	import { daysBetween, formatShortDay } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		BILLING_CYCLE_LABELS,
		isoWeekday,
		REMINDER_DAYS_DEFAULT,
		WEEKDAY_LABELS,
		type BillingSchedule,
		type SubscriptionFormValues
	} from '#lib/shared/subscriptions';
	import { catalogueEntry, type CatalogueEntry } from '#lib/shared/subscriptions-catalogue';
	import {
		candidateFormValues,
		type SubscriptionCandidate
	} from '#lib/shared/subscriptions-detect';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import PageAction from '#lib/ui/shell/PageAction.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import CandidateList from '#lib/ui/subscriptions/CandidateList.svelte';
	import CataloguePicker from '#lib/ui/subscriptions/CataloguePicker.svelte';
	import CheckCard from '#lib/ui/subscriptions/CheckCard.svelte';
	import PayForm from '#lib/ui/subscriptions/PayForm.svelte';
	import SubscriptionForm from '#lib/ui/subscriptions/SubscriptionForm.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	type Subscription = (typeof data.subscriptions)[number];

	/** A blank add form: from a catalogue entry (name and category copied) or a typed name. */
	const blank = (entry: CatalogueEntry | null): SubscriptionFormValues => ({
		catalogueId: entry?.id ?? '',
		name: entry?.name ?? '',
		category: entry?.category ?? 'lainnya',
		amount: '',
		currency: 'IDR',
		cycle: 'monthly',
		day: String(Number(data.today.slice(8))),
		weekday: String(isoWeekday(data.today)),
		month: String(Number(data.today.slice(5, 7))),
		walletId: '',
		reminderDays: String(REMINDER_DAYS_DEFAULT)
	});
	const valuesOf = (s: Subscription): SubscriptionFormValues => ({
		catalogueId: s.catalogueId ?? '',
		name: s.name,
		category: s.category,
		amount: minorToAmountText(s.amountMinor, s.currency, locale),
		currency: s.currency,
		cycle: s.schedule.cycle,
		day: s.schedule.cycle === 'weekly' ? blank(null).day : String(s.schedule.day),
		weekday: s.schedule.cycle === 'weekly' ? String(s.schedule.day) : blank(null).weekday,
		month: String(s.schedule.month ?? Number(data.today.slice(5, 7))),
		walletId: s.walletId ?? '',
		reminderDays: String(s.reminderDaysBefore)
	});

	const fromCandidate = (c: SubscriptionCandidate) => candidateFormValues(c, locale);
	const candidate = (key: string | null) => data.candidates.find((c) => c.matchKey === key);

	type SheetState =
		| { kind: 'check' }
		| { kind: 'pick' }
		| { kind: 'add'; values: SubscriptionFormValues }
		| { kind: 'edit'; sub: Subscription }
		| { kind: 'pay'; sub: Subscription };

	// With JavaScript the forms open in a sheet; without it, `?tambah=…` / `?ubah=<id>` / `?bayar=<id>` (and a
	// refused submission) render the same forms inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let sheet = $state<SheetState>({ kind: 'pick' });
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	let payError = $state('');
	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openSheet(next: SheetState) {
		sheet = next;
		fieldErrors = {};
		payError = '';
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	const intercept = (next: () => SheetState) => (event: MouseEvent) => {
		event.preventDefault();
		openSheet(next());
	};
	const live = (id: string | null) => data.subscriptions.find((s) => s.id === id);

	onMount(() => {
		hydrated = true;
		const { add, edit, pay, check, fromCheck } = data.open;
		const c = candidate(fromCheck);
		if (check) openSheet({ kind: 'check' });
		else if (c) openSheet({ kind: 'add', values: fromCandidate(c) });
		else if (add === '1') openSheet({ kind: 'pick' });
		else if (add) openSheet({ kind: 'add', values: blank(catalogueEntry(add)) });
		else if (edit && live(edit)) openSheet({ kind: 'edit', sub: live(edit) as Subscription });
		else if (pay && live(pay)) openSheet({ kind: 'pay', sub: live(pay) as Subscription });
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		const keys = ['tambah', 'ubah', 'bayar', 'periksa', 'kandidat'];
		if (keys.some((k) => url.searchParams.has(k))) {
			for (const k of keys) url.searchParams.delete(k);
			replaceState(url, {});
		}
	}

	/** Shows success only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			payError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update();
				if (result.type === 'failure') {
					fieldErrors =
						((result.data?.errors ?? result.data?.payErrors) as Partial<Record<string, string>>) ??
						{};
					payError = typeof result.data?.payError === 'string' ? result.data.payError : '';
					// Changed or gone meanwhile: show the list, and an open form, as they are now.
					if (result.status === 404 || result.status === 409) {
						await invalidateAll();
						if (sheet.kind === 'edit' || sheet.kind === 'pay') {
							const fresh = live(sheet.sub.id);
							if (fresh) {
								sheet = { kind: sheet.kind, sub: fresh };
								formKey++;
							} else sheetOpen = false;
						}
					}
				} else if (result.type === 'success' && closeSheet) {
					sheetOpen = false;
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

	const savedText: Record<string, string> = {
		created: msg('Langganan ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		deleted: msg('Langganan dihapus.'),
		paid: msg('Dicatat sudah dibayar. Tagihan berikutnya sudah diperbarui.'),
		dismissed: msg('Ditandai bukan langganan. Tidak akan ditawarkan lagi.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const dismissed = $derived(!!form && 'saved' in form && form.saved === 'dismissed');
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by((): SheetState | null => {
		if (form && 'action' in form && form.action) {
			if (form.action === 'create') return { kind: 'add', values: form.values };
			const sub = live(form.subscriptionId ?? null);
			return sub ? { kind: 'edit', sub } : null;
		}
		if (form && 'payFor' in form && form.payFor) {
			const sub = live(form.payFor);
			return sub ? { kind: 'pay', sub } : null;
		}
		const { add, edit, pay, check, fromCheck } = data.open;
		const c = candidate(fromCheck);
		if (check) return { kind: 'check' };
		if (c) return { kind: 'add', values: fromCandidate(c) };
		if (add === '1') return { kind: 'pick' };
		if (add) return { kind: 'add', values: blank(catalogueEntry(add)) };
		if (edit && live(edit)) return { kind: 'edit', sub: live(edit) as Subscription };
		if (pay && live(pay)) return { kind: 'pay', sub: live(pay) as Subscription };
		return null;
	});
	const inlineErrors = $derived(
		form && 'errors' in form && form.errors
			? (form.errors as Partial<Record<string, string>>)
			: form && 'payErrors' in form && form.payErrors
				? (form.payErrors as Partial<Record<string, string>>)
				: {}
	);
	const inlinePayError = $derived(form && 'payError' in form ? (form.payError ?? '') : '');

	const sheetTitle = (s: SheetState) =>
		s.kind === 'check'
			? tr('Kemungkinan langganan')
			: s.kind === 'pick'
				? tr('Pilih layanan')
				: s.kind === 'add'
					? tr('Tambah langganan')
					: s.kind === 'edit'
						? tr('Ubah langganan')
						: tr('Tandai sudah dibayar');

	/** The row's short schedule: "tgl 8", "Jumat", "3 Nov" (the cycle word comes before it). */
	const shortSchedule = (s: BillingSchedule) =>
		s.cycle === 'monthly'
			? trf('tgl {tanggal}', { tanggal: s.day })
			: s.cycle === 'weekly'
				? tr(WEEKDAY_LABELS[s.day - 1] as string)
				: // A leap year, so 29 February is a valid date to format.
					formatShortDay(
						`2028-${String(s.month).padStart(2, '0')}-${String(s.day).padStart(2, '0')}`,
						locale
					);
	/** The due chip: "Hari ini" / "Besok" when it is that close, otherwise the date. */
	const dueText = (next: string) => {
		const left = daysBetween(data.today, next);
		if (left === 0) return tr('Hari ini');
		if (left === 1) return tr('Besok');
		return formatShortDay(next, locale);
	};
	const totalText = (t: { currency: string; totalMinor: number | null }) =>
		t.totalMinor === null
			? tr('Total terlalu besar untuk ditampilkan')
			: `≈ ${formatMoney(t.totalMinor, t.currency)}`;
	const main = $derived(data.totals[0] ?? null);
	const others = $derived(data.totals.slice(1));
</script>

<svelte:head><title>{tr('Langganan')}</title></svelte:head>
<ScreenTitle
	title={tr('Langganan')}
	subtitle={data.loadError ? undefined : trf('{n} langganan', { n: data.subscriptions.length })}
>
	{#snippet actions()}
		{#if !data.loadError && data.subscriptions.length > 0}
			<PageAction
				at="header"
				href="/langganan?tambah=1"
				icon="plus"
				onclick={intercept(() => ({ kind: 'pick' }))}>{tr('Tambah langganan')}</PageAction
			>
		{/if}
	{/snippet}
</ScreenTitle>

{#if data.hiddenModules.includes('langganan')}
	<p class="hidden-note">
		{tr('Langganan disembunyikan dari menu. Angkanya tetap dihitung.')}
		<a href="/pengaturan/fitur">{tr('Tampilkan lagi di menu')}</a>
	</p>
{/if}

{#snippet sheetBody(s: SheetState, errors: Partial<Record<string, string>>, payErr: string)}
	{#if s.kind === 'check'}
		{#if dismissed && sheetOpen}<p class="ok" role="status">{saved}</p>{/if}
		<CandidateList
			candidates={data.candidates}
			{busy}
			onadd={hydrated ? (c) => openSheet({ kind: 'add', values: fromCandidate(c) }) : undefined}
			dismiss={(key) => track(`dismiss:${key}`)}
		/>
	{:else if s.kind === 'pick'}
		<CataloguePicker
			onpick={hydrated ? (entry) => openSheet({ kind: 'add', values: blank(entry) }) : undefined}
		/>
	{:else if s.kind === 'add'}
		<SubscriptionForm
			action="?/createSubscription"
			values={s.values}
			{errors}
			busy={busy !== ''}
			wallets={data.wallets}
			submit={track('create', true)}
		/>
	{:else if s.kind === 'edit'}
		{#if s.sub.linked}
			<p class="last-paid">
				{trf('Terakhir dibayar {tanggal}', {
					tanggal: formatShortDay(s.sub.linked.occurredOn, locale)
				})}
			</p>
		{/if}
		<SubscriptionForm
			action="?/updateSubscription"
			subscription={s.sub}
			values={valuesOf(s.sub)}
			{errors}
			busy={busy !== ''}
			wallets={data.wallets}
			submit={track('update', true)}
		/>
		<details class="confirm">
			<summary>{tr('Hapus langganan')}</summary>
			<form method="POST" action="?/deleteSubscription" use:enhance={track('delete', true)}>
				<input type="hidden" name="subscriptionId" value={s.sub.id} />
				<input type="hidden" name="updatedAt" value={s.sub.updatedAt} />
				<p>
					{tr('Langganan ini dihapus dari daftar. Transaksi yang sudah dicatat tetap ada.')}
				</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'delete' ? tr('Memproses…') : tr('Ya, hapus')}
				</Button>
			</form>
		</details>
	{:else}
		<PayForm
			subscription={s.sub}
			wallets={data.wallets}
			categories={data.categories}
			expenses={data.expenses}
			today={data.today}
			{errors}
			error={payErr || undefined}
			busy={busy !== ''}
			submit={track('pay', true)}
		/>
	{/if}
{/snippet}

{#snippet checkBlock()}
	<CheckCard candidates={data.candidates} onopen={intercept(() => ({ kind: 'check' }))} />
	<div class="add-full">
		<Button
			href="/langganan?tambah=1"
			variant="secondary"
			icon="plus"
			full
			onclick={intercept(() => ({ kind: 'pick' }))}>{tr('Tambah langganan')}</Button
		>
	</div>
{/snippet}

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if !hydrated && inline}
	<section class="inline-form" aria-labelledby="inline-title">
		<h2 id="inline-title">{sheetTitle(inline)}</h2>
		{@render sheetBody(inline, inlineErrors, inlinePayError)}
		<a class="cancel" href="/langganan">{tr('Batal')}</a>
	</section>
{/if}

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.subscriptions.length === 0}
	<EmptyState
		illustration="calendar"
		text={`${tr('Belum ada langganan. Catat tagihan rutin supaya tidak kelewatan.')} ${tr('Streaming, musik, paket data, internet, listrik — catat berapa yang keluar tiap bulan.')}`}
	/>
	{@render checkBlock()}
{:else}
	{#if main}
		<section class="hero" aria-labelledby="total-label">
			<p id="total-label" class="label">{tr('Perkiraan biaya per bulan')}</p>
			<p class="figure num">{totalText(main)}</p>
			{#if others.length > 0}
				<p class="other num">
					{trf('Ditambah {jumlah} dalam mata uang lain', {
						jumlah: others.map(totalText).join(' + ')
					})}
				</p>
			{/if}
			<p class="note">
				{tr('Tahunan dibagi 12 dan mingguan dikali 52 lalu dibagi 12, jadi angkanya perkiraan.')}
			</p>
		</section>
	{/if}

	{@render checkBlock()}

	<section aria-labelledby="list-title">
		<h2 id="list-title">{tr('Tagihan berikutnya')}</h2>
		<GroupList records>
			{#each data.subscriptions as sub (sub.id)}
				<GroupRow>
					<a
						class="open"
						href="/langganan?ubah={sub.id}"
						onclick={intercept(() => ({ kind: 'edit', sub }))}
					>
						<BrandBadge name={sub.name} />
						<!-- Two lines at 360 px: name and schedule left, amount and due date right (a long name takes the first line
						     and wraps; the amount then sits below it). -->
						<span class="body">
							<span class="line first">
								<span class="title">
									<span class="name">{sub.name}</span>
									{#if sub.isDemo}<StatusTag>{tr('Data demo')}</StatusTag>{/if}
								</span>
								<span class="amount num">{formatMoney(sub.amountMinor, sub.currency)}</span>
							</span>
							<span class="line">
								<span class="meta">
									{tr(BILLING_CYCLE_LABELS[sub.schedule.cycle])} · {shortSchedule(sub.schedule)}
								</span>
								<span class="due" class:soon={daysBetween(data.today, sub.nextChargeOn) <= 1}>
									<span class="sr-only">{tr('Jatuh tempo')}</span>
									{dueText(sub.nextChargeOn)}
								</span>
							</span>
						</span>
						<span class="sr-only">{tr('Ubah')}</span>
					</a>
					{#if !sub.isDemo}
						<a
							class="pay"
							href="/langganan?bayar={sub.id}"
							onclick={intercept(() => ({ kind: 'pay', sub }))}
							aria-label={trf('Tandai {nama} sudah dibayar', { nama: sub.name })}
						>
							<Icon name="check" size={20} />
						</a>
					{/if}
				</GroupRow>
			{/each}
		</GroupList>
	</section>
	<PageAction
		at="bottom"
		href="/langganan?tambah=1"
		icon="plus"
		onclick={intercept(() => ({ kind: 'pick' }))}>{tr('Tambah langganan')}</PageAction
	>
{/if}

<Sheet bind:open={sheetOpen} title={sheetTitle(sheet)} onclose={onSheetClose}>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render sheetBody(sheet, fieldErrors, payError)}
		{/key}
	{/if}
</Sheet>

<style>
	section {
		margin-top: 8px;
	}
	h2 {
		margin: 24px 0 10px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	/* One big number first (§ 2 HeroAmount scale), left-aligned on the page, no card. */
	.hero {
		display: grid;
		gap: 6px;
		padding: 8px 0;
	}
	.hero .label,
	.hero .note,
	.hero .other {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	.hero .note {
		max-width: 52ch;
		font-size: 13px;
	}
	.figure {
		margin: 0;
		font-size: 44px;
		font-weight: 700;
		line-height: 1.05;
		letter-spacing: -0.04em;
		overflow-wrap: anywhere;
	}
	@media (min-width: 1024px) {
		.figure {
			font-size: 52px;
		}
	}
	.open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	/* Two lines, each its own row: name | amount, then schedule | due chip (the schedule gets the room the
	   amount does not need on the second line). A name too long to sit beside the amount gets its own line. */
	.body {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}
	.title {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	/* Name and amount share the first line when the name fits beside it; otherwise the amount wraps below. */
	.first {
		flex-wrap: wrap;
	}
	.first .amount {
		margin-left: auto;
	}
	.title :global(.tag) {
		flex: none;
	}
	/* A long name keeps the whole first line and wraps to a second one (then an ellipsis), never cut to a few
	   letters at 360 px; the amount then moves to its own line, right-aligned (.first). */
	.name {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.meta {
		overflow: hidden;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.amount {
		flex: none;
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	/* The due date as a small chip; today or tomorrow in ink. */
	.due {
		flex: none;
		padding: 1px 7px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
	}
	.due.soon {
		background: var(--ink);
		color: var(--bg);
	}
	.add-full {
		margin-top: 12px;
	}
	.last-paid {
		margin: 0 0 12px;
		font-size: 14px;
		color: var(--muted);
	}
	.pay {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	/* No-JavaScript form: on the page colour, so its panel-filled inputs stay visible. */
	.inline-form {
		margin: 8px 0 24px;
	}
	.inline-form h2 {
		margin-top: 0;
	}
	.confirm {
		margin-top: 16px;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.hidden-note {
		margin: 4px 0 8px;
		font-size: 14px;
		color: var(--muted);
	}
	.hidden-note a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
