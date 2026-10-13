<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import AdjustmentForm from '#lib/ui/transactions/AdjustmentForm.svelte';
	import TransactionForm from '#lib/ui/transactions/TransactionForm.svelte';
	import { QUEUE_FULL } from '#lib/shared/offline-queue';
	import {
		formAmountMinor,
		formPayload,
		transactionSummary
	} from '#lib/ui/offline-queue/form-item';
	import { browserOffline, enqueueOffline } from '#lib/ui/offline-queue/runtime.svelte';
	import { QUEUE_NETWORK, QUEUE_QUEUED_HERE } from '#lib/ui/offline-queue/view';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	/** The action in flight ('' when none); every submit button is disabled meanwhile. */
	let busy = $state('');
	let networkError = $state('');
	let formKey = $state(0);

	/** A change of this page waits in the offline queue: the forms give way (no second, conflicting one). */
	let queued = $state(false);

	/**
	 * FN-02: offline, or no answer came back. The edit or delete is queued with the `updated_at` this page loaded,
	 * so the server refuses it ("changed meanwhile") if the row changed elsewhere first, never overwrites. A
	 * balance adjustment (FN-37) is never queued.
	 */
	async function queueChange(name: 'update' | 'delete', formData: FormData) {
		const wallet = data.wallets.find((w) => w.id === data.values.walletId);
		const currency = wallet?.currency ?? 'IDR';
		const spaceId = data.queue?.spaceId;
		const result = spaceId
			? await enqueueOffline({
					clientId: crypto.randomUUID(),
					spaceId,
					spaceName: data.queue?.spaceName ?? '',
					kind: name === 'update' ? 'transaction.update' : 'transaction.delete',
					targetId: data.transaction.id,
					expectedUpdatedAt: data.transaction.updatedAt,
					payload: name === 'update' ? formPayload(formData) : [],
					locale,
					summary:
						name === 'update'
							? transactionSummary(formData, data.wallets, locale)
							: {
									title: data.values.title,
									amountMinor: formAmountMinor(data.values.amount, currency, locale),
									currency,
									count: 1
								}
				})
			: 'unavailable';
		if (result === 'queued') queued = true;
		else networkError = tr(result === 'full' ? QUEUE_FULL : QUEUE_NETWORK);
		busy = '';
	}

	/** Success is the redirect to Riwayat, after the server confirmed the write. */
	const track =
		(name: 'update' | 'delete'): SubmitFunction =>
		({ formData, cancel }) => {
			const queueable = !data.adjustment;
			networkError = '';
			if (queueable && browserOffline()) {
				cancel();
				void queueChange(name, formData);
				return;
			}
			busy = name;
			return async ({ result, update }) => {
				if (result.type === 'error') {
					// No status: fetch failed or the answer was not the server's (offline, a proxy page).
					if (queueable && result.status === undefined) await queueChange(name, formData);
					else {
						networkError = tr(QUEUE_NETWORK);
						busy = '';
					}
					return;
				}
				await update({ reset: false });
				if (result.type === 'failure') {
					// Changed or gone meanwhile: show the transaction as it is now.
					if (result.status === 404 || result.status === 409) await invalidateAll();
					formKey++;
				}
				busy = '';
			};
		};

	const values = $derived(form && 'values' in form && form.values ? form.values : data.values);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
</script>

<svelte:head><title>{tr('Ubah transaksi')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/riwayat', label: tr('Kembali ke Riwayat') }}
	title={tr('Ubah transaksi')}
/>

<div class="page">
	<FormBanner message={banner} />
	{#if data.seriesId}
		<p class="series">
			{tr('Dibuat dari transaksi berulang. Perubahan di sini hanya mengubah transaksi ini.')}
			<a href="/riwayat/berulang/{data.seriesId}">{tr('Ubah seri')}</a>
		</p>
	{/if}
	{#if data.patungan}
		<!-- FN-49: a split's bill keeps its amount, currency and type until it is unlinked there. -->
		<p class="series">
			{data.patungan.effectiveAmountMinor < data.patungan.amountMinor
				? trf(
						'Tertaut ke patungan: semua total hanya menghitung bagianmu, {amount}. Jumlah, mata uang dan jenisnya tidak bisa diubah selama tertaut.',
						{
							amount: formatMoney(
								data.patungan.effectiveAmountMinor,
								data.patungan.currency,
								'auto',
								locale
							)
						}
					)
				: tr('Bagianmu dari sebuah patungan. Jumlahnya mengikuti patungan itu.')}
			<a href="/patungan/{data.patungan.splitId}">{tr('Lihat patungan')}</a>
		</p>
	{:else if data.canSplit}
		<p class="series">
			{tr('Bayar tagihan bersama? Bagi ke teman, totalmu hanya menghitung bagianmu.')}
			<a href="/patungan/baru?dariTransaksi={data.transaction.id}">{tr('Buat patungan')}</a>
		</p>
	{/if}
	{#if queued}
		<p class="queued" role="status">
			{tr(QUEUE_QUEUED_HERE)} <a href="/riwayat">{tr('Lihat di Riwayat')}</a>
		</p>
	{:else}
		<p class="meta">
			{trf('Waktu tersimpan: {waktu}', {
				waktu: formatDateTimeWib(data.transaction.occurredAt, locale)
			})}
		</p>
		{#if data.transaction.hasPhoto}
			<a class="receipt" href="/riwayat/{data.transaction.id}/foto">
				<img src="/riwayat/{data.transaction.id}/foto" alt={tr('Foto struk')} />
				<span>{tr('Lihat foto struk')}</span>
			</a>
		{/if}
		{#key formKey}
			{#if data.adjustment && data.adjustmentValues}
				<AdjustmentForm
					action="?/update"
					adjustment={data.adjustment}
					values={form && 'adjustmentValues' in form && form.adjustmentValues
						? form.adjustmentValues
						: data.adjustmentValues}
					{errors}
					busy={busy !== ''}
					submit={track('update')}
				/>
			{:else}
				<TransactionForm
					action="?/update"
					transaction={data.transaction}
					{values}
					{errors}
					wallets={data.wallets}
					categories={data.categories}
					categoryReason={data.categoryReason}
					busy={busy !== ''}
					submit={track('update')}
				/>
			{/if}
		{/key}

		<details class="confirm">
			<summary>{tr('Hapus transaksi')}</summary>
			<form method="POST" action="?/delete" use:enhance={track('delete')}>
				<input type="hidden" name="updatedAt" value={data.transaction.updatedAt} />
				<p>{tr('Transaksi ini dihapus dari riwayat dan semua total. Tidak bisa dibatalkan.')}</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'delete' ? tr('Memproses…') : tr('Ya, hapus')}
				</Button>
			</form>
		</details>
	{/if}

	<a class="cancel" href="/riwayat">{tr('Batal')}</a>
</div>

<style>
	.page {
		display: grid;
		gap: 16px;
		max-width: 560px;
		margin-top: 8px;
	}
	.queued {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink-2);
		font-size: 15px;
	}
	.queued a {
		color: var(--ink);
		font-weight: 600;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.receipt {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.receipt img {
		width: 72px;
		height: 72px;
		border-radius: var(--r-xs);
		object-fit: cover;
		background: var(--panel);
	}
	.series {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		font-size: 14px;
	}
	.series a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		justify-self: center;
		text-decoration: none;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
</style>
