<script lang="ts">
	import { onMount } from 'svelte';
	import { msg } from '#lib/shared/i18n';
	import type { WealthSuggestion } from '#lib/shared/wealth';
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';
	import { useI18n } from '#lib/ui/i18n-context';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';

	// FN-25b "Belum dihitung": a card per class the space has not recorded yet (missingSuggestions). Tapping one
	// opens the add sheet pre-filled (never saved by itself); without JavaScript the link opens the inline form.
	// Hiding a card lasts for this visit only (component state): nothing is stored, nothing hidden server-side.
	let {
		suggestions,
		onpick
	}: { suggestions: WealthSuggestion[]; onpick: (s: WealthSuggestion) => void } = $props();
	const { tr } = useI18n();

	const CARDS: Readonly<
		Record<WealthSuggestion, { title: string; text: string; icon: IconName; param: string }>
	> = {
		gold: {
			title: msg('Emas'),
			text: msg('Dihitung per gram dengan harga hari ini'),
			icon: 'sparkle',
			param: 'emas'
		},
		pension: {
			title: msg('Dana pensiun'),
			text: msg('BPJS JHT, DPLK'),
			icon: 'lock',
			param: 'pensiun'
		}
	};

	let hidden = $state<WealthSuggestion[]>([]);
	// The hide button only works with JavaScript, so it only shows then.
	let hydrated = $state(false);
	onMount(() => (hydrated = true));
	const shownCards = $derived(suggestions.filter((s) => !hidden.includes(s)));
</script>

{#if shownCards.length > 0}
	<section class="missing" aria-labelledby="nw-missing-title">
		<h3 id="nw-missing-title">{tr('Belum dihitung')}</h3>
		<GroupList>
			{#each shownCards as s (s)}
				{@const card = CARDS[s]}
				<GroupRow>
					<a
						class="open"
						href="/kekayaan?aset=baru&saran={card.param}"
						onclick={(event) => {
							event.preventDefault();
							onpick(s);
						}}
					>
						<span class="tile" aria-hidden="true"><Icon name={card.icon} size={20} /></span>
						<span class="text">
							<span class="name">{tr(card.title)}</span>
							<span class="meta">{tr(card.text)}</span>
						</span>
						<span class="add" aria-hidden="true"><Icon name="plus" size={20} /></span>
					</a>
					{#if hydrated}
						<button
							type="button"
							class="dismiss"
							aria-label={`${tr('Sembunyikan saran')}: ${tr(card.title)}`}
							onclick={() => (hidden = [...hidden, s])}
						>
							<Icon name="close" size={16} />
						</button>
					{/if}
				</GroupRow>
			{/each}
		</GroupList>
	</section>
{/if}

<style>
	h3 {
		margin: 0 0 12px;
		font-size: 19px;
		font-weight: 600;
	}
	.open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-s);
		background: var(--panel-2);
		color: var(--ink);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-weight: 600;
	}
	.meta {
		font-size: 14px;
		color: var(--muted);
	}
	.add {
		display: grid;
		flex: none;
		color: var(--muted);
	}
	.dismiss {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.dismiss:hover {
		background: var(--panel-2);
		color: var(--ink);
	}
</style>
