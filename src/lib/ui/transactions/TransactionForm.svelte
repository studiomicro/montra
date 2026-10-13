<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { MERCHANT_REASON_LABELS, type MerchantReason } from '#lib/shared/merchants/resolve';
	import {
		CATEGORY_KIND_LABELS,
		NOTE_MAX_LENGTH,
		TITLE_MAX_LENGTH,
		TRANSACTION_TYPE_LABELS,
		FORM_TRANSACTION_TYPES,
		categoryLabel,
		type CategoryKind,
		type TileKey,
		type TransactionFormValues
	} from '#lib/shared/transactions';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import {
		createSuggester,
		fetchSuggestions,
		type MerchantSuggestion
	} from '#lib/ui/transactions/merchant-suggest';

	let {
		action,
		transaction,
		values,
		errors = {},
		wallets,
		categories,
		busy,
		submit,
		enctype,
		suggest = false,
		categoryReason = null
	}: {
		action: '?/create' | '?/update';
		/** The transaction being edited (absent when composing). */
		transaction?: { id: string; updatedAt: number };
		values: TransactionFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		wallets: { id: string; name: string; currency: string }[];
		categories: {
			id: string;
			kind: CategoryKind;
			name: string;
			tileKey: TileKey;
			isPreset: boolean;
		}[];
		busy: boolean;
		submit: SubmitFunction;
		/** `multipart/form-data` when the submission carries a file (FN-15: a receipt photo). */
		enctype?: 'multipart/form-data';
		/** FN-20: offer a merchant and category chip while the title is typed (the compose form only). */
		suggest?: boolean;
		/**
		 * FN-48: why the stored category was picked (a captured row on the edit page, recomputed by the server, never
		 * stored); shown only while that category is still the selected one.
		 */
		categoryReason?: MerchantReason | null;
	} = $props();

	const { tr, locale } = useI18n();
	const uid = $props.id();

	// Plain form fields first: every value posts without JavaScript. With JavaScript the type, wallet and
	// category follow each other (destination list, currency symbol, a category of the chosen kind).
	let type = $state(untrack(() => values.type || 'expense'));
	let walletId = $state(untrack(() => values.walletId || wallets[0]?.id || ''));
	let transferToWalletId = $state(untrack(() => values.transferToWalletId));
	let categoryId = $state(untrack(() => values.categoryId));

	const currency = $derived(wallets.find((w) => w.id === walletId)?.currency ?? 'IDR');
	const initialMinor = $derived(untrack(() => typedAmountMinor(values.amount, currency, locale)));
	const destinations = $derived(wallets.filter((w) => w.id !== walletId));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	function onTypeChange(next: string) {
		const chosen = categories.find((c) => c.id === categoryId);
		if (chosen && chosen.kind !== next) categoryId = '';
		suggestTitle(title);
	}

	// FN-20 suggestion chip: a category the user picked is never overwritten by it.
	let title = $state(untrack(() => values.title));
	let userPicked = $state(untrack(() => values.categoryId !== ''));
	let suggestion = $state<MerchantSuggestion | null>(null);
	const suggester = createSuggester({
		request: async (q) => (await fetchSuggestions([q]))?.[0] ?? null,
		onResult: (s) => (suggestion = s)
	});
	onDestroy(() => suggester.dispose());
	const suggestedCategory = $derived(
		suggestion?.categoryId
			? categories.find((c) => c.id === suggestion?.categoryId && c.kind === type)
			: undefined
	);
	function suggestTitle(text: string) {
		if (!suggest) return;
		if (type === 'expense' || type === 'income') suggester.input(text, type);
		else suggestion = null;
	}
	function applySuggestion() {
		if (!suggestion) return;
		if (suggestion.merchant) title = suggestion.merchant;
		if (!userPicked && suggestedCategory) categoryId = suggestedCategory.id;
		suggestion = null;
	}
</script>

