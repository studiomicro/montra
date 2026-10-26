<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { cardAmountText } from '#lib/shared/cards';
	import {
		EMONEY_FORM_TYPE,
		EMONEY_ISSUER_LABELS,
		EMONEY_ISSUERS,
		EMONEY_QUICK_PICKS,
		isCardType,
		WALLET_CURRENCIES,
		WALLET_FORM_TYPE_LABELS,
		WALLET_FORM_TYPES,
		WALLET_QUICK_PICKS,
		walletCurrencyLabel,
		type EmoneyQuickPick,
		type WalletFormValues,
		type WalletQuickPick
	} from '#lib/shared/wallets';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Chip from '#lib/ui/kit/Chip.svelte';

	let {
		action,
		wallet,
		values,
		errors = {},
		busy,
		firstWallet,
		submit
	}: {
		action: '?/createWallet' | '?/updateWallet';
		/** The wallet being edited (absent when adding). */
		wallet?: { id: string; updatedAt: number; isFavourite: boolean };
		values: WalletFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		busy: boolean;
		/** No live wallet yet: this one becomes the favourite anyway. */
		firstWallet: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr, locale } = useI18n();
	const uid = $props.id();
	const known = (code: string) => (WALLET_CURRENCIES as readonly string[]).includes(code);
	// Follows the select so the amount field shows the chosen currency's symbol and exponent.
	let currency = $state(untrack(() => (known(values.currency) ? values.currency : 'IDR')));
	// Read once in the currency the text was typed in; a later currency change is AmountInput's (FN-47).
	const initialMinor = $derived(
		untrack(() =>
			values.balanceMode === 'plain'
				? typedAmountMinor(values.openingBalance, currency, locale)
				: null
		)
	);
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	// FN-55a: a card is set up in card wording ("Tagihan berjalan", typed as owed, with its sen) plus its limit and
	// days. Without JavaScript the form keeps the wording it was rendered with (`?jenis=kartu_kredit` renders it as a
	// card) and shows the card fields for any type (the server refuses them on another type, never ignores them);
	// with it, choosing the type switches the wording and shows the card fields only for a card.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	let walletType = $state(untrack(() => values.type));
	let mode = $state<'plain' | 'card'>(untrack(() => values.balanceMode));
	/** The plain field's amount (AmountInput) and the card field's text, carried over when the wording switches. */
	let plainMinor = $state<number | null>(untrack(() => initialMinor));
	let cardText = $state(
		untrack(() => (values.balanceMode === 'card' ? values.openingBalance : ''))
	);
	let plainTyped = $state<string | undefined>(
		untrack(() =>
			errors.openingBalanceMinor && values.balanceMode === 'plain'
				? values.openingBalance
				: undefined
		)
	);
	let plainKey = $state(0);
	const isCard = $derived(isCardType(walletType));
	// FN-58 pass 1: "Kartu e-money" needs its issuer. Without JavaScript the issuer picker shows for any type (the
	// server refuses an issuer on another type); with it, only for the e-money choice.
	const isEmoney = $derived(walletType === EMONEY_FORM_TYPE);
	let issuer = $state(untrack(() => values.emoneyIssuer));
	function chooseType(next: string) {
		walletType = next;
		const wanted = isCardType(next) ? 'card' : 'plain';
		if (!hydrated || wanted === mode) return;
		if (wanted === 'card') cardText = cardAmountText(plainMinor, currency, locale);
		else {
			// Kept exactly as typed: a whole-unit currency with sen is refused by the server, never rounded here.
			plainTyped = cardText;
			plainKey++;
		}
		mode = wanted;
	}
	const editing = $derived(wallet !== undefined);

	let formEl: HTMLFormElement | undefined = $state();
	// A refused last 4 may be a full card number: the field is emptied, never left filled (red team L1).
	$effect(() => {
		if (!errors.lastFour || !formEl) return;
		const field = formEl.elements.namedItem('lastFour');
		if (field instanceof HTMLInputElement) field.value = '';
	});

	// FN-39 quick picks: each is a plain link (`?tambah=1&dompet=<id>`, the page prefills the form without
	// JavaScript); with it, a pick fills the name and selects E-wallet in place. Both stay editable.
	/** Fills the name and the type choice in place; false (the link then opens) while the form is not ready. */
	function fillPick(event: MouseEvent, pickName: string, type: string): boolean {
		const name = formEl?.elements.namedItem('name');
		const field = formEl?.elements.namedItem('type');
		if (!(name instanceof HTMLInputElement) || !(field instanceof RadioNodeList)) return false;
		event.preventDefault();
		name.value = pickName;
		field.value = type;
		chooseType(type);
		name.focus();
		return true;
	}
	const pick = (choice: WalletQuickPick) => (event: MouseEvent) =>
		void fillPick(event, choice.name, 'e_wallet');
	/** FN-58 pass 1: an e-money card quick pick fills the name, the "Kartu e-money" choice and its issuer. */
	const pickEmoney = (choice: EmoneyQuickPick) => (event: MouseEvent) => {
		if (fillPick(event, choice.name, EMONEY_FORM_TYPE)) issuer = choice.issuer;
	};
	/** FN-55a: "Kartu kredit" as a quick start: a link without JavaScript, the card type in place with it. */
	const pickCard = (event: MouseEvent) => {
		const field = formEl?.elements.namedItem('type');
		if (!(field instanceof RadioNodeList)) return;
		event.preventDefault();
		field.value = 'kartu_kredit';
		chooseType('kartu_kredit');
	};
