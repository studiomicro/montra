<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatShortDate } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { maskedLastFour } from '#lib/shared/wallets';
	import DueChip from '#lib/ui/cards/DueChip.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	// FN-55a card page: what is owed, the limit, the last stored bill as printed and what happened since it. Every
	// figure is computed from stored rows or printed on a stored statement; a figure the statement did not print is
	// absent. No interest estimate, no "pay at least", no score: information, not advice.
	let { data } = $props();
	applyAmountsHiddenAtLoad();
	const { tr, trf, locale } = useI18n();

	let refreshing = $state(false);
	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const card = $derived(data.card);
	const summary = $derived(data.summary);
	const bill = $derived(summary?.bill ?? null);
	const TOO_LARGE = msg('Total terlalu besar untuk ditampilkan');
	const money = (minor: number | null) =>
		minor === null ? tr(TOO_LARGE) : shown(formatMoney(minor, card.currency, 'auto', locale));
	const date = (d: string) => formatShortDate(d, locale);
	/** A credit balance is not owed: the hero names it "Saldo kredit". */
	const inCredit = $derived(summary !== null && (summary.creditMinor ?? 0) > 0);
	const payHref = $derived(`/riwayat/baru?type=transfer&ke=${card.id}`);
	const editHref = $derived(`/dompet?ubah=${card.id}`);
	const adjustHref = $derived(`/riwayat/baru?type=adjustment&wallet=${card.id}`);
</script>

<svelte:head><title>{card.name}</title></svelte:head>

<ScreenTitle
	back={{ href: '/dompet', label: tr('Kembali ke Dompet') }}
	title={card.name}
	subtitle={card.lastFour
		? `${tr('Kartu kredit')} · ${maskedLastFour(card.lastFour)}`
		: tr('Kartu kredit')}
