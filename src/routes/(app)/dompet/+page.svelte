<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import { minorToAmountText } from '#lib/shared/amount-input';
	import { cardAmountText } from '#lib/shared/cards';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import {
		EMONEY_FORM_TYPE,
		emoneyQuickPick,
		maskedLastFour,
		walletFormType,
		walletKindLabel,
		walletQuickPick,
		type EmoneyQuickPick,
		type WalletFormValues,
		type WalletQuickPick
	} from '#lib/shared/wallets';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import { richParts, type RichPart } from '#lib/ui/kit/rich';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import { nfcBridge } from '#lib/ui/emoney/nfc';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import GoalsSection from '#lib/ui/goals/GoalsSection.svelte';
	import WalletForm from '#lib/ui/wallets/WalletForm.svelte';
	import DueChip from '#lib/ui/cards/DueChip.svelte';

	let { data, form } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const { tr, trf, locale } = useI18n();

	type Wallet = (typeof data.wallets)[number];

	const active = $derived(data.wallets.filter((w) => !w.archived));
	const archived = $derived(data.wallets.filter((w) => w.archived));

	/**
	 * A new wallet's form; an FN-39 quick pick (`?dompet=<id>`) fills its name and the e-wallet type, an FN-58
	 * e-money pick (`?kartu=<issuer>`) its name, "Kartu e-money" and the issuer, and `&jenis=kartu_kredit` (FN-55a)
	 * starts it as a card.
	 */
	const blank = (
		prefill: WalletQuickPick | null = null,
		card = false,
		emoney: EmoneyQuickPick | null = null
	): WalletFormValues => ({
		name: prefill?.name ?? emoney?.name ?? '',
		type: prefill ? 'e_wallet' : emoney ? EMONEY_FORM_TYPE : card ? 'kartu_kredit' : 'tunai',
		currency: 'IDR',
		openingBalance: '',
		negative: false,
		isFavourite: false,
		lastFour: '',
		balanceMode: card && !prefill ? 'card' : 'plain',
		overpaid: false,
		creditLimit: '',
		statementDay: '',
		dueDay: '',
		emoneyIssuer: !prefill && emoney ? emoney.issuer : ''
	});
	/** FN-55a: a card is edited in card wording (the bill owed, with its sen); every other type as before. */
	const valuesOf = (w: Wallet): WalletFormValues => {
		const card = w.type === 'kartu_kredit';
		return {
			name: w.name,
			type: walletFormType(w),
			currency: w.currency,
			openingBalance: card
				? cardAmountText(Math.abs(w.openingBalanceMinor), w.currency, locale)
				: minorToAmountText(Math.abs(w.openingBalanceMinor), w.currency, locale),
			negative: w.openingBalanceMinor < 0,
			isFavourite: w.isFavourite,
			lastFour: w.lastFour ?? '',
			balanceMode: card ? 'card' : 'plain',
			overpaid: card && w.openingBalanceMinor > 0,
			creditLimit: cardAmountText(w.creditLimitMinor, w.currency, locale),
			statementDay: w.statementDay === null ? '' : String(w.statementDay),
			dueDay: w.dueDay === null ? '' : String(w.dueDay),
			emoneyIssuer: w.emoneyIssuer ?? ''
		};
	};
	/** FN-55a: each live card's summary (owed, available credit, due chip), by wallet id. */
	const cardOf = $derived(new Map(data.cards.map((c) => [c.walletId, c])));

	// With JavaScript the form opens in a sheet; without it, `?tambah=1` / `?ubah=<id>` (and a refused
	// submission) render the same form inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let editing = $state<Wallet | null>(null);
	let addPrefill = $state<WalletQuickPick | null>(null);
	let addCard = $state(false);
	let addEmoney = $state<EmoneyQuickPick | null>(null);
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openAdd() {
		editing = null;
		addPrefill = null;
		addCard = false;
		addEmoney = null;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	function openEdit(w: Wallet) {
		editing = w;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	const intercept = (fn: () => void) => (event: MouseEvent) => {
		event.preventDefault();
		fn();
	};

	// FN-58: the card reader row shows only inside the Android app, where the NFC bridge exists.
	let canReadCards = $state(false);

	onMount(() => {
		hydrated = true;
		canReadCards = nfcBridge() !== null;
		if (data.open === 'add') {
			openAdd();
			addPrefill = walletQuickPick(data.quickPick);
			addCard = data.addCard;
			addEmoney = emoneyQuickPick(data.emoneyPick);
		} else if (data.open) {
			const w = data.wallets.find((x) => x.id === data.open && !x.archived);
			if (w) openEdit(w);
		}
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('tambah') || url.searchParams.has('ubah')) {
			url.searchParams.delete('tambah');
			url.searchParams.delete('ubah');
			url.searchParams.delete('dompet');
			url.searchParams.delete('kartu');
			replaceState(url, {});
		}
	}

	/** Shows success only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update();
				if (result.type === 'failure') {
					fieldErrors = (result.data?.errors as Partial<Record<string, string>>) ?? {};
					// Changed or gone meanwhile: show the list, and an open edit form, as they are now.
					if (result.status === 404 || result.status === 409) {
						await invalidateAll();
						if (editing) {
							const id = editing.id;
							const fresh = data.wallets.find((w) => w.id === id && !w.archived);
							if (fresh) {
								editing = fresh;
								formKey++;
							}
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
		created: msg('Dompet ditambahkan.'),
		updated: msg('Perubahan disimpan.'),
		archived: msg('Dompet diarsipkan.'),
		restored: msg('Dompet dipulihkan.'),
		favourite: msg('Dompet favorit diganti.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by(() => {
		if (form && 'action' in form && form.action) {
			const wallet =
				form.action === 'update' ? active.find((w) => w.id === form.walletId) : undefined;
			if (form.action === 'update' && !wallet) return null;
			return { wallet: wallet ?? null, values: form.values, errors: form.errors };
		}
		if (data.open === 'add')
			return {
				wallet: null,
				values: blank(
					walletQuickPick(data.quickPick),
					data.addCard,
					emoneyQuickPick(data.emoneyPick)
				),
				errors: {}
			};
		const wallet = data.open ? active.find((w) => w.id === data.open) : undefined;
		return wallet ? { wallet, values: valuesOf(wallet), errors: {} } : null;
	});

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	/** A balance past the safe integer range is never rounded: it is named too large instead. */
	const balanceText = (w: Wallet) =>
		w.balanceMinor === null
			? tr(TOO_LARGE)
			: shown(formatMoney(w.balanceMinor, w.currency, 'auto', locale));

	const archivedHref = $derived(data.showArchived ? '/dompet' : '/dompet?arsip=1');

	/** The Tujuan section's (FN-10) part of the action result; the wallet keys above never carry it. */
	const goalResult = $derived(
		form && ('goalAction' in form || 'goalSaved' in form || 'goalError' in form) ? form : null
	);

	const hero = $derived(data.totals.find((t) => t.currency === data.heroCurrency) ?? null);
	const otherTotals = $derived(data.totals.filter((t) => t.currency !== data.heroCurrency));
	const setAside = $derived(data.setAside.find((g) => g.currency === data.heroCurrency) ?? null);
	const compact = (minor: number | null, currency: string) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoneyCompact(minor, currency, locale));
	/** A transfer needs two live wallets in the same currency (FN-05). */
	const canTransfer = $derived(
		active.some((w) => active.some((o) => o.id !== w.id && o.currency === w.currency))
	);
	/** "1 dompet" / "3 dompet": one phrase each, so English can say "1 wallet" and "3 wallets". */
	const walletCount = $derived(
		active.length === 1 ? tr('1 dompet') : trf('{n} dompet', { n: active.length })
	);
	const subtitle = $derived(
		data.loadError
			? undefined
			: data.space.kind === 'shared'
				? trf('{dompet} · Ruang {nama}', { dompet: walletCount, nama: data.space.name })
				: walletCount
	);
</script>

<svelte:head><title>{tr('Dompet')}</title></svelte:head>

{#snippet rich(parts: RichPart[])}
	{#each parts as part, i (i)}{#if part.strong}<strong>{part.text}</strong
			>{:else}{part.text}{/if}{/each}
{/snippet}

<ScreenTitle title={tr('Dompet')} {subtitle}>
	{#snippet actions()}
		{#if canTransfer}
			<Button variant="secondary" icon="transfer" href="/riwayat/baru?type=transfer">
				{tr('Transfer')}
			</Button>
		{:else}
			<Button variant="secondary" icon="transfer" disabled describedby="transfer-why">
				{tr('Transfer')}
			</Button>
		{/if}
		<Button icon="plus" href="/dompet?tambah=1" onclick={intercept(openAdd)}>
			{tr('Tambah dompet')}
		</Button>
	{/snippet}
</ScreenTitle>
{#if !canTransfer && !data.loadError}
	<p class="why" id="transfer-why">
		{tr('Transfer butuh dua dompet dengan mata uang yang sama.')}
	</p>
{/if}

{#snippet walletForm(
	wallet: Wallet | null,
	values: WalletFormValues,
	errors: Partial<Record<string, string>>
)}
	<WalletForm
		action={wallet ? '?/updateWallet' : '?/createWallet'}
		wallet={wallet ?? undefined}
		{values}
		{errors}
		busy={busy !== ''}
		firstWallet={active.length === 0}
		submit={track(wallet ? 'update' : 'create', true)}
	/>
	{#if wallet}
		<!-- FN-37: a dated, listed adjustment for "the real balance is now …" ("Saldo awal" stays the setup figure). -->
		<a class="adjust" href="/riwayat/baru?type=adjustment&wallet={wallet.id}">
			{tr('Sesuaikan saldo ke angka sebenarnya')}
		</a>
		<details class="confirm">
			<summary>{tr('Arsipkan dompet')}</summary>
			<form method="POST" action="?/archiveWallet" use:enhance={track('archive', true)}>
				<input type="hidden" name="walletId" value={wallet.id} />
				<input type="hidden" name="updatedAt" value={wallet.updatedAt} />
				<p>
					{tr('Dompet yang diarsipkan tidak tampil di daftar. Kamu bisa memulihkannya kapan saja.')}
				</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'archive' ? tr('Memproses…') : tr('Ya, arsipkan')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if !hydrated && inline}
	<section class="inline-form" aria-labelledby="inline-title">
		<h2 id="inline-title">{inline.wallet ? tr('Ubah dompet') : tr('Tambah dompet')}</h2>
		{@render walletForm(inline.wallet, inline.values, inline.errors)}
		<a class="cancel" href="/dompet">{tr('Batal')}</a>
	</section>
{/if}

<div class="two-col">
	<div class="main-col">
		{#if refreshing}
			<Skeleton rows={4} />
		{:else if data.loadError}
			<ErrorState text={tr(data.loadError)} onretry={retry} />
		{:else}
			{#if active.length > 0}
				<HeroAmount
					label={tr('Total saldo')}
					amountMinor={hero ? hero.totalMinor : 0}
					currency={data.heroCurrency}
					fallback={tr(TOO_LARGE)}
				>
					{#if setAside && setAside.savedMinor !== 0}
						<p class="num">
							{@render rich(
								richParts(tr('{jumlah} disisihkan untuk tujuan'), {
									jumlah: compact(setAside.savedMinor, setAside.currency)
								})
							)}
						</p>
					{/if}
					{#if otherTotals.length > 0}
						<p class="num">
							{trf('Ditambah {jumlah} dalam mata uang lain', {
								jumlah: otherTotals.map((t) => compact(t.totalMinor, t.currency)).join(' + ')
							})}
						</p>
					{/if}
				</HeroAmount>
			{/if}

			<section aria-labelledby="wallets-title">
				<h2 id="wallets-title">{tr('Dompet kamu')}</h2>
				{#if active.length === 0}
					<EmptyState
						illustration="wallet"
						text={tr('Belum ada dompet. Tambah satu untuk mulai mencatat.')}
						actionLabel={tr('Tambah dompet')}
						actionHref="/dompet?tambah=1"
						onaction={openAdd}
					/>
				{:else}
					<GroupList records>
						{#each active as wallet (wallet.id)}
							{@const card = cardOf.get(wallet.id)}
							<GroupRow>
								<!-- FN-55a: a card opens its card page (edit from there); every other wallet its edit form. -->
								<a
									class="open"
									href={card ? `/dompet/kartu/${wallet.id}` : `/dompet?ubah=${wallet.id}`}
									onclick={card ? undefined : intercept(() => openEdit(wallet))}
								>
									<BrandBadge name={wallet.name} round />
									<span class="text">
										<span class="name">
											<span class="name-text">{wallet.name}</span>
										</span>
										<span class="meta">
											{walletKindLabel(wallet, tr)}{#if wallet.lastFour}&nbsp;· <span
													class="num four">{maskedLastFour(wallet.lastFour)}</span
												>{/if}
										</span>
										{#if card?.available}
											<span class="meta num">
												{card.available.kind === 'over'
													? tr('Melebihi limit')
													: trf('Kredit tersedia {jumlah}', {
															jumlah:
																card.available.minor === null
																	? tr(TOO_LARGE)
																	: shown(
																			formatMoney(
																				card.available.minor,
																				wallet.currency,
																				'auto',
																				locale
																			)
																		)
														})}
											</span>
										{/if}
										{#if card?.due}<span class="due"><DueChip due={card.due} /></span>{/if}
									</span>
									<span class="end">
										<span class="kind" aria-hidden="true">{tr('Saldo')}</span>
										<span class="amount num">{balanceText(wallet)}</span>
									</span>
									<span class="sr-only">{card ? tr('Buka kartu') : tr('Ubah')}</span>
									<span class="chev" aria-hidden="true"
										><Icon name="chevron-right" size={18} /></span
									>
								</a>
								<!-- One 44 px slot on every row, so balances line up: the favourite's star, or the button that sets it. -->
								{#if wallet.isFavourite}
									<span class="star" title={tr('Favorit')}>
										<Icon name="star" size={20} />
										<span class="sr-only">{tr('Favorit')}</span>
									</span>
								{:else}
									<form
										method="POST"
										action="?/setFavourite"
										use:enhance={track(`fav-${wallet.id}`)}
									>
										<input type="hidden" name="walletId" value={wallet.id} />
										<button
											type="submit"
											class="fav"
											disabled={busy !== ''}
											aria-label={trf('Jadikan {nama} favorit', { nama: wallet.name })}
										>
											<Icon name="star" size={20} />
										</button>
									</form>
								{/if}
							</GroupRow>
						{/each}
					</GroupList>
				{/if}

				<a class="toggle" href={archivedHref}>
					{data.showArchived ? tr('Sembunyikan yang diarsipkan') : tr('Lihat yang diarsipkan')}
				</a>

				{#if data.showArchived}
					<h3 class="sub">{tr('Diarsipkan')}</h3>
					{#if archived.length === 0}
						<p class="meta">{tr('Tidak ada dompet yang diarsipkan.')}</p>
					{:else}
						<GroupList>
							{#each archived as wallet (wallet.id)}
								<GroupRow>
									<BrandBadge name={wallet.name} round />
									<span class="text">
										<span class="name">{wallet.name}</span>
										<span class="meta">
											{tr('Diarsipkan')} · {walletKindLabel(wallet, tr)}
										</span>
									</span>
									<span class="amount num muted">{balanceText(wallet)}</span>
									<form
										method="POST"
										action="?arsip=1&/restoreWallet"
										use:enhance={track(`restore-${wallet.id}`)}
									>
										<input type="hidden" name="walletId" value={wallet.id} />
										<input type="hidden" name="updatedAt" value={wallet.updatedAt} />
										<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
											{busy === `restore-${wallet.id}` ? tr('Memproses…') : tr('Pulihkan')}
										</Button>
									</form>
								</GroupRow>
							{/each}
						</GroupList>
					{/if}
				{/if}
			</section>
		{/if}
	</div>

	<div class="side-col">
		{#if canReadCards}
			<GroupList>
				<IconRow
					icon="wallet"
					title={tr('Baca kartu e-money')}
					hint={tr('Tempelkan kartu ke ponsel lewat NFC')}
					href="/dompet/diagnosa-kartu"
				/>
			</GroupList>
		{/if}
		<GoalsSection
			goals={data.goals}
			loadError={data.goalsError}
			showArchived={data.showArchived}
			openAdd={data.openGoal}
			result={goalResult}
		/>
	</div>
</div>

<Sheet
	bind:open={sheetOpen}
	title={editing ? tr('Ubah dompet') : tr('Tambah dompet')}
	onclose={onSheetClose}
>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{@render walletForm(
				editing,
				editing ? valuesOf(editing) : blank(addPrefill, addCard, addEmoney),
				fieldErrors
			)}
		{/key}
	{/if}
</Sheet>

<style>
	.why {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
	.two-col {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 32px;
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
	.main-col :global(strong) {
		color: var(--ink);
	}
	h2 {
		margin: 0 0 12px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	h3 {
		margin: 0 0 12px;
		font-size: 17px;
		font-weight: 600;
	}
	.sub {
		margin-top: 20px;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	p.meta {
		margin: 0;
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
	/* FN-51: desktop hover/focus lift on a wallet row — the hover colour everywhere, the 1 px rise only with motion. */
	@media (min-width: 1024px) and (hover: hover) and (pointer: fine) {
		.open:hover,
		.open:focus-visible {
			background: var(--panel-2);
		}
		@media (prefers-reduced-motion: no-preference) {
			.open {
				transition:
					transform var(--duration-fast) var(--ease),
					background var(--duration-fast) var(--ease);
			}
			.open:hover,
			.open:focus-visible {
				transform: translateY(-1px);
			}
		}
	}
	.chev {
		display: grid;
		flex: none;
		color: var(--muted);
	}
	/* A phone row keeps its width for the name: the whole row opens the wallet, the chevron is a desktop hint. */
	@media (max-width: 479px) {
		.chev {
			display: none;
		}
		.open {
			gap: 10px;
		}
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.name-text {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* The masked number never breaks inside "•••• 4821". */
	.four {
		white-space: nowrap;
	}
	/*
	 * A phone row gives the name up to two lines (POLISH_AUDIT B4), and the 44 px star slot overlaps the row's
	 * edge padding instead of taking more of the name's width (its tap target stays 44 px).
	 */
	@media (max-width: 479px) {
		.name-text {
			display: -webkit-box;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			white-space: normal;
			overflow-wrap: anywhere;
		}
		.star,
		.fav {
			margin: 0 -10px 0 -6px;
		}
	}
	.due {
		display: flex;
		margin-top: 4px;
	}
	.star {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		color: var(--ink);
	}
	.star :global(svg) {
		fill: currentColor;
	}
	/* Phone layout v3: a small grey label over the balance (records list only). */
	.end {
		display: flex;
		flex: none;
		flex-direction: column;
		align-items: flex-end;
		max-width: 55%;
	}
	.kind {
		display: none;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
	}
	@media (max-width: 600px) {
		:global(.records) .kind {
			display: block;
		}
		:global(.records) .name {
			font-size: 17px;
			font-weight: 700;
		}
		:global(.records) .amount {
			font-size: 17px;
		}
		:global(.records) .meta {
			font-size: 14px;
		}
	}
	/* A long balance wraps inside the row instead of widening a 360 px page. */
	.amount {
		flex: none;
		max-width: 100%;
		font-weight: 700;
		text-align: right;
		overflow-wrap: anywhere;
	}
	.muted {
		color: var(--muted);
	}
	.fav {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
	}
	.fav:disabled {
		opacity: 0.5;
	}
	/* The page's text-link look: underlined, never bold like a heading. */
	.toggle,
	.cancel,
	.adjust {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.toggle,
	.cancel {
		margin-top: 12px;
	}
	.inline-form {
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
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
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
