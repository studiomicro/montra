<script lang="ts">
	import { DRAFT_SOURCE_LABELS, type DraftFlag, type DraftSource } from '#lib/shared/drafts';
	import { MERCHANT_REASON_LABELS, type MerchantReason } from '#lib/shared/merchants/resolve';
	import { formatMoney } from '#lib/shared/money-format';
	import { categoryLabel, type CategoryKind, type TileKey } from '#lib/shared/transactions';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';

	/**
	 * The content of one draft row (inbox and review screen): the category's tile, the title, a meta line (date,
	 * category, wallet), the tags (source, "Perlu dilengkapi", "Mungkin duplikat", "Data demo", and FN-20's
	 * reason for the category, e.g. "Dari aturanmu") and the amount.
	 */
	let {
		draft,
		category,
		walletName,
		dateLabel,
		reason
	}: {
		draft: {
			type: CategoryKind;
			amountMinor: number;
			currency: string;
			title: string | null;
			source: DraftSource;
			flag: DraftFlag | null;
			isDemo: boolean;
			walletId: string | null;
			categoryId: string | null;
		};
		category: { name: string; isPreset: boolean; tileKey: TileKey } | null;
		walletName: string | null;
		dateLabel?: string;
		/** Why the category is what it is (FN-20); absent when the user picked it. */
		reason?: MerchantReason;
	} = $props();

	const { tr } = useI18n();
	const meta = $derived(
		[
			dateLabel,
			category ? categoryLabel(category, tr) : tr('Tanpa kategori'),
			walletName ?? tr('Tanpa dompet')
		]
			.filter(Boolean)
			.join(' · ')
	);
	const source = $derived(tr(DRAFT_SOURCE_LABELS[draft.source]));
	const amount = $derived(
		formatMoney(
			draft.type === 'expense' ? -draft.amountMinor : draft.amountMinor,
			draft.currency,
			'signed'
		)
	);
</script>

<CategoryTile category={category?.tileKey ?? 'lain'} />
<span class="text">
	<span class="title">{draft.title ?? source}</span>
	<span class="meta">{meta}</span>
	<span class="tags">
		<Badge>{source}</Badge>
		{#if reason && reason !== 'none' && category}<Badge>{tr(MERCHANT_REASON_LABELS[reason])}</Badge
			>{/if}
		{#if !draft.walletId || !draft.categoryId}<Badge>{tr('Perlu dilengkapi')}</Badge>{/if}
		{#if draft.flag === 'duplicate'}<Badge>{tr('Mungkin duplikat')}</Badge>{/if}
		{#if draft.flag === 'needs_review'}<Badge>{tr('Perlu ditinjau')}</Badge>{/if}
		{#if draft.isDemo}<Badge>{tr('Data demo')}</Badge>{/if}
	</span>
</span>
<span class="end">
	<span class="kind" aria-hidden="true"
		>{draft.type === 'income' ? tr('Pemasukan') : tr('Pengeluaran')}</span
	>
	<span class="amount num" class:income={draft.type === 'income'}>{amount}</span>
</span>

<style>
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		overflow: hidden;
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
	/* The row sits on a panel: the tags take the page background so they read as pills. */
	.tags :global(.badge) {
		height: 22px;
		padding: 0 8px;
		background: var(--bg);
		font-size: 11px;
		white-space: nowrap;
	}
	.end {
		display: flex;
		flex: none;
		flex-direction: column;
		align-items: flex-end;
		align-self: flex-start;
	}
	/* Phone layout v3: a small grey label over the amount, in a record list only. */
	.kind {
		display: none;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
	}
	@media (max-width: 600px) {
		:global(.records) .kind {
			display: block;
		}
		:global(.records) .title {
			font-size: 17px;
			font-weight: 700;
		}
		:global(.records) .meta {
			font-size: 14px;
		}
		:global(.records) .amount {
			font-size: 17px;
		}
	}
	.amount {
		flex: none;
		padding-top: 2px;
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	.income {
		color: var(--money-in);
	}
</style>
