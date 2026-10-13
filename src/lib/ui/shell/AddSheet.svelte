<script lang="ts">
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Sheet from './Sheet.svelte';
	import { ADD_PATHS, type AddPath } from './nav';

	/** `paths`: this server's paths (`addPaths`: FN-15 gates "Struk", FN-19 "Otomatis"); the static list by default. */
	let {
		open = $bindable(false),
		paths = ADD_PATHS
	}: { open?: boolean; paths?: readonly AddPath[] } = $props();
	const { tr } = useI18n();
</script>

<Sheet bind:open title={tr('Tambah transaksi')}>
	<ul class="paths">
		{#each paths as path (path.id)}
			<li>
				{#if path.href}
					<a class="path" href={path.href} onclick={() => (open = false)}>
						<span class="tile"><Icon name={path.icon} /></span>
						<span class="text">
							<span class="label">{tr(path.label)}</span>
							<span class="hint">{tr(path.hint)}</span>
						</span>
					</a>
				{:else}
					<button type="button" class="path" disabled aria-describedby="soon-{path.id}">
						<span class="tile"><Icon name={path.icon} /></span>
						<span class="text">
							<span class="label">{tr(path.label)}</span>
							<span class="hint">{tr(path.hint)}</span>
							<!-- The reason sits in the text column under the hint, so the title keeps the row's width. -->
							<span class="soon" id="soon-{path.id}"
								>{path.unavailable ? tr(path.unavailable) : tr('Segera hadir')}</span
							>
						</span>
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</Sheet>

<style>
	.paths {
		list-style: none;
		margin: 0;
		padding: 0;
		background: var(--panel);
		border-radius: var(--r-group);
		overflow: hidden;
	}
	/* § 3a GroupedList hairline: inset after the 40 px tile. */
	li + li .path::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 70px;
		border-top: 1px solid var(--line);
	}
	.path {
		position: relative;
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
		min-height: 64px;
		padding: 10px 16px;
		border: 0;
		background: transparent;
		color: var(--ink);
		text-align: left;
		font: inherit;
		text-decoration: none;
	}
	a.path:hover {
		background: var(--panel-2);
	}
	.path:disabled {
		cursor: not-allowed;
	}
	.path:disabled .tile,
	.path:disabled .label {
		opacity: 0.6;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.label {
		font-size: 15px;
		font-weight: 600;
	}
	.hint,
	.soon {
		font-size: 13px;
		color: var(--muted);
	}
</style>
