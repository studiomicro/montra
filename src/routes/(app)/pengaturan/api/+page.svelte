<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { API_SCOPE_LABELS, API_TOKEN_SCOPES } from '#lib/shared/api-tokens';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);
	let copied = $state<'yes' | 'no' | null>(null);

	/** Success is shown only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			copied = null;
			return async ({ result, update }) => {
				if (result.type === 'error')
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else await update({ reset: result.type === 'success' });
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

	async function copy(token: string) {
		try {
			await navigator.clipboard.writeText(token);
			copied = 'yes';
		} catch {
			copied = 'no';
		}
	}

	const created = $derived(form && 'created' in form ? form.created : undefined);
	const revoked = $derived(form && 'done' in form && form.done === 'revoked');
	const values = $derived(form && 'values' in form ? form.values : undefined);
	const serverError = $derived(
		form && 'error' in form && form.error ? trf(form.error, { n: data.maxTokens }) : ''
	);
	const banner = $derived(actionError || serverError || undefined);
	const full = $derived(data.tokens.length >= data.maxTokens);

	const spaceName = (s: { kind: string | null; name: string | null }) =>
		s.kind === 'personal' ? tr('Pribadi') : (s.name ?? tr('Ruang tidak tersedia'));
	const when = (ms: number) => formatDateTimeWib(ms, locale);
</script>

<svelte:head><title>{tr('API')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('API')}
	subtitle={tr('Token untuk skrip dan aplikasimu sendiri')}
>
	{#snippet actions()}
		<Button href="/pengaturan/api/dokumentasi" variant="secondary" size="sm"
			>{tr('Dokumentasi API')}</Button
		>
		<Button href="/api/v1/openapi.json" variant="secondary" size="sm">OpenAPI</Button>
	{/snippet}
</ScreenTitle>

<p class="intro">
	{tr(
		'Token membuka data ruangmu tanpa kata sandi: transaksi, dompet, kategori, anggaran dan Laporan. Simpan token seperti kata sandi dan cabut bila tidak dipakai lagi.'
	)}
</p>
<p class="intro">{tr('Mengganti kata sandi mencabut semua token.')}</p>

{#if created}
	<section class="created" aria-labelledby="created-title">
		<h2 id="created-title">{trf('Token “{nama}” dibuat', { nama: created.name })}</h2>
		<label for="new-token">{tr('Token')}</label>
		<input
			id="new-token"
			class="secret"
			type="text"
			readonly
			value={created.token}
			autocomplete="off"
			spellcheck="false"
		/>
		<p class="meta">
			{tr('Salin sekarang: token ini hanya ditampilkan sekali dan tidak bisa dilihat lagi.')}
			{trf('Berlaku sampai {waktu}.', { waktu: when(created.expiresAt) })}
		</p>
		<Button variant="secondary" onclick={() => copy(created.token)}>{tr('Salin token')}</Button>
		<p class="meta" role="status">
			{#if copied === 'yes'}{tr('Token disalin.')}{:else if copied === 'no'}{tr(
					'Tidak bisa menyalin. Salin token secara manual.'
				)}{/if}
		</p>
	</section>
{/if}

{#if revoked}<p class="ok" role="status">
		{tr('Token dicabut. Permintaan dengan token itu langsung ditolak.')}
	</p>{/if}
<FormBanner message={banner} />

<section class="group" aria-labelledby="tokens-title">
	<div class="heading">
		<h2 id="tokens-title">{tr('Token aktif')}</h2>
		<span class="meta num"
			>{trf('{n} dari {max}', { n: data.tokens.length, max: data.maxTokens })}</span
		>
	</div>
	{#if refreshing}
		<Skeleton rows={3} />
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if data.tokens.length === 0}
		<EmptyState text={tr('Belum ada token')} />
	{:else}
		<GroupList>
			{#each data.tokens as token (token.id)}
				<GroupRow>
					<div class="token">
						<div class="line">
							<span class="name">{token.name}</span>
							<Badge>{tr(API_SCOPE_LABELS[token.scope])}</Badge>
						</div>
						<span class="meta">
							{token.space ? spaceName(token.space) : tr('Semua ruang')} ·
							<span class="num">…{token.lastFour}</span>
						</span>
						<span class="meta">
							{trf('Dibuat {waktu}', { waktu: when(token.createdAt) })} · {trf(
								'Berlaku sampai {waktu}',
								{ waktu: when(token.expiresAt) }
							)}
						</span>
						<span class="meta">
							{token.lastUsedAt
								? trf('Terakhir dipakai {waktu}', { waktu: when(token.lastUsedAt) })
								: tr('Belum pernah dipakai')}
						</span>
						<details class="confirm">
							<summary>{tr('Cabut')}</summary>
							<form method="POST" action="?/revoke" use:enhance={track(`revoke-${token.id}`)}>
								<input type="hidden" name="tokenId" value={token.id} />
								<p>
									{tr('Skrip atau aplikasi yang memakai token ini langsung tidak bisa masuk lagi.')}
								</p>
								<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
									{busy === `revoke-${token.id}` ? tr('Memproses…') : tr('Ya, cabut')}
								</Button>
							</form>
						</details>
					</div>
				</GroupRow>
			{/each}
		</GroupList>
	{/if}
</section>

<section class="group" aria-labelledby="create-title">
	<h2 id="create-title">{tr('Buat token')}</h2>
	<form method="POST" action="?/create" class="create" use:enhance={track('create')}>
		<Field
			id="token-name"
			name="name"
			label={tr('Nama')}
			hint={tr('Untuk mengenali token, misalnya “Skrip laporan”.')}
			maxlength={data.nameMaxLength}
			required
			autocomplete="off"
			value={values?.name ?? ''}
		/>
		<label class="field">
			<span>{tr('Izin')}</span>
			<select name="scope">
				{#each API_TOKEN_SCOPES as scope (scope)}
					<option value={scope} selected={(values?.scope ?? 'read') === scope}
						>{tr(API_SCOPE_LABELS[scope])}</option
					>
				{/each}
			</select>
		</label>
		<label class="field">
			<span>{tr('Ruang')}</span>
			<select name="space">
				<option value="" selected={!values?.space}>{tr('Semua ruang')}</option>
				{#each data.spaces as space (space.id)}
					<option value={space.id} selected={values?.space === space.id}>{spaceName(space)}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			<span>{tr('Masa berlaku')}</span>
			<select name="lifetime">
				{#each data.lifetimes as days (days)}
					<option
						value={String(days)}
						selected={(values?.lifetime ?? String(data.defaultLifetime)) === String(days)}
						>{trf('{n} hari', { n: days })}</option
					>
				{/each}
			</select>
		</label>
		<Field
			id="token-password"
			name="password"
			type="password"
			label={tr('Kata sandi saat ini')}
			hint={tr('Token bisa membuka datamu tanpa sesi, jadi membuatnya butuh kata sandimu.')}
			autocomplete="current-password"
			required
		/>
		{#if full}
			<p class="meta" id="create-full">
				{trf('Sudah ada {n} token aktif, batas terbanyak. Cabut satu token dulu.', {
					n: data.maxTokens
				})}
			</p>
		{/if}
		<Button
			type="submit"
			variant="primary"
			full
			disabled={busy !== '' || full}
			describedby={full ? 'create-full' : undefined}
		>
			{busy === 'create' ? tr('Memproses…') : tr('Buat token')}
		</Button>
	</form>
</section>

<style>
	.intro {
		margin: 4px 0 8px;
		color: var(--muted);
		font-size: 15px;
	}
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	.heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.token {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.name {
		min-width: 0;
		font-size: 15px;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
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
		padding: 0 0 8px;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.created {
		display: grid;
		gap: 8px;
		margin-bottom: 16px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.created h2 {
		overflow-wrap: anywhere;
	}
	.created label {
		font-weight: 600;
	}
	.secret {
		width: 100%;
		min-width: 0;
		min-height: 48px;
		padding: 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--bg);
		color: var(--ink);
		font-family: var(--font-mono);
		font-size: 14px;
	}
	.created .meta {
		margin: 0;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.create {
		display: grid;
		gap: 16px;
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
		font-size: 16px;
		font-weight: 400;
	}
	.create .meta {
		margin: 0;
	}
</style>
