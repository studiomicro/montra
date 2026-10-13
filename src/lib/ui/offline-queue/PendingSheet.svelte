<script lang="ts">
	import { formatMoney } from '#lib/shared/money-format';
	import type { QueueItem } from '#lib/shared/offline-queue';
	import { useI18n } from '#lib/ui/i18n-context';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import { itemState, itemStateText, QUEUE_KIND_LABELS, reopenHref } from './view';

	/**
	 * FN-02 "Perubahan menunggu": every queued item of this account in plain language, with its state and the
	 * one action that fits it. "Buang" removes only the queued change, never the transaction.
	 */
	let {
		open = $bindable(false),
		items,
		currentSpaceId,
		sessionEnded,
		now,
		onretry,
		ondiscard
	}: {
		open?: boolean;
		items: QueueItem[];
		currentSpaceId: string | null;
		sessionEnded: boolean;
		now: number;
		onretry: (clientId: string) => void;
		ondiscard: (clientId: string) => void;
	} = $props();
	const { tr, trf, locale } = useI18n();

	/** Names the space only when it is not obvious (another space than the current one, or several). */
	const showSpace = $derived(
		new Set(items.map((i) => i.spaceId)).size > 1 || items.some((i) => i.spaceId !== currentSpaceId)
	);

	function label(item: QueueItem): string {
		const s = item.summary;
		const what =
			s.count > 1
				? trf('{n} transaksi', { n: s.count })
				: s.title || tr(QUEUE_KIND_LABELS[item.kind]);
		return s.amountMinor === null
			? what
			: `${what} · ${formatMoney(s.amountMinor, s.currency, 'auto', locale)}`;
	}
</script>

<Sheet bind:open title={tr('Perubahan menunggu')}>
	{#if items.length === 0}
		<p class="empty">{tr('Semua tersinkron')}</p>
	{:else}
		<ul class="list">
			{#each items as item (item.clientId)}
				{@const state = itemState(item, { sessionEnded, now })}
				{@const reopen = reopenHref(item)}
				<li class="row">
					<div class="text">
						<span class="kind">
							{tr(QUEUE_KIND_LABELS[item.kind])}{#if showSpace}&nbsp;· {item.spaceName}{/if}
						</span>
						<span class="what">{label(item)}</span>
						<span class="state {state}">{tr(itemStateText(state, item))}</span>
					</div>
					{#if state !== 'sending'}
						<div class="actions">
							{#if reopen}
								<a class="action" href={reopen} onclick={() => ondiscard(item.clientId)}
									>{tr('Buka transaksi')}</a
								>
							{:else if state === 'failed' || state === 'stale'}
								<button type="button" class="action" onclick={() => onretry(item.clientId)}>
									{tr('Kirim lagi')}
								</button>
							{/if}
							<button type="button" class="action quiet" onclick={() => ondiscard(item.clientId)}>
								{tr('Buang')}
							</button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="note">{tr('Perubahan dikirim otomatis saat perangkat online.')}</p>
	{/if}
</Sheet>

<style>
	.empty,
	.note {
		margin: 8px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.list {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
		padding: 12px 16px;
	}
	.row + .row {
		border-top: 1px solid var(--line);
	}
	.text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		gap: 2px;
	}
	.kind {
		color: var(--muted);
		font-size: 13px;
	}
	.what {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.state {
		font-size: 14px;
		color: var(--ink-2);
	}
	.state.failed,
	.state.stale,
	.state.session {
		color: var(--warn-text);
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}
	.quiet {
		background: transparent;
		color: var(--muted);
	}
</style>
