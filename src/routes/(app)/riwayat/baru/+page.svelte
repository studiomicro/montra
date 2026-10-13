<script lang="ts">
	import { onMount } from 'svelte';
	import type { ActionResult, SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import AdjustmentForm from '#lib/ui/transactions/AdjustmentForm.svelte';
	import TransactionForm from '#lib/ui/transactions/TransactionForm.svelte';
	import { QUEUE_FULL } from '#lib/shared/offline-queue';
	import { formPayload, transactionSummary } from '#lib/ui/offline-queue/form-item';
	import { browserOffline, enqueueOffline } from '#lib/ui/offline-queue/runtime.svelte';
	import { takeHeldPhoto, type HeldPhoto } from '#lib/ui/receipts/held-photo';
	import { queueAmountMissing, QUEUE_NETWORK, QUEUE_QUEUED_HERE } from '#lib/ui/offline-queue/view';

	let { data, form } = $props();
	const { tr, locale } = useI18n();

	let busy = $state(false);
	let networkError = $state('');
	let formKey = $state(0);
	let refreshing = $state(false);

	/** FN-02: the id this form's row gets; the same id when the same submission is sent again. */
	let clientId = crypto.randomUUID();
	/** A write of this page waits in the offline queue (never shown as saved). */
	let queued = $state(false);
	/** FN-15 "Lampirkan fotonya saja": the receipt photo /riwayat/struk handed over, sent with the form. */
	let heldPhoto = $state<HeldPhoto | null>(null);
	onMount(() => {
		heldPhoto = takeHeldPhoto();
	});

	/**
	 * Offline, or the request never got an answer: the submission goes to the offline queue with this form's
	 * clientId (so an attempt that did reach the server is not written twice). A server answer — a refusal, a
	 * 401 — is never queued.
	 */
	async function queueCreate(formData: FormData) {
		const summary = transactionSummary(formData, data.wallets, locale);
		if (!summary.amountMinor) {
			networkError = tr(queueAmountMissing(summary.currency));
			return;
		}
		const spaceId = data.queue?.spaceId;
		const result = spaceId
			? await enqueueOffline({
					clientId,
					spaceId,
					spaceName: data.queue?.spaceName ?? '',
					kind: 'transaction.create',
					payload: formPayload(formData),
					locale,
					summary
				})
			: 'unavailable';
		if (result === 'queued') {
			queued = true;
			clientId = crypto.randomUUID();
			formKey++;
		} else networkError = tr(result === 'full' ? QUEUE_FULL : QUEUE_NETWORK);
	}

	/** Success is the redirect to Riwayat, which happens only after the server wrote the row. */
	async function settle({
		result,
		update
	}: {
		result: ActionResult;
		update: (opts?: { reset?: boolean }) => Promise<void>;
	}) {
		if (result.type === 'error') networkError = tr(QUEUE_NETWORK);
		else {
			await update({ reset: false });
			if (result.type === 'failure') formKey++;
		}
		busy = false;
	}

	/** "Penyesuaian saldo" (FN-37) is never queued: it needs the wallet's balance as the server reads it now. */
	const adjustSubmit: SubmitFunction = () => {
		networkError = '';
		queued = false;
		busy = true;
		return settle;
	};

	const createSubmit: SubmitFunction = ({ formData, cancel }) => {
		networkError = '';
		queued = false;
		formData.set('clientId', clientId);
		if (heldPhoto) {
			// A photo cannot wait in the offline queue: it is sent now or not at all.
			if (browserOffline()) {
				cancel();
				networkError = tr('Foto struk hanya bisa dilampirkan saat online.');
				return;
			}
			formData.set('photo', heldPhoto.file);
			busy = true;
			return async (answer) => {
				if (answer.result.type === 'error') {
					networkError = tr(QUEUE_NETWORK);
					busy = false;
				} else await settle(answer);
			};
		}
		if (browserOffline()) {
			cancel();
			void queueCreate(formData);
			return;
		}
		busy = true;
		return async (answer) => {
			// No status: fetch failed or the answer was not the server's (offline, a proxy page).
			if (answer.result.type === 'error' && answer.result.status === undefined) {
				await queueCreate(formData);
				busy = false;
			} else await settle(answer);
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
	const adjustmentValues = $derived(
		form && 'adjustmentValues' in form && form.adjustmentValues
			? form.adjustmentValues
			: data.adjustmentValues
	);
	const adjustmentErrors = $derived(
		form && 'adjustmentErrors' in form && form.adjustmentErrors
			? (form.adjustmentErrors as Partial<Record<string, string>>)
			: {}
	);
	const title = $derived(data.adjustmentValues ? tr('Penyesuaian saldo') : tr('Tambah transaksi'));
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
</script>

<svelte:head><title>{title}</title></svelte:head>
<ScreenTitle back={{ href: '/riwayat', label: tr('Kembali ke Riwayat') }} {title}>
	{#snippet actions()}
		{#if data.adjustmentValues}
			<Button href="/riwayat/baru" variant="secondary" size="sm">
				{tr('Catat pengeluaran, pemasukan atau transfer')}
			</Button>
		{:else}
			<Button href="/riwayat/baru?type=adjustment" variant="secondary" size="sm">
				{tr('Sesuaikan saldo dompet')}
			</Button>
		{/if}
	{/snippet}
</ScreenTitle>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError || !values}
	<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
{:else if data.wallets.length === 0}
	<EmptyState
		illustration="wallet"
		text={tr('Tambah dompet dulu supaya transaksi punya tempat.')}
		actionLabel={tr('Tambah dompet')}
		actionHref="/dompet?tambah=1"
	/>
{:else}
	<div class="page">
		<FormBanner message={banner} />
		{#if queued}
			<p class="queued" role="status">{tr(QUEUE_QUEUED_HERE)}</p>
		{/if}
		{#if adjustmentValues}
			{#key formKey}
				<AdjustmentForm
					action="?/adjust"
					values={adjustmentValues}
					errors={adjustmentErrors}
					wallets={data.wallets}
					{busy}
					submit={adjustSubmit}
				/>
			{/key}
		{:else}
			{#if heldPhoto}
				<div class="held" role="status">
					{#if heldPhoto.preview}
						<img src={heldPhoto.preview} alt={tr('Pratinjau foto struk')} />
					{/if}
					<p>{tr('Foto struk akan disimpan bersama transaksi ini.')}</p>
					<button type="button" class="drop" onclick={() => (heldPhoto = null)}
						>{tr('Lepas foto')}</button
					>
				</div>
			{/if}
			{#key formKey}
				<TransactionForm
					action="?/create"
					{values}
					{errors}
					wallets={data.wallets}
					categories={data.categories}
					{busy}
					submit={createSubmit}
					enctype={heldPhoto ? 'multipart/form-data' : undefined}
					suggest
				/>
			{/key}
		{/if}
		<a class="cancel" href="/riwayat">{tr('Batal')}</a>
	</div>
{/if}

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
	.held {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.held img {
		width: 64px;
		height: 64px;
		border-radius: var(--r-xs);
		object-fit: cover;
	}
	.held p {
		flex: 1 1 12em;
		margin: 0;
		font-size: 15px;
	}
	.drop {
		min-height: 44px;
		padding: 0 4px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
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
</style>
