<script lang="ts">
	import { formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';

	// FN-55b: a card statement's figures in the Impor preview and result — each as printed, or a sum of its rows
	// computed on the server (wallet convention: owed is negative). Every figure goes through `shown()`, so the eye's
	// hidden amounts mask it like any other page (red team L3).
	let {
		card,
		firstStatement
	}: {
		card: {
			statementDate: string;
			dueDate: string | null;
			previousBalanceMinor: number;
			newBalanceMinor: number;
			minimumPaymentMinor: number | null;
			limitMinor: number | null;
			totals: { payments: number; credits: number; purchases: number };
			feesAndInterestMinor: number | null;
			walletBalanceMinor: number | null;
		};
		/** No earlier statement of this card: its continuity makes no claim (the wallet balance is shown). */
		firstStatement: boolean;
	} = $props();
	const { tr, trf, locale } = useI18n();

	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, 'IDR', 'auto', locale));
	const owed = (balance: number) =>
		balance > 0 ? trf('{jumlah} (saldo kredit)', { jumlah: money(balance) }) : money(-balance);
</script>

<dl class="card-bill">
	<dt>{tr('Tanggal tagihan')}</dt>
	<dd>{formatShortDate(card.statementDate, locale)}</dd>
	{#if card.dueDate}
		<dt>{tr('Tanggal jatuh tempo')}</dt>
		<dd>{formatShortDate(card.dueDate, locale)}</dd>
	{/if}
	<dt>{tr('Tagihan sebelumnya')}</dt>
	<dd class="num">{owed(card.previousBalanceMinor)}</dd>
	<dt>{tr('Pembayaran')}</dt>
	<dd class="num">{money(card.totals.payments)}</dd>
	{#if card.totals.credits > 0}
		<dt>{tr('Kredit lain (refund)')}</dt>
		<dd class="num">{money(card.totals.credits)}</dd>
	{/if}
	<dt>{tr('Pembelian')}</dt>
	<dd class="num">{money(card.totals.purchases)}</dd>
	<dt>{tr('Biaya dan bunga')}</dt>
	<dd class="num">{money(card.feesAndInterestMinor)}</dd>
	<dt>{tr('Tagihan baru')}</dt>
	<dd class="num">{owed(card.newBalanceMinor)}</dd>
	{#if card.minimumPaymentMinor !== null}
		<dt>{tr('Pembayaran minimum (tertera)')}</dt>
		<dd class="num">{money(card.minimumPaymentMinor)}</dd>
	{/if}
	{#if card.limitMinor !== null}
		<dt>{tr('Limit kredit (tertera)')}</dt>
		<dd class="num">{money(card.limitMinor)}</dd>
	{/if}
</dl>
{#if firstStatement}
	<p>
		{card.walletBalanceMinor === null
			? tr('Tagihan pertama kartu ini: saldonya belum dibandingkan.')
			: trf(
					'Tagihan pertama kartu ini: saldonya belum dibandingkan. Saldo dompet kartu sekarang {jumlah}.',
					{ jumlah: money(card.walletBalanceMinor) }
				)}
	</p>
{/if}

<style>
	.card-bill {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 4px 12px;
		margin: 8px 0;
	}
	.card-bill dt {
		min-width: 0;
		color: var(--muted);
	}
	.card-bill dd {
		margin: 0;
		font-weight: 600;
		text-align: right;
		overflow-wrap: anywhere;
	}
</style>
