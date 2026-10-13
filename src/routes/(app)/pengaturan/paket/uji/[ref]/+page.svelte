<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { PLAN_CATALOGUE } from '#lib/shared/billing/plans';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	let busy = $state<'pay' | 'fail' | null>(null);
	let netError = $state('');

	const submit =
		(which: 'pay' | 'fail'): SubmitFunction =>
		() => {
			busy = which;
			netError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					netError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update();
				busy = null;
			};
		};

	const entry = $derived(PLAN_CATALOGUE[data.checkout.plan]);
	const paid = $derived(form && 'result' in form && form.result === 'paid' ? form : null);
	const failed = $derived(form && 'result' in form && form.result === 'failed');
	const banner = $derived(
		netError || (form && 'error' in form && form.error ? tr(form.error) : undefined)
	);
</script>

<svelte:head><title>{tr('Pembayaran uji')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/paket', label: tr('Kembali ke Paket & kredit') }}
	title={tr('Pembayaran uji')}
/>

<p class="test-mode" role="note">{tr('Mode uji — tidak ada tagihan sebenarnya')}</p>

<section class="card" aria-labelledby="checkout-plan">
	<h2 id="checkout-plan">{trf('Paket {paket}', { paket: tr(entry.label) })}</h2>
	<p class="price">
		<span class="num">{formatMoney(data.checkout.amountMinor, data.checkout.currency)}</span>
		<Badge>{tr('harga sementara')}</Badge>
	</p>
	<p class="note">
		{tr(
			'Ini simulasi untuk pengujian. Tidak ada kartu, tidak ada uang yang berpindah dan tidak ada penyedia pembayaran yang dihubungi.'
		)}
	</p>
</section>

{#if paid}
	<div class="ok" role="status">
		<p>
			{trf('Pembayaran uji berhasil. Paketmu sekarang {paket}.', {
				paket: tr(PLAN_CATALOGUE[paid.plan].label)
			})}
			{#if paid.periodEnd}
				{trf('Berlaku sampai {tanggal}.', { tanggal: formatDateTimeWib(paid.periodEnd, locale) })}
			{/if}
		</p>
	</div>
	<a class="back" href="/pengaturan/paket">{tr('Kembali ke Paket & kredit')}</a>
{:else if data.checkout.paid}
	<p class="note" role="status">{tr('Pembayaran uji ini sudah selesai.')}</p>
	<a class="back" href="/pengaturan/paket">{tr('Kembali ke Paket & kredit')}</a>
{:else}
	{#if failed}
		<p class="failed" role="status">
			{tr('Pembayaran uji gagal (simulasi). Paketmu tidak berubah. Kamu bisa mencoba lagi.')}
		</p>
	{/if}
	<FormBanner message={banner} />
	<div class="actions">
		<form method="POST" action="?/pay" use:enhance={submit('pay')}>
			<Button type="submit" variant="primary" size="lg" full disabled={busy !== null}>
				{busy === 'pay' ? tr('Memproses…') : tr('Bayar (mode uji)')}
			</Button>
		</form>
		<form method="POST" action="?/fail" use:enhance={submit('fail')}>
			<Button type="submit" variant="secondary" size="lg" full disabled={busy !== null}>
				{busy === 'fail' ? tr('Memproses…') : tr('Simulasikan gagal')}
			</Button>
		</form>
		<a class="back" href="/pengaturan/paket">{tr('Batal')}</a>
	</div>
{/if}

<style>
	.test-mode {
		margin: 8px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
	}
	.card {
		display: grid;
		gap: 8px;
		margin-top: 16px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
	}
	.price {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0;
	}
	.num {
		font-size: 24px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.ok p,
	.failed {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.ok p {
		color: var(--money-in);
	}
	.actions {
		display: grid;
		gap: 12px;
		margin-top: 16px;
	}
	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		margin-top: 8px;
		color: var(--ink);
		font-weight: 700;
		text-decoration: none;
	}
</style>
