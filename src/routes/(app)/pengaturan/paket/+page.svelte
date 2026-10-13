<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import {
		formatCreditDelta,
		formatCredits,
		LEDGER_REASON_LABELS
	} from '#lib/shared/billing/credits';
	import {
		PLAN_CATALOGUE,
		PLAN_FEATURES,
		PLANS,
		planRank,
		type Plan
	} from '#lib/shared/billing/plans';
	import { REFUND_STATUS_LABELS } from '#lib/shared/billing/refunds';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { hasProLook } from '#lib/shared/pro-look';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	let redeeming = $state(false);
	let redeemNetError = $state('');
	let checkingOut = $state<Plan | null>(null);
	let checkoutNetError = $state('');
	let refreshing = $state(false);

	const redeem: SubmitFunction = () => {
		redeeming = true;
		redeemNetError = '';
		return async ({ result, update }) => {
			if (result.type === 'error')
				redeemNetError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			// A refused code stays in the field so it can be corrected; a redeemed one is cleared.
			else await update({ reset: result.type === 'success' });
			redeeming = false;
		};
	};

	const checkout =
		(plan: Plan): SubmitFunction =>
		() => {
			checkingOut = plan;
			checkoutNetError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					checkoutNetError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update();
				checkingOut = null;
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

	const redeemForm = $derived(form && form.action === 'redeem' ? form : null);
	const redeemed = $derived(
		!redeeming && redeemForm && 'redeemed' in redeemForm ? redeemForm.redeemed : null
	);
	const redeemError = $derived(
		redeemNetError ||
			(redeemForm && 'error' in redeemForm && redeemForm.error ? tr(redeemForm.error) : undefined)
	);
	const checkoutError = $derived(
		checkoutNetError ||
			(form && form.action === 'checkout' && 'error' in form && form.error
				? tr(form.error)
				: undefined)
	);
	const redeemedText = $derived(
		redeemed
			? redeemed.credits !== null
				? trf('Voucher ditukar: {n} kredit masuk ke saldomu.', {
						n: formatCredits(redeemed.credits, locale)
					})
				: trf('Voucher ditukar: paket {paket} selama {hari} hari.', {
						paket: tr(PLAN_CATALOGUE[redeemed.plan ?? 'pro'].label),
						hari: redeemed.days ?? 0
					})
			: ''
	);
	const periodLabel = (plan: Plan) =>
		PLAN_CATALOGUE[plan].billingPeriod === 'weekly' ? tr('/minggu') : tr('/bulan');
</script>

<svelte:head><title>{tr('Paket & kredit')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Paket & kredit')}
/>

{#if refreshing}
	<Skeleton rows={6} />
{:else if data.loadError || !data.state || data.balance === null}
	<ErrorState
		text={tr(data.loadError ?? 'Paket dan kredit tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	<section class="hero" aria-labelledby="balance-title">
		<p class="eyebrow" id="balance-title">{tr('Saldo kredit')}</p>
		<p class="big" data-testid="credit-balance">{formatCredits(data.balance, locale)}</p>
		<p class="unit">{tr('kredit')}</p>
		{#snippet planLine(state: NonNullable<typeof data.state>)}
			<p class="plan-line">
				{trf('Paketmu: {paket}', { paket: tr(PLAN_CATALOGUE[state.plan].label) })}
				{#if state.plan !== 'gratis' && state.currentPeriodEnd !== null}
					· {trf('berlaku sampai {tanggal}', {
						tanggal: formatDateTimeWib(state.currentPeriodEnd, locale)
					})}
				{:else if state.storedPlan !== 'gratis' && state.currentPeriodEnd !== null}
					· {trf('paket {paket} berakhir {tanggal}; datamu tetap tersimpan', {
						paket: tr(PLAN_CATALOGUE[state.storedPlan].label),
						tanggal: formatDateTimeWib(state.currentPeriodEnd, locale)
					})}
				{/if}
			</p>
		{/snippet}
		<!-- FN-46: on Pro and Agen the plan line sits on its own Pro card (same card for both; the label differs). -->
		{#if hasProLook(data.state.plan)}
			<div class="pro-card" data-testid="pro-card">
				<ProBadge />
				{@render planLine(data.state)}
			</div>
		{:else}
			{@render planLine(data.state)}
		{/if}
		<p class="note">{tr('Kredit bukan uang dan tidak bisa dicairkan.')}</p>
	</section>

	<section class="section" aria-labelledby="voucher-title">
		<h2 id="voucher-title">{tr('Tukar voucher')}</h2>
		{#if redeemed}<p class="ok" role="status">{redeemedText}</p>{/if}
		<FormBanner message={redeemError} />
		<form method="POST" action="?/redeem" class="voucher" use:enhance={redeem}>
			<Field
				id="voucher-code"
				name="code"
				label={tr('Kode voucher')}
				autocomplete="off"
				autocapitalize="characters"
				maxlength={40}
				required
				value={redeemForm && 'code' in redeemForm ? redeemForm.code : ''}
			/>
			<Button type="submit" variant="secondary" size="lg" full disabled={redeeming}>
				{redeeming ? tr('Menukar…') : tr('Tukar')}
			</Button>
		</form>
	</section>

	<section class="section" aria-labelledby="plans-title">
		<h2 id="plans-title">{tr('Pilihan paket')}</h2>
		{#if data.mockCheckout}
			<p class="test-mode" role="note">{tr('Mode uji — tidak ada tagihan sebenarnya')}</p>
		{/if}
		<FormBanner message={checkoutError} />
		<ul class="plans">
			{#each PLANS as plan (plan)}
				{@const entry = PLAN_CATALOGUE[plan]}
				<li class="plan" data-testid="plan-{plan}">
					<div class="plan-head">
						<h3>{tr(entry.label)}</h3>
						{#if data.state.plan === plan}<span class="current-tag">{tr('Paketmu sekarang')}</span
							>{/if}
					</div>
					<p class="price">
						<span class="num">{formatMoney(entry.priceMinor, entry.currency)}</span>{periodLabel(
							plan
						)}
					</p>
					<Badge>{tr('harga sementara')}</Badge>
					<ul class="features">
						{#each PLAN_FEATURES[plan] as feature, i (i)}
							<li>{tr(feature)}</li>
						{/each}
					</ul>
					{#if data.mockCheckout && plan !== 'gratis' && planRank(plan) >= planRank(data.state.plan)}
						<form method="POST" action="?/checkout" use:enhance={checkout(plan)}>
							<input type="hidden" name="plan" value={plan} />
							<Button
								type="submit"
								variant="primary"
								size="md"
								full
								disabled={checkingOut !== null}
							>
								{checkingOut === plan
									? tr('Membuka pembayaran uji…')
									: data.state.plan === plan
										? trf('Perpanjang {paket} (mode uji)', { paket: tr(entry.label) })
										: trf('Pilih {paket} (mode uji)', { paket: tr(entry.label) })}
							</Button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="note">
			{tr('Harga di atas sementara dan belum final. Pembayaran sungguhan belum tersedia.')}
		</p>
	</section>

	{#if data.refunds.length > 0}
		<section class="section" aria-labelledby="refunds-title">
			<h2 id="refunds-title">{tr('Pengembalian dana')}</h2>
			<ul class="ledger" data-testid="refunds">
				{#each data.refunds as row (row.id)}
					<li>
						<span class="what">
							<span class="reason">
								{row.plan === 'pro' || row.plan === 'agen'
									? trf('Pembayaran {paket}', { paket: tr(PLAN_CATALOGUE[row.plan].label) })
									: tr('Pengembalian dana')}
							</span>
							<span class="when">{formatDateTimeWib(row.createdAt, locale)}</span>
							{#if row.provider === 'mock'}
								<span class="when">{tr('Mode uji — tidak ada uang yang berpindah')}</span>
							{/if}
						</span>
						<span class="amounts">
							<span class="refund-amount">
								{row.amountMinor !== null && row.currency
									? formatMoney(row.amountMinor, row.currency)
									: '—'}
							</span>
							<span class="after">{tr(REFUND_STATUS_LABELS[row.status])}</span>
						</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="section" aria-labelledby="history-title">
		<h2 id="history-title">{tr('Riwayat kredit')}</h2>
		{#if data.ledger.length === 0}
			<p class="empty">{tr('Belum ada riwayat kredit.')}</p>
		{:else}
			<ul class="ledger">
				{#each data.ledger as row (row.id)}
					<li>
						<span class="what">
							<span class="reason">{tr(LEDGER_REASON_LABELS[row.reason])}</span>
							<span class="when">{formatDateTimeWib(row.createdAt, locale)}</span>
						</span>
						<span class="amounts">
							<span class="delta" class:spend={row.delta < 0}>
								{formatCreditDelta(row.delta, locale)}
							</span>
							<span class="after">
								{trf('Saldo {n}', { n: formatCredits(row.balanceAfter, locale) })}
							</span>
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		<nav class="pager" aria-label={tr('Halaman riwayat kredit')}>
			{#if data.paged}<a href="/pengaturan/paket">{tr('Terbaru')}</a>{/if}
			{#if data.olderCursor}
				<a href="/pengaturan/paket?sebelum={data.olderCursor}">{tr('Lebih lama')}</a>
			{/if}
		</nav>
	</section>
{/if}

<style>
	/* One big number first (§ 3a): the balance stands on the page, no card around it. */
	.hero {
		margin-top: 8px;
	}
	.eyebrow,
	.unit,
	.note,
	.empty {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.big {
		margin: 2px 0 0;
		font-size: 56px;
		line-height: 1.05;
		font-weight: 700;
		letter-spacing: -0.045em;
		font-variant-numeric: tabular-nums;
	}
	@media (min-width: 1024px) {
		.big {
			font-size: 52px;
		}
	}
	.plan-line {
		margin: 12px 0 4px;
		font-size: 15px;
		font-weight: 600;
	}
	/* FN-46: the Pro card — the Pro look's soft gold (grey in Hitam-putih) behind the plan line. */
	.pro-card {
		display: grid;
		justify-items: start;
		gap: 8px;
		margin: 12px 0 4px;
		padding: 14px 16px;
		border: 1px solid color-mix(in srgb, var(--pro) 40%, transparent);
		border-radius: var(--r-group);
		background: var(--pro-soft);
	}
	.pro-card .plan-line {
		margin: 0;
	}
	.section {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	h3 {
		margin: 0;
		font-size: 17px;
		font-weight: 700;
	}
	.voucher {
		display: grid;
		gap: 12px;
	}
	.ok {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.test-mode {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
	.plans {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
		gap: 12px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.plan {
		/* Cards stretch to one row height: content stacks from the top, the button sits at the bottom. */
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		min-width: 0;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.plan form {
		align-self: stretch;
		min-width: 0;
		margin-top: auto;
	}
	.plan :global(.btn) {
		min-width: 0;
		white-space: normal;
		text-align: center;
	}
	.plan-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	/* Fills, not frames: the current plan is marked by an ink tag, not a ring. */
	.current-tag {
		display: inline-flex;
		align-items: center;
		height: 24px;
		padding: 0 10px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-size: 12px;
		font-weight: 700;
	}
	.price {
		margin: 0;
		color: var(--muted);
	}
	.price .num {
		color: var(--ink);
		font-size: 22px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.features {
		display: grid;
		gap: 6px;
		margin: 0 0 8px;
		padding: 0;
		list-style: none;
		font-size: 15px;
	}
	.features li {
		position: relative;
		padding-left: 16px;
	}
	.features li::before {
		content: '';
		position: absolute;
		top: 0.6em;
		left: 2px;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--muted);
	}
	.ledger {
		margin: 0;
		padding: 0;
		list-style: none;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.ledger li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
	}
	.ledger li {
		position: relative;
	}
	.ledger li + li::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 16px;
		border-top: 1px solid var(--line);
	}
	.reason {
		font-size: 15px;
		font-weight: 600;
	}
	.what,
	.amounts {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.amounts {
		justify-items: end;
		text-align: right;
	}
	.when,
	.after {
		color: var(--muted);
		font-size: 13px;
	}
	.delta {
		font-size: 15px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--money-in);
	}
	.refund-amount {
		font-size: 15px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.delta.spend {
		color: var(--ink);
	}
	.pager {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}
	.pager a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-size: 14px;
		font-weight: 700;
		text-decoration: none;
	}
</style>
