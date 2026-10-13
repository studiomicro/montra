<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { formatMonthName } from '#lib/shared/dates';
	import {
		BILLING_CYCLE_LABELS,
		BILLING_CYCLES,
		REMINDER_DAYS_MAX,
		SUBSCRIPTION_NAME_MAX_LENGTH,
		WEEKDAY_LABELS,
		type SubscriptionFormValues
	} from '#lib/shared/subscriptions';
	import {
		SUBSCRIPTION_CATEGORIES,
		SUBSCRIPTION_CATEGORY_KEYS
	} from '#lib/shared/subscriptions-catalogue';
	import { WALLET_CURRENCIES, walletCurrencyLabel } from '#lib/shared/wallets';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	let {
		action,
		subscription,
		values,
		errors = {},
		busy,
		wallets,
		submit
	}: {
		action: '?/createSubscription' | '?/updateSubscription';
		/** The subscription being edited (absent when adding): its `updated_at` guards against a stale save. */
		subscription?: { id: string; updatedAt: number };
		values: SubscriptionFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		busy: boolean;
		wallets: { id: string; name: string; currency: string }[];
		submit: SubmitFunction;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();
	const known = (code: string) => (WALLET_CURRENCIES as readonly string[]).includes(code);
	// Follow the selects, so the amount field, the day fields and the wallet list match the choice.
	let currency = $state(untrack(() => (known(values.currency) ? values.currency : 'IDR')));
	let cycle = $state(
		untrack(() =>
			(BILLING_CYCLES as readonly string[]).includes(values.cycle) ? values.cycle : 'monthly'
		)
	);
	// Read once in the currency the text was typed in; a later currency change is AmountInput's (FN-47).
	const initialMinor = $derived(untrack(() => typedAmountMinor(values.amount, currency, locale)));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
	// Without JavaScript every day field is shown (the server reads the one of the posted cycle).
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	const shows = (field: 'day' | 'month' | 'weekday') =>
		!hydrated ||
		(field === 'day' && cycle !== 'weekly') ||
		(field === 'month' && cycle === 'yearly') ||
		(field === 'weekday' && cycle === 'weekly');
	const walletChoices = $derived(
		hydrated ? wallets.filter((w) => w.currency === currency || w.id === values.walletId) : wallets
	);
	const days = Array.from({ length: 31 }, (_, i) => i + 1);
	const months = Array.from({ length: 12 }, (_, i) => i + 1);
	const reminders = Array.from({ length: REMINDER_DAYS_MAX + 1 }, (_, i) => i);
	const reminderLabel = (n: number) =>
		n === 0 ? tr('Pada hari tagihan') : trf('{n} hari sebelumnya', { n });
</script>

<form method="POST" {action} use:enhance={submit} class="sub-form" novalidate>
	{#if subscription}
		<input type="hidden" name="subscriptionId" value={subscription.id} />
		<input type="hidden" name="updatedAt" value={subscription.updatedAt} />
	{:else}
		<input type="hidden" name="catalogueId" value={values.catalogueId} />
	{/if}
	{#if error('catalogueId')}<p class="error">{error('catalogueId')}</p>{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama langganan')}
		value={values.name}
		maxlength={SUBSCRIPTION_NAME_MAX_LENGTH}
		autocomplete="off"
		error={error('name')}
	/>

	<div class="field">
		<label for="{uid}-category">{tr('Kategori')}</label>
		<select
			id="{uid}-category"
			name="category"
			value={values.category || 'lainnya'}
			aria-invalid={error('category') ? 'true' : undefined}
		>
			{#each SUBSCRIPTION_CATEGORY_KEYS as key (key)}
				<option value={key}>{tr(SUBSCRIPTION_CATEGORIES[key].label)}</option>
			{/each}
		</select>
		{#if error('category')}<p class="error">{error('category')}</p>{/if}
	</div>

	<div class="row">
		<div class="field cur">
			<label for="{uid}-currency">{tr('Mata uang')}</label>
			<select
				id="{uid}-currency"
				name="currency"
				bind:value={currency}
				aria-invalid={error('currency') ? 'true' : undefined}
			>
				{#each WALLET_CURRENCIES as code (code)}
					<option value={code}>{walletCurrencyLabel(code)}</option>
				{/each}
			</select>
		</div>
		<div class="field grow">
			<AmountInput
				label={tr('Biaya per tagihan')}
				name="amount"
				valueMinor={initialMinor}
				{currency}
				typed={errors.amountMinor ? values.amount : undefined}
			/>
		</div>
	</div>
	{#if error('currency')}<p class="error">{error('currency')}</p>{/if}
	{#if error('amountMinor')}<p class="error">{error('amountMinor')}</p>{/if}

	<div class="field">
		<span class="label" id="{uid}-cycle">{tr('Siklus tagihan')}</span>
		<Segmented
			name="cycle"
			label={tr('Siklus tagihan')}
			bind:value={cycle}
			options={BILLING_CYCLES.map((c) => ({ value: c, label: tr(BILLING_CYCLE_LABELS[c]) }))}
		/>
		{#if error('cycle')}<p class="error">{error('cycle')}</p>{/if}
	</div>

	<div class="row">
		{#if shows('month')}
			<div class="field grow">
				<label for="{uid}-month">
					{hydrated ? tr('Bulan tagihan') : tr('Bulan tagihan (untuk Tahunan)')}
				</label>
				<select
					id="{uid}-month"
					name="month"
					value={values.month}
					aria-invalid={error('month') ? 'true' : undefined}
				>
					{#each months as m (m)}
						<option value={String(m)}>
							{formatMonthName(`2026-${String(m).padStart(2, '0')}`, locale)}
						</option>
					{/each}
				</select>
				{#if error('month')}<p class="error">{error('month')}</p>{/if}
			</div>
		{/if}
		{#if shows('day')}
			<div class="field grow">
				<label for="{uid}-day">
					{hydrated ? tr('Tanggal tagihan') : tr('Tanggal tagihan (Bulanan dan Tahunan)')}
				</label>
				<select
					id="{uid}-day"
					name="day"
					value={values.day}
					aria-invalid={error('day') ? 'true' : undefined}
				>
					{#each days as d (d)}
						<option value={String(d)}>{d}</option>
					{/each}
				</select>
				{#if error('day')}<p class="error">{error('day')}</p>{/if}
			</div>
		{/if}
		{#if shows('weekday')}
			<div class="field grow">
				<label for="{uid}-weekday">
					{hydrated ? tr('Hari tagihan') : tr('Hari tagihan (untuk Mingguan)')}
				</label>
				<select
					id="{uid}-weekday"
					name="weekday"
					value={values.weekday}
					aria-invalid={error('weekday') ? 'true' : undefined}
				>
					{#each WEEKDAY_LABELS as label, i (i)}
						<option value={String(i + 1)}>{tr(label)}</option>
					{/each}
				</select>
				{#if error('weekday')}<p class="error">{error('weekday')}</p>{/if}
			</div>
		{/if}
	</div>
	{#if shows('day')}
		<p class="meta">{tr('Tanggal 29–31 jatuh di hari terakhir pada bulan yang lebih pendek.')}</p>
	{/if}

	<div class="field">
		<label for="{uid}-wallet">{tr('Dibayar dari (opsional)')}</label>
		<select
			id="{uid}-wallet"
			name="walletId"
			value={values.walletId}
			aria-invalid={error('walletId') ? 'true' : undefined}
		>
			<option value="">{tr('Tanpa dompet')}</option>
			{#each walletChoices as w (w.id)}
				<option value={w.id}>{w.name} · {w.currency}</option>
			{/each}
		</select>
		{#if error('walletId')}<p class="error">{error('walletId')}</p>{/if}
	</div>

	<div class="field">
		<label for="{uid}-reminder">{tr('Ingatkan')}</label>
		<select
			id="{uid}-reminder"
			name="reminderDays"
			value={values.reminderDays}
			aria-invalid={error('reminderDays') ? 'true' : undefined}
		>
			{#each reminders as n (n)}
				<option value={String(n)}>{reminderLabel(n)}</option>
			{/each}
		</select>
		{#if error('reminderDays')}<p class="error">{error('reminderDays')}</p>{/if}
	</div>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : subscription ? tr('Simpan perubahan') : tr('Tambah langganan')}
	</Button>
</form>

<style>
	.sub-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}
	.field > label,
	.label {
		font-size: 15px;
		font-weight: 600;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 12px;
	}
	.cur {
		flex: 0 0 auto;
	}
	.grow {
		flex: 1 1 140px;
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
	.meta {
		margin: -8px 0 0;
		font-size: 14px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
