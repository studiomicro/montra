<script lang="ts">
	import { enhance } from '$app/forms';
	import { isAccountKeySupported } from '#lib/shared/account-key';
	import { msg } from '#lib/shared/i18n';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import {
		fetchKeyMaterial,
		KeyDerivationTimeout,
		holdDeviceKey,
		rewrapAccountKey,
		setKeyFields,
		type DeviceKey
	} from './device';

	/**
	 * "Ubah kata sandi" on /pengaturan/akun (FN-21 adds it; FN-01 had none). With X25519 the account key is
	 * re-wrapped on this device under the new password (same key pair, so sealed results stay openable) and
	 * sent with the change. Without it, or for a key that already does not open with the current password,
	 * the password changes alone and the answer says the key needs re-locking.
	 */
	let {
		keyState,
		form
	}: {
		keyState: { exists: boolean; stale: boolean };
		form: { passwordError?: string; passwordChanged?: boolean; keyNotice?: string } | null;
	} = $props();
	const { tr } = useI18n();
	let busy = $state(false);
	/** A refusal decided on the device, before the change was sent; server refusals come in `form`. */
	let problem = $state<string | null>(null);
	const error = $derived(problem ?? form?.passwordError);
</script>

<section class="section" aria-labelledby="password-title">
	<h2 id="password-title">{tr('Ubah kata sandi')}</h2>
	{#if form?.passwordChanged}
		<p class="ok" role="status">{tr('Kata sandi diubah.')}</p>
		{#if form.keyNotice}<p class="warn" role="alert">{tr(form.keyNotice)}</p>{/if}
	{/if}
	<form
		method="POST"
		action="?/changePassword"
		class="form"
		use:enhance={async ({ formData, cancel }) => {
			busy = true;
			problem = null;
			let rewrapped: DeviceKey | null = null;
			const current = String(formData.get('password') ?? '');
			const next = String(formData.get('newPassword') ?? '');
			if (
				keyState.exists &&
				!keyState.stale &&
				next === formData.get('confirmPassword') &&
				(await isAccountKeySupported())
			) {
				const stop = (message: string) => {
					problem = message;
					busy = false;
					cancel();
				};
				const got = await fetchKeyMaterial(current);
				if (!got.ok) return stop(got.error ?? msg('E-mail atau kata sandi salah.'));
				if (got.material) {
					try {
						const result = await rewrapAccountKey(got.material, current, next);
						if (result) {
							setKeyFields(formData, result);
							formData.set('keyVersion', String(got.material.version));
							rewrapped = result.key;
						}
					} catch (e) {
						// A slow device is told so and nothing changes; any other failure changes the password
						// alone (the answer then says the key needs re-locking).
						if (e instanceof KeyDerivationTimeout)
							return stop(msg('Kunci akun terlalu lama diproses di perangkat ini. Coba lagi.'));
						rewrapped = null;
					}
				}
			}
			return async ({ result, update }) => {
				if (result.type === 'success' && rewrapped) holdDeviceKey(rewrapped);
				await update();
				busy = false;
			};
		}}
	>
		<FormBanner message={error ? tr(error) : undefined} />
		<Field
			id="change-current-password"
			name="password"
			type="password"
			label={tr('Kata sandi saat ini')}
			autocomplete="current-password"
			required
		/>
		<Field
			id="change-new-password"
			name="newPassword"
			type="password"
			label={tr('Kata sandi baru')}
			autocomplete="new-password"
			required
			minlength={8}
			maxlength={200}
			hint={tr('Minimal 8 karakter.')}
		/>
		<Field
			id="change-confirm-password"
			name="confirmPassword"
			type="password"
			label={tr('Ulangi kata sandi baru')}
			autocomplete="new-password"
			required
		/>
		<Button type="submit" size="lg" full disabled={busy}>
			{busy ? tr('Memproses…') : tr('Ubah kata sandi')}
		</Button>
	</form>
</section>

<style>
	.section {
		margin-top: 32px;
	}
	h2 {
		margin: 0 0 8px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.form {
		display: grid;
		gap: 16px;
		margin-top: 16px;
	}
	.ok,
	.warn {
		margin: 8px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.ok {
		color: var(--money-in);
	}
	.warn {
		color: var(--money-up);
	}
</style>
