<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { formatShortDay } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { SUBSCRIPTION_CATEGORIES } from '#lib/shared/subscriptions-catalogue';
	import { categoryLabel } from '#lib/shared/transactions';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	interface Subscription {
		id: string;
		updatedAt: number;
		name: string;
		amountMinor: number;
		currency: string;
		category: keyof typeof SUBSCRIPTION_CATEGORIES;
		walletId: string | null;
	}

	let {
		subscription,
		wallets,
		categories,
		expenses,
		today,
		errors = {},
		error,
		busy,
		submit
	}: {
		subscription: Subscription;
		wallets: { id: string; name: string; currency: string }[];
		categories: { id: string; name: string; tileKey: string; isPreset: boolean }[];
		expenses: {
			id: string;
			title: string | null;
			amountMinor: number;
			currency: string;
			occurredOn: string;
		}[];
		today: string;
		/** FN-05 field errors of the new transaction (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		error?: string;
		busy: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr, locale } = useI18n();
	const uid = $props.id();
	let mode = $state('new');
	// Without JavaScript both ways are shown; the posted `mode` decides.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const sameCurrency = $derived(wallets.filter((w) => w.currency === subscription.currency));
	const payable = $derived(expenses.filter((e) => e.currency === subscription.currency));
	const defaultWallet = $derived(
		sameCurrency.find((w) => w.id === subscription.walletId)?.id ?? sameCurrency[0]?.id ?? ''
	);
	// The bill's category's preset tile (Hiburan, Tagihan, Pendidikan), else the first expense category.
	const defaultCategory = $derived.by(() => {
		const tile = SUBSCRIPTION_CATEGORIES[subscription.category].tileKey;
		return categories.find((c) => c.isPreset && c.tileKey === tile)?.id ?? categories[0]?.id ?? '';
	});
	const err = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<form method="POST" action="?/markPaid" use:enhance={submit} class="pay-form" novalidate>
	<input type="hidden" name="subscriptionId" value={subscription.id} />
	<input type="hidden" name="updatedAt" value={subscription.updatedAt} />
	<p class="meta">
		{subscription.name} ·
		<span class="num">{formatMoney(subscription.amountMinor, subscription.currency)}</span>
	</p>
	{#if error}<p class="error" role="alert">{tr(error)}</p>{/if}

	<Segmented
		name="mode"
		label={tr('Cara mencatat pembayaran')}
		bind:value={mode}
		options={[
			{ value: 'new', label: tr('Catat transaksi baru') },
			{ value: 'link', label: tr('Hubungkan transaksi') }
		]}
	/>

	{#if !hydrated || mode === 'new'}
		<fieldset>
			{#if !hydrated}<legend>{tr('Catat transaksi baru')}</legend>{/if}
			{#if sameCurrency.length === 0}
				<p class="meta">
					{tr('Belum ada dompet dengan mata uang ini. Tambah dompet di Kekayaan dulu.')}
				</p>
			{:else}
				<div class="field">
					<label for="{uid}-wallet">{tr('Dompet')}</label>
					<select id="{uid}-wallet" name="walletId" value={defaultWallet}>
						{#each sameCurrency as w (w.id)}
							<option value={w.id}>{w.name}</option>
						{/each}
					</select>
					{#if err('walletId')}<p class="error">{err('walletId')}</p>{/if}
				</div>
			{/if}
			<div class="field">
				<label for="{uid}-category">{tr('Kategori')}</label>
				<select id="{uid}-category" name="categoryId" value={defaultCategory}>
					{#each categories as c (c.id)}
						<option value={c.id}>{categoryLabel(c, tr)}</option>
					{/each}
				</select>
				{#if err('categoryId')}<p class="error">{err('categoryId')}</p>{/if}
			</div>
			<div class="field">
				<label for="{uid}-date">{tr('Tanggal bayar')}</label>
				<input id="{uid}-date" type="date" name="occurredOn" value={today} />
				{#if err('occurredOn')}<p class="error">{err('occurredOn')}</p>{/if}
			</div>
			{#if err('amountMinor')}<p class="error">{err('amountMinor')}</p>{/if}
		</fieldset>
	{/if}

	{#if !hydrated || mode === 'link'}
		<fieldset>
			{#if !hydrated}<legend>{tr('Hubungkan transaksi')}</legend>{/if}
			{#if payable.length === 0}
				<p class="meta">{tr('Belum ada pengeluaran dengan mata uang ini untuk dihubungkan.')}</p>
			{:else}
				<div class="field">
					<label for="{uid}-tx">{tr('Pengeluaran')}</label>
					<select id="{uid}-tx" name="transactionId">
						{#each payable as e (e.id)}
							<option value={e.id}>
								{formatShortDay(e.occurredOn, locale)} · {e.title ?? tr('Tanpa judul')} · {formatMoney(
									e.amountMinor,
									e.currency
								)}
							</option>
						{/each}
					</select>
				</div>
			{/if}
		</fieldset>
	{/if}

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : tr('Tandai sudah dibayar')}
	</Button>
</form>

<style>
	.pay-form {
		display: grid;
		gap: 16px;
		padding-bottom: 8px;
	}
	fieldset {
		display: grid;
		gap: 16px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 8px;
		padding: 0;
		font-size: 17px;
		font-weight: 600;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field > label {
		font-size: 15px;
		font-weight: 600;
	}
	select,
	input[type='date'] {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
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
