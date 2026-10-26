<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import {
		INBOUND_REASON_LABELS,
		INBOUND_STATUS_LABELS,
		INBOUND_TRUST_LABELS
	} from '#lib/shared/inbound/address';
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
	const { tr, trf, locale } = useI18n();

	// Every write is a plain form post (works without JavaScript); with it, the page shows progress and reloads
	// its data from the server. Success is shown only once the server confirmed the write.
	let hydrated = $state(false);
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);
	let copied = $state<'idle' | 'done' | 'failed'>('idle');

	onMount(() => {
		hydrated = true;
	});

	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			copied = 'idle';
			return async ({ result, update }) => {
				if (result.type === 'error')
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else {
					await update();
					if (result.type === 'failure' && (result.status === 404 || result.status === 409))
						await invalidateAll();
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

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = 'done';
		} catch {
			copied = 'failed';
		}
	}

	const doneText: Record<string, string> = {
		created: msg('Alamat penerusan dibuat.'),
		rotated: msg('Alamat diganti. Alamat lama langsung berhenti menerima e-mail.'),
		revoked: msg('Alamat dimatikan. E-mail ke alamat itu ditolak.'),
		moved: msg('Ruang tujuan disimpan.')
	};
	const done = $derived(
		form && 'done' in form && form.done && Object.hasOwn(doneText, form.done)
			? tr(doneText[form.done] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const when = (ms: number) => formatDateTimeWib(ms, locale);
	const spaceLabel = (s: { kind: string; name: string }) =>
		s.kind === 'personal' ? tr('Pribadi') : s.name;
	const personal = $derived(data.spaces.find((s) => s.kind === 'personal') ?? data.spaces[0]);
</script>

<svelte:head><title>{tr('Teruskan e-mail')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/aplikasi', label: tr('Kembali ke Aplikasi terhubung') }}
	title={tr('Teruskan e-mail')}
	subtitle={tr('Catat pembayaran dari e-mail bank dan QRIS')}
/>

<p class="intro">
	{tr(
		'Teruskan e-mail notifikasi bank, QRIS dan dompet digital ke alamat rahasiamu. Pembayaran yang terbaca masuk ke Kotak masuk sebagai draf; tidak ada yang tersimpan sebelum kamu periksa.'
	)}
</p>

{#if done}<p class="ok" role="status">{done}</p>{/if}
<FormBanner message={banner} />

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if !data.configured}
	<section class="notice" aria-labelledby="not-configured-title">
		<h2 id="not-configured-title">{tr('Belum dikonfigurasi')}</h2>
		<p>
			{tr(
				'Domain penerusan e-mail belum disiapkan di server ini, jadi alamat penerusan belum bisa dibuat.'
			)}
		</p>
	</section>
{:else if !data.address}
	<section class="group" aria-labelledby="create-title">
		<h2 id="create-title">{tr('Buat alamat penerusan')}</h2>
		<EmptyState
			text={tr('Belum ada alamat penerusan. Buat satu, lalu atur penerusan di kotak suratmu.')}
		/>
		<form method="POST" action="?/create" class="stack" use:enhance={track('create')}>
			<label class="field">
				<span>{tr('Dicatat ke')}</span>
				<select name="spaceId">
					{#each data.spaces as space (space.id)}
						<option value={space.id} selected={space.id === personal?.id}
							>{spaceLabel(space)}</option
						>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="primary" full disabled={busy !== ''}>
				{busy === 'create' ? tr('Membuat…') : tr('Buat alamat')}
			</Button>
		</form>
	</section>
{:else}
	{@const address = data.address}
	<section class="group" aria-labelledby="address-title">
		<h2 id="address-title">{tr('Alamat penerusanmu')}</h2>
		<GroupList>
			<GroupRow>
				<div class="address">
					<code class="email" id="forward-address">{address.email}</code>
					<span class="meta">
						{address.lastReceivedAt
							? trf('E-mail terakhir {waktu}', { waktu: when(address.lastReceivedAt) })
							: tr('Belum ada e-mail masuk')}
					</span>
					{#if address.spaceName === null}
						<span class="meta bad">
							{tr('Ruang tujuan tidak tersedia lagi; e-mail ditolak. Pilih ruang lain.')}
						</span>
					{/if}
				</div>
			</GroupRow>
		</GroupList>
		{#if hydrated}
			<Button variant="secondary" full onclick={() => copy(address.email)}>
				{tr('Salin alamat')}
			</Button>
			{#if copied === 'done'}<p class="meta" role="status">{tr('Alamat disalin.')}</p>{/if}
			{#if copied === 'failed'}<p class="meta" role="status">
					{tr('Tidak bisa menyalin. Pilih alamat di atas lalu salin manual.')}
				</p>{/if}
		{:else}
			<p class="meta">{tr('Pilih alamat di atas lalu salin.')}</p>
		{/if}
		<p class="meta">
			{tr(
				'Alamat ini rahasia: siapa pun yang tahu bisa mengirim e-mail ke Kotak masukmu. Ganti bila bocor.'
			)}
		</p>

		<form method="POST" action="?/target" class="stack" use:enhance={track('target')}>
			<input type="hidden" name="addressId" value={address.id} />
			<input type="hidden" name="updatedAt" value={address.updatedAt} />
			<label class="field">
				<span>{tr('Dicatat ke')}</span>
				<select name="spaceId">
					{#each data.spaces as space (space.id)}
						<option value={space.id} selected={space.id === address.spaceId}
							>{spaceLabel(space)}</option
						>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="secondary" full disabled={busy !== ''}>
				{busy === 'target' ? tr('Menyimpan…') : tr('Simpan ruang tujuan')}
			</Button>
		</form>

		<div class="stack">
			<details class="confirm">
				<summary>{tr('Putar ulang alamat')}</summary>
				<form method="POST" action="?/rotate" use:enhance={track('rotate')}>
					<input type="hidden" name="addressId" value={address.id} />
					<input type="hidden" name="updatedAt" value={address.updatedAt} />
					<p>
						{tr(
							'Alamat baru dibuat dan alamat lama langsung berhenti. Perbarui penerusan di kotak suratmu.'
						)}
					</p>
					<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
						{busy === 'rotate' ? tr('Memproses…') : tr('Ya, ganti alamat')}
					</Button>
				</form>
			</details>
			<details class="confirm">
				<summary class="danger">{tr('Matikan')}</summary>
				<form method="POST" action="?/revoke" use:enhance={track('revoke')}>
					<input type="hidden" name="addressId" value={address.id} />
					<input type="hidden" name="updatedAt" value={address.updatedAt} />
					<p>{tr('E-mail ke alamat ini akan ditolak. Draf yang sudah masuk tetap ada.')}</p>
					<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
						{busy === 'revoke' ? tr('Memproses…') : tr('Ya, matikan')}
					</Button>
				</form>
			</details>
		</div>
	</section>

	<section class="group" aria-labelledby="howto-title">
		<h2 id="howto-title">{tr('Cara meneruskan')}</h2>
		<ol class="howto">
			<li>
				{tr(
					'Gmail: Setelan › Penerusan dan POP/IMAP › Tambahkan alamat penerusan, lalu tempel alamat di atas.'
				)}
			</li>
			<li>
				{tr(
					'Gmail mengirim kode konfirmasi ke alamat ini; kodenya muncul di bawah. Masukkan kode itu di Gmail.'
				)}
			</li>
			<li>
				{tr(
					'Buat filter untuk pengirim bank, QRIS dan dompet digitalmu dengan tindakan “Teruskan ke” alamat ini.'
				)}
			</li>
			<li>{tr('Kotak surat lain: teruskan e-mail notifikasi secara manual ke alamat ini.')}</li>
		</ol>
	</section>
{/if}

{#if data.configured || data.mail.length > 0}
	<section class="group" aria-labelledby="mail-title">
		<h2 id="mail-title">{tr('E-mail terakhir')}</h2>
		{#if data.mail.length === 0}
			<EmptyState text={tr('Belum ada e-mail yang diterima.')} />
		{:else}
			<GroupList>
				{#each data.mail as mail (mail.id)}
					<GroupRow>
						<div class="mail">
							<span class="line">
								<span class="name">{tr(INBOUND_STATUS_LABELS[mail.status])}</span>
								<span class="meta">{when(mail.receivedAt)}</span>
							</span>
							{#if mail.subject}<span class="meta subject">{mail.subject}</span>{/if}
							{#if mail.trust && mail.status !== 'not_payment'}
								<span class="meta">{tr(INBOUND_TRUST_LABELS[mail.trust])}</span>
							{/if}
							{#if mail.reason}
								<span class="meta">{tr(INBOUND_REASON_LABELS[mail.reason])}</span>
								{#if mail.reason === 'no_ai_key' && !data.hasKey}
									<a class="link" href="/pengaturan/integrasi">{tr('Tambahkan kunci Anthropic')}</a>
								{/if}
							{/if}
							{#if mail.status === 'draft_created'}
								<a class="link" href="/kotak-masuk">{tr('Buka Kotak masuk')}</a>
							{/if}
							{#if mail.confirmationCode}
								<span class="code-row">
									{tr('Kode konfirmasi Gmail')}: <code class="code">{mail.confirmationCode}</code>
								</span>
							{/if}
						</div>
					</GroupRow>
				{/each}
			</GroupList>
		{/if}
	</section>
{/if}

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
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
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
	.stack {
		display: grid;
		gap: 8px;
		margin-top: 8px;
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
	.address,
	.mail {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.email,
	.code {
		font-family: var(--font-mono);
		font-size: 14px;
		overflow-wrap: anywhere;
		user-select: all;
	}
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.subject {
		color: var(--ink);
	}
	.bad {
		color: var(--money-up);
		font-weight: 600;
	}
	.code-row {
		font-size: 14px;
	}
	/* A block row of its own (never inline in a sentence: a 44 px inline box blows up the line height). */
	.link {
		display: flex;
		align-items: center;
		width: fit-content;
		min-height: 44px;
		/* The app's one standalone text link (app.css .text-link): ink, underlined, never blue or bold. */
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.howto {
		display: grid;
		gap: 8px;
		margin: 0;
		padding-left: 20px;
		font-size: 14px;
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
