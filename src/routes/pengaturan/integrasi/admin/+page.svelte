<script lang="ts">
	import { REFUND_REASON_LABELS } from '#lib/shared/billing/refunds';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr, trf, locale } = useI18n();

	type State = 'ok' | 'partial' | 'missing';
	const set = (configured: boolean): State => (configured ? 'ok' : 'missing');
	const label = (state: State) =>
		state === 'ok'
			? tr('Terkonfigurasi')
			: state === 'partial'
				? tr('Belum lengkap')
				: tr('Belum dikonfigurasi');

	const rows = $derived([
		{
			id: 'web-push',
			title: tr('Web Push'),
			names: 'VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · VAPID_SUBJECT',
			state: data.webPush as State,
			note: data.webPush === 'partial' ? tr('Isi ketiganya atau kosongkan ketiganya.') : ''
		},
		{
			id: 'turnstile',
			title: tr('Turnstile (pemeriksaan bot)'),
			names: 'TURNSTILE_SITE_KEY · TURNSTILE_SECRET_KEY',
			state: data.turnstile as State,
			note:
				data.turnstile === 'partial'
					? tr('Baru sebagian diisi: isi keduanya atau kosongkan keduanya.')
					: ''
		},
		{
			id: 'connected-apps',
			title: tr('Aplikasi terhubung'),
			names: 'CONNECTED_APPS_ENCRYPTION_KEY',
			state: set(data.connectedApps.configured),
			note: data.connectedApps.previous
				? tr('Kunci sebelumnya (_PREVIOUS) masih diisi: rotasi kunci belum selesai.')
				: ''
		},
		{
			id: 'ai-keys',
			title: tr('Kunci AI pengguna'),
			names: 'AI_KEYS_ENCRYPTION_KEY',
			state: set(data.aiKeys.configured),
			note: data.aiKeys.previous
				? tr('Kunci sebelumnya (_PREVIOUS) masih diisi: rotasi kunci belum selesai.')
				: ''
		},
		{
			id: 'ai-gateway',
			title: tr('AI Gateway'),
			names: 'AI_GATEWAY_ACCOUNT_ID · AI_GATEWAY_ID',
			state: set(data.aiGateway),
			note: ''
		},
		{
			id: 'support-email',
			title: tr('Alamat dukungan'),
			names: 'SUPPORT_EMAIL',
			state: set(data.supportEmail),
			note: ''
		},
		{
			id: 'claim-hash',
			title: tr('Penanda klaim ulang'),
			names: 'CLAIM_HASH_KEY',
			state: set(data.claimHash.configured),
			note: data.claimHash.previous
				? tr('Kunci sebelumnya (_PREVIOUS) masih diisi: rotasi kunci belum selesai.')
				: ''
		},
		{
			id: 'billing-mock',
			title: tr('Pembayaran mode uji'),
			names: 'BILLING_MOCK_ENABLED',
			state: set(data.billingMock.enabled),
			note: ''
		},
		{
			id: 'billing-mock-secret',
			title: tr('Rahasia webhook mode uji'),
			names: 'MOCK_PAYMENT_WEBHOOK_SECRET',
			state: set(data.billingMock.webhookSecret),
			note: ''
		}
	]);
	const mockInProduction = $derived(
		data.appEnv === 'production' && (data.billingMock.enabled || data.billingMock.webhookSecret)
	);
</script>

<svelte:head><title>{tr('Status integrasi')}</title></svelte:head>

<main class="admin">
	<p class="back"><a href="/pengaturan/integrasi">{tr('Kembali ke Integrasi AI')}</a></p>
	<ScreenTitle
		title={tr('Status integrasi')}
		subtitle={tr('Hanya nama dan status; nilai rahasia tidak pernah ditampilkan')}
	/>

	{#if mockInProduction}
		<p class="warn" role="alert">
			{tr('Pembayaran mode uji terpasang di production. Hapus kedua rahasianya sekarang.')}
		</p>
	{/if}

	<section class="group" aria-labelledby="secrets-title">
		<h2 id="secrets-title">{tr('Rahasia aplikasi')}</h2>
		<GroupList>
			{#each rows as row (row.id)}
				<GroupRow>
					<div class="item">
						<div class="line">
							<span class="title">{row.title}</span>
							<span class="state" class:good={row.state === 'ok'}>{label(row.state)}</span>
						</div>
						<code class="names">{row.names}</code>
						{#if row.note}<span class="note">{row.note}</span>{/if}
					</div>
				</GroupRow>
			{/each}
			<GroupRow>
				<div class="item">
					<div class="line">
						<span class="title">{tr('Lingkungan')}</span>
						<span class="state">{data.appEnv ?? tr('Tidak diisi')}</span>
					</div>
					<code class="names">APP_ENV</code>
				</div>
			</GroupRow>
		</GroupList>
	</section>

	<section class="group" aria-labelledby="byok-title">
		<h2 id="byok-title">{tr('Kunci AI pengguna')}</h2>
		<p class="count">
			{data.keyCount === null
				? tr('Jumlah tidak bisa dimuat. Muat ulang halaman.')
				: trf('{n} pengguna menyimpan kunci Anthropic', { n: data.keyCount })}
		</p>
	</section>

	<section class="group" aria-labelledby="refunds-title">
		<h2 id="refunds-title">{tr('Pengembalian dana menunggu')}</h2>
		{#if data.refunds === null}
			<p class="count" role="alert">
				{tr('Daftar pengembalian dana tidak bisa dimuat. Muat ulang halaman.')}
			</p>
		{:else if data.refunds.count === 0}
			<p class="count" data-testid="refund-count">{tr('Belum ada')}</p>
		{:else}
			<p class="count" data-testid="refund-count">
				{trf('{n} pengembalian dana menunggu', { n: data.refunds.count })}
				{#if data.refunds.count > data.refunds.rows.length}
					· {trf('Menampilkan {n} terbaru', { n: data.refunds.rows.length })}
				{/if}
			</p>
			<GroupList>
				{#each data.refunds.rows as row (row.id)}
					<GroupRow>
						<div class="item">
							<div class="line">
								<span class="title">
									{row.amountMinor !== null && row.currency
										? formatMoney(row.amountMinor, row.currency)
										: '—'}
								</span>
								<span class="state">{tr(REFUND_REASON_LABELS[row.reason])}</span>
							</div>
							<code class="names">{row.provider} · {row.reference ?? '—'}</code>
							<span class="when">{formatDateTimeWib(row.createdAt, locale)}</span>
						</div>
					</GroupRow>
				{/each}
			</GroupList>
		{/if}
	</section>
</main>

<style>
	.admin {
		box-sizing: border-box;
		width: 100%;
		max-width: 720px;
		margin: 0 auto;
		padding: 8px max(16px, var(--sai-right)) calc(40px + var(--sai-bottom))
			max(16px, var(--sai-left));
	}
	.back {
		margin: 0;
	}
	.back a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--brand);
		font-weight: 600;
	}
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.item {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		min-height: 44px;
		padding: 4px 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 4px 8px;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
	}
	.state {
		font-size: 14px;
		color: var(--muted);
	}
	.state.good {
		color: var(--money-in);
		font-weight: 600;
	}
	.names {
		font-family: var(--font-mono);
		font-size: 12px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.when {
		font-size: 13px;
		color: var(--muted);
	}
	.note {
		font-size: 13px;
		color: var(--money-up);
	}
	.count {
		margin: 0;
		font-size: 15px;
	}
	.warn {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-weight: 600;
	}
</style>
