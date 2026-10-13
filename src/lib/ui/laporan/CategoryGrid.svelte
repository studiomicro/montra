<script lang="ts">
	import { formatShortMonth } from '#lib/shared/dates';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import CategoryTile from '#lib/ui/kit/CategoryTile.svelte';
	import type { CategoryKey } from '#lib/ui/kit/category';

	// "Kategori dari waktu ke waktu": rows = categories, columns = months, darker = more money. Only rendered
	// when no figure is too large (the page shows "Total terlalu besar" instead).
	let {
		rows,
		months,
		currency = 'IDR',
		label
	}: {
		rows: {
			name: string;
			tileKey: CategoryKey;
			cells: { minor: number; level: 0 | 1 | 2 | 3 | 4 }[];
			total: number;
		}[];
		months: string[];
		currency?: string;
		label: string;
	} = $props();
	const { tr, locale } = useI18n();
</script>

<div class="scroll">
	<table aria-label={label}>
		<thead>
			<tr>
				<th scope="col" class="cat">{tr('Kategori')}</th>
				{#each months as m (m)}<th scope="col">{formatShortMonth(m, locale)}</th>{/each}
				<th scope="col" class="total">{tr('Total')}</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r, i (i)}
				<tr>
					<th scope="row" class="cat">
						<CategoryTile category={r.tileKey} size={36} />
						<span class="name">{r.name}</span>
					</th>
					{#each r.cells as c, j (j)}
						<td
							class="cell l{c.level}"
							title={shown(formatMoney(c.minor, currency, 'auto', locale))}
						>
							<span class="sr-only">{shown(formatMoney(c.minor, currency, 'auto', locale))}</span>
						</td>
					{/each}
					<td class="total num">{shown(formatMoneyCompact(r.total, currency, locale))}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.scroll {
		/* Positioned, so the absolutely placed screen-reader text stays inside the scroll box. */
		position: relative;
		overflow-x: auto;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	table {
		width: 100%;
		border-collapse: separate;
		border-spacing: 3px;
		padding: 8px;
		font-size: 12px;
	}
	th {
		color: var(--muted);
		font-weight: 600;
		text-align: center;
	}
	th.cat {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 140px;
		color: var(--ink);
		text-align: left;
	}
	thead th.cat {
		color: var(--muted);
	}
	.name {
		overflow: hidden;
		max-width: 120px;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 13px;
	}
	.cell {
		min-width: 20px;
		height: 28px;
		border-radius: 6px;
	}
	.l0 {
		background: var(--chart-track);
	}
	.l1 {
		background: var(--heat-1);
	}
	.l2 {
		background: var(--heat-2);
	}
	.l3 {
		background: var(--heat-3);
	}
	.l4 {
		background: var(--heat-4);
	}
	.total {
		padding-left: 8px;
		font-weight: 600;
		text-align: right;
		white-space: nowrap;
	}
</style>
