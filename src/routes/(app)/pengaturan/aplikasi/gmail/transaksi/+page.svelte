<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDayLabel, formatShortDay, wibDateString } from '#lib/shared/dates';
	import type { GmailReviewState } from '#lib/shared/gmail/review';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	// Every action is a plain form post (works without JavaScript). Success (exact counts) shows only once the server
	// confirmed the write; after the undo dialog, focus goes back to the control that opened it.
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	const track =
		(name: string, opener: string | null): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update();
				busy = '';
				await tick();
				// Back to the control that opened the dialog; once the scan is undone that control is gone, so the
				// result line takes focus instead (it announces the counts).
				const target =
					(opener ? document.getElementById(opener) : null) ??
					document.getElementById('review-result');
				target?.focus();
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const STATE_LABELS: Record<GmailReviewState, string> = {
		draft: msg('Draf'),
		saved: msg('Tersimpan'),
		cancelled: msg('Dibatalkan'),
		duplicate: msg('Duplikat')
	};

	const scanLabel = (scan: { kind: string; days: number | null; createdAt: number } | null) =>
		!scan
			? tr('Pemeriksaan')
			: scan.kind === 'lookback'
				? trf('Lihat ke belakang {n} hari', { n: scan.days ?? 0 })
				: trf('Pemeriksaan otomatis {date}', {
						date: formatShortDay(wibDateString(scan.createdAt), locale)
					});

	const amountText = (row: {
		amountMinor: number | null;
		currency: string | null;
		direction: string | null;
	}) =>
		row.amountMinor === null || !row.currency
			? ''
			: formatMoney(
					row.direction === 'expense' ? -row.amountMinor : row.amountMinor,
					row.currency,
					'signed',
					locale
				);

	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const undone = $derived(form && 'undone' in form ? form.undone : null);
	const savedAll = $derived(form && 'savedAll' in form ? form.savedAll : null);
</script>

