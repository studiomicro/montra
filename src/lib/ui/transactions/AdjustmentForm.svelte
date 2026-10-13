<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		NOTE_MAX_LENGTH,
		TITLE_MAX_LENGTH,
		type AdjustmentFormValues
	} from '#lib/shared/transactions';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	// "Penyesuaian saldo" (FN-37). Composing: pick a wallet and type its real balance; the server reads the
	// wallet's balance again and records the difference. Editing (`adjustment` set): amount, direction and
	// wallet are fixed (owner decision A), so only title, note, date and time are fields.
	let {
		action,
		adjustment,
		values,
		errors = {},
		wallets = [],
		busy,
		submit
	}: {
		action: '?/adjust' | '?/update';
		/** The adjustment being edited (absent when composing). */
		adjustment?: {
			updatedAt: number;
			walletName: string;
			/** Signed: + raised the balance, − lowered it. */
			signedMinor: number;
			currency: string;
		};
		values: AdjustmentFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		/** Live wallets with the balance the page loaded (only a hint; null when too large to show). */
		wallets?: { id: string; name: string; currency: string; balanceMinor: number | null }[];
		busy: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	let walletId = $state(untrack(() => values.walletId || wallets[0]?.id || ''));
	const wallet = $derived(wallets.find((w) => w.id === walletId));
	const currency = $derived(wallet?.currency ?? 'IDR');
	const initialMinor = $derived(untrack(() => typedAmountMinor(values.balance, currency, locale)));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<form method="POST" {action} use:enhance={submit} class="adjust-form" novalidate>
	{#if adjustment}
		<input type="hidden" name="updatedAt" value={adjustment.updatedAt} />
		<div class="summary">
			<p class="figure num">
				{adjustment.walletName} · {formatMoney(
					adjustment.signedMinor,
					adjustment.currency,
					'signed',
					locale
				)}
			</p>
			<p class="meta">
				{tr(
					'Jumlah, arah dan dompet penyesuaian tidak bisa diubah. Untuk mengoreksinya, hapus lalu buat penyesuaian baru.'
				)}
			</p>
		</div>
	{:else}
		<p class="meta">
			{tr(
				'Isi saldo dompet yang sebenarnya. Selisihnya dicatat sebagai satu penyesuaian, tidak dihitung sebagai pengeluaran, pemasukan atau anggaran.'
			)}
		</p>
		<div class="field">
			<label for="{uid}-wallet">{tr('Dompet')}</label>
			<select
				id="{uid}-wallet"
				name="walletId"
				bind:value={walletId}
				aria-invalid={error('walletId') ? 'true' : undefined}
			>
				{#each wallets as w (w.id)}
					<option value={w.id}>{w.name} · {w.currency}</option>
				{/each}
			</select>
			{#if error('walletId')}<p class="error">{error('walletId')}</p>{/if}
			{#if wallet}
				<p class="meta num">
					{wallet.balanceMinor === null
						? tr('Total terlalu besar untuk ditampilkan')
						: trf('Saldo {dompet} sekarang: {saldo}', {
								dompet: wallet.name,
								saldo: formatMoney(wallet.balanceMinor, wallet.currency, 'auto', locale)
							})}
				</p>
			{/if}
		</div>

		<div class="field">
			<AmountInput
				label={tr('Saldo baru')}
				name="balance"
				valueMinor={initialMinor}
				{currency}
				typed={errors.amountMinor ? values.balance : undefined}
			/>
			{#if error('amountMinor')}<p class="error" role="alert">{error('amountMinor')}</p>{/if}
			<label class="check">
				<input type="checkbox" name="negative" checked={values.negative} />
				<span>{tr('Saldo minus (utang, misalnya tagihan kartu kredit)')}</span>
			</label>
		</div>
	{/if}

	<Field
		id="{uid}-title"
		name="title"
		label={tr('Judul (opsional)')}
		hint={tr('Kosongkan untuk memakai “Penyesuaian saldo”.')}
		value={values.title}
		maxlength={TITLE_MAX_LENGTH}
		autocomplete="off"
		error={error('title')}
	/>
	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={NOTE_MAX_LENGTH}
		autocomplete="off"
		error={error('note')}
	/>
	<Field
		id="{uid}-date"
		name="occurredOn"
		type="date"
		label={tr('Tanggal')}
		value={values.occurredOn}
		required
		error={error('occurredOn')}
	/>
	<Field
		id="{uid}-time"
		name="occurredTime"
		type="time"
		label={tr('Waktu (WIB, opsional)')}
		hint={adjustment
			? tr('Kosongkan untuk tetap memakai waktu yang tersimpan.')
			: tr('Kosongkan untuk memakai waktu saat disimpan.')}
		value={values.occurredTime}
		error={error('occurredTime')}
	/>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : adjustment ? tr('Simpan perubahan') : tr('Simpan penyesuaian')}
	</Button>
</form>

<style>
	.adjust-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.field > label {
		margin-bottom: 6px;
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
	.summary {
		display: grid;
		gap: 6px;
		padding: 14px 16px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.figure {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		font-size: 15px;
	}
	.check input {
		width: 20px;
		height: 20px;
		margin: 0;
		flex: none;
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
