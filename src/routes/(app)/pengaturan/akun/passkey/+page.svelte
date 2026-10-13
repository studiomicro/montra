<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { msg } from '#lib/shared/i18n';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import {
		isCancelled,
		isPasskeySupported,
		postAction,
		registrationFields,
		toCreationOptions,
		type CreationOptionsJson
	} from '#lib/ui/auth/webauthn';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-50 passkey management: the list (name, host, created, last used, synced), the register sheet (current
	 * password + optional name → the browser's passkey prompt → the row written), and per-row removal (current
	 * password). Success is shown only once the server confirmed the write; the list is then reloaded.
	 */
	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	let supported = $state(true);
	let sheetOpen = $state(false);
	let busy = $state('');
	let notice = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let refreshing = $state(false);
	let addButton: HTMLDivElement | undefined = $state();
	let nameInput = $state('');

	const CANCELLED = msg('Dibatalkan. Passkey tidak ditambahkan.');
	const OFFLINE = msg('Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.');
	const FAILED = msg('Pendaftaran passkey gagal. Coba lagi.');
	/** The browser's answer when this authenticator already holds one of the listed passkeys (`excludeCredentials`). */
	const ALREADY = msg('Perangkat ini sudah menyimpan passkey untuk akun ini.');

	onMount(() => {
		supported = isPasskeySupported();
	});

	const full = $derived(data.passkeys.length >= data.maxPasskeys);
	const serverError = $derived(
		form && 'error' in form && form.error ? trf(form.error, { n: data.maxPasskeys }) : ''
	);
	const when = (ms: number) => formatDateTimeWib(ms, locale);

	async function closeSheet() {
		sheetOpen = false;
		await tick();
		addButton?.querySelector('button')?.focus();
	}

	/**
	 * The register sheet's submit: the password goes to `registerOptions`; with its options the browser makes the
	 * credential; the result goes to `register`. A dismissed prompt makes no second call.
	 */
	const register: SubmitFunction = () => {
		busy = 'register';
		notice = null;
		return async ({ result, update }) => {
			if (result.type !== 'success') {
				await update({ reset: false });
				busy = '';
				return;
			}
			const options = (result.data as { options: CreationOptionsJson }).options;
			let credential: Credential | null;
			try {
				credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) });
			} catch (e) {
				const already = e instanceof DOMException && e.name === 'InvalidStateError';
				notice = { kind: 'error', text: already ? ALREADY : isCancelled(e) ? CANCELLED : FAILED };
				busy = '';
				return;
			}
			if (!(credential instanceof PublicKeyCredential)) {
				notice = { kind: 'error', text: FAILED };
				busy = '';
				return;
			}
			const posted = await postAction('/pengaturan/akun/passkey?/register', {
				...registrationFields(credential),
				name: nameInput
			}).catch(() => null);
			if (posted?.type === 'success') {
				notice = { kind: 'ok', text: msg('Passkey ditambahkan.') };
				nameInput = '';
				await invalidateAll();
				await closeSheet();
			} else {
				notice = {
					kind: 'error',
					text:
						posted?.type === 'failure'
							? ((posted.data as { error?: string }).error ?? FAILED)
							: OFFLINE
				};
			}
			busy = '';
		};
	};

	const remove =
		(id: string): SubmitFunction =>
		() => {
			busy = `remove-${id}`;
			notice = null;
			return async ({ result, update }) => {
				if (result.type === 'success') {
					notice = {
						kind: 'ok',
						text: msg('Passkey dihapus. Sesi yang dibuat dengannya ditutup.')
					};
					await invalidateAll();
				} else await update({ reset: false });
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
</script>

<svelte:head><title>{tr('Passkey')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/akun', label: tr('Kembali ke Akun') }}
	title={tr('Passkey')}
	subtitle={tr('Masuk dengan sidik jari, wajah atau PIN perangkat')}
/>

<p class="intro">
	{tr(
		'Passkey tersimpan di perangkat atau pengelola sandimu dan tidak bisa dipancing. Kata sandimu tetap ada: ia membuka kunci akun dan tindakan penting lainnya.'
	)}
</p>

{#if notice}
	<p class={notice.kind} role={notice.kind === 'ok' ? 'status' : 'alert'}>{tr(notice.text)}</p>
{/if}
{#if !notice && serverError}<FormBanner message={serverError} />{/if}
<noscript
	><p class="error">
		{tr('Passkey membutuhkan JavaScript. Aktifkan JavaScript lalu muat ulang.')}
	</p></noscript
>

<section class="group" aria-labelledby="passkeys-title">
	<div class="heading">
		<h2 id="passkeys-title">{tr('Passkey terdaftar')}</h2>
		<span class="meta num"
			>{trf('{n} dari {max}', { n: data.passkeys.length, max: data.maxPasskeys })}</span
		>
	</div>
	{#if refreshing}
		<Skeleton rows={3} />
	{:else if data.loadError}
		<ErrorState text={tr(data.loadError)} onretry={retry} />
	{:else if data.passkeys.length === 0}
		<EmptyState text={tr('Belum ada passkey')} />
	{:else}
		<GroupList>
			{#each data.passkeys as passkey (passkey.id)}
				<GroupRow>
					<div class="passkey">
						<div class="line">
							<span class="name">{passkey.name}</span>
							{#if passkey.backedUp}<Badge>{tr('Tersinkron')}</Badge>{/if}
						</div>
						<span class="meta">
							{passkey.rpId}{#if passkey.transports.length}
								· {passkey.transports.join(', ')}{/if}
						</span>
						<span class="meta">{trf('Dibuat {waktu}', { waktu: when(passkey.createdAt) })}</span>
						<span class="meta">
							{passkey.lastUsedAt
								? trf('Terakhir dipakai {waktu}', { waktu: when(passkey.lastUsedAt) })
								: tr('Belum pernah dipakai')}
						</span>
						<details class="confirm">
							<summary>{tr('Hapus')}</summary>
							<form method="POST" action="?/remove" class="remove" use:enhance={remove(passkey.id)}>
								<input type="hidden" name="passkeyId" value={passkey.id} />
								<p>
									{tr(
										'Perangkat yang masuk dengan passkey ini akan keluar. Perangkat ini tetap masuk.'
									)}
								</p>
								<Field
									id="remove-password-{passkey.id}"
									name="password"
									type="password"
									label={tr('Kata sandi saat ini')}
									autocomplete="current-password"
									required
								/>
								<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
									{busy === `remove-${passkey.id}` ? tr('Memproses…') : tr('Ya, hapus')}
								</Button>
							</form>
						</details>
					</div>
				</GroupRow>
			{/each}
		</GroupList>
	{/if}
</section>

<section class="group" aria-labelledby="add-title">
	<h2 id="add-title">{tr('Tambah passkey')}</h2>
	{#if !data.hostOk}
		<p class="meta">{tr('Passkey tidak tersedia di alamat ini.')}</p>
	{:else if !supported}
		<p class="meta" data-testid="passkey-unsupported">
			{tr('Browser ini belum mendukung passkey.')}
		</p>
	{:else if full}
		<p class="meta" id="add-full">
			{trf('Batas {n} passkey tercapai. Hapus satu dulu.', { n: data.maxPasskeys })}
		</p>
	{:else if !sheetOpen}
		<div bind:this={addButton}>
			<Button variant="primary" size="lg" full icon="key" onclick={() => (sheetOpen = true)}>
				{tr('Tambah passkey')}
			</Button>
		</div>
	{:else}
		<form
			method="POST"
			action="?/registerOptions"
			class="create"
			aria-labelledby="add-title"
			use:enhance={register}
		>
			<Field
				id="passkey-name"
				name="name"
				label={tr('Nama (opsional)')}
				hint={tr('Misalnya “iPhone Budi”. Kosongkan untuk nama otomatis.')}
				maxlength={data.nameMaxLength}
				autocomplete="off"
				value={nameInput}
				oninput={(e) => (nameInput = e.currentTarget.value)}
			/>
			<Field
				id="passkey-password"
				name="password"
				type="password"
				label={tr('Kata sandi saat ini')}
				hint={tr('Passkey bisa membuka akunmu, jadi menambahkannya butuh kata sandimu.')}
				autocomplete="current-password"
				required
			/>
			<div class="actions">
				<Button type="submit" variant="primary" size="lg" disabled={busy !== ''}>
					{busy === 'register' ? tr('Menunggu perangkat…') : tr('Buat passkey')}
				</Button>
				<Button variant="secondary" size="lg" disabled={busy !== ''} onclick={closeSheet}>
					{tr('Batal')}
				</Button>
			</div>
		</form>
	{/if}
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
	.passkey {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	/* A 40-character name truncates with an ellipsis instead of pushing the row wider than 360 px. */
	.name {
		min-width: 0;
		overflow: hidden;
		font-size: 15px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
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
	.remove {
		display: grid;
		gap: 12px;
		padding: 0 0 8px;
	}
	.remove p {
		margin: 0;
		font-size: 14px;
	}
	.ok,
	.error {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		font-size: 15px;
	}
	.ok {
		color: var(--money-in);
	}
	.error {
		color: var(--money-up);
	}
	.create {
		display: grid;
		gap: 16px;
	}
	.actions {
		display: grid;
		gap: 8px;
	}
	.group .meta {
		margin: 0;
	}
</style>
