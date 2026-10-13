<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import {
		formatCreditDelta,
		formatCredits,
		LEDGER_REASON_LABELS
	} from '#lib/shared/billing/credits';
	import { PLAN_CATALOGUE } from '#lib/shared/billing/plans';
	import { formatDateTimeWib, formatMonthName } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import type { IconName } from '#lib/ui/icons';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import type { LimitKey } from './+page.server';

	/**
	 * FN-42 "Pemakaian": plan, credits and real usage against real limits, all from the server's `load` (no client
	 * fetch, works without JavaScript). Where no ceiling exists (connected apps) only the count shows; where no
	 * usage figure exists (Gmail look-back) only the limit, labelled "paling lama".
	 */
	let { data } = $props();
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

	const LIMIT_ROWS: Record<LimitKey, { icon: IconName; label: string }> = {
		spaces: { icon: 'people', label: msg('Ruang') },
		tokens: { icon: 'code', label: msg('Token API') }
	};
	const ratio = (used: number, allowed: number) => trf('{n} dari {m}', { n: used, m: allowed });
</script>

<svelte:head><title>{tr('Pemakaian')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Pemakaian')}
/>

{#if refreshing}
	<Skeleton rows={6} />
{:else if data.loadError || !data.usage}
	<ErrorState
		text={tr(data.loadError ?? 'Pemakaian tidak bisa dimuat. Coba lagi sebentar lagi.')}
		onretry={retry}
	/>
{:else}
	{@const usage = data.usage}
	<section class="hero" aria-labelledby="balance-title">
		<p class="eyebrow" id="balance-title">{tr('Saldo kredit')}</p>
		<p class="big" data-testid="usage-balance">{formatCredits(usage.balance, locale)}</p>
		<p class="unit">{tr('kredit')}</p>
		<p class="line" data-testid="usage-spent">
			{trf('Terpakai bulan {bulan}: {n} kredit', {
				bulan: formatMonthName(usage.month, locale),
				n: formatCredits(usage.spentThisMonth, locale)
			})}
		</p>
		<p class="line">
			{trf('Paketmu: {paket}', { paket: tr(PLAN_CATALOGUE[usage.state.plan].label) })}
			{#if usage.state.plan !== 'gratis' && usage.state.currentPeriodEnd !== null}
				· {trf('berlaku sampai {tanggal}', {
					tanggal: formatDateTimeWib(usage.state.currentPeriodEnd, locale)
				})}
			{:else if usage.state.storedPlan !== 'gratis' && usage.state.currentPeriodEnd !== null}
				· {trf('paket {paket} berakhir {tanggal}; datamu tetap tersimpan', {
					paket: tr(PLAN_CATALOGUE[usage.state.storedPlan].label),
					tanggal: formatDateTimeWib(usage.state.currentPeriodEnd, locale)
				})}
			{/if}
		</p>
		<p class="note">{tr('Kredit bukan uang dan tidak bisa dicairkan.')}</p>
	</section>

	<section class="group" aria-labelledby="usage-account">
		<h2 id="usage-account">{tr('Akun')}</h2>
		<GroupList>
			{#each usage.limits as limit (limit.key)}
				{@const row = LIMIT_ROWS[limit.key]!}
				<IconRow icon={row.icon} title={tr(row.label)}>
					{#snippet trailing()}
						<span class="value" data-testid="limit-{limit.key}">
							{ratio(limit.used, limit.allowed)}
						</span>
					{/snippet}
				</IconRow>
			{/each}
			<IconRow icon="mail" title={tr('Gmail: lihat ke belakang')}>
				{#snippet trailing()}
					<span class="value" data-testid="limit-gmail">
						{trf('paling lama {n} hari', { n: usage.gmailLookbackDays })}
					</span>
				{/snippet}
			</IconRow>
			<IconRow
				icon="sparkle"
				title={tr('Kecerdasan buatan')}
				hint={tr('Belum ada pemakaian AI')}
				href={data.aiLink ?? undefined}
			/>
		</GroupList>
	</section>

	<section class="group" aria-labelledby="usage-space">
		<h2 id="usage-space">{trf('Ruang ini: {nama}', { nama: data.space.name })}</h2>
		<GroupList>
			<IconRow icon="grid" title={tr('Kategori')}>
				{#snippet trailing()}
					<span class="value" data-testid="limit-categories">
						{ratio(usage.categories.used, usage.categories.allowed)}
					</span>
				{/snippet}
			</IconRow>
			<IconRow icon="link" title={tr('Aplikasi terhubung')}>
				{#snippet trailing()}
					<span class="value" data-testid="usage-connected">
						{usage.connectedApps.real}
						{#if usage.connectedApps.demo > 0}
							<Badge>{trf('+{n} Data demo', { n: usage.connectedApps.demo })}</Badge>
						{/if}
					</span>
				{/snippet}
			</IconRow>
			<IconRow icon="user" title={tr('Anggota ruang')}>
				{#snippet trailing()}
					<span class="value" data-testid="usage-members">
						{usage.members ? ratio(usage.members.used, usage.members.allowed) : tr('Ruang pribadi')}
					</span>
				{/snippet}
			</IconRow>
			<IconRow icon="box" title={tr('Foto barang')}>
				{#snippet trailing()}
					<span class="value" data-testid="usage-photos-belongings">
						{usage.photos.belongings}
					</span>
				{/snippet}
			</IconRow>
			<IconRow icon="star" title={tr('Foto koleksi')}>
				{#snippet trailing()}
					<span class="value" data-testid="usage-photos-collectibles">
						{usage.photos.collectibles}
					</span>
				{/snippet}
			</IconRow>
			<IconRow icon="receipt" title={tr('Foto struk')}>
				{#snippet trailing()}
					<span class="value" data-testid="usage-photos-receipts">
						{usage.photos.receipts}
					</span>
				{/snippet}
			</IconRow>
		</GroupList>
	</section>

	<section class="group" aria-labelledby="usage-ledger">
		<h2 id="usage-ledger">{tr('Riwayat kredit')}</h2>
		{#if usage.ledger.length === 0}
			<p class="note">{tr('Belum ada riwayat kredit.')}</p>
		{:else}
			<ul class="ledger">
				{#each usage.ledger as row (row.id)}
					<li>
						<span class="what">
							<span class="reason">{tr(LEDGER_REASON_LABELS[row.reason])}</span>
							<span class="when">{formatDateTimeWib(row.createdAt, locale)}</span>
						</span>
						<span class="delta" class:spend={row.delta < 0}>
							{formatCreditDelta(row.delta, locale)}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
		{#if usage.olderCursor}
			<a class="more" href="/pengaturan/paket?sebelum={usage.olderCursor}">{tr('Lebih lama')}</a>
		{/if}
	</section>
{/if}

<style>
	/* One big number first (§ 3a): the balance stands on the page, no card around it. */
	.hero {
		margin-top: 8px;
	}
	.eyebrow,
	.unit,
	.note {
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
	.line {
		margin: 8px 0 0;
		font-size: 15px;
		font-weight: 600;
	}
	.note {
		margin-top: 4px;
	}
	.group {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	/* Same section title as Paket & kredit. */
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.value {
		display: inline-flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 6px;
		font-size: 15px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		text-align: right;
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
		position: relative;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
	}
	.ledger li + li::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 16px;
		border-top: 1px solid var(--line);
	}
	.what {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.reason {
		font-size: 15px;
		font-weight: 600;
	}
	.when {
		color: var(--muted);
		font-size: 13px;
	}
	.delta {
		font-size: 15px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--money-in);
	}
	.delta.spend {
		color: var(--ink);
	}
	.more {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-size: 14px;
		font-weight: 700;
		text-decoration: none;
	}
</style>
