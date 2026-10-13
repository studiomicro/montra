<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import {
		WALLET_CURRENCIES,
		WALLET_QUICK_PICKS,
		WALLET_TYPE_LABELS,
		WALLET_TYPES,
		walletCurrencyLabel,
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
		untrack(() => typedAmountMinor(values.openingBalance, currency, locale))
	);
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	let formEl: HTMLFormElement | undefined = $state();
	// A refused last 4 may be a full card number: the field is emptied, never left filled (red team L1).
	$effect(() => {
		if (!errors.lastFour || !formEl) return;
		const field = formEl.elements.namedItem('lastFour');
		if (field instanceof HTMLInputElement) field.value = '';
	});

	// FN-39 quick picks: each is a plain link (`?tambah=1&dompet=<id>`, the page prefills the form without
	// JavaScript); with it, a pick fills the name and selects E-wallet in place. Both stay editable.
	const pick = (choice: WalletQuickPick) => (event: MouseEvent) => {
		const name = formEl?.elements.namedItem('name');
		const type = formEl?.elements.namedItem('type');
		if (!(name instanceof HTMLInputElement) || !(type instanceof RadioNodeList)) return;
		event.preventDefault();
		name.value = choice.name;
		type.value = 'e_wallet';
		name.focus();
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
			{#each WALLET_TYPES as type (type)}
				<label class="pill">
					<input type="radio" name="type" value={type} checked={values.type === type} />
					<span>{tr(WALLET_TYPE_LABELS[type])}</span>
				</label>
			{/each}
		</div>
		{#if error('type')}<p id="{uid}-type-error" class="error">{error('type')}</p>{/if}
	</fieldset>

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

	<div class="field">
		<AmountInput
			label={tr('Saldo awal')}
			name="openingBalance"
			valueMinor={initialMinor}
			typed={errors.openingBalanceMinor ? values.openingBalance : undefined}
			{currency}
		/>
		{#if error('openingBalanceMinor')}<p class="error">{error('openingBalanceMinor')}</p>{/if}
		<label class="check">
			<input type="checkbox" name="negative" checked={values.negative} />
			<span>{tr('Saldo minus (utang, misalnya tagihan kartu kredit)')}</span>
		</label>
	</div>

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
		background: var(--ink);
		color: var(--bg);
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