>
	{#snippet actions()}
		<Button variant="secondary" size="sm" href={editHref}>{tr('Ubah kartu')}</Button>
	{/snippet}
</ScreenTitle>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError || !summary}
	<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
{:else}
	<div class="page">
		<HeroAmount
			label={inCredit ? tr('Saldo kredit') : tr('Utang sekarang')}
			amountMinor={inCredit ? summary.creditMinor : summary.owedMinor}
			currency={card.currency}
			fallback={tr(TOO_LARGE)}
		>
			{#if summary.available?.kind === 'available'}
				<p class="num">
					{trf('Kredit tersedia {jumlah}', { jumlah: money(summary.available.minor) })}
					· {trf('Limit kredit {jumlah}', { jumlah: money(summary.limitMinor) })}
				</p>
			{:else if summary.available?.kind === 'over'}
				<p class="num">
					{tr('Melebihi limit')} · {trf('Limit kredit {jumlah}', {
						jumlah: money(summary.limitMinor)
					})}
				</p>
			{/if}
		</HeroAmount>

		<div class="row-actions">
			{#if summary.due}<DueChip due={summary.due} />{/if}
			{#if !summary.due && card.dueDay === null && card.statementDay === null && !bill}
				<a class="link" href={editHref}>{tr('Tambah tanggal')}</a>
			{/if}
		</div>

		<div class="actions">
			<Button icon="transfer" href={payHref}>{tr('Bayar tagihan')}</Button>
		</div>
		<p class="meta">
			{tr('Bayar tagihan dicatat sebagai transfer dari dompetmu ke kartu ini, bukan pengeluaran.')}
		</p>

		<section aria-labelledby="bill-title">
			<h2 id="bill-title">{tr('Tagihan terakhir')}</h2>
			{#if !bill}
				<p class="meta">
					{tr('Belum ada tagihan yang diimpor untuk kartu ini.')}
					<a class="link" href="/impor#mutasi">{tr('Impor tagihan kartu')}</a>
				</p>
			{:else}
				<GroupList>
					<GroupRow>
						<span class="label">{tr('Tanggal tagihan')}</span>
						<span class="value">{date(bill.statement.statementDate)}</span>
					</GroupRow>
					{#if bill.statement.dueDate}
						<GroupRow>
							<span class="label">{tr('Tanggal jatuh tempo')}</span>
							<span class="value">{date(bill.statement.dueDate)}</span>
						</GroupRow>
					{/if}
					<GroupRow>
						<span class="label">{tr('Tagihan terakhir (tertera)')}</span>
						<span class="value num">
							{bill.statement.newBalanceMinor > 0
								? `${tr('Saldo kredit')} ${money(bill.statement.newBalanceMinor)}`
								: money(-bill.statement.newBalanceMinor)}
						</span>
					</GroupRow>
					{#if bill.statement.minimumPaymentMinor !== null}
						<GroupRow>
							<span class="label">{tr('Pembayaran minimum (tertera)')}</span>
							<span class="value num">{money(bill.statement.minimumPaymentMinor)}</span>
						</GroupRow>
					{/if}
					<GroupRow>
						<span class="label">{tr('Sudah dibayar sejak tagihan')}</span>
						<span class="value num">{money(bill.paidMinor)}</span>
					</GroupRow>
					<GroupRow>
						<span class="label">{tr('Sisa tagihan')}</span>
						<span class="value num">
							{bill.remainingMinor === 0 ? tr('Lunas') : money(bill.remainingMinor)}
						</span>
					</GroupRow>
					<GroupRow>
						<span class="label">{tr('Belum ditagih')}</span>
						<span class="value num">{money(bill.unbilledMinor)}</span>
					</GroupRow>
				</GroupList>
				{#if bill.gapMinor !== null && bill.gapMinor !== 0}
					<p class="warn" role="note">
						{trf('Saldo dompet tidak cocok dengan tagihan terakhir (selisih {jumlah}).', {
							jumlah: money(Math.abs(bill.gapMinor))
						})}
						<a class="link" href={adjustHref}>{tr('Sesuaikan saldo')}</a>
					</p>
				{/if}
			{/if}
		</section>

		{#if summary.unmatchedPayments > 0}
			<p class="meta">
				<a class="link" href="/impor/cocokkan-transfer">
					{summary.unmatchedPayments === 1
						? tr('1 pembayaran kartu belum dicocokkan')
						: trf('{n} pembayaran kartu belum dicocokkan', { n: summary.unmatchedPayments })}
				</a>
			</p>
		{/if}

		<section aria-labelledby="statements-title">
			<h2 id="statements-title">{tr('Tagihan yang diimpor')}</h2>
			{#if data.statements.length === 0}
				<p class="meta">{tr('Belum ada.')}</p>
			{:else}
				<GroupList>
					{#each data.statements as s (s.id)}
						<GroupRow>
							<span class="text">
								<span class="name">{date(s.statementDate)}</span>
								{#if s.dueDate}
									<span class="meta">
										{trf('Jatuh tempo {tanggal}', { tanggal: date(s.dueDate) })}
									</span>
								{/if}
							</span>
							<span class="value num">
								{s.newBalanceMinor > 0 ? money(s.newBalanceMinor) : money(-s.newBalanceMinor)}
							</span>
						</GroupRow>
					{/each}
				</GroupList>
				<a class="link" href="/impor#riwayat">{tr('Lihat Riwayat impor')}</a>
			{/if}
		</section>

		<p class="meta">
			{tr(
				'Cicilan yang kamu catat sendiri: buat transaksi berulang bulanan dengan tanggal berakhir di kartu ini.'
			)}
			<a class="link" href="/riwayat/berulang">{tr('Transaksi berulang')}</a>
		</p>
	</div>
{/if}

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 740px;
		margin-top: 8px;
	}
	h2 {
		margin: 0 0 12px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.label {
		flex: 1;
		min-width: 0;
		font-size: 15px;
		color: var(--ink-2);
	}
	.value {
		flex: none;
		max-width: 60%;
		font-weight: 700;
		text-align: right;
		overflow-wrap: anywhere;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-weight: 600;
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.warn {
		margin: 12px 0 0;
		font-size: 14px;
		color: var(--money-up);
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink-2);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
</style>
