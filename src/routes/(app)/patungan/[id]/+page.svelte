<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { formatDayLabel } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { MODE_LABELS, isFormMode } from '#lib/shared/patungan';
	import { categoryLabel } from '#lib/shared/transactions';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	const split = $derived(data.split);
	const money = (minor: number) => formatMoney(minor, split.currency, 'auto', locale);

	/** The action being sent (its name), so its button says so and the others wait. */
	let busy = $state<string | null>(null);
	let networkError = $state('');
	const act =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			networkError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					networkError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update({ reset: false });
				busy = null;
			};
		};

	const savedText: Record<string, string> = {
		created: msg('Patungan disimpan.'),
		updated: msg('Perubahan disimpan.'),
		settled: msg('Ditandai lunas.'),
		unsettled: msg('Tanda lunas dibatalkan.'),
		linked: msg('Transaksi ditautkan.'),
		unlinked: msg('Tautan dilepas. Transaksinya kembali dihitung penuh.')
	};
	const banner = $derived(
		networkError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
	const errors = $derived(
		form && 'errors' in form && form.errors ? (form.errors as Partial<Record<string, string>>) : {}
	);
	const payer = $derived(split.participants.find((p) => p.isPayer));
	const canAct = $derived(data.isPayer && !split.isDemo);
</script>

<svelte:head><title>{split.title}</title></svelte:head>
<ScreenTitle
	back={{ href: '/patungan', label: tr('Kembali ke Patungan') }}
	title={split.title}
	subtitle="{money(split.totalAmountMinor)} · {formatDayLabel(split.occurredOn, locale)}"
/>

<div class="page">
	{#if data.saved && Object.hasOwn(savedText, data.saved)}
		<p class="ok" role="status">{tr(savedText[data.saved] as string)}</p>
	{/if}
	<FormBanner message={banner} />

	<p class="meta">
		{isFormMode(split.mode) ? tr(MODE_LABELS[split.mode]) : ''} · {trf('Dibayar {name}', {
			name: split.payerName
		})}
		{#if split.isDemo}<span class="chip">{tr('Data demo')}</span>{/if}
	</p>
	{#if split.note}<p class="note">{split.note}</p>{/if}

	<section aria-labelledby="people-title">
		<h2 id="people-title">{tr('Bagian setiap orang')}</h2>
		<GroupList>
			{#each split.participants as person (person.id)}
				<li class="person" class:you={person.memberUserId === data.viewerId}>
					<span class="who">
						<span class="name">{person.displayName}</span>
						<span class="sub">
							{#if person.isPayer}
								{tr('Pembayar')}
							{:else if person.memberUserId === data.viewerId}
								{tr('Bagianmu')}
							{:else if person.kind === 'member'}
								{tr('Anggota ruang')}
							{:else}
								{tr('Teman')}
							{/if}
						</span>
					</span>
					<span class="end">
						<span class="num share">{money(person.shareAmountMinor)}</span>
						{#if person.isPayer}
							<span class="sub">{tr('Bagian pembayar')}</span>
						{:else if person.paidAt !== null}
							<StatusTag>{tr('Lunas')}</StatusTag>
						{:else}
							<span class="sub">{tr('Belum lunas')}</span>
						{/if}
						{#if canAct && !person.isPayer}
							<form
								method="POST"
								action={person.paidAt === null ? '?/settle' : '?/unsettle'}
								use:enhance={act(`paid-${person.id}`)}
							>
								<input type="hidden" name="participant" value={person.id} />
								<Button type="submit" size="sm" variant="secondary" disabled={busy !== null}>
									{busy === `paid-${person.id}`
										? tr('Menyimpan…')
										: person.paidAt === null
											? tr('Tandai lunas')
											: tr('Batalkan lunas')}
								</Button>
							</form>
						{/if}
					</span>
				</li>
			{/each}
		</GroupList>
		{#if split.locked}
			<p class="hint">
				{tr(
					'Sudah ada yang membayar, jadi orang dan bagiannya tidak bisa diubah lagi. Nama, tanggal dan catatan tetap bisa.'
				)}
			</p>
		{/if}
	</section>

	<section aria-labelledby="books-title">
		<h2 id="books-title">{tr('Di catatanmu')}</h2>
		{#if split.linked}
			<div class="card">
				{#if split.linked.ownShare}
					<p>
						{trf('Bagianmu {amount} dicatat sebagai pengeluaran dari {wallet}.', {
							amount: money(split.linked.effectiveAmountMinor),
							wallet: split.linked.walletName
						})}
					</p>
				{:else}
					<p>
						{trf('Tertaut ke transaksi {title} sebesar {amount}.', {
							title: split.linked.title ?? tr('Tanpa judul'),
							amount: money(split.linked.amountMinor)
						})}
					</p>
					<p class="hint">
						{trf('Semua total hanya menghitung bagianmu: {amount}.', {
							amount: money(split.linked.effectiveAmountMinor)
						})}
					</p>
				{/if}
				<a class="link" href="/riwayat/{split.linked.id}/edit">{tr('Lihat transaksi')}</a>
				{#if canAct || data.canRescue}
					<form method="POST" action="?/unlink" use:enhance={act('unlink')}>
						<Button type="submit" size="sm" variant="secondary" disabled={busy !== null}>
							{busy === 'unlink' ? tr('Menyimpan…') : tr('Lepas tautan')}
						</Button>
					</form>
				{/if}
			</div>
		{:else}
			<div class="card">
				<p>
					{tr(
						'Belum ada transaksi untuk patungan ini, jadi bagian pembayar belum dihitung di pengeluaran mana pun.'
					)}
				</p>
				{#if canAct}
					{#if data.candidates.length > 0}
						<h3>{tr('Tautkan transaksi lain')}</h3>
						<ul class="cands">
							{#each data.candidates as c (c.id)}
								<li>
									<form
										method="POST"
										action="?/link"
										use:enhance={act(`link-${c.id}`)}
										class="cand"
									>
										<input type="hidden" name="transaction" value={c.id} />
										<span class="cand-text">
											<span class="name">{c.title ?? tr('Tanpa judul')}</span>
											<span class="sub"
												>{formatDayLabel(c.occurredOn, locale)} · {c.walletName}</span
											>
										</span>
										<Button type="submit" size="sm" variant="secondary" disabled={busy !== null}>
											{busy === `link-${c.id}` ? tr('Menyimpan…') : tr('Tautkan')}
										</Button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
					{#if payer && data.wallets.length > 0}
						<h3>{tr('Buat transaksi untuk bagianmu')}</h3>
						<form method="POST" action="?/ownShare" use:enhance={act('own')} class="own">
							<label for="own-wallet">{tr('Dompet')}</label>
							<select id="own-wallet" name="walletId">
								{#each data.wallets as wallet (wallet.id)}
									<option value={wallet.id}>{wallet.name} · {wallet.currency}</option>
								{/each}
							</select>
							{#if errors.walletId}<p class="error">{tr(errors.walletId)}</p>{/if}
							<label for="own-category">{tr('Kategori')}</label>
							<select id="own-category" name="categoryId">
								<option value="">{tr('Pilih kategori')}</option>
								{#each data.categories as category (category.id)}
									<option value={category.id}>{categoryLabel(category, tr)}</option>
								{/each}
							</select>
							{#if errors.categoryId}<p class="error">{tr(errors.categoryId)}</p>{/if}
							<Button type="submit" size="sm" disabled={busy !== null}>
								{busy === 'own'
									? tr('Menyimpan…')
									: trf('Catat {amount}', { amount: money(payer.shareAmountMinor) })}
							</Button>
						</form>
					{/if}
				{/if}
			</div>
		{/if}
	</section>

	{#if data.canRescue}
		<p class="hint">
			{tr(
				'Pembayar sudah tidak ada di ruang ini. Sebagai pemilik ruang, kamu bisa melepas tautan atau menghapus patungan ini.'
			)}
		</p>
	{/if}
	{#if canAct || data.canRescue}
		<div class="actions">
			{#if canAct}
				<Button variant="secondary" href="/patungan/{split.id}/ubah">{tr('Ubah')}</Button>
			{/if}
			<details class="danger">
				<summary>{tr('Hapus patungan')}</summary>
				<p class="hint">
					{tr('Patungan dan semua bagiannya dihapus. Transaksi yang tertaut tidak ikut dihapus.')}
				</p>
				<form method="POST" action="?/delete" use:enhance={act('delete')}>
					<input type="hidden" name="updatedAt" value={split.updatedAt} />
					<Button type="submit" variant="destructive" disabled={busy !== null}>
						{busy === 'delete' ? tr('Menghapus…') : tr('Ya, hapus')}
					</Button>
				</form>
			</details>
		</div>
	{:else if !data.isPayer}
		<p class="hint">{tr('Hanya pembayar yang bisa mengubah patungan ini.')}</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		gap: 20px;
		max-width: 640px;
	}
	.ok {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	h2 {
		margin: 0 0 8px;
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}
	h3 {
		margin: 8px 0 0;
		font-size: 15px;
		font-weight: 600;
	}
	.meta,
	.note {
		margin: 0;
		color: var(--muted);
	}
	.note {
		overflow-wrap: anywhere;
	}
	.chip {
		margin-left: 8px;
		font-size: 13px;
		font-weight: 600;
	}
	.person {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 8px 12px;
		min-height: 56px;
		padding: 10px 16px;
	}
	.person + .person {
		border-top: 1px solid var(--line);
	}
	.you .name {
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.who,
	.cand-text {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.sub {
		font-size: 13px;
		color: var(--muted);
	}
	.end {
		display: grid;
		justify-items: end;
		gap: 4px;
	}
	.share {
		font-weight: 700;
		white-space: nowrap;
	}
	.card {
		display: grid;
		gap: 8px;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.card p {
		margin: 0;
	}
	.cands {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.cand {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.own {
		display: grid;
		gap: 6px;
	}
	label {
		font-size: 15px;
		font-weight: 600;
	}
	select {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	.link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.actions {
		display: grid;
		gap: 12px;
	}
	.danger summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
	}
	.danger {
		display: grid;
		gap: 8px;
	}
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
