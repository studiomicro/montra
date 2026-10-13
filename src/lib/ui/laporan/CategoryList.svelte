<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import type { CategoryKey } from '#lib/ui/kit/category';

	// "Ke mana uangnya" list: share and per-day (or per-month) figure under the name, amount right, a chevron
	// when the row opens the matching Riwayat list.
	let {
		rows
	}: {
		rows: {
			name: string;
			tileKey: CategoryKey;
			detail: string;
			amount: string;
			href: string | null;
		}[];
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
			<span class="amount num">{r.amount}</span>
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
	.name {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.detail {
		color: var(--muted);
		font-size: 13px;
	}
	.amount {
		flex: none;
		font-weight: 700;
	}
	.chevron {
		flex: none;
		display: inline-flex;
		color: var(--faint);
	}
</style>
