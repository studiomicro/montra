<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { isAccountKeySupported } from '#lib/shared/account-key';
	import { msg } from '#lib/shared/i18n';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import {
		createAccountKey,
		deviceKey,
		deviceKeyOpenFailed,
		fetchKeyMaterial,
		holdDeviceKey,
		KeyDerivationTimeout,
		openAccountKey,
		rewrapAccountKey,
		setKeyFields
	} from './device';

	/**
	 * The account key on /pengaturan/akun (FN-21): "Kunci dengan akunku" for an account without a key (absent,
	 * not disabled, once one exists); the re-lock form for a key wrapped under an earlier password; otherwise
	 * what the key does. Key work happens on this device; only the public key and the wrapped key are sent.
	 */
	let {
		keyState,
		form
	}: {
		keyState: { exists: boolean; stale: boolean };
		form: { keyError?: string; keyActivated?: boolean; keyRewrapped?: boolean } | null;
	} = $props();
	const { tr } = useI18n();
	let busy = $state(false);
	/** A refusal decided on the device, before anything was sent; server refusals come in `form`. */
	let problem = $state<string | null>(null);
	/** The earlier password a stale key opens with: read here, never sent (the input has no name). */
	let previousPassword = $state('');
	let openFailed = $state(false);
	/**
	 * FN-50: whether this page session holds the opened key. After a passkey sign-in (no password), or a reload,
	 * it does not; "Buka kunci dengan kata sandi" below re-proves the password through the existing `keyMaterial`
	 * action and opens the key on this device, exactly as a password sign-in does.
	 */
	let held = $state(true);
	let unlockPassword = $state('');
	let unlocked = $state(false);
	onMount(() => {
		openFailed = deviceKeyOpenFailed();
		held = deviceKey() !== null;
	});

	async function unlock(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		problem = null;
		const password = unlockPassword;
		try {
			const got = await fetchKeyMaterial(password);
			if (!got.ok) return refuse(got.error ?? msg('E-mail atau kata sandi salah.'), () => {});
			if (!got.material) return refuse(UNSUPPORTED, () => {});
			const key = await openAccountKey(password, got.material);
			if (!key) return refuse(msg('Kunci akun tidak bisa dibuka dengan kata sandi ini.'), () => {});
			holdDeviceKey(key);
			held = true;
			openFailed = false;
			unlocked = true;
			unlockPassword = '';
		} catch (e) {
			refuse(failureOf(e), () => {});
		} finally {
			busy = false;
		}
	}

	const UNSUPPORTED = msg(
		'Browser ini belum bisa membuat kunci akun. Gunakan browser terbaru dengan JavaScript aktif.'
	);
	const TIMEOUT = msg('Kunci akun terlalu lama diproses di perangkat ini. Coba lagi.');
	const error = $derived(problem ?? form?.keyError);

	/** The refusal for a key operation that threw: a timeout says so, anything else is "unsupported". */
	const failureOf = (e: unknown) => (e instanceof KeyDerivationTimeout ? TIMEOUT : UNSUPPORTED);

	function refuse(message: string, cancel: () => void) {
		problem = message;
		busy = false;
		cancel();
	}
</script>

