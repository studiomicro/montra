<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { RECURRING_TYPES, type RecurringFormValues } from '#lib/shared/recurring';
	import { WEEKDAY_LABELS } from '#lib/shared/subscriptions';
	import {
		CATEGORY_KIND_LABELS,
		NOTE_MAX_LENGTH,
		TITLE_MAX_LENGTH,
		TRANSACTION_TYPE_LABELS,
		categoryLabel,
		type CategoryKind,
		type TileKey
	} from '#lib/shared/transactions';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	let {
		action,
		series,
		values,
		errors = {},
		wallets,
		categories,
		busy,
		submit
	}: {
		action: '?/create' | '?/update';
		/** The series being edited (absent when creating). */
		series?: { updatedAt: number };
		values: RecurringFormValues;
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
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	// Plain form fields: every value posts without JavaScript; the CSS below shows the fields of the checked
	// type and frequency with or without it.
	let type = $state(untrack(() => values.type || 'expense'));
	let frequency = $state(untrack(() => values.frequency || 'monthly'));
	let walletId = $state(untrack(() => values.walletId || wallets[0]?.id || ''));
	let categoryId = $state(untrack(() => values.categoryId));

	const currency = $derived(wallets.find((w) => w.id === walletId)?.currency ?? 'IDR');
	const initialMinor = $derived(untrack(() => typedAmountMinor(values.amount, currency, locale)));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
	const days = Array.from({ length: 31 }, (_, i) => String(i + 1));

	function onTypeChange(next: string) {
		const chosen = categories.find((c) => c.id === categoryId);
		if (chosen && chosen.kind !== next) categoryId = '';
	}
</script>

<form method="POST" {action} use:enhance={submit} class="rec-form" novalidate>
	{#if series}<input type="hidden" name="updatedAt" value={series.updatedAt} />{/if}

	<Segmented
		name="type"
		label={tr('Jenis transaksi')}
		bind:value={type}
		onchange={onTypeChange}
		options={RECURRING_TYPES.map((t) => ({ value: t, label: tr(TRANSACTION_TYPE_LABELS[t]) }))}
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
		<label for="{uid}-wallet">{tr('Dompet')}</label>
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

	<fieldset class="category-field">
		<legend>{tr('Kategori')}</legend>
		<div class="tiles">
			{#each categories as category (category.id)}
				<label class="tile kind-{category.kind}">
					<input type="radio" name="categoryId" value={category.id} bind:group={categoryId} />
					<CategoryTile category={category.tileKey} />
					<span class="tile-name">{categoryLabel(category, tr)}</span>
					<span class="sr-only">{tr(CATEGORY_KIND_LABELS[category.kind])}</span>
				</label>
			{/each}
		</div>
		{#if error('categoryId')}<p class="error">{error('categoryId')}</p>{/if}
	</fieldset>

	<Field
		id="{uid}-title"
		name="title"
		label={tr('Judul (opsional)')}
		hint={tr('Contoh: Sewa kos, Gaji bulanan.')}
		value={values.title}
		maxlength={TITLE_MAX_LENGTH}
		autocomplete="off"
	/>
	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={NOTE_MAX_LENGTH}
		autocomplete="off"
	/>

	<fieldset class="schedule">
		<legend>{tr('Jadwal')}</legend>
		<Segmented
			name="frequency"
			label={tr('Jadwal')}
			bind:value={frequency}
			options={[
				{ value: 'monthly', label: tr('Bulanan') },
				{ value: 'weekly', label: tr('Mingguan') }
			]}
		/>
		{#if error('frequency')}<p class="error">{error('frequency')}</p>{/if}
		<div class="field day-field">
			<label for="{uid}-day">{tr('Tanggal')}</label>
			<select
				id="{uid}-day"
				name="day"
				value={values.day || '1'}
				aria-invalid={error('day') && frequency !== 'weekly' ? 'true' : undefined}
			>
				{#each days as d (d)}
					<option value={d}>{trf('Tiap tanggal {n}', { n: d })}</option>
				{/each}
			</select>
			<p class="hint">{tr('Di bulan yang lebih pendek, dicatat di hari terakhir bulan itu.')}</p>
		</div>
		<div class="field weekday-field">
			<label for="{uid}-weekday">{tr('Hari')}</label>
			<select
				id="{uid}-weekday"
				name="weekday"
				value={values.weekday || '1'}
				aria-invalid={error('day') && frequency === 'weekly' ? 'true' : undefined}
			>
				{#each WEEKDAY_LABELS as label, i (label)}
					<option value={String(i + 1)}>{tr(label)}</option>
				{/each}
			</select>
		</div>
		{#if error('day')}<p class="error">{error('day')}</p>{/if}
	</fieldset>

	<Field
		id="{uid}-start"
		name="startOn"
		type="date"
		label={tr('Mulai')}
		value={values.startOn}
		required
		error={error('startOn')}
	/>
	<Field
		id="{uid}-end"
		name="endOn"
		type="date"
		label={tr('Selesai (opsional)')}
		hint={tr('Kosongkan bila tidak ada tanggal selesai.')}
		value={values.endOn}
		error={error('endOn')}
	/>
	<p class="hint">
		{tr(
			'Transaksi dibuat otomatis pada tanggalnya, mulai pukul 06.00 WIB. Tanggal yang sudah lewat tidak dicatat.'
		)}
	</p>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : series ? tr('Simpan seri') : tr('Simpan transaksi berulang')}
	</Button>
</form>

<style>
	.rec-form {
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
	/* Air between the Jadwal control and the day field under it. */
	.day-field,
	.weekday-field {
		margin-top: 10px;
	}
	/* The day field of the checked frequency only (the radios post either way). */
	.weekday-field {
		display: none;
	}
	.rec-form:has(:global(input[name='frequency'][value='weekly']:checked)) .weekday-field {
		display: grid;
	}
	.rec-form:has(:global(input[name='frequency'][value='weekly']:checked)) .day-field {
		display: none;
	}
	.rec-form:has(:global(input[name='type'][value='expense']:checked)) .kind-income,
	.rec-form:has(:global(input[name='type'][value='income']:checked)) .kind-expense {
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
		outline: 2px solid var(--action);
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
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
