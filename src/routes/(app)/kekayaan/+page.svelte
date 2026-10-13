<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import Button from '#lib/ui/kit/Button.svelte';
	import { applyAmountsHiddenAtLoad, shown } from '#lib/ui/kit/amounts.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import NetWorthSection from '#lib/ui/net-worth/NetWorthSection.svelte';

	// Kekayaan bersih (FN-25), reached from the Fitur section. Wallets and goals are on /dompet (wave C); the
	// Langganan entry is in the sidebar's Fitur section and the Fitur sheet.
	let { data, form } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const { tr, locale } = useI18n();
	let section: NetWorthSection | undefined = $state();

	/** The net-worth section's (FN-25) part of the action result. */
	const netWorthResult = $derived(
		form && ('nwAction' in form || 'nwSaved' in form || 'nwError' in form) ? form : null
	);
</script>

<svelte:head><title>{tr('Kekayaan bersih')}</title></svelte:head>
<ScreenTitle title={tr('Kekayaan bersih')} subtitle={tr('Total aset dikurangi utang')}>
	{#snippet actions()}
		<!-- FN-25b: a second way into the same add sheet (`?aset=baru` without JavaScript). -->
		<Button
			icon="plus"
			href="/kekayaan?aset=baru"
			onclick={(event) => {
				if (!section) return;
				event.preventDefault();
				section.openAdd();
			}}
		>
			{tr('Tambah aset')}
		</Button>
	{/snippet}
</ScreenTitle>

{#if data.hiddenModules.includes('kekayaan')}
	<p class="hidden-note">
		{tr('Kekayaan disembunyikan dari menu. Angkanya tetap dihitung.')}
		<a href="/pengaturan/fitur">{tr('Tampilkan lagi di menu')}</a>
	</p>
{/if}

<NetWorthSection
	bind:this={section}
	netWorth={data.netWorth}
	trend={data.trend}
	creditCards={data.creditCards}
	openItem={data.openItem}
	suggestion={data.suggestion}
	result={netWorthResult}
>
	<!-- FN-27 / FN-28: the belongings and collectibles values beside net worth (the same figures as on their pages);
	each row is hidden with its module (FN-12). -->
	{#if !data.hiddenModules.includes('barang')}
		<section class="more" aria-labelledby="belongings-title">
			<h2 id="belongings-title">{tr('Barang')}</h2>
			<GroupList>
				<GroupRow href="/barang">
					<Icon name="box" size={20} />
					<span class="text">
						<span class="name">{tr('Nilai barang')}</span>
					</span>
					<span class="amount num">
						{#if data.belongings.failed}
							{tr('Tidak bisa dimuat')}
						{:else if data.belongings.totals.length === 0}
							<span class="muted">{tr('Belum ada')}</span>
						{:else}
							{#each data.belongings.totals as total (total.currency)}
								<span class="line">
									{total.totalMinor === null
										? tr('Total terlalu besar untuk ditampilkan')
										: shown(formatMoney(total.totalMinor, total.currency, 'auto', locale))}
								</span>
							{/each}
						{/if}
					</span>
					<span class="chev" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
				</GroupRow>
			</GroupList>
		</section>
	{/if}

	{#if !data.hiddenModules.includes('koleksi')}
		<section class="more" aria-labelledby="collectibles-title">
			<h2 id="collectibles-title">{tr('Koleksi')}</h2>
			<GroupList>
				<GroupRow href="/koleksi">
					<Icon name="sparkle" size={20} />
					<span class="text">
						<span class="name">{tr('Nilai koleksi')}</span>
					</span>
					<span class="amount num">
						{#if data.collectibles.failed}
							{tr('Tidak bisa dimuat')}
						{:else if data.collectibles.totals.length === 0}
							<span class="muted">{tr('Belum ada')}</span>
						{:else}
							{#each data.collectibles.totals as total (total.currency)}
								<span class="line">
									{total.valueMinor === null
										? tr('Total terlalu besar untuk ditampilkan')
										: shown(formatMoney(total.valueMinor, total.currency, 'auto', locale))}
								</span>
							{/each}
						{/if}
					</span>
					<span class="chev" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
				</GroupRow>
			</GroupList>
		</section>
	{/if}
</NetWorthSection>

<style>
	section {
		margin-top: 8px;
	}
	/* Inside the net-worth layout's main column (FN-25b), whose gap spaces the sections. */
	.more {
		margin-top: 0;
	}
	.line {
		display: block;
	}
	h2 {
		margin: 0 0 12px;
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.chev {
		display: grid;
		flex: none;
		color: var(--muted);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.amount {
		flex: none;
		font-weight: 600;
		text-align: right;
	}
	.muted {
		color: var(--muted);
	}
	.hidden-note {
		margin: 4px 0 8px;
		font-size: 14px;
		color: var(--muted);
	}
	.hidden-note a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
