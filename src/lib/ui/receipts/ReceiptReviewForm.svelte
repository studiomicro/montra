<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { amountDigits, digitsToMinor, groupDigits } from '#lib/shared/amount-input';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		adjustmentsMinor,
		canSplit,
		RECEIPT_ITEMS_MAX,
		receiptDateCheck,
		reconcileReceipt,
		type ReceiptFormValues,
		type ReceiptMode,
		type ReceiptReview
	} from '#lib/shared/receipts';
	import { categoryLabel, TITLE_MAX_LENGTH, type TileKey } from '#lib/shared/transactions';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import ToggleRow from '#lib/ui/kit/ToggleRow.svelte';
	import PhotoPicker from '#lib/ui/photos/PhotoPicker.svelte';

	/**
	 * FN-15 review screen: every read field editable, the reconciliation and date checks live as the user types
	 * (the same shared functions the save action runs again), "Satu transaksi" / "Pisah per item", the wallet and
	 * categories, and whether the photo is kept. Plain form fields first: without JavaScript the form posts as
	 * it is (the photo picked again in its file field).
	 */
	let {
		values,
		review,
		errors,
		wallets,
		categories,
		today,
		heldPhoto,
		canReadAgain,
		saving,
		submit,
		onreadagain,
		onattachonly
	}: {
		values: ReceiptFormValues;
		/** The read's checks; null after a no-JavaScript refusal (the read is not repeated). */
		review: Omit<ReceiptReview, 'values'> | null;
		errors: Record<string, string>;
		wallets: { id: string; name: string }[];
		categories: { id: string; name: string; tileKey: TileKey; isPreset: boolean }[];
		today: string;
		/** The page holds the re-encoded photo (JavaScript): the file field is not needed. */
		heldPhoto: boolean;
		canReadAgain: boolean;
		saving: boolean;
		submit: SubmitFunction;
		onreadagain: () => void;
		onattachonly: () => void;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();
	let mounted = $state(false);
	onMount(() => (mounted = true));

	const initial = untrack(() => values);
	let mode = $state<ReceiptMode>(initial.mode);
	let shop = $state(initial.shop);
	let occurredOn = $state(initial.occurredOn);
	let walletId = $state(initial.walletId || untrack(() => wallets[0]?.id) || '');
	let categoryId = $state(initial.categoryId);
	let items = $state(initial.items.map((i) => ({ ...i })));
	let tax = $state(initial.tax);
	let service = $state(initial.service);
	let discount = $state(initial.discount);
	let total = $state(initial.total);
	let keepPhoto = $state(initial.keepPhoto);
	let acceptMismatch = $state(initial.acceptMismatch);

	const minor = (text: string) => digitsToMinor(amountDigits(text), 'IDR');
	const filled = $derived(
		items.filter((i) => i.name.trim() !== '' || amountDigits(i.amount) !== '')
	);
	const figures = $derived({
		taxMinor: minor(tax),
		serviceMinor: minor(service),
		discountMinor: minor(discount)
	});
	const balance = $derived(
		reconcileReceipt(
			{ items: filled.map((i) => minor(i.amount)), ...figures, totalMinor: minor(total) },
			review?.foreignCurrency ?? 'IDR'
		)
	);
	const splitAllowed = $derived(canSplit(figures));
	const extraRow = $derived(adjustmentsMinor(figures) > 0);
	const rowCount = $derived(mode === 'single' ? 1 : filled.length + (extraRow ? 1 : 0));
	const dateCheck = $derived(
		/^\d{4}-\d{2}-\d{2}$/.test(occurredOn) ? receiptDateCheck(occurredOn, today) : 'ok'
	);
	const duplicates = $derived(new Set(review?.duplicates ?? []));
	const money = (value: number | null) =>
		value === null ? '—' : formatMoney(value, 'IDR', 'auto', locale);
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	$effect(() => {
		if (!splitAllowed && mode === 'split') mode = 'single';
	});

	/** Groups digits as the user types (whole rupiah), like AmountInput. */
	function grouped(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		input.value = groupDigits(amountDigits(input.value));
		return input.value;
	}

	async function addItem() {
		if (items.length >= RECEIPT_ITEMS_MAX) return;
		items.push({ name: '', amount: '', categoryId: '' });
		await tick();
		document.getElementById(`${uid}-item-name-${items.length - 1}`)?.focus();
	}

	async function removeItem(index: number) {
		items.splice(index, 1);
		await tick();
		document.getElementById(`${uid}-add-item`)?.focus();
	}
</script>

<form
	method="POST"
	action="?/save"
	enctype="multipart/form-data"
	use:enhance={submit}
	class="review"
	novalidate
	aria-labelledby="{uid}-title"
>
	<h2 id="{uid}-title" tabindex="-1">{tr('Periksa hasil bacaan')}</h2>

	{#if review?.alreadySaved}
		<p class="note warn" role="status">{tr('Struk ini sudah pernah disimpan.')}</p>
	{/if}
	{#if balance.status === 'mismatch'}
		<div class="note warn" role="status">
			<p class="note-title">{tr('Periksa totalnya')}</p>
			{#if review?.foreignCurrency}
				<p>
					{trf('Struk ini dalam {mata_uang}; semua transaksi disimpan dalam rupiah.', {
						mata_uang: review.foreignCurrency
					})}
				</p>
			{/if}
			<p>
				{trf('Barang + pajak + servis − diskon = {hitung}, total di struk {total}.', {
					hitung: money(balance.computedMinor),
					total: money(balance.totalMinor)
				})}
			</p>
			<label class="check">
				<input type="checkbox" name="acceptMismatch" bind:checked={acceptMismatch} />
				<span>{tr('Simpan walau totalnya berbeda')}</span>
			</label>
		</div>
	{/if}
	{#if dateCheck !== 'ok'}
		<div class="note warn" role="status">
			<p class="note-title">{tr('Periksa tanggalnya')}</p>
			<p>
				{dateCheck === 'future'
					? tr('Tanggal ini setelah hari ini.')
					: tr('Tanggal ini lebih dari 2 tahun yang lalu.')}
			</p>
		</div>
	{/if}

	<div class="field">
		<label for="{uid}-shop">{tr('Toko')}</label>
		<input
			id="{uid}-shop"
			name="shop"
			bind:value={shop}
			maxlength={TITLE_MAX_LENGTH}
			autocomplete="off"
		/>
	</div>

	<div class="field">
		<label for="{uid}-date">{tr('Tanggal')}</label>
		<input
			id="{uid}-date"
			name="occurredOn"
			type="date"
			bind:value={occurredOn}
			required
			aria-invalid={error('occurredOn') ? 'true' : undefined}
			aria-describedby={error('occurredOn') ? `${uid}-date-error` : undefined}
		/>
		{#if error('occurredOn')}<p id="{uid}-date-error" class="error">{error('occurredOn')}</p>{/if}
	</div>

	<fieldset class="items">
		<legend>{tr('Barang')}</legend>
		<input type="hidden" name="count" value={items.length} />
		{#each items as item, i (i)}
			<div class="item">
				<div class="item-fields">
					<label class="sr-only" for="{uid}-item-name-{i}"
						>{trf('Nama barang {n}', { n: i + 1 })}</label
					>
					<input
						id="{uid}-item-name-{i}"
						class="item-name"
						name="itemName.{i}"
						bind:value={item.name}
						maxlength={TITLE_MAX_LENGTH}
						placeholder={tr('Nama barang')}
						autocomplete="off"
					/>
					<label class="sr-only" for="{uid}-item-amount-{i}"
						>{trf('Harga barang {n}', { n: i + 1 })}</label
					>
					<input
						id="{uid}-item-amount-{i}"
						class="item-amount num"
						name="itemAmount.{i}"
						inputmode="numeric"
						autocomplete="off"
						placeholder="0"
						value={item.amount}
						oninput={(e) => (item.amount = grouped(e))}
						aria-invalid={error(`item.${i}`) ? 'true' : undefined}
						aria-describedby={error(`item.${i}`) ? `${uid}-item-error-${i}` : undefined}
					/>
					{#if mounted}
						<button
							type="button"
							class="remove"
							aria-label={trf('Hapus barang {n}', { n: i + 1 })}
							onclick={() => removeItem(i)}>×</button
						>
					{/if}
				</div>
				{#if mode === 'split'}
					<label class="item-category">
						<span class="sr-only">{trf('Kategori barang {n}', { n: i + 1 })}</span>
						<select name="itemCategory.{i}" bind:value={item.categoryId}>
							<option value="">{tr('Sama dengan struk')}</option>
							{#each categories as category (category.id)}
								<option value={category.id}>{categoryLabel(category, tr)}</option>
							{/each}
						</select>
					</label>
				{:else}
					<input type="hidden" name="itemCategory.{i}" value={item.categoryId} />
				{/if}
				{#if duplicates.has(`item.${i}`)}
					<p class="meta">{tr('Mungkin sudah dicatat')}</p>
				{/if}
				{#if error(`item.${i}`)}
					<p id="{uid}-item-error-{i}" class="error">{error(`item.${i}`)}</p>
				{/if}
			</div>
		{/each}
		{#if mounted && items.length < RECEIPT_ITEMS_MAX}
			<button type="button" id="{uid}-add-item" class="add" onclick={addItem}
				>{tr('+ Tambah barang')}</button
			>
		{/if}
	</fieldset>

	<div class="figures">
		{#each [{ name: 'tax', label: tr('Pajak (PB1)') }, { name: 'service', label: tr('Servis') }, { name: 'discount', label: tr('Diskon') }] as figure (figure.name)}
			<div class="field">
				<label for="{uid}-{figure.name}">{figure.label}</label>
				<input
					id="{uid}-{figure.name}"
					class="num"
					name={figure.name}
					inputmode="numeric"
					autocomplete="off"
					placeholder="0"
					value={figure.name === 'tax' ? tax : figure.name === 'service' ? service : discount}
					oninput={(e) => {
						const v = grouped(e);
						if (figure.name === 'tax') tax = v;
						else if (figure.name === 'service') service = v;
						else discount = v;
					}}
					aria-invalid={error(figure.name) ? 'true' : undefined}
				/>
				{#if error(figure.name)}<p class="error">{error(figure.name)}</p>{/if}
			</div>
		{/each}
		<div class="field">
			<label for="{uid}-total">{tr('Total')}</label>
			<input
				id="{uid}-total"
				class="num total"
				name="total"
				inputmode="numeric"
				autocomplete="off"
				placeholder="0"
				value={total}
				oninput={(e) => (total = grouped(e))}
				aria-invalid={error('total') ? 'true' : undefined}
				aria-describedby={error('total') ? `${uid}-total-error` : undefined}
			/>
			{#if duplicates.has('total')}<p class="meta">{tr('Mungkin sudah dicatat')}</p>{/if}
			{#if error('total')}<p id="{uid}-total-error" class="error">{error('total')}</p>{/if}
		</div>
	</div>

	<input type="hidden" name="paymentMethod" value={values.paymentMethod} />
	<input type="hidden" name="readTicket" value={values.readTicket} />
	{#if values.paymentMethod}
		<p class="meta">{trf('Tertulis dibayar dengan: {cara}', { cara: values.paymentMethod })}</p>
	{/if}

	<div class="field">
		<label for="{uid}-wallet">{tr('Dompet')}</label>
		<select
			id="{uid}-wallet"
			name="walletId"
			bind:value={walletId}
			aria-invalid={error('walletId') ? 'true' : undefined}
		>
			{#each wallets as wallet (wallet.id)}
				<option value={wallet.id}>{wallet.name}</option>
			{/each}
		</select>
		{#if error('walletId')}<p class="error">{error('walletId')}</p>{/if}
	</div>

	<div class="field">
		<label for="{uid}-category">{tr('Kategori')}</label>
		<select
			id="{uid}-category"
			name="categoryId"
			bind:value={categoryId}
			aria-invalid={error('categoryId') ? 'true' : undefined}
		>
			<option value="">{tr('Pilih kategori')}</option>
			{#each categories as category (category.id)}
				<option value={category.id}>{categoryLabel(category, tr)}</option>
			{/each}
		</select>
		{#if error('categoryId')}<p class="error">{error('categoryId')}</p>{/if}
	</div>

	<div class="field">
		<Segmented
			name="mode"
			label={tr('Cara menyimpan')}
			bind:value={mode}
			options={[
				{ value: 'single', label: tr('Satu transaksi') },
				{ value: 'split', label: tr('Pisah per item'), disabled: !splitAllowed }
			]}
		/>
		{#if !splitAllowed}
			<p class="meta">
				{tr('Diskon lebih besar dari pajak dan servis — gunakan “Satu transaksi”')}
			</p>
		{:else if mode === 'split' && extraRow}
			<p class="meta">
				{tr('Pajak, servis dan diskon disimpan sebagai satu transaksi “Pajak & servis”.')}
			</p>
		{/if}
	</div>

	<ToggleRow
		icon="receipt"
		name="keepPhoto"
		bind:checked={keepPhoto}
		label={tr('Simpan foto struk sebagai bukti')}
	/>

	{#if !heldPhoto}
		<!-- Without JavaScript nothing holds the photo between requests: it is picked again here. -->
		<div class="field">
			<PhotoPicker
				id="{uid}-photo"
				name="photo"
				label={tr('Foto struk (pilih lagi untuk menyimpan)')}
				required
			/>
		</div>
	{/if}

	{#if error('form')}<p class="error" role="alert">{error('form')}</p>{/if}

	<Button type="submit" size="lg" full disabled={saving || Boolean(review?.alreadySaved)}>
		{saving
			? tr('Menyimpan…')
			: rowCount === 1
				? tr('Simpan 1 transaksi')
				: trf('Simpan {n} transaksi', { n: rowCount })}
	</Button>
	<div class="ways">
		{#if canReadAgain}
			<Button
				type="submit"
				variant="secondary"
				formaction="?/read"
				disabled={saving}
				onclick={(event) => {
					if (!heldPhoto) return;
					event.preventDefault();
					onreadagain();
				}}>{tr('Baca lagi')}</Button
			>
		{/if}
		<a
			class="link"
			href="/riwayat/baru"
			onclick={(event) => {
				event.preventDefault();
				onattachonly();
			}}>{tr('Lampirkan fotonya saja')}</a
		>
	</div>
</form>

<style>
	/* Every track may shrink below its content (a long category name in a select), so 360 px never scrolls. */
	.review,
	.field,
	.items,
	.item {
		grid-template-columns: minmax(0, 1fr);
	}
	.review {
		display: grid;
		gap: 16px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
	}
	h2:focus {
		outline: none;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field > label,
	legend {
		font-size: 15px;
		font-weight: 600;
	}
	input:not([type='checkbox']):not([type='radio']):not([type='file']),
	select {
		width: 100%;
		min-height: 48px;
		min-width: 0;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	input:focus-visible,
	select:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
	[aria-invalid='true'] {
		box-shadow: inset 0 0 0 1.5px var(--money-up);
	}
	.num {
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.items {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.item {
		display: grid;
		gap: 6px;
	}
	.item-fields {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.item-name {
		flex: 1 1 auto;
	}
	.item-amount {
		flex: 0 0 8.5em;
		width: 8.5em;
	}
	.item-category select {
		width: 100%;
	}
	.remove,
	.add {
		min-width: 44px;
		min-height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
		cursor: pointer;
	}
	.remove {
		font-size: 22px;
		color: var(--muted);
	}
	.add {
		justify-self: start;
		padding: 0 4px;
	}
	.figures {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.total {
		font-weight: 700;
	}
	.note {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		font-size: 14px;
	}
	.note p {
		margin: 0;
	}
	.note-title {
		font-weight: 700;
	}
	.warn {
		box-shadow: inset 3px 0 0 var(--money-up);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
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
		font-size: 13px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
	.ways {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
