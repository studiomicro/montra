<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { amountDigits, digitsToMinor } from '#lib/shared/amount-input';
	import {
		COLLECTIBLE_NAME_MAX_LENGTH,
		COLLECTIBLE_NOTE_MAX_LENGTH,
		type CollectibleFormValues
	} from '#lib/shared/collectibles';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import AiUnavailable from '#lib/ui/photos/AiUnavailable.svelte';
	import PhotoField from '#lib/ui/photos/PhotoField.svelte';

	let {
		action,
		collectible,
		values,
		errors = {},
		today,
		busy,
		submit
	}: {
		action: '?/create' | '?/update';
		/** The collectible being edited (absent when adding): its `updated_at` guards against a stale save. */
		collectible?: { id: string; updatedAt: number; hasPhoto: boolean };
		values: CollectibleFormValues;
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
	class="collectible-form"
	novalidate
>
	{#if collectible}
		<input type="hidden" name="collectibleId" value={collectible.id} />
		<input type="hidden" name="updatedAt" value={collectible.updatedAt} />
	{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama koleksi')}
		hint={tr('Contoh: Kartu langka, Sepatu edisi terbatas, Figur.')}
		value={values.name}
		maxlength={COLLECTIBLE_NAME_MAX_LENGTH}
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
		<AmountInput label={tr('Nilai sekarang')} name="currentValue" {valueMinor} />
		<p class="meta">{tr('Nilai yang kamu isi sendiri. Ubah kapan saja harganya berubah.')}</p>
		{#if error('manualValueMinor')}<p class="error">{error('manualValueMinor')}</p>{/if}
	</div>

	<div class="field">
		<label class="check">
			<input type="checkbox" disabled aria-describedby="{uid}-auto" />
			<span>{tr('Harga pasar otomatis')}</span>
		</label>
		<p id="{uid}-auto" class="meta">
			{tr('Belum dikonfigurasi. Untuk sekarang semua koleksi memakai nilai yang kamu isi sendiri.')}
		</p>
	</div>

	<PhotoField
		id="{uid}-photo"
		hasPhoto={collectible?.hasPhoto ?? false}
		serverError={error('photo')}
	/>

	<AiUnavailable
		id="{uid}-ai"
		labels={[tr('Kenali dari foto (AI)'), tr('Perkirakan nilai (AI)')]}
		hint={tr('Belum dikonfigurasi. Isi nama dan harga sendiri dulu.')}
	/>

	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={COLLECTIBLE_NOTE_MAX_LENGTH}
		autocomplete="off"
		error={error('note')}
	/>

	<Button type="submit" size="lg" full disabled={busy !== ''}>
		{busy === 'upload'
			? tr('Mengunggah foto…')
			: busy !== ''
				? tr('Menyimpan…')
				: collectible
					? tr('Simpan perubahan')
					: tr('Tambah koleksi')}
	</Button>
</form>

<style>
	.collectible-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
		cursor: not-allowed;
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
