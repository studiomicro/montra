<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import Icon from '#lib/ui/Icon.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, locale } = useI18n();

	/** The action in flight ('' when none): every button is disabled meanwhile. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	/**
	 * No optimistic change: a row disappears or turns read only once the server confirmed and the list is
	 * reloaded. A network or server failure keeps the row as it was and shows a retryable error.
	 */
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

	const loading = $derived(refreshing || navigating.to?.url.pathname === '/kotak-masuk/notifikasi');
	const banner = $derived(
		actionError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);
	const dismissed = $derived(!busy && form && 'dismissed' in form && form.dismissed);
</script>

<svelte:head><title>{tr('Notifikasi')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/kotak-masuk', label: tr('Kembali ke Kotak masuk') }}
	title={tr('Notifikasi')}
	subtitle={tr('Notifikasi terbaru untuk akunmu, yang terbaru di atas.')}
>
	{#snippet actions()}
		<Button variant="secondary" size="sm" icon="gear" href="/pengaturan/notifikasi">
			{tr('Atur notifikasi')}
		</Button>
	{/snippet}
</ScreenTitle>

{#if dismissed}<p class="ok" role="status">{tr('Notifikasi dihapus.')}</p>{/if}
<FormBanner message={banner} />

{#if loading}
	<div aria-busy="true"><Skeleton rows={4} /></div>
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if data.items.length === 0}
	<EmptyState illustration="inbox" text={tr('Belum ada notifikasi.')} />
{:else}
	<GroupList>
		{#each data.items as item (item.id)}
			<GroupRow>
				<form method="POST" action="?/open" class="open" use:enhance={track(`open-${item.id}`)}>
					<input type="hidden" name="id" value={item.id} />
					<button type="submit" class="item" class:unread={item.unread} disabled={busy !== ''}>
						<span class="title">
							{#if item.unread}<span class="dot" aria-hidden="true"></span><span class="sr"
									>{tr('Belum dibaca')}:</span
								>{/if}
							{item.title}
						</span>
						{#if item.body}<span class="body">{item.body}</span>{/if}
						<span class="time">{formatDateTimeWib(item.createdAt, locale)}</span>
					</button>
				</form>
				<form method="POST" action="?/dismiss" use:enhance={track(`dismiss-${item.id}`)}>
					<input type="hidden" name="id" value={item.id} />
					<button
						type="submit"
						class="dismiss"
						aria-label={tr('Hapus notifikasi')}
						disabled={busy !== ''}
					>
						<Icon name="close" size={18} />
					</button>
				</form>
			</GroupRow>
		{/each}
	</GroupList>
{/if}

<style>
	.ok {
		margin: 8px 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.open {
		flex: 1;
		min-width: 0;
	}
	.item {
		display: grid;
		gap: 2px;
		width: 100%;
		min-height: 44px;
		padding: 4px 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 15px;
		font-weight: 500;
	}
	.unread .title {
		font-weight: 700;
	}
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--ink);
	}
	.body {
		color: var(--ink-2);
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.time {
		color: var(--muted);
		font-size: 13px;
	}
	.dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
