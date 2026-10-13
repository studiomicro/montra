<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import { riwayatHref } from '#lib/shared/riwayat-query';
	import { maskedLastFour } from '#lib/shared/wallets';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';

	// FN-25b: one credit-card wallet with what was spent from it in the last 30 WIB days (creditCardSpend). The
	// card links to that exact Riwayat list (same wallet, type and period), so the figure reconciles with it.
	// Statement and due days come with FN-25c.
	let {
		card
	}: {
		card: {
			walletId: string;
			name: string;
			lastFour: string | null;
			currency: string;
			from: string;
			to: string;
			totals: { currency: string; outMinor: number | null }[];
		};
	} = $props();
	const { tr, locale } = useI18n();

	const href = $derived(
		riwayatHref({
			type: 'expense',
			period: 'range',
			month: '',
			from: card.from,
			to: card.to,
			categoryId: null,
			walletId: card.walletId,
			q: '',
			recurring: false
		})
	);
	const lines = $derived(
		card.totals.length > 0 ? card.totals : [{ currency: card.currency, outMinor: 0 }]
	);
</script>

<a class="card" {href}>
	<span class="head">
		<span class="tile" aria-hidden="true"><Icon name="wallet" size={18} /></span>
		<span class="name">{card.name}</span>
		{#if card.lastFour}<span class="four num">{maskedLastFour(card.lastFour)}</span>{/if}
	</span>
	<span class="body">
		<span class="label">{tr('Terpakai 30 hari terakhir')}</span>
		{#each lines as l (l.currency)}
			<span class="amount num">
				{l.outMinor === null
					? tr('Total terlalu besar untuk ditampilkan')
					: shown(formatMoney(l.outMinor, l.currency, 'auto', locale))}
			</span>
		{/each}
	</span>
	<span class="chev" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
</a>

<style>
	.card {
		position: relative;
		display: grid;
		gap: 12px;
		min-height: 44px;
		padding: 16px 44px 16px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
		color: var(--ink);
		text-decoration: none;
	}
	/* FN-51: desktop hover/focus lift — the hover colour everywhere, the 1 px rise only with motion. */
	@media (min-width: 1024px) and (hover: hover) and (pointer: fine) {
		.card:hover,
		.card:focus-visible {
			background: var(--panel-2);
		}
		@media (prefers-reduced-motion: no-preference) {
			.card {
				transition:
					transform var(--duration-fast) var(--ease),
					background var(--duration-fast) var(--ease);
			}
			.card:hover,
			.card:focus-visible {
				transform: translateY(-1px);
			}
		}
	}
	.head {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--r-pill);
		background: var(--panel-2);
	}
	.name {
		overflow: hidden;
		flex: 1;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.four {
		flex: none;
		color: var(--muted);
		font-size: 14px;
	}
	.body {
		display: grid;
		gap: 2px;
	}
	.label {
		color: var(--muted);
		font-size: 14px;
	}
	.amount {
		font-size: 19px;
		font-weight: 700;
	}
	.chev {
		position: absolute;
		top: 50%;
		right: 14px;
		display: grid;
		color: var(--muted);
		transform: translateY(-50%);
	}
</style>