{#snippet unlockForm()}
	<form class="form" onsubmit={unlock} data-testid="unlock-key">
		<FormBanner message={error ? tr(error) : undefined} />
		<!-- No name: the password is read here, sent only to the keyMaterial action, never with this form. -->
		<Field
			id="unlock-password"
			type="password"
			label={tr('Kata sandi saat ini')}
			autocomplete="current-password"
			required
			value={unlockPassword}
			oninput={(e) => (unlockPassword = e.currentTarget.value)}
		/>
		<Button type="submit" size="lg" full disabled={busy}>
			{busy ? tr('Memproses…') : tr('Buka kunci dengan kata sandi')}
		</Button>
	</form>
{/snippet}

<section class="section" aria-labelledby="key-title">
	<h2 id="key-title">{tr('Kunci akun')}</h2>
	{#if form?.keyActivated}
		<p class="ok" role="status">{tr('Kunci akun diaktifkan.')}</p>
	{:else if form?.keyRewrapped}
		<p class="ok" role="status">{tr('Kunci akun dikunci ulang.')}</p>
	{/if}
	{#if !keyState.exists}
		<p class="note">
			{tr(
				'Kunci akun belum aktif. Tanpa kunci, hasil baca struk dan mutasi tidak disimpan sama sekali.'
			)}
		</p>
		<form
			method="POST"
			action="?/activateAccountKey"
			class="form"
			use:enhance={async ({ formData, cancel }) => {
				busy = true;
				problem = null;
				if (!(await isAccountKeySupported())) return refuse(UNSUPPORTED, cancel);
				let made: Awaited<ReturnType<typeof createAccountKey>>;
				try {
					made = await createAccountKey(String(formData.get('password') ?? ''));
				} catch (e) {
					return refuse(failureOf(e), cancel);
				}
				setKeyFields(formData, made);
				const key = made.key;
				return async ({ result, update }) => {
					// Held only once the server confirmed the key row was written.
					if (result.type === 'success') holdDeviceKey(key);
					await update();
					busy = false;
				};
			}}
		>
			<FormBanner message={error ? tr(error) : undefined} />
			<Field
				id="activate-password"
				name="password"
				type="password"
				label={tr('Kata sandi saat ini')}
				autocomplete="current-password"
				required
			/>
			<Button type="submit" size="lg" full disabled={busy}>
				{busy ? tr('Memproses…') : tr('Kunci dengan akunku')}
			</Button>
		</form>
	{:else if keyState.stale || openFailed}
		<p class="warn" role="alert">
			{tr('Kunci akun tidak bisa dibuka dengan kata sandi barumu. Kunci ulang di bawah ini.')}
		</p>
		{#if keyState.stale}
			<form
				method="POST"
				action="?/rewrapAccountKey"
				class="form"
				use:enhance={async ({ formData, cancel }) => {
					busy = true;
					problem = null;
					if (!(await isAccountKeySupported())) return refuse(UNSUPPORTED, cancel);
					const current = String(formData.get('password') ?? '');
					const got = await fetchKeyMaterial(current);
					if (!got.ok) return refuse(got.error ?? msg('E-mail atau kata sandi salah.'), cancel);
					if (!got.material) return refuse(UNSUPPORTED, cancel);
					let rewrapped: Awaited<ReturnType<typeof rewrapAccountKey>>;
					try {
						rewrapped = await rewrapAccountKey(got.material, previousPassword, current);
					} catch (e) {
						return refuse(failureOf(e), cancel);
					}
					if (!rewrapped) return refuse(msg('Kata sandi sebelumnya salah.'), cancel);
					setKeyFields(formData, rewrapped);
					formData.set('keyVersion', String(got.material.version));
					const key = rewrapped.key;
					return async ({ result, update }) => {
						if (result.type === 'success') {
							holdDeviceKey(key);
							openFailed = false;
							previousPassword = '';
						}
						await update();
						busy = false;
					};
				}}
			>
				<FormBanner message={error ? tr(error) : undefined} />
				<!-- No name: the earlier password is read here and never sent. -->
				<Field
					id="previous-password"
					type="password"
					label={tr('Kata sandi sebelumnya')}
					autocomplete="off"
					required
					value={previousPassword}
					oninput={(e) => (previousPassword = e.currentTarget.value)}
				/>
				<Field
					id="rewrap-password"
					name="password"
					type="password"
					label={tr('Kata sandi saat ini')}
					autocomplete="current-password"
					required
				/>
				<Button type="submit" size="lg" full disabled={busy}>
					{busy ? tr('Memproses…') : tr('Kunci ulang')}
				</Button>
			</form>
		{:else}
			{@render unlockForm()}
		{/if}
	{:else}
		{#if unlocked}
			<p class="ok" role="status">{tr('Kunci akun dibuka di perangkat ini.')}</p>
		{:else if !held}
			<p class="note">
				{tr(
					'Kunci akun belum dibuka di sesi ini (masuk tanpa kata sandi atau halaman dimuat ulang).'
				)}
			</p>
			{@render unlockForm()}
		{/if}
		<p class="note">
			{tr(
				'Kunci akun aktif. Hasil baca struk dan mutasi disimpan terkunci dan hanya terbuka di perangkat tempat kamu masuk dengan kata sandimu.'
			)}
		</p>
		<p class="note">
			{tr(
				'Lupa kata sandi berarti hasil yang terkunci tidak bisa dibuka lagi: mengatur ulang kata sandi tanpa kata sandi lama tidak memulihkannya.'
			)}
		</p>
	{/if}
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
	.note {
		margin: 8px 0 0;
		font-size: 15px;
		color: var(--muted);
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
