<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import Icon from '#lib/ui/Icon.svelte';
	import { useLocale } from '#lib/ui/i18n-context';
	import CategoryTile from './CategoryTile.svelte';
	import GroupRow from './GroupRow.svelte';
	import StatusTag from './StatusTag.svelte';
	import { shown } from './amounts.svelte';
	import type { CategoryKey } from './category';

	let {
		title,
		meta,
		amountMinor,
		currency = 'IDR',
		category,
		kind,
		status,
		recurring,
		label,
		share,
		href
	}: {
		title: string;
		meta: string;
		/** Signed for expense (−), income (+) and an adjustment (±); a transfer passes its magnitude. */
		amountMinor: number;
		currency?: string;
		category: CategoryKey;
		/**
		 * Defaults to the sign of `amountMinor`. A transfer shows its amount unsigned and uncoloured; a balance
		 * adjustment (FN-37) signed (+/−) but never coloured as income.
		 */
		kind?: 'expense' | 'income' | 'transfer' | 'adjustment';
		status?: string;
		/** FN-36: the label of the "Berulang" tag of a row a recurring series created (distinct from `status`). */
		recurring?: string;
		/** Phone layout v3: the small grey word over the amount in a record list ("Pengeluaran"); none when absent. */
		label?: string;
		/** FN-49: the small line under the amount of a row linked to a split ("patungan: bagianmu Rp 100.000"). */
		share?: string;
		href?: string;
	} = $props();

	const locale = useLocale();
	const shownKind = $derived(kind ?? (amountMinor > 0 ? 'income' : 'expense'));
	const amountText = $derived(
		shownKind === 'transfer'
			? formatMoney(Math.abs(amountMinor), currency, 'auto', locale)
			: formatMoney(amountMinor, currency, 'signed', locale)
	);
</script>

<GroupRow {href}>
	<CategoryTile {category} />
	<span class="text">
		<span class="title">{title}</span>
		<span class="meta">{meta}</span>
		{#if status}<StatusTag>{status}</StatusTag>{/if}
		{#if recurring}<span class="repeat"><Icon name="repeat" size={12} />{recurring}</span>{/if}
	</span>
	<span class="end">
		{#if label}<span class="kind" aria-hidden="true">{label}</span>{/if}
		<span class="amount num" class:income={shownKind === 'income'}>{shown(amountText)}</span>
		{#if share}<span class="share">{share}</span>{/if}
	</span>
</GroupRow>

<style>
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1px;
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
	.repeat {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
	}
	.end {
		display: flex;
		flex: none;
		flex-direction: column;
		align-items: flex-end;
		max-width: 52%;
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
		/* The title and meta get the room; a long amount still shows whole (it never wraps). */
		:global(.records) .end {
			max-width: 44%;
		}
		:global(.records) .amount {
			font-size: 17px;
		}
		:global(.records) .title {
			font-size: 17px;
			font-weight: 700;
		}
		:global(.records) .meta {
			font-size: 14px;
		}
	}
	.amount {
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	.income {
		color: var(--money-in);
	}
	.share {
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
		text-align: right;
	}
</style>
