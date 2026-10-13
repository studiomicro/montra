<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	/** The action in flight ('' when none): its button shows "Memproses…", every action button is disabled. */
	let busy = $state('');
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			return async ({ update }) => {
				await update();
				busy = '';
			};
		};

	const title = $derived(data.space.kind === 'personal' ? tr('Pribadi') : data.space.name);
	const isOwner = $derived(data.role === 'owner');
	const shared = $derived(data.space.kind === 'shared');
	const full = $derived(data.members.length >= data.maxMembers);
	const created = $derived(form && 'created' in form ? form.created : undefined);

	let copied = $state<'yes' | 'no' | null>(null);
	async function copy(link: string) {
		try {
			await navigator.clipboard.writeText(link);
			copied = 'yes';
		} catch {
			copied = 'no';
		}
	}
</script>

<svelte:head><title>{title}</title></svelte:head>
<ScreenTitle
	back={{ href: '/ruang', label: tr('Kembali ke Ruang') }}
	{title}
	subtitle={isOwner ? tr('Kamu pemilik ruang ini') : tr('Kamu anggota ruang ini')}
>
	{#snippet actions()}
		{#if data.isCurrent}
			<Badge>{tr('Sedang dipakai')}</Badge>
		{:else}
			<form method="POST" action="/ruang?/switchSpace" use:enhance={track('switch')}>
				<input type="hidden" name="spaceId" value={data.space.id} />
				<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
					{busy === 'switch' ? tr('Memproses…') : tr('Pakai ruang ini')}
				</Button>
			</form>
		{/if}
	{/snippet}
</ScreenTitle>

<FormBanner message={form && 'error' in form && form.error ? tr(form.error) : undefined} />
{#if form && 'revoked' in form}
	<p class="ok" role="status">{tr('Tautan undangan dicabut.')}</p>
{:else if form && 'removed' in form}
	<p class="ok" role="status">
		{tr('Anggota dikeluarkan dari ruang. Tautan undangan lama tidak berlaku lagi.')}
	</p>
{/if}

<section aria-labelledby="members-title">
	<h2 id="members-title">{tr('Orang di ruang ini')}</h2>
	<p class="meta">
		{trf('{n} dari {max} orang', { n: data.members.length, max: data.maxMembers })}
	</p>
	<GroupList>
		{#each data.members as member (member.id)}
			<GroupRow>
				<InitialsTile name={member.name} size={40} round />
				<span class="person">
					<span class="title">
						{member.isYou ? trf('{nama} (kamu)', { nama: member.name }) : member.name}
					</span>
					<span class="meta">{member.role === 'owner' ? tr('Pemilik') : tr('Anggota')}</span>
				</span>
				{#if isOwner && member.role === 'member'}
					<details class="confirm">
						<summary>{tr('Keluarkan')}</summary>
						<form method="POST" action="?/removeMember" use:enhance={track(`remove-${member.id}`)}>
							<input type="hidden" name="memberId" value={member.id} />
							<p>{trf('Keluarkan {nama} dari ruang ini?', { nama: member.name })}</p>
							<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
								{busy === `remove-${member.id}` ? tr('Memproses…') : tr('Ya, keluarkan')}
							</Button>
						</form>
					</details>
				{/if}
			</GroupRow>
		{/each}
	</GroupList>
</section>

{#if isOwner && shared}
	<section aria-labelledby="invite-title">
		<h2 id="invite-title">{tr('Undang lewat tautan')}</h2>
		{#if created}
			<div class="created">
				<label for="invite-link">{tr('Tautan undangan')}</label>
				<input id="invite-link" class="link" type="text" readonly value={created.link} />
				<p class="meta">
					{tr('Salin sekarang: tautan ini hanya ditampilkan sekali.')}
					{trf('Berlaku sampai {waktu}.', {
						waktu: formatDateTimeWib(created.expiresAt, locale)
					})}
				</p>
				<Button variant="secondary" onclick={() => copy(created.link)}>{tr('Salin tautan')}</Button>
				<p class="meta" role="status">
					{#if copied === 'yes'}{tr('Tautan disalin.')}{:else if copied === 'no'}{tr(
							'Tidak bisa menyalin. Salin tautan secara manual.'
						)}{/if}
				</p>
			</div>
		{:else if data.invite}
			<p class="meta">
				{data.invite.expired
					? tr('Tautan undangan sudah kedaluwarsa.')
					: trf('Tautan undangan aktif sampai {waktu}.', {
							waktu: formatDateTimeWib(data.invite.expiresAt, locale)
						})}
			</p>
		{:else}
			<p class="meta">
				{tr(
					'Belum ada tautan undangan. Siapa pun yang membuka tautan bisa bergabung selama 7 hari.'
				)}
			</p>
		{/if}
		{#if full}
			<p class="meta">{tr('Ruang ini sudah penuh.')}</p>
		{/if}
		<div class="actions">
			<form method="POST" action="?/createInvite" use:enhance={track('create')}>
				<input type="hidden" name="replaces" value={data.invite?.id ?? ''} />
				<Button type="submit" size="md" disabled={busy !== ''}>
					{busy === 'create'
						? tr('Memproses…')
						: data.invite
							? tr('Buat tautan baru')
							: tr('Buat tautan undangan')}
				</Button>
			</form>
			{#if data.invite}
				<form method="POST" action="?/revokeInvite" use:enhance={track('revoke')}>
					<input type="hidden" name="inviteId" value={data.invite.id} />
					<Button type="submit" variant="destructive" size="md" disabled={busy !== ''}>
						{busy === 'revoke' ? tr('Memproses…') : tr('Cabut tautan')}
					</Button>
				</form>
			{/if}
		</div>
	</section>
{/if}

{#if data.role === 'member'}
	<section aria-labelledby="leave-title">
		<h2 id="leave-title">{tr('Keluar dari ruang')}</h2>
		<details class="confirm">
			<summary>{tr('Keluar dari ruang')}</summary>
			<form method="POST" action="?/leave" use:enhance={track('leave')}>
				<p>{tr('Kamu tidak lagi melihat data ruang ini. Pemilik bisa mengundangmu lagi.')}</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'leave' ? tr('Memproses…') : tr('Ya, keluar')}
				</Button>
			</form>
		</details>
	</section>
{/if}

<style>
	section {
		margin-top: 24px;
	}
	h2 {
		margin: 0 0 4px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.meta {
		margin: 0 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
	.person {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.person .meta {
		margin: 0;
	}
	.title {
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		padding: 0 12px;
		border-radius: var(--r-pill);
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
	.created {
		display: grid;
		gap: 8px;
		margin-bottom: 12px;
	}
	.created label {
		font-weight: 600;
	}
	.link {
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 15px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
