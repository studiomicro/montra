<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import type { CategoryKey } from '#lib/ui/kit/category';

	// "Ke mana uangnya" list: share and per-day (or per-month) figure under the name, amount right, a chevron
	// when the row opens the matching Riwayat list. `income` colours the (signed) amounts as money in.
	let {
		rows,
		income = false
	}: {
		rows: {
			name: string;
			tileKey: CategoryKey;
			detail: string;
			amount: string;
			href: string | null;
		}[];
		income?: boolean;
	} = $props();
	const { tr } = useI18n();
</script>

<GroupList>
	{#each rows as r, i (i)}
		<GroupRow href={r.href ?? undefined}>
			<CategoryTile category={r.tileKey} />
			<span class="text">
				<span class="name">{r.name}</span>
				<span class="detail num">{r.detail}</span>
			</span>
			<span class="amount num" class:income>{r.amount}</span>
			{#if r.href}<span class="chevron" aria-hidden="true"
					><Icon name="chevron-right" size={16} /></span
				><span class="sr-only">{tr('Lihat transaksinya')}</span>{/if}
		</GroupRow>
	{/each}
</GroupList>

<style>
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	/* The name is the row's meaning: it may take two lines rather than be cut to "Tempat Ti…" (POLISH_AUDIT A4). */
	.name {
		display: -webkit-box;
		overflow: hidden;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	/* One line: "66% · Rp233 rb/hari" never wraps under the name (POLISH_AUDIT A4). */
	.detail {
		overflow: hidden;
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	/* Row amount 15 / 700 (DESIGN_SYSTEM § Transaction row), so the category name keeps the room. */
	.amount {
		flex: none;
		font-size: 15px;
		font-weight: 700;
	}
	.income {
		color: var(--money-in);
	}
	.chevron {
		flex: none;
		display: inline-flex;
		color: var(--faint);
	}
	/* A phone row keeps its width for the name: the whole row opens Riwayat, the chevron is a wider-screen hint. */
	@media (max-width: 479px) {
		.chevron {
			display: none;
		}
	}
</style>
