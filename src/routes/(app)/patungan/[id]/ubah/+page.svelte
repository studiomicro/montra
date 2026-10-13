<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { SPLIT_NOTE_MAX, SPLIT_TITLE_MAX } from '#lib/shared/patungan';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import SplitForm from '#lib/ui/patungan/SplitForm.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	let busy = $state(false);
	let networkError = $state('');
	let formKey = $state(0);

	/** Success is the redirect to the split, which happens only after the server wrote the change. */
	const submit: SubmitFunction = () => {
		busy = true;
		networkError = '';
		return async ({ result, update }) => {
			if (result.type === 'error') {
				networkError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				busy = false;
				return;
			}
			await update({ reset: false });
			if (result.type === 'failure') formKey++;
			busy = false;
		};
	};

	const values = $derived(form && 'values' in form && form.values ? form.values : data.values);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<svelte:head><title>{tr('Ubah patungan')}</title></svelte:head>
<ScreenTitle
	back={{ href: `/patungan/${data.split.id}`, label: tr('Kembali ke patungan') }}
	title={tr('Ubah patungan')}
/>

<div class="page">
	<FormBanner message={banner} />
	{#key formKey}
		{#if data.split.locked}
			<p class="hint">
				{tr(
					'Sudah ada yang membayar, jadi orang dan bagiannya tidak bisa diubah lagi. Nama, tanggal dan catatan tetap bisa.'
				)}
			</p>
			<form method="POST" action="?/details" use:enhance={submit} class="details" novalidate>
				<input type="hidden" name="updatedAt" value={data.split.updatedAt} />
				<Field
					id="details-title"
					name="title"
					label={tr('Nama patungan')}
					value={values.title}
					maxlength={SPLIT_TITLE_MAX}
					required
					error={error('title')}
				/>
				<Field
					id="details-date"
					name="occurredOn"
					type="date"
					label={tr('Tanggal')}
					value={values.occurredOn}
					required
					error={error('occurredOn')}
				/>
				<Field
					id="details-note"
					name="note"
					label={tr('Catatan (opsional)')}
					value={values.note}
					maxlength={SPLIT_NOTE_MAX}
					error={error('note')}
				/>
				<Button type="submit" size="lg" full disabled={busy}>
					{busy ? tr('Menyimpan…') : tr('Simpan perubahan')}
				</Button>
			</form>
		{:else}
			<SplitForm
				action="?/update"
				{values}
				{errors}
				members={data.members}
				payerName={tr('Kamu')}
				currency={data.split.currency}
				fixedTotal={data.fixedTotal}
				{busy}
				{submit}
				submitLabel={tr('Simpan perubahan')}
			>
				{#snippet hidden()}
					<input type="hidden" name="updatedAt" value={data.split.updatedAt} />
				{/snippet}
			</SplitForm>
		{/if}
	{/key}
</div>

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 560px;
	}
	.details {
		display: grid;
		gap: 20px;
	}
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
</style>
