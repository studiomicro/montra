<script lang="ts">
	import { enhance } from '$app/forms';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import PageAction from '#lib/ui/shell/PageAction.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	const { tr, trf } = useI18n();
	let switching = $state<string | null>(null);
	const hasShared = $derived(data.spaces.some((s) => s.kind === 'shared'));
</script>

<svelte:head><title>{tr('Ruang')}</title></svelte:head>
<ScreenTitle
	title={tr('Ruang')}
	subtitle={tr('Ruang pribadi untukmu sendiri, ruang bersama sampai 5 orang.')}
>
	{#snippet actions()}
		{#if hasShared}
			<PageAction at="header" href="/ruang/baru" icon="plus">{tr('Buat ruang bersama')}</PageAction>
		{/if}
	{/snippet}
</ScreenTitle>

{#if data.left}
	<p class="ok" role="status">{tr('Kamu sudah keluar dari ruang.')}</p>
{/if}

<div class="list">
	<GroupList>
		{#each data.spaces as space (space.id)}
			<GroupRow>
				<InitialsTile
					name={space.kind === 'personal' ? tr('Pribadi') : space.name}
					size={40}
					round
				/>
				<a class="name" href="/ruang/{space.id}">
					<span class="title">{space.kind === 'personal' ? tr('Pribadi') : space.name}</span>
					<span class="meta">
						{space.role === 'owner' ? tr('Pemilik') : tr('Anggota')} · {trf('{n} orang', {
							n: space.memberCount
						})}
					</span>
				</a>
				{#if space.id === data.currentId}
					<!-- A state, not an action: the status tag, so it never reads as a smaller twin of "Pakai" (POLISH_AUDIT B14). -->
					<StatusTag>{tr('Sedang dipakai')}</StatusTag>
				{:else}
					<form
						method="POST"
						action="?/switchSpace"
						use:enhance={() => {
							switching = space.id;
							return async ({ update }) => {
								await update();
								switching = null;
							};
						}}
					>
						<input type="hidden" name="spaceId" value={space.id} />
						<Button type="submit" variant="secondary" size="sm" disabled={switching !== null}>
							{switching === space.id ? tr('Memproses…') : tr('Pakai')}
						</Button>
					</form>
				{/if}
			</GroupRow>
		{/each}
	</GroupList>
</div>

{#if hasShared}
	<PageAction at="bottom" href="/ruang/baru" icon="plus">{tr('Buat ruang bersama')}</PageAction>
{:else}
	<EmptyState
		illustration="people"
		text={tr(
			'Belum ada ruang bersama. Buat satu untuk mencatat keuangan bersama pasangan atau keluarga.'
		)}
		actionLabel={tr('Buat ruang bersama')}
		actionHref="/ruang/baru"
	/>
{/if}

<style>
	.list {
		margin-top: 16px;
	}
	.name {
		display: flex;
		flex: 1;
		flex-direction: column;
		justify-content: center;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.ok {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