</script>

<form bind:this={formEl} method="POST" {action} use:enhance={submit} class="wallet-form" novalidate>
	{#if wallet}
		<input type="hidden" name="walletId" value={wallet.id} />
		<input type="hidden" name="updatedAt" value={wallet.updatedAt} />
	{/if}

	{#if !wallet}
		<div class="picks" role="group" aria-labelledby="{uid}-picks">
			<span id="{uid}-picks" class="picks-label">{tr('Isi cepat e-wallet')}</span>
			{#each WALLET_QUICK_PICKS as choice (choice.id)}
				<Chip href="/dompet?tambah=1&dompet={choice.id}" brand={choice.id} onclick={pick(choice)}
					>{choice.name}</Chip
				>
			{/each}
		</div>
		<!-- FN-58 pass 1: a contactless e-money card, kept as an e-wallet with its issuer. -->
		<div class="picks" role="group" aria-labelledby="{uid}-emoney-picks">
			<span id="{uid}-emoney-picks" class="picks-label">{tr('Isi cepat kartu e-money')}</span>
			{#each EMONEY_QUICK_PICKS as choice (choice.issuer)}
				<Chip href="/dompet?tambah=1&kartu={choice.issuer}" onclick={pickEmoney(choice)}
					>{choice.name}</Chip
				>
			{/each}
		</div>
		<!-- FN-55a: a card is not an e-wallet: its own quick start, apart from the e-wallet picks. -->
		<div class="picks" role="group" aria-labelledby="{uid}-card-pick">
			<span id="{uid}-card-pick" class="picks-label">{tr('Atau mulai sebagai kartu kredit')}</span>
			<Chip href="/dompet?tambah=1&jenis=kartu_kredit" onclick={pickCard}>{tr('Kartu kredit')}</Chip
			>
		</div>
	{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama dompet')}
		hint={tr('Contoh: BCA, GoPay, Dompet harian.')}
		value={values.name}
		maxlength={60}
		autocomplete="off"
		error={error('name')}
	/>

	<fieldset aria-describedby={error('type') ? `${uid}-type-error` : undefined}>
		<legend>{tr('Jenis')}</legend>
		<div class="pills">
			{#each WALLET_FORM_TYPES as option (option)}
				<label class="pill">
					<input
						type="radio"
						name="type"
						value={option}
						checked={values.type === option}
						onchange={() => chooseType(option)}
					/>
					<span>{tr(WALLET_FORM_TYPE_LABELS[option])}</span>
				</label>
			{/each}
		</div>
		{#if error('type')}<p id="{uid}-type-error" class="error">{error('type')}</p>{/if}
	</fieldset>

	{#if !hydrated || isEmoney}
		<div class="field">
			<label for="{uid}-issuer"
				>{hydrated
					? tr('Penerbit kartu')
					: tr('Penerbit kartu e-money (kosongkan untuk jenis lain)')}</label
			>
			<select
				id="{uid}-issuer"
				name="emoneyIssuer"
				bind:value={issuer}
				aria-invalid={error('emoneyIssuer') ? 'true' : undefined}
				aria-describedby={error('emoneyIssuer') ? `${uid}-issuer-error` : undefined}
			>
				<option value="">{tr('Pilih penerbit')}</option>
				{#each EMONEY_ISSUERS as key (key)}
					<option value={key}>{EMONEY_ISSUER_LABELS[key]}</option>
				{/each}
			</select>
			{#if error('emoneyIssuer')}<p id="{uid}-issuer-error" class="error">
					{error('emoneyIssuer')}
				</p>{/if}
		</div>
	{/if}

	<div class="field">
		<label for="{uid}-currency">{tr('Mata uang')}</label>
		<select
			id="{uid}-currency"
			name="currency"
			bind:value={currency}
			aria-invalid={error('currency') ? 'true' : undefined}
		>
			{#each WALLET_CURRENCIES as code (code)}
				<option value={code}>{walletCurrencyLabel(code)}</option>
			{/each}
		</select>
		{#if error('currency')}<p class="error">{error('currency')}</p>{/if}
	</div>

	<input type="hidden" name="balanceMode" value={mode} />
	{#if mode === 'card'}
		<div class="field">
			<label for="{uid}-bill">
				{editing
					? tr('Utang awal (saat kartu ditambahkan)')
					: tr('Tagihan berjalan sekarang (utang)')}
			</label>
			<input
				id="{uid}-bill"
				name="openingBalance"
				class="num"
				inputmode="decimal"
				autocomplete="off"
				placeholder="0"
				bind:value={cardText}
				aria-invalid={error('openingBalanceMinor') ? 'true' : undefined}
				aria-describedby="{uid}-bill-hint"
			/>
			<p id="{uid}-bill-hint" class="meta">
				{tr('Tulis seperti di tagihan, termasuk sen jika ada: 1.250.000,50.')}
			</p>
			{#if error('openingBalanceMinor')}<p class="error">{error('openingBalanceMinor')}</p>{/if}
			<label class="check">
				<input type="checkbox" name="overpaid" checked={values.overpaid} />
				<span>{tr('Kartu ini sedang lebih bayar (saldo kredit)')}</span>
			</label>
		</div>
	{:else}
		<div class="field">
			{#key plainKey}
				<AmountInput
					label={tr('Saldo awal')}
					name="openingBalance"
					bind:valueMinor={plainMinor}
					typed={plainTyped}
					{currency}
				/>
			{/key}
			{#if error('openingBalanceMinor')}<p class="error">{error('openingBalanceMinor')}</p>{/if}
			<label class="check">
				<input type="checkbox" name="negative" checked={values.negative} />
				<span>{tr('Saldo minus (utang, misalnya tagihan kartu kredit)')}</span>
			</label>
		</div>
	{/if}

	{#if !hydrated || isCard}
		<fieldset class="card-fields">
			<legend
				>{hydrated
					? tr('Kartu kredit')
					: tr('Khusus kartu kredit (kosongkan untuk jenis lain)')}</legend
			>
			<Field
				id="{uid}-limit"
				name="creditLimit"
				label={tr('Limit kredit (opsional)')}
				value={values.creditLimit}
				inputmode="decimal"
				autocomplete="off"
				error={error('creditLimitMinor')}
			/>
			<div class="days">
				<Field
					id="{uid}-statement-day"
					name="statementDay"
					label={tr('Tanggal tagihan (opsional)')}
					hint={tr('Tanggal 1-31 tiap bulan.')}
					value={values.statementDay}
					inputmode="numeric"
					maxlength={2}
					autocomplete="off"
					error={error('statementDay')}
				/>
				<Field
					id="{uid}-due-day"
					name="dueDay"
					label={tr('Tanggal jatuh tempo (opsional)')}
					hint={tr('Tanggal 1-31 tiap bulan.')}
					value={values.dueDay}
					inputmode="numeric"
					maxlength={2}
					autocomplete="off"
					error={error('dueDay')}
				/>
			</div>
		</fieldset>
	{/if}

	<Field
		id="{uid}-last-four"
		name="lastFour"
		label={tr('4 angka terakhir (opsional)')}
		hint={tr('Hanya 4 angka terakhir nomor rekening atau kartu. Jangan isi nomor lengkap.')}
		value={values.lastFour}
		inputmode="numeric"
		autocomplete="off"
		error={error('lastFour')}
	/>

	{#if wallet?.isFavourite}
		<p class="meta">
			{tr('Ini dompet favoritmu. Pilih dompet lain sebagai favorit untuk menggantinya.')}
		</p>
	{:else if firstWallet}
		<p class="meta">{tr('Dompet pertama otomatis jadi favorit.')}</p>
	{:else}
		<label class="check">
			<input type="checkbox" name="favourite" checked={values.isFavourite} />
			<span>{tr('Jadikan favorit')}</span>
		</label>
	{/if}

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : wallet ? tr('Simpan perubahan') : tr('Tambah dompet')}
	</Button>
</form>

<style>
	.wallet-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend,
	.field > label {
		margin-bottom: 6px;
		padding: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.picks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.picks-label {
		flex-basis: 100%;
		font-size: 13px;
		color: var(--muted);
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pill {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 16px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}
	.pill input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.pill:has(input:checked) {
		background: var(--action);
		color: var(--on-action);
	}
	.pill:has(input:focus-visible) {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	select {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	select[aria-invalid='true'] {
		box-shadow: inset 0 0 0 1.5px var(--money-up);
	}
	.card-fields {
		display: grid;
		gap: 16px;
	}
	.days {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 12px;
	}
	.field > input {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	.field > input[aria-invalid='true'] {
		box-shadow: inset 0 0 0 1.5px var(--money-up);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		font-size: 15px;
		cursor: pointer;
	}
	.check input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--ink);
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
