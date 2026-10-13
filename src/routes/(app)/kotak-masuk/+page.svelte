<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { prefersReducedMotion } from 'svelte/motion';
	import { rowOut } from '#lib/ui/motion';
	import { navigating } from '$app/state';
	import { addDays, formatDayLabel } from '#lib/shared/dates';
	import { groupByDay } from '#lib/shared/drafts';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import DraftSummary from '#lib/ui/drafts/DraftSummary.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import DayHeader from '#lib/ui/kit/DayHeader.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import PageAction from '#lib/ui/shell/PageAction.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	const days = $derived(groupByDay(data.drafts));
	const walletName = (id: string | null) => data.wallets.find((w) => w.id === id)?.name ?? null;
	const categoryOf = (id: string | null) => data.categories.find((c) => c.id === id) ?? null;

	function dayLabel(date: string): string {
		if (date === data.today) return tr('Hari ini');
		if (date === addDays(data.today, -1)) return tr('Kemarin');
		return formatDayLabel(date, locale);
	}

	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	/** Success is shown only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				} else {
					await update();
					if (result.type === 'failure') await invalidateAll();
				}
				busy = '';
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

	const loading = $derived(refreshing || navigating.to?.url.pathname === '/kotak-masuk');

	const notice = $derived.by(() => {
		const n = data.notice;
		if (!n) return [];
		return [
			n.incomplete === 0
				? trf('Disimpan {n} transaksi', { n: n.saved })
				: trf('Disimpan {saved} dari {total} transaksi · {incomplete} belum lengkap', {
						saved: n.saved,
						total: n.total,
						incomplete: n.incomplete
					}),
			...(n.remaining > 0
				? [
						trf('{n} draf terpilih belum diproses. Buka Periksa draf untuk melanjutkan.', {
							n: n.remaining
						})
					]
				: [])
		];
	});

	const done = $derived.by(() => {
		if (!form || !('done' in form)) return '';
		if (form.done === 'discarded') return tr('Draf diabaikan.');
		if (form.done === 'renamed') return tr('Nama draf diganti.');
		if (form.done === 'seeded') return trf('{n} draf contoh ditambahkan.', { n: form.count ?? 0 });
		return trf('{n} draf contoh dikosongkan.', { n: form.count ?? 0 });
	});
	const banner = $derived(
		actionError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
</script>

<svelte:head><title>{tr('Kotak masuk')}</title></svelte:head>
<ScreenTitle
	title={tr('Kotak masuk')}
	subtitle={tr('Draf dan notifikasi yang menunggu kamu periksa.')}
>
	{#snippet actions()}
		{#if !data.loadError && data.drafts.length > 0}
			<PageAction at="header" href="/kotak-masuk/periksa" icon="check"
				>{tr('Periksa draf')}</PageAction
			>
		{/if}
	{/snippet}
</ScreenTitle>

{#each notice as line, i (i)}
	<p class="ok" role="status">{line}</p>
{/each}
{#if done}<p class="ok" role="status">{done}</p>{/if}
<FormBanner message={banner} />

<div class="bell">
	<GroupList>
		<IconRow
			icon="bell"
			title={tr('Notifikasi')}
			hint={data.unread
				? data.unread >= 100
					? '99+'
					: trf('{n} belum dibaca', { n: data.unread })
				: undefined}
			href="/kotak-masuk/notifikasi"
		/>
	</GroupList>
</div>

{#if !data.loadError}
	<div class="head">
		<h2>{tr('Draf')}</h2>
		{#if data.total > 0}
			<p class="count num">{trf('{n} draf menunggu', { n: data.total })}</p>
		{/if}
		{#if data.total > data.drafts.length}
			<p class="meta">
				{trf('Menampilkan {n} draf terbaru.', { n: data.drafts.length })}
			</p>
		{/if}
	</div>
{/if}

{#if loading}
	<div aria-busy="true"><Skeleton rows={4} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.drafts.length === 0}
	<EmptyState illustration="inbox" text={tr('Tidak ada draf yang menunggu.')} />
{:else}
	{#each days as day (day.date)}
		<section aria-label={dayLabel(day.date)}>
			<DayHeader label={dayLabel(day.date)} inMinor={0} outMinor={0} />
			<GroupList records>
				{#each day.rows as draft (draft.id)}
					<GroupRow exit={(node) => rowOut(node, { reducedMotion: prefersReducedMotion.current })}>
						<DraftSummary
							{draft}
							reason={data.reasons[draft.id]}
							category={categoryOf(draft.categoryId)}
							walletName={walletName(draft.walletId)}
						/>
						{#if data.names[draft.id]}
							<!-- FN-20 red team L2: the AI-recognised name is only offered; the server re-resolves it. -->
							<form method="POST" action="?/useName" use:enhance={track(`name-${draft.id}`)}>
								<input type="hidden" name="id" value={draft.id} />
								<input type="hidden" name="updatedAt" value={draft.updatedAt} />
								<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
									{busy === `name-${draft.id}`
										? tr('Memproses…')
										: trf('Pakai nama {nama}', { nama: data.names[draft.id] ?? '' })}
								</Button>
							</form>
						{/if}
						<details class="confirm">
							<summary>{tr('Abaikan')}</summary>
							<form method="POST" action="?/discard" use:enhance={track(`discard-${draft.id}`)}>
								<input type="hidden" name="id" value={draft.id} />
								<input type="hidden" name="updatedAt" value={draft.updatedAt} />
								<p>{tr('Draf yang diabaikan tidak bisa dikembalikan.')}</p>
								<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
									{busy === `discard-${draft.id}` ? tr('Memproses…') : tr('Ya, abaikan')}
								</Button>
							</form>
						</details>
					</GroupRow>
				{/each}
			</GroupList>
		</section>
	{/each}
{/if}

{#if !data.loadError && data.drafts.length > 0}
	<PageAction at="bottom" href="/kotak-masuk/periksa" icon="check">{tr('Periksa draf')}</PageAction>
{/if}

{#if data.devTools}
	<section class="dev" aria-labelledby="dev-title">
		<h2 id="dev-title">{tr('Alat pengembang')}</h2>
		<p class="meta">
			{tr('Draf contoh untuk uji tampilan. Hanya ada di lingkungan pengembangan.')}
		</p>
		<div class="dev-actions">
			<form method="POST" action="?/seedDemoDrafts" use:enhance={track('seed')}>
				<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
					{busy === 'seed' ? tr('Memproses…') : tr('Tambah draf contoh')}
				</Button>
			</form>
			<form method="POST" action="?/clearDemoDrafts" use:enhance={track('clear')}>
				<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
					{busy === 'clear' ? tr('Memproses…') : tr('Kosongkan draf contoh')}
				</Button>
			</form>
		</div>
	</section>
{/if}

<style>
	.bell {
		margin-top: 8px;
	}
	.head {
		margin: 24px 0 10px;
	}
	.head h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.count {
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--muted);
	}
	.meta {
		margin: 2px 0 0;
		font-size: 13px;
		color: var(--muted);
	}
	.ok {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	section :global(.row) {
		flex-wrap: wrap;
	}
	/* Phone layout v3: the tile sits beside the title, not centred on the tags and the "Abaikan" link under it. */
	@media (max-width: 600px) {
		section :global(.row) {
			align-items: flex-start;
		}
	}
	.confirm {
		flex-basis: 100%;
		padding-left: 52px;
	}
	/* Phone layout v3: the rows hold a 48 px tile and no side padding, so the link lines up with the text. */
	@media (max-width: 600px) {
		.confirm {
			padding-left: 64px;
		}
	}
	.confirm summary {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		justify-items: start;
		gap: 8px;
		padding-bottom: 8px;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.dev {
		margin-top: 32px;
	}
	.dev h2 {
		margin: 0 0 4px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.dev-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
</style>
