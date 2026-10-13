<script lang="ts">
	import { untrack } from 'svelte';
	import type { SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDayLabel } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import SplitForm from '#lib/ui/patungan/SplitForm.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, locale } = useI18n();

	let busy = $state(false);
	let networkError = $state('');
	let formKey = $state(0);
	let refreshing = $state(false);

	/** Success is the redirect to the split, which happens only after the server wrote it. */
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

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const values = $derived(form && 'values' in form && form.values ? form.values : data.values);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const banner = $derived(
		networkError ||
			(form && 'error' in form && form.error ? tr(form.error) : '') ||
			(data.billRefused
				? tr(
						'Transaksi ini tidak bisa ditautkan: harus pengeluaran yang belum tertaut ke patungan lain, dengan total yang sama persis.'
					)
				: '') ||
			undefined
	);
	let walletId = $state(untrack(() => values?.walletId ?? ''));
	const currency = $derived(
		data.bill?.currency ?? data.wallets.find((w) => w.id === walletId)?.currency ?? 'IDR'
	);
	const money = (minor: number, c: string) => formatMoney(minor, c, 'auto', locale);
</script>

<svelte:head><title>{tr('Patungan baru')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/patungan', label: tr('Kembali ke Patungan') }}
	title={tr('Patungan baru')}
/>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError || !values}
	<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
{:else if !data.bill && data.wallets.length === 0}
	<EmptyState
		illustration="wallet"
		text={tr('Tambah dompet dulu supaya bagianmu punya tempat dicatat.')}
		actionLabel={tr('Tambah dompet')}
		actionHref="/dompet?tambah=1"
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#if data.bill}
			<section class="bill" aria-labelledby="bill-title">
				<h2 id="bill-title">{tr('Dari transaksi')}</h2>
				<p class="bill-row">
					<span class="bill-name">{data.bill.title ?? tr('Tanpa judul')}</span>
					<span class="num">{money(data.bill.amountMinor, data.bill.currency)}</span>
				</p>
				<p class="hint">
					{formatDayLabel(data.bill.occurredOn, locale)} · {data.bill.walletName}
				</p>
				<p class="hint">
					{tr(
						'Transaksi ini tetap tercatat dengan jumlah penuh, tetapi semua total hanya menghitung bagianmu.'
					)}
				</p>
				<a class="link" href="/patungan/baru">{tr('Jangan tautkan transaksi')}</a>
			</section>
		{:else if data.candidates.length > 0}
			<details class="pick">
				<summary>{tr('Sudah tercatat? Tautkan transaksinya')}</summary>
				<p class="hint">
					{tr(
						'Pilih pengeluaran yang membayar seluruh tagihan. Jumlahnya tidak berubah; totalmu hanya menghitung bagianmu.'
					)}
				</p>
				<GroupList>
					{#each data.candidates as c (c.id)}
						<GroupRow href="/patungan/baru?dariTransaksi={c.id}">
							<span class="cand">
								<span class="bill-name">{c.title ?? tr('Tanpa judul')}</span>
								<span class="hint">{formatDayLabel(c.occurredOn, locale)} · {c.walletName}</span>
							</span>
							<span class="num">{money(c.amountMinor, c.currency)}</span>
						</GroupRow>
					{/each}
				</GroupList>
			</details>
		{/if}

		{#key formKey}
			<SplitForm
				action="?/create"
				{values}
				{errors}
				members={data.members}
				payerName={tr('Kamu')}
				{currency}
				fixedTotal={data.bill?.amountMinor ?? null}
				{busy}
				{submit}
				submitLabel={tr('Simpan patungan')}
			>
				{#snippet hidden()}
					<input type="hidden" name="clientId" value={data.clientId} />
					{#if data.bill}
						<input type="hidden" name="bill" value={data.bill.id} />
					{:else}
						<div class="field">
							<label for="split-wallet">{tr('Dibayar dari dompet')}</label>
							<select
								id="split-wallet"
								name="walletId"
								bind:value={walletId}
								aria-invalid={errors.walletId ? 'true' : undefined}
							>
								{#each data.wallets as wallet (wallet.id)}
									<option value={wallet.id}>{wallet.name} · {wallet.currency}</option>
								{/each}
							</select>
							<p class="hint">
								{tr('Bagianmu dicatat sebagai pengeluaran dari dompet ini, bukan seluruh tagihan.')}
							</p>
							{#if errors.walletId}<p class="error">{tr(errors.walletId)}</p>{/if}
						</div>
						<div class="field">
							<label for="split-category">{tr('Kategori bagianmu')}</label>
							<select
								id="split-category"
								name="categoryId"
								value={values.categoryId}
								aria-invalid={errors.categoryId ? 'true' : undefined}
							>
								<option value="">{tr('Pilih kategori')}</option>
								{#each data.categories as category (category.id)}
									<option value={category.id}>{categoryLabel(category, tr)}</option>
								{/each}
							</select>
							{#if errors.categoryId}<p class="error">{tr(errors.categoryId)}</p>{/if}
						</div>
					{/if}
				{/snippet}
			</SplitForm>
		{/key}
	</div>
{/if}

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 560px;
	}
	.bill,
	.pick {
		display: grid;
		gap: 6px;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	h2 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.bill-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		margin: 0;
		font-weight: 700;
	}
	.bill-name {
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
	}
	.cand {
		display: grid;
		flex: 1;
		min-width: 0;
	}
	.num {
		white-space: nowrap;
		font-weight: 700;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	label {
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
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
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
