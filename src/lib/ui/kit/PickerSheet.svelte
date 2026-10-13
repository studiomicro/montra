<script lang="ts" generics="V extends string">
	import Icon from '#lib/ui/Icon.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import BrandBadgeById from './BrandBadgeById.svelte';
	import CategoryTile from './CategoryTile.svelte';
	import type { PickerOption } from './picker';

	/**
	 * § 2 PickerSheet: a bottom sheet on phones, a centred dialog on desktop (Sheet), with one radio-style row per
	 * option and an optional "+ Tambah …" row at the end. The chosen row is marked for assistive tech
	 * (`aria-current` on links, `aria-checked` on radios).
	 */
	let {
		open = $bindable(false),
		title,
		options,
		value,
		onselect,
		addHref,
		addLabel
	}: {
		open?: boolean;
		title: string;
		options: PickerOption<V>[];
		value: V | null;
		onselect?: (value: V) => void;
		addHref?: string;
		addLabel?: string;
	} = $props();

	function choose(option: PickerOption<V>) {
		onselect?.(option.value);
		open = false;
	}
</script>

{#snippet content(option: PickerOption<V>)}
	{#if option.brand}<BrandBadgeById id={option.brand} size={36} />{/if}
	{#if option.tile}<CategoryTile category={option.tile} size={36} />{/if}
	<span class="text">
		<span class="title">{option.label}</span>
		{#if option.hint}<span class="hint">{option.hint}</span>{/if}
	</span>
	{#if !option.disabled}
		<span class="radio" class:on={option.value === value} aria-hidden="true"></span>
	{/if}
{/snippet}

<Sheet bind:open {title}>
	{#if open}
		<ul class="options" role={options.some((o) => o.href) ? undefined : 'radiogroup'}>
			{#each options as option (option.value)}
				<li>
					{#if option.href && !option.disabled}
						<a
							class="option"
							href={option.href}
							aria-current={option.value === value ? 'true' : undefined}
							onclick={() => (open = false)}
						>
							{@render content(option)}
						</a>
					{:else if option.disabled}
						<!-- A disabled native button: out of the tab order, never clicked, announced as disabled. -->
						<button
							type="button"
							class="option"
							role="radio"
							aria-checked="false"
							aria-disabled="true"
							tabindex="-1"
							disabled
						>
							{@render content(option)}
						</button>
					{:else}
						<button
							type="button"
							class="option"
							role="radio"
							aria-checked={option.value === value}
							onclick={() => choose(option)}
						>
							{@render content(option)}
						</button>
					{/if}
				</li>
			{/each}
			{#if addHref && addLabel}
				<li>
					<a class="option add" href={addHref}>
						<span class="plus"><Icon name="plus" size={18} /></span>
						<span class="title">{addLabel}</span>
					</a>
				</li>
			{/if}
		</ul>
	{/if}
</Sheet>

<style>
	.options {
		list-style: none;
		margin: 0 0 4px;
		padding: 0;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	li + li .option {
		border-top: 1px solid var(--line);
	}
	.option {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 56px;
		padding: 8px 16px;
		border: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		text-align: left;
		text-decoration: none;
	}
	.option:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.option:disabled {
		cursor: default;
	}
	.option:disabled .title {
		color: var(--muted);
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.radio {
		flex: none;
		width: 22px;
		height: 22px;
		border-radius: var(--r-pill);
		box-shadow: inset 0 0 0 2px var(--faint);
	}
	.radio.on {
		box-shadow: inset 0 0 0 7px var(--ink);
	}
	.plus {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--r-pill);
		background: var(--bg);
	}
</style>