<form method="POST" {action} {enctype} use:enhance={submit} class="tx-form" novalidate>
	{#if transaction}
		<input type="hidden" name="updatedAt" value={transaction.updatedAt} />
	{/if}

	<Segmented
		name="type"
		label={tr('Jenis transaksi')}
		bind:value={type}
		onchange={onTypeChange}
		options={FORM_TRANSACTION_TYPES.map((t) => ({
			value: t,
			label: tr(TRANSACTION_TYPE_LABELS[t])
		}))}
	/>
	{#if error('type')}<p class="error">{error('type')}</p>{/if}

	<div class="field">
		<AmountInput
			label={tr('Jumlah')}
			name="amount"
			valueMinor={initialMinor}
			{currency}
			typed={errors.amountMinor ? values.amount : undefined}
		/>
		{#if error('amountMinor')}<p class="error" role="alert">{error('amountMinor')}</p>{/if}
	</div>

	<div class="field">
		<label for="{uid}-wallet">{type === 'transfer' ? tr('Dari dompet') : tr('Dompet')}</label>
		<select
			id="{uid}-wallet"
			name="walletId"
			bind:value={walletId}
			aria-invalid={error('walletId') ? 'true' : undefined}
		>
			{#each wallets as wallet (wallet.id)}
				<option value={wallet.id}>{wallet.name} · {wallet.currency}</option>
			{/each}
		</select>
		{#if error('walletId')}<p class="error">{error('walletId')}</p>{/if}
	</div>

	<div class="field to-field">
		<label for="{uid}-to">{tr('Ke dompet')}</label>
		<select
			id="{uid}-to"
			name="transferToWalletId"
			bind:value={transferToWalletId}
			aria-invalid={error('transferToWalletId') ? 'true' : undefined}
		>
			<option value="">{tr('Pilih dompet tujuan')}</option>
			{#each destinations as wallet (wallet.id)}
				<option value={wallet.id}>{wallet.name} · {wallet.currency}</option>
			{/each}
		</select>
		{#if error('transferToWalletId')}<p class="error">{error('transferToWalletId')}</p>{/if}
	</div>

	<fieldset class="category-field">
		<legend>{tr('Kategori')}</legend>
		<div class="tiles">
			{#each categories as category (category.id)}
				<label class="tile kind-{category.kind}">
					<input
						type="radio"
						name="categoryId"
						value={category.id}
						bind:group={categoryId}
						onchange={() => (userPicked = true)}
					/>
					<CategoryTile category={category.tileKey} />
					<span class="tile-name">{categoryLabel(category, tr)}</span>
					<span class="sr-only">{tr(CATEGORY_KIND_LABELS[category.kind])}</span>
				</label>
			{/each}
		</div>
		{#if categoryReason && categoryReason !== 'none' && categoryId === values.categoryId}
			<p class="reason"><Badge>{tr(MERCHANT_REASON_LABELS[categoryReason])}</Badge></p>
		{/if}
		{#if error('categoryId')}<p class="error">{error('categoryId')}</p>{/if}
		<a class="link" href="/pengaturan/kategori">{tr('Kelola kategori')}</a>
	</fieldset>

	<div class="field">
		<Field
			id="{uid}-title"
			name="title"
			label={tr('Judul (opsional)')}
			hint={tr('Contoh: Kopi susu, Gaji Oktober.')}
			value={title}
			oninput={(e) => {
				title = e.currentTarget.value;
				suggestTitle(title);
			}}
			maxlength={TITLE_MAX_LENGTH}
			autocomplete="off"
		/>
		{#if suggestion && suggestedCategory}
			<button type="button" class="suggestion" onclick={applySuggestion}>
				<span class="sr-only">{tr('Pakai saran')}:</span>
				<span class="suggestion-name">
					{suggestion.merchant ? `${suggestion.merchant}, ` : ''}{categoryLabel(
						suggestedCategory,
						tr
					)}
				</span>
				<span class="suggestion-why">· {tr(MERCHANT_REASON_LABELS[suggestion.reason])}</span>
			</button>
		{/if}
	</div>
	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={NOTE_MAX_LENGTH}
		autocomplete="off"
	/>

	<Field
		id="{uid}-date"
		name="occurredOn"
		type="date"
		label={tr('Tanggal')}
		value={values.occurredOn}
		required
		error={error('occurredOn')}
	/>
	<Field
		id="{uid}-time"
		name="occurredTime"
		type="time"
		label={tr('Waktu (WIB, opsional)')}
		hint={transaction
			? tr('Kosongkan untuk tetap memakai waktu yang tersimpan.')
			: tr('Kosongkan untuk memakai waktu saat disimpan.')}
		value={values.occurredTime}
		error={error('occurredTime')}
	/>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : transaction ? tr('Simpan perubahan') : tr('Simpan transaksi')}
	</Button>
</form>

<style>
	.tx-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	fieldset {
		display: grid;
		gap: 10px;
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
	/* Fields follow the checked type without JavaScript too (the radios post either way). */
	.to-field {
		display: none;
	}
	.tx-form:has(:global(input[name='type'][value='transfer']:checked)) .to-field {
		display: grid;
	}
	.tx-form:has(:global(input[name='type'][value='transfer']:checked)) .category-field {
		display: none;
	}
	.tx-form:has(:global(input[name='type'][value='expense']:checked)) .kind-income,
	.tx-form:has(:global(input[name='type'][value='income']:checked)) .kind-expense {
		display: none;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
		gap: 8px;
	}
	.tile {
		position: relative;
		display: grid;
		justify-items: center;
		align-content: start;
		gap: 6px;
		min-height: 88px;
		padding: 10px 4px;
		border-radius: var(--r-s);
		background: var(--panel);
		text-align: center;
		cursor: pointer;
	}
	.tile input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.tile:has(input:checked) {
		outline: 2px solid var(--ink);
		outline-offset: -2px;
	}
	.tile:has(input:focus-visible) {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.tile-name {
		font-size: 13px;
		font-weight: 600;
		line-height: 1.2;
	}
	/* A secondary action inside the content: a small underlined text link, never bold like a heading. */
	.link {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 15px;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.suggestion {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		justify-self: start;
		gap: 4px;
		max-width: 100%;
		min-height: 44px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.suggestion-name {
		overflow-wrap: anywhere;
	}
	.suggestion-why {
		color: var(--ink-2);
		font-weight: 500;
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
	.reason {
		margin: 8px 0 0;
	}
</style>
