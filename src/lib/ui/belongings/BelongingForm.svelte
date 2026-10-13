<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { amountDigits, digitsToMinor } from '#lib/shared/amount-input';
	import {
		BELONGING_NAME_MAX_LENGTH,
		BELONGING_NOTE_MAX_LENGTH,
		type BelongingFormValues
	} from '#lib/shared/belongings';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import AiUnavailable from '#lib/ui/photos/AiUnavailable.svelte';
	import PhotoField from '#lib/ui/photos/PhotoField.svelte';

	let {
		action,
		belonging,
		values,
		errors = {},
		today,
		busy,
		submit
	}: {
		action: '?/create' | '?/update';
		/** The belonging being edited (absent when adding): its `updated_at` guards against a stale save. */
		belonging?: { id: string; updatedAt: number; hasPhoto: boolean; name: string };
		values: BelongingFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		/** Today's WIB date: the latest purchase date. */
		today: string;
		/** '' when idle; 'upload' while a photo is being sent; anything else while saving. */
		busy: string;
		submit: SubmitFunction;
	} = $props();

	const { tr } = useI18n();
	const uid = $props.id();
	const priceMinor = $derived(digitsToMinor(amountDigits(values.purchasePrice), 'IDR'));
	const valueMinor = $derived(digitsToMinor(amountDigits(values.currentValue), 'IDR'));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<form
	method="POST"
	{action}
	enctype="multipart/form-data"
	use:enhance={submit}
	class="belonging-form"
	novalidate
>
	{#if belonging}
		<input type="hidden" name="belongingId" value={belonging.id} />
		<input type="hidden" name="updatedAt" value={belonging.updatedAt} />
	{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama barang')}
		hint={tr('Contoh: Laptop kerja, Kulkas, Helm.')}
		value={values.name}
		maxlength={BELONGING_NAME_MAX_LENGTH}
		autocomplete="off"
		error={error('name')}
	/>

	<div class="field">
		<AmountInput label={tr('Harga beli')} name="purchasePrice" valueMinor={priceMinor} />
		{#if error('purchasePriceMinor')}<p class="error">{error('purchasePriceMinor')}</p>{/if}
	</div>

	<Field
		id="{uid}-date"
		name="purchasedOn"
		type="date"
		label={tr('Tanggal beli')}
		value={values.purchasedOn}
		max={today}
		error={error('purchasedOn')}
	/>

	<div class="field">
		<AmountInput label={tr('Nilai sekarang (opsional)')} name="currentValue" {valueMinor} />
		<p class="meta">
			{tr('Kosongkan untuk memakai estimasi: turun rata sampai 20% dari harga beli dalam 5 tahun.')}
		</p>
		{#if error('currentValueMinor')}<p class="error">{error('currentValueMinor')}</p>{/if}
	</div>

	<PhotoField
		id="{uid}-photo"
		hasPhoto={belonging?.hasPhoto ?? false}
		serverError={error('photo')}
	/>

	<AiUnavailable
		id="{uid}-ai"
		labels={[tr('Kenali dari foto (AI)')]}
		hint={tr('Belum dikonfigurasi. Isi nama dan harga sendiri dulu.')}
	/>

	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={BELONGING_NOTE_MAX_LENGTH}
		autocomplete="off"
		error={error('note')}
	/>

	<Button type="submit" size="lg" full disabled={busy !== ''}>
		{busy === 'upload'
			? tr('Mengunggah foto…')
			: busy !== ''
				? tr('Menyimpan…')
				: belonging
					? tr('Simpan perubahan')
					: tr('Tambah barang')}
	</Button>
</form>

<style>
	.belonging-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
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
