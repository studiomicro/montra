<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { formatShortDay } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { BILLING_CYCLE_LABELS } from '#lib/shared/subscriptions';
	import type { SubscriptionCandidate } from '#lib/shared/subscriptions-detect';
	import { useI18n } from '#lib/ui/i18n-context';
	import BrandBadge from '#lib/ui/kit/BrandBadge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	/**
	 * FN-26b: the subscription check's candidates, each with its own source rows (read-only, as stored). "Tambah"
	 * is a plain link (`?kandidat=<key>`) to the prefilled add form; with JavaScript `onadd` opens it in the sheet.
	 * "Bukan langganan" asks once, then posts `?/dismissCandidate`; nothing is added or hidden before the server
	 * confirms.
	 */
	let {
		candidates,
		busy,
		onadd,
		dismiss
	}: {
		candidates: SubscriptionCandidate[];
		/** The action in flight ('' when none): `dismiss:<key>` shows progress on that row. */
		busy: string;
		onadd?: (candidate: SubscriptionCandidate) => void;
		dismiss: (matchKey: string) => SubmitFunction;
	} = $props();
	const { tr, trf, locale } = useI18n();

	const addHref = (c: SubscriptionCandidate) =>
		`/langganan?kandidat=${encodeURIComponent(c.matchKey)}`;
	const add = (c: SubscriptionCandidate) => (event: MouseEvent) => {
		if (!onadd) return;
		event.preventDefault();
		onadd(c);
	};
</script>

{#if candidates.length === 0}
	<p class="empty">{tr('Belum ditemukan langganan baru')}</p>
{:else}
	<p class="intro">
		{tr('Dari riwayat transaksi yang sudah dicatat. Periksa dulu sebelum menambahkan.')}
	</p>
	<ul class="list">
		{#each candidates as c, i (c.sourceRows[0]?.id ?? i)}
			<li class="cand">
				<div class="top">
					<BrandBadge name={c.name} />
					<span class="body">
						<span class="name">{c.name}</span>
						<span class="meta">
							{trf('{siklus} (perkiraan)', { siklus: tr(BILLING_CYCLE_LABELS[c.cadence]) })} ·
							{trf('terakhir {tanggal}', { tanggal: formatShortDay(c.lastOccurredOn, locale) })}
						</span>
					</span>
					<span class="amount num">{formatMoney(c.amountMinor, c.currency)}</span>
				</div>
				<details class="rows">
					<summary>{trf('{n} transaksi terkait', { n: c.sourceRows.length })}</summary>
					<ul>
						{#each c.sourceRows as r (r.id)}
							<li>
								<span class="day">{formatShortDay(r.occurredOn, locale)}</span>
								<span class="title">{r.title ?? ''}</span>
								<span class="num">{formatMoney(r.amountMinor, r.currency)}</span>
							</li>
						{/each}
					</ul>
				</details>
				<div class="actions">
					<Button href={addHref(c)} size="sm" icon="plus" onclick={add(c)}>{tr('Tambah')}</Button>
					<details class="confirm">
						<summary>{tr('Bukan langganan')}</summary>
						<form method="POST" action="?/dismissCandidate" use:enhance={dismiss(c.matchKey)}>
							<input type="hidden" name="matchKey" value={c.matchKey} />
							<p>{tr('Tidak akan ditawarkan lagi di ruang ini.')}</p>
							<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
								{busy === `dismiss:${c.matchKey}` ? tr('Memproses…') : tr('Ya, bukan langganan')}
							</Button>
						</form>
					</details>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.empty,
	.intro {
		margin: 0 0 12px;
		color: var(--muted);
		font-size: 14px;
	}
	.list {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0 0 8px;
		list-style: none;
	}
	.cand {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.top {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.body {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.amount {
		flex: none;
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}
	.rows ul {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0 0 4px;
		list-style: none;
		font-size: 13px;
	}
	.rows li {
		display: flex;
		gap: 8px;
		min-width: 0;
	}
	.rows .day {
		flex: none;
		color: var(--muted);
	}
	.rows .title {
		flex: 1;
		overflow: hidden;
		min-width: 0;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rows .num {
		flex: none;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 8px 16px;
	}
	.confirm summary {
		list-style: none;
		color: var(--muted);
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 4px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
</style>
