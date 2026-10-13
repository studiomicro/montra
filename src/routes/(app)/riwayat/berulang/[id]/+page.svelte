<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatShortDate } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		RECURRING_ATTENTION_HINTS,
		RECURRING_STATUS_LABELS,
		scheduleLabel
	} from '#lib/shared/recurring';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import RecurringForm from '#lib/ui/recurring/RecurringForm.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const i18n = useI18n();
	const { tr, trf, locale } = i18n;

	/** The action in flight ('' when none); every submit button is disabled meanwhile. */
	let busy = $state('');
	let networkError = $state('');
	let formKey = $state(0);

	/** Success is the redirect to the list, after the server confirmed the write. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			networkError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					networkError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update({ reset: false });
				if (result.type === 'failure') {
					// Changed or gone meanwhile: show the series as it is now.
					if (result.status === 404 || result.status === 409) await invalidateAll();
					formKey++;
				}
				busy = '';
			};
		};

	const s = $derived(data.series);
	const title = $derived(
		s.title ?? (s.category ? categoryLabel(s.category, tr) : tr('Tanpa kategori'))
	);
	const subtitle = $derived(
		`${scheduleLabel(s.schedule, i18n)} · ${
			s.status === 'active'
				? trf('Berikutnya {tanggal}', { tanggal: formatShortDate(s.nextRunOn, locale) })
				: tr(RECURRING_STATUS_LABELS[s.status])
		}`
	);
	const values = $derived(form && 'values' in form && form.values ? form.values : data.values);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
	const signed = (minor: number) => (s.type === 'expense' ? -minor : minor);
</script>

<svelte:head><title>{title}</title></svelte:head>
<ScreenTitle
	back={{ href: '/riwayat/berulang', label: tr('Kembali ke Transaksi berulang') }}
	{title}
	{subtitle}
/>

<div class="page">
	<FormBanner message={banner} />
	{#if s.attention}
		<p class="attention" role="status">
			{tr('Perlu perhatian')}: {tr(RECURRING_ATTENTION_HINTS[s.attention])}
		</p>
	{/if}

	{#if s.status !== 'stopped'}
		<div class="controls">
			{#if s.status === 'active'}
				<form method="POST" action="?/pause" use:enhance={track('pause')}>
					<input type="hidden" name="updatedAt" value={s.updatedAt} />
					<Button type="submit" variant="secondary" disabled={busy !== ''}>
						{busy === 'pause' ? tr('Memproses…') : tr('Jeda')}
					</Button>
				</form>
			{:else}
				<form method="POST" action="?/resume" use:enhance={track('resume')}>
					<input type="hidden" name="updatedAt" value={s.updatedAt} />
					<Button type="submit" disabled={busy !== ''}>
						{busy === 'resume' ? tr('Memproses…') : tr('Lanjutkan')}
					</Button>
				</form>
			{/if}
		</div>
		{#if s.status === 'paused'}
			<p class="hint">
				{tr(
					'Dilanjutkan dari jadwal berikutnya mulai hari ini. Tanggal yang terlewat saat dijeda tidak dicatat.'
				)}
			</p>
		{/if}

		<section aria-labelledby="edit-series">
			<h2 id="edit-series">{tr('Ubah seri')}</h2>
			<p class="hint">
				{tr(
					'Hanya transaksi berikutnya yang memakai perubahan ini. Transaksi yang sudah tercatat tidak berubah.'
				)}
			</p>
			{#key formKey}
				<RecurringForm
					action="?/update"
					series={s}
					{values}
					{errors}
					wallets={data.wallets}
					categories={data.categories}
					busy={busy !== ''}
					submit={track('update')}
				/>
			{/key}
		</section>
	{/if}

	<section aria-labelledby="instances">
		<h2 id="instances">{tr('Transaksi dari seri ini')}</h2>
		{#if data.instances.length === 0}
			<p class="hint">{tr('Belum ada transaksi yang dibuat dari seri ini.')}</p>
		{:else}
			<p class="hint">{tr('Pilih satu transaksi untuk mengubah transaksi itu saja.')}</p>
			<GroupList label={tr('Transaksi dari seri ini')}>
				{#each data.instances as t (t.id)}
					<GroupRow href="/riwayat/{t.id}/edit">
						<span class="text">
							<span class="title">{formatShortDate(t.occurredOn, locale)}</span>
							<span class="meta">{tr('Ubah transaksi ini')}</span>
						</span>
						<span class="amount num" class:income={s.type === 'income'}
							>{shown(formatMoney(signed(t.amountMinor), t.currency, 'signed', locale))}</span
						>
					</GroupRow>
				{/each}
			</GroupList>
		{/if}
	</section>

	{#if s.status !== 'stopped'}
		<details class="confirm">
			<summary>{tr('Hentikan')}</summary>
			<form method="POST" action="?/stop" use:enhance={track('stop')}>
				<input type="hidden" name="updatedAt" value={s.updatedAt} />
				<p>
					{tr(
						'Seri ini tidak membuat transaksi lagi. Transaksi yang sudah tercatat tetap ada. Tidak bisa dibatalkan.'
					)}
				</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'stop' ? tr('Memproses…') : tr('Ya, hentikan')}
				</Button>
			</form>
		</details>
	{/if}
	<details class="confirm">
		<summary>{tr('Hapus seri')}</summary>
		<form method="POST" action="?/delete" use:enhance={track('delete')}>
			<input type="hidden" name="updatedAt" value={s.updatedAt} />
			<p>{tr('Seri ini dihapus. Transaksi yang sudah tercatat tetap ada.')}</p>
			<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
				{busy === 'delete' ? tr('Memproses…') : tr('Ya, hapus')}
			</Button>
		</form>
	</details>

	<a class="cancel" href="/riwayat/berulang">{tr('Kembali')}</a>
</div>

<style>
	.page {
		display: grid;
		gap: 16px;
		max-width: 560px;
		margin-top: 8px;
	}
	section {
		display: grid;
		gap: 10px;
	}
	h2 {
		margin: 8px 0 0;
		font-size: 20px;
		font-weight: 700;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.hint {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.attention {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--warn-text);
		font-weight: 600;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.amount {
		font-size: 15px;
		font-weight: 700;
		white-space: nowrap;
	}
	.income {
		color: var(--money-in);
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		justify-self: center;
		text-decoration: none;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
</style>
