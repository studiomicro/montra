<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { amountFractionDigits, typedAmountMinor } from '#lib/shared/amount-input';
	import {
		NET_WORTH_KIND_LABELS,
		NET_WORTH_KINDS,
		PRICED_SOURCE_OF_KIND,
		QUANTITY_SCALE,
		type NetWorthFormValues,
		type NetWorthKind
	} from '#lib/shared/net-worth';
	import { WALLET_CURRENCIES, walletCurrencyLabel } from '#lib/shared/wallets';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	let {
		action,
		item,
		values,
		errors = {},
		busy,
		submit
	}: {
		action: '?/createItem' | '?/updateItem';
		/** The item being edited (absent when adding). */
		item?: { id: string; updatedAt: number };
		values: NetWorthFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		busy: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr, locale } = useI18n();
	const uid = $props.id();
	const isKind = (v: string): v is NetWorthKind =>
		(NET_WORTH_KINDS as readonly string[]).includes(v);

	let kind = $state<string>(untrack(() => (isKind(values.kind) ? values.kind : 'cash')));
	let source = $state(untrack(() => values.priceSource || 'manual'));
	let currency = $state(
		untrack(() =>
			(WALLET_CURRENCIES as readonly string[]).includes(values.currency) ? values.currency : 'IDR'
		)
	);
	// Without JavaScript every field shows (with hints saying when it applies); with it, only the relevant ones.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const pricedSource = $derived(isKind(kind) ? (PRICED_SOURCE_OF_KIND[kind] ?? null) : null);
	const priced = $derived(pricedSource !== null && source === pricedSource);
	const hasQuantity = $derived(isKind(kind) && QUANTITY_SCALE[kind] !== undefined);
	const amountCurrency = $derived(priced ? 'IDR' : currency);
	// Read once in the currency the text was typed in; a later currency change is AmountInput's (FN-47).
	const initialMinor = $derived(
		untrack(() => typedAmountMinor(values.manualValue, amountCurrency, locale))
	);
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	// A kind without the chosen source falls back to the manual value.
	$effect(() => {
		if (pricedSource === null || (source !== 'manual' && source !== pricedSource))
			untrack(() => (source = 'manual'));
	});
</script>

<form method="POST" {action} use:enhance={submit} class="nw-form" novalidate>
	{#if item}
		<input type="hidden" name="itemId" value={item.id} />
		<input type="hidden" name="updatedAt" value={item.updatedAt} />
	{/if}

	<fieldset aria-describedby={error('kind') ? `${uid}-kind-error` : undefined}>
		<legend>{tr('Jenis')}</legend>
		<div class="pills">
			{#each NET_WORTH_KINDS as k (k)}
				<label class="pill">
					<input type="radio" name="kind" value={k} bind:group={kind} />
					<span>{tr(NET_WORTH_KIND_LABELS[k])}</span>
				</label>
			{/each}
		</div>
		{#if error('kind')}<p id="{uid}-kind-error" class="error">{error('kind')}</p>{/if}
	</fieldset>

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama aset')}
		hint={tr('Contoh: Rumah Bekasi, Bitcoin, Emas Antam, KPR.')}
		value={values.name}
		maxlength={60}
		autocomplete="off"
		error={error('name')}
	/>

	{#if !hydrated || pricedSource !== null}
		<div class="field">
			<label for="{uid}-source">{tr('Sumber nilai')}</label>
			<select
				id="{uid}-source"
				name="priceSource"
				bind:value={source}
				aria-invalid={error('priceSource') ? 'true' : undefined}
			>
				<option value="manual">{tr('Nilai yang saya isi sendiri')}</option>
				{#if !hydrated || pricedSource === 'indodax'}
					<option value="indodax">{tr('Harga Indodax (kripto)')}</option>
				{/if}
				{#if !hydrated || pricedSource === 'gold_api'}
					<option value="gold_api">{tr('Harga emas dunia dari gold-api.com (emas)')}</option>
				{/if}
			</select>
			<p class="hint">
				{tr('Harga diperbarui tiap jam pukul 06.00–23.00 WIB. Saham diisi manual.')}
			</p>
			{#if error('priceSource')}<p class="error">{error('priceSource')}</p>{/if}
		</div>
	{/if}

	{#if !hydrated || (priced && source === 'indodax')}
		<Field
			id="{uid}-symbol"
			name="symbol"
			label={tr('Kode koin')}
			hint={tr('Hanya untuk harga Indodax. Contoh: BTC, ETH, USDT.')}
			value={values.symbol}
			maxlength={15}
			autocomplete="off"
			autocapitalize="characters"
			error={error('symbol')}
		/>
	{/if}

	{#if !hydrated || hasQuantity}
		<Field
			id="{uid}-quantity"
			name="quantity"
			label={kind === 'investment_gold' ? tr('Jumlah (gram)') : tr('Jumlah')}
			hint={tr('Untuk kripto dan emas. Pakai koma untuk desimal: 0,015 atau 2,5.')}
			value={values.quantity}
			inputmode="decimal"
			autocomplete="off"
			error={error('quantity')}
		/>
	{/if}

	{#if !hydrated || !priced}
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
			{#if !hydrated}
				<p class="hint">{tr('Aset dengan harga otomatis selalu dalam rupiah.')}</p>
			{/if}
			{#if error('currency')}<p class="error">{error('currency')}</p>{/if}
		</div>
	{/if}

	<div class="field">
		<AmountInput
			label={priced ? tr('Nilai cadangan (opsional)') : tr('Nilai sekarang')}
			name="manualValue"
			valueMinor={initialMinor}
			currency={amountCurrency}
			typed={errors.manualValue ? values.manualValue : undefined}
		/>
		<p class="hint">
			{priced
				? tr('Dipakai selama harga otomatis belum tersedia.')
				: kind === 'debt'
					? tr('Sisa utang sekarang. Utang mengurangi kekayaan bersih.')
					: amountFractionDigits(amountCurrency) > 0
						? tr('Perkiraanmu sendiri, boleh dengan sen.')
						: tr('Perkiraanmu sendiri, dalam angka bulat.')}
		</p>
		{#if error('manualValue')}<p class="error">{error('manualValue')}</p>{/if}
	</div>

	<div class="field">
		<label for="{uid}-acquired">{tr('Tanggal didapat (opsional)')}</label>
		<input
			id="{uid}-acquired"
			type="date"
			name="acquiredOn"
			value={values.acquiredOn}
			aria-invalid={error('acquiredOn') ? 'true' : undefined}
		/>
		{#if error('acquiredOn')}<p class="error">{error('acquiredOn')}</p>{/if}
	</div>

	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={200}
		autocomplete="off"
		error={error('note')}
	/>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : item ? tr('Simpan perubahan') : tr('Tambah aset')}
	</Button>
</form>

<style>
	.nw-form {
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
	select,
	input[type='date'] {
		min-height: 48px;
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	select[aria-invalid='true'],
	input[aria-invalid='true'] {
		border-color: var(--money-up);
	}
	.hint,
	.error {
		margin: 0;
		font-size: 13px;
	}
	.hint {
		color: var(--muted);
	}
	.error {
		color: var(--money-up);
	}
</style>
