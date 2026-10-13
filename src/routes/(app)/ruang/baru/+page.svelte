<script lang="ts">
	import { enhance } from '$app/forms';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();
	let saving = $state(false);
</script>

<svelte:head><title>{tr('Buat ruang bersama')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/ruang', label: tr('Kembali ke Ruang') }}
	title={tr('Buat ruang bersama')}
	subtitle={tr('Ruang bersama berisi dompet, transaksi dan anggaran yang dilihat sampai 5 orang.')}
/>

<form
	method="POST"
	class="form"
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update();
			saving = false;
		};
	}}
>
	<FormBanner message={form?.error ? tr(form.error) : undefined} />
	<Field
		id="space-name"
		name="name"
		label={tr('Nama ruang')}
		hint={tr('Contoh: Keluarga, Rumah, Liburan.')}
		required
		maxlength={data.nameMax}
		autocomplete="off"
		defaultValue={form?.values?.name ?? ''}
	/>
	<Button type="submit" size="lg" full disabled={saving}>
		{saving ? tr('Menyimpan…') : tr('Buat ruang')}
	</Button>
	<Button variant="secondary" size="lg" full href="/ruang">{tr('Batal')}</Button>
</form>

<style>
	.form {
		display: grid;
		gap: 16px;
		margin-top: 16px;
	}
</style>
