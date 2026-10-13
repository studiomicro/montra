<script lang="ts">
	import {
		SUBSCRIPTION_CATALOGUE,
		SUBSCRIPTION_CATEGORIES,
		SUBSCRIPTION_CATEGORY_KEYS,
		type CatalogueEntry
	} from '#lib/shared/subscriptions-catalogue';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';

	// Each choice is a plain link (`?tambah=<id>`), so picking works without JavaScript; with it, `onpick`
	// opens the prefilled form instead (null: "Lainnya", a typed name).
	let { onpick }: { onpick?: (entry: CatalogueEntry | null) => void } = $props();
	const { tr } = useI18n();

	const groups = SUBSCRIPTION_CATEGORY_KEYS.map((key) => ({
		key,
		entries: SUBSCRIPTION_CATALOGUE.filter((e) => e.category === key)
	})).filter((g) => g.entries.length > 0);

	const pick = (entry: CatalogueEntry | null) => (event: MouseEvent) => {
		if (!onpick) return;
		event.preventDefault();
		onpick(entry);
	};
</script>

<div class="picker">
	<a class="choice custom" href="/langganan?tambah=lainnya" onclick={pick(null)}>
		<span class="plus"><Icon name="plus" size={20} /></span>
		<span>{tr('Lainnya: ketik nama sendiri')}</span>
	</a>
	{#each groups as group (group.key)}
		<h3>{tr(SUBSCRIPTION_CATEGORIES[group.key].label)}</h3>
		<ul>
			{#each group.entries as entry (entry.id)}
				<li>
					<a class="choice" href="/langganan?tambah={entry.id}" onclick={pick(entry)}>
						<BrandBadge name={entry.name} size={36} />
						<span class="name">{entry.name}</span>
					</a>
				</li>
			{/each}
		</ul>
	{/each}
</div>

<style>
	.picker {
		display: grid;
		gap: 8px;
		padding-bottom: 8px;
	}
	h3 {
		margin: 12px 0 0;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	ul {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 6px 10px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.choice:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.name {
		overflow: hidden;
		min-width: 0;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 15px;
	}
	.plus {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--r-s);
		background: var(--panel-2);
	}
</style>
