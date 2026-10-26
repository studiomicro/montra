<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { hasProLook } from '#lib/shared/pro-look';
	import AccountKeySection from '#lib/ui/account-key/AccountKeySection.svelte';
	import ChangePasswordSection from '#lib/ui/account-key/ChangePasswordSection.svelte';
	import { announceSignOut } from '#lib/ui/account-key/device';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ProBadge from '#lib/ui/kit/ProBadge.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import { clearOfflineQueue, offlineState } from '#lib/ui/offline-queue/runtime.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();
	let signingOut = $state(false);
	/**
	 * FN-02: sign-out clears this browser's storage (Clear-Site-Data), and with it the offline queue. With changes
	 * still queued the user confirms first; cancelling keeps the session and the queue as they are.
	 */
	const queuedCount = $derived(offlineState.queue?.items.length ?? 0);
	let askLeave = $state(false);
	let leaveConfirmed = false;
	let signOutForm: HTMLFormElement | undefined = $state();
	let signOutButton: HTMLDivElement | undefined = $state();

	function focusOnShow(node: HTMLElement) {
		node.focus();
	}

	function leaveAnyway() {
		leaveConfirmed = true;
		askLeave = false;
		signOutForm?.requestSubmit();
	}

	function stay() {
		askLeave = false;
		signOutButton?.querySelector('button')?.focus();
	}
	let deleting = $state(false);
	/** Narrowed views of the action answers for the two FN-21 sections. */
	const keyForm = $derived(
		form && ('keyError' in form || 'keyActivated' in form || 'keyRewrapped' in form)
			? (form as { keyError?: string; keyActivated?: boolean; keyRewrapped?: boolean })
			: null
	);
	const passwordForm = $derived(
		form && ('passwordError' in form || 'passwordChanged' in form)
			? (form as { passwordError?: string; passwordChanged?: boolean; keyNotice?: string })
			: null
	);
</script>

<svelte:head><title>{tr('Akun')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Akun')}
/>

<dl class="group">
	<div class="row">
		<dt>{tr('Nama')}</dt>
		<dd class="name">
			<span>{data.account.name}</span>
			{#if hasProLook(data.shell.plan)}<ProBadge />{/if}
		</dd>
	</div>
	<div class="row">
		<dt>{tr('E-mail')}</dt>
		<dd>{data.account.email}</dd>
	</div>
	<div class="row">
		<dt>{tr('Akun dibuat pada')}</dt>
		<dd>{formatDateTimeWib(data.account.createdAt, locale)}</dd>
	</div>
</dl>

<!-- FN-50: passkeys live on their own page; the row keeps the account page short. -->
<section class="section" aria-labelledby="passkey-title">
	<h2 id="passkey-title">{tr('Passkey')}</h2>
	<p class="note">{tr('Masuk tanpa kata sandi dengan sidik jari, wajah atau PIN perangkat.')}</p>
	<p class="link">
		<a class="text-link" href="/pengaturan/akun/passkey">{tr('Kelola passkey')}</a>
	</p>
</section>

<AccountKeySection keyState={data.accountKey} form={keyForm} />
<ChangePasswordSection keyState={data.accountKey} form={passwordForm} />

<form
	method="POST"
	action="?/signOut"
	class="section"
	bind:this={signOutForm}
	use:enhance={({ cancel }) => {
		if (queuedCount > 0 && !leaveConfirmed) {
			cancel();
			askLeave = true;
			return;
		}
		leaveConfirmed = false;
		signingOut = true;
		return async ({ result, update }) => {
			// A full page load, not a client-side navigation: nothing of this signed-in document (its
			// hydration data included) stays in the tab for the next person on a shared device (FN-13).
			if (result.type === 'redirect') {
				// Signed out (server-confirmed): the queue goes too, as Clear-Site-Data also removes it.
				await clearOfflineQueue();
				// The opened account key leaves with the session (FN-21); the full load drops it as well.
				announceSignOut();
				location.assign(result.location);
				return;
			}
			await update();
			signingOut = false;
		};
	}}
>
	<h2 id="session-title">{tr('Sesi')}</h2>
	<div bind:this={signOutButton}>
		<Button type="submit" variant="secondary" size="lg" full disabled={signingOut || askLeave}>
			{signingOut ? tr('Memproses…') : tr('Keluar dari akun')}
		</Button>
	</div>
	{#if askLeave}
		<div class="leave" role="alertdialog" aria-labelledby="leave-text">
			<p id="leave-text" tabindex="-1" use:focusOnShow>
				{trf('{n} perubahan belum tersinkron. Keluar tetap akan membuangnya dari perangkat ini.', {
					n: queuedCount
				})}
			</p>
			<div class="leave-actions">
				<Button variant="destructive" onclick={leaveAnyway}>{tr('Tetap keluar')}</Button>
				<Button variant="secondary" onclick={stay}>{tr('Batal')}</Button>
			</div>
		</div>
	{/if}
	<p class="note">{tr('Hanya perangkat ini yang keluar.')}</p>
</form>

<section class="section danger" aria-labelledby="delete-title">
	<h2 id="delete-title">{tr('Hapus akun')}</h2>
	<p class="note">
		{tr(
			'Akun, ruang pribadi dan semua sesi masuk dihapus permanen dari server. Tindakan ini tidak bisa dibatalkan.'
		)}
	</p>
	<form
		method="POST"
		action="?/deleteAccount"
		class="form"
		use:enhance={() => {
			deleting = true;
			return async ({ result, update }) => {
				// Account deletion needs no queue confirmation: the account's data is removed regardless.
				if (result.type === 'redirect') {
					await clearOfflineQueue();
					announceSignOut();
				}
				await update();
				deleting = false;
			};
		}}
	>
		<FormBanner message={form?.deleteError ? tr(form.deleteError) : undefined} />
		<Field
			id="delete-password"
			name="password"
			type="password"
			label={tr('Kata sandi saat ini')}
			autocomplete="current-password"
			required
		/>
		<label class="check">
			<input type="checkbox" name="confirm" required />
			<span>{tr('Saya mengerti akun saya dihapus permanen.')}</span>
		</label>
		<Button type="submit" variant="destructive" size="lg" full disabled={deleting}>
			{deleting ? tr('Memproses…') : tr('Hapus akun permanen')}
		</Button>
	</form>
</section>

<style>
	.group {
		margin: 16px 0 0;
		border-radius: var(--r-group);
		background: var(--panel);
		overflow: hidden;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 16px;
		padding: 14px 16px;
	}
	.row + .row {
		border-top: 1px solid var(--line);
	}
	dt {
		color: var(--muted);
	}
	dd {
		margin: 0;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.section {
		margin-top: 40px;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.note {
		margin: 8px 0 0;
		font-size: 15px;
		color: var(--muted);
	}
	.link {
		margin: 0;
	}
	.leave {
		display: grid;
		gap: 12px;
		margin-top: 12px;
		padding: 14px 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.leave p {
		margin: 0;
		color: var(--ink);
		font-size: 15px;
	}
	.leave p:focus {
		outline: none;
	}
	.leave-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.form {
		display: grid;
		gap: 16px;
		margin-top: 16px;
	}
	.check {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		min-height: 44px;
		cursor: pointer;
		color: var(--ink-2);
		font-size: 15px;
	}
	.check input {
		flex: none;
		width: 22px;
		height: 22px;
		margin: 2px 0 0;
		accent-color: var(--ink);
	}
</style>