<svelte:head><title>{tr('Transaksi dari Gmail')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/aplikasi/gmail', label: tr('Kembali ke Gmail') }}
	title={tr('Transaksi dari Gmail')}
	subtitle={tr('Yang dibawa Gmail, per hari dan per pemeriksaan')}
/>

{#if undone}
	<p class="ok" role="status" id="review-result" tabindex="-1">
		{undone.skipped > 0
			? trf('{n} dibatalkan, {skipped} dilewati karena sudah kamu ubah', {
					n: undone.cancelled,
					skipped: undone.skipped
				})
			: trf('{n} dibatalkan', { n: undone.cancelled })}
	</p>
{/if}
{#if savedAll}
	<p class="ok" role="status" id="review-result" tabindex="-1">
		{savedAll.incomplete > 0
			? trf('{n} tersimpan, {incomplete} belum lengkap tetap di Kotak masuk', {
					n: savedAll.saved,
					incomplete: savedAll.incomplete
				})
			: trf('{n} tersimpan', { n: savedAll.saved })}
	</p>
{/if}
<FormBanner message={banner} />

{#if refreshing}
	<Skeleton rows={6} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if !data.connected}
	<section class="notice" aria-labelledby="not-connected-title">
		<h2 id="not-connected-title">{tr('Belum terhubung')}</h2>
		<p>{tr('Hubungkan Gmail dulu untuk melihat pembayaran yang dibawanya.')}</p>
		<a class="link" href="/pengaturan/aplikasi/gmail">{tr('Buka pengaturan Gmail')}</a>
	</section>
{:else if data.days.length === 0}
	<section class="notice" aria-labelledby="empty-title">
		<h2 id="empty-title">{tr('Belum ada transaksi dari Gmail')}</h2>
		<p>
			{tr(
				'Pembayaran yang ditemukan pemeriksaan Gmail dalam 90 hari terakhir akan tampil di sini.'
			)}
		</p>
		{#if data.paged}<a class="link" href="?">{tr('Kembali ke yang terbaru')}</a>{/if}
	</section>
{:else}
	{#each data.days as day (day.date)}
		<section class="group" aria-labelledby="day-{day.date}">
			<div class="day-head">
				<h2 id="day-{day.date}">{formatDayLabel(day.date, locale)}</h2>
				{#if day.savedOutMinor > 0}
					<span class="meta"
						>{trf('Tersimpan: {amount}', {
							amount: formatMoney(day.savedOutMinor, 'IDR', 'auto', locale)
						})}</span
					>
				{/if}
			</div>
			{#each day.scans as group (group.key)}
				<div class="scan">
					<h3>{scanLabel(group.scan)}</h3>
					<GroupList>
						{#each group.rows as row (row.id)}
							<GroupRow>
								<div class="rows">
									<div class="line">
										<span class="name">{row.title ?? tr('Pembayaran dari Gmail')}</span>
										{#if row.amountMinor !== null}
											<span class="amount {row.direction === 'income' ? 'in' : ''}"
												>{amountText(row)}</span
											>
										{/if}
									</div>
									<div class="line meta">
										<span class="state state-{row.state}">{tr(STATE_LABELS[row.state])}</span>
										{#if row.senderDomain}<span class="domain">{row.senderDomain}</span>{/if}
									</div>
									{#if row.subject}<span class="meta">{row.subject}</span>{/if}
									{#if row.gmailUrl}
										<a
											class="link small"
											href={row.gmailUrl}
											target="_blank"
											rel="noopener noreferrer">{tr('Buka di Gmail')}</a
										>
									{/if}
								</div>
							</GroupRow>
						{/each}
					</GroupList>
					{#if group.scan && group.scan.undoable}
						{@const scanId = group.scan.id}
						<div class="actions">
							{#if group.scan.kind === 'lookback'}
								<form
									method="POST"
									action="?/saveAll"
									class="stack"
									use:enhance={track('saveAll', null)}
								>
									<input type="hidden" name="scanId" value={scanId} />
									{#if data.wallets.length > 0}
										<label class="field">
											<span>{tr('Dompet untuk yang belum punya')}</span>
											<select name="walletId">
												<option value="">{tr('Biarkan')}</option>
												{#each data.wallets as wallet (wallet.id)}
													<option value={wallet.id}>{wallet.name}</option>
												{/each}
											</select>
										</label>
									{/if}
									{#if data.categories.length > 0}
										<label class="field">
											<span>{tr('Kategori untuk pengeluaran yang belum punya')}</span>
											<select name="categoryId">
												<option value="">{tr('Biarkan')}</option>
												{#each data.categories as category (category.id)}
													<option value={category.id}>{categoryLabel(category, tr)}</option>
												{/each}
											</select>
										</label>
									{/if}
									<Button type="submit" variant="secondary" full disabled={busy !== ''}>
										{busy === 'saveAll' ? tr('Menyimpan…') : tr('Simpan semua yang lengkap')}
									</Button>
								</form>
							{/if}
							<details class="confirm">
								<summary id="undo-{scanId}-{day.date}" class="danger"
									>{tr('Urungkan pemindaian')}</summary
								>
								<form
									method="POST"
									action="?/undo"
									use:enhance={track('undo', `undo-${scanId}-${day.date}`)}
								>
									<input type="hidden" name="scanId" value={scanId} />
									<p>
										{tr(
											'Draf dari pemindaian ini dibuang dan transaksi yang tersimpan darinya dihapus (sampai 7 hari setelah pemindaian). Transaksi yang sudah kamu ubah tetap ada.'
										)}
									</p>
									<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
										{busy === 'undo' ? tr('Memproses…') : tr('Ya, urungkan')}
									</Button>
								</form>
							</details>
						</div>
					{:else if group.scan}
						<p class="meta">{tr('Sudah diurungkan')}</p>
					{/if}
				</div>
			{/each}
		</section>
	{/each}
	{#if data.nextCursor}
		<a class="link" href="?setelah={encodeURIComponent(data.nextCursor)}"
			>{tr('Muat lebih banyak')}</a
		>
	{/if}
{/if}

<style>
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	.day-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 4px 12px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	h3 {
		margin: 8px 0 4px;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	.scan {
		display: grid;
		gap: 4px;
	}
	.notice {
		display: grid;
		gap: 4px;
		margin-top: 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.notice h2 {
		font-size: 15px;
	}
	.notice p {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.rows {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 2px 8px;
		min-width: 0;
	}
	.name {
		min-width: 0;
		font-size: 15px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.amount {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		white-space: nowrap;
	}
	.amount.in {
		color: var(--money-in);
	}
	.meta {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.state {
		font-weight: 600;
		color: var(--ink-2);
	}
	.state-saved {
		color: var(--money-in);
	}
	.domain {
		overflow-wrap: anywhere;
	}
	.stack {
		display: grid;
		gap: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
		font-size: 15px;
		font-weight: 600;
	}
	.field select {
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-weight: 400;
	}
	.actions {
		display: grid;
		gap: 8px;
		margin-top: 4px;
	}
	.link {
		display: flex;
		align-items: center;
		width: fit-content;
		min-height: 44px;
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.link.small {
		font-size: 13px;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary.danger {
		color: var(--money-up);
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 0 0 8px;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.ok {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
