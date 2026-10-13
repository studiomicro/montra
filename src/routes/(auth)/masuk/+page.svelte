<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { isAccountKeySupported } from '#lib/shared/account-key';
	import { msg } from '#lib/shared/i18n';
	import {
		dropDeviceKey,
		holdDeviceKey,
		markOpenFailed,
		openAccountKey,
		type KeyMaterial
	} from '#lib/ui/account-key/device';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Turnstile from '#lib/ui/auth/Turnstile.svelte';
	import {
		assertionFields,
		isCancelled,
		isConditionalMediationAvailable,
		isPasskeySupported,
		postAction,
		toRequestOptions,
		type RequestOptionsJson
	} from '#lib/ui/auth/webauthn';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import { TURNSTILE_SCRIPT_URL } from '#lib/shared/turnstile';

	let { data, form } = $props();
	const { tr } = useI18n();
	let pending = $state(false);
	// The show/hide toggle needs script to switch the input's type: it is drawn once the page is interactive.
	let interactive = $state(false);
	let showPassword = $state(false);
	/** FN-50: bumped after a refused submit so the single-use Turnstile token is replaced without a reload. */
	let turnstileReset = $state(0);

	/**
	 * FN-50 passkeys. With `window.PublicKeyCredential` the "Masuk dengan passkey" button appears under the form;
	 * with conditional mediation one challenge is fetched on mount and offered in the e-mail field's autofill. A
	 * cancelled prompt makes no server call; a server refusal shows its one message. Nothing here is rendered
	 * without JavaScript.
	 */
	let passkeySupported = $state(false);
	let conditional = $state(false);
	let passkeyPending = $state(false);
	let passkeyNotice = $state<string | null>(null);
	let heldOptions: RequestOptionsJson | null = null;
	let conditionalAbort: AbortController | null = null;
	/** The running autofill request, awaited after its abort: a browser refuses a second request while one is pending. */
	let conditionalRun: Promise<void> | null = null;
	const CANCELLED = msg('Dibatalkan. Masuk dengan kata sandi atau coba lagi.');
	const OFFLINE = msg('Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.');
	const FAILED = msg('Masuk dengan passkey gagal. Coba lagi.');

	const next = $derived(page.url.searchParams.get('next'));
	const signUpHref = $derived(next ? `/daftar?next=${encodeURIComponent(next)}` : '/daftar');
	const actionUrl = (name: string) =>
		`/masuk?/${name}${next ? `&next=${encodeURIComponent(next)}` : ''}`;

	async function fetchOptions(): Promise<RequestOptionsJson | null> {
		const result = await postAction(actionUrl('passkeyOptions'), {}).catch(() => null);
		if (!result) {
			passkeyNotice = OFFLINE;
			return null;
		}
		if (result.type === 'failure') {
			passkeyNotice = (result.data as { passkeyError?: string }).passkeyError ?? OFFLINE;
			return null;
		}
		if (result.type !== 'success') return null;
		return (result.data as { passkeyOptions: RequestOptionsJson }).passkeyOptions;
	}

	/** Runs `navigator.credentials.get`, then posts the assertion. `mediation` conditional = the autofill offer. */
	async function signInWithPasskey(mediation: 'conditional' | 'optional') {
		passkeyNotice = null;
		const controller = new AbortController();
		if (mediation === 'conditional') conditionalAbort = controller;
		const options = heldOptions ?? (await fetchOptions());
		// Aborted while the options were on their way (the button took over): the button's request goes ahead.
		if (!options || controller.signal.aborted) return;
		heldOptions = options;
		let credential: Credential | null;
		try {
			credential = await navigator.credentials.get({
				publicKey: toRequestOptions(options),
				mediation,
				signal: controller.signal
			});
		} catch (e) {
			if (mediation === 'conditional' || isCancelled(e)) {
				// An aborted conditional request (the button took over) says nothing; a dismissed prompt does.
				if (mediation === 'optional') passkeyNotice = CANCELLED;
			} else passkeyNotice = FAILED;
			return;
		}
		if (!(credential instanceof PublicKeyCredential)) return;
		passkeyPending = true;
		dropDeviceKey();
		const result = await postAction(actionUrl('passkey'), assertionFields(credential)).catch(
			() => null
		);
		// The challenge is spent either way: the next attempt needs a fresh one.
		heldOptions = null;
		if (result?.type === 'redirect') {
			await goto(result.location, { invalidateAll: true });
			return;
		}
		passkeyPending = false;
		passkeyNotice = !result
			? OFFLINE
			: result.type === 'failure'
				? ((result.data as { passkeyError?: string }).passkeyError ?? OFFLINE)
				: OFFLINE;
	}

	async function onPasskeyButton() {
		conditionalAbort?.abort();
		conditionalAbort = null;
		await conditionalRun;
		conditionalRun = null;
		await signInWithPasskey('optional');
	}

	onMount(() => {
		interactive = true;
		if (!data.passkeyHost || !isPasskeySupported()) return;
		passkeySupported = true;
		isConditionalMediationAvailable().then((available) => {
			conditional = available;
			if (available) conditionalRun = signInWithPasskey('conditional');
		});
		return () => conditionalAbort?.abort();
	});
</script>

<svelte:head>
	<title>{tr('Masuk')}</title>
	{#if data.turnstile}
		<script
			src="{TURNSTILE_SCRIPT_URL}?render=explicit&onload=onloadTurnstileCallback"
			defer
		></script>
	{/if}
</svelte:head>

<!-- FN-40: decorative, wide screens only — at phone width the form stays at the top. -->
<div class="hero-art"><Mascot pose="wave" size={168} /></div>
<h1>{tr('Masuk')}</h1>
<p class="subtitle">{tr('Masuk untuk membuka catatan keuanganmu.')}</p>

<form
	method="POST"
	action={actionUrl('password')}
	class="form"
	use:enhance={async ({ formData }) => {
		pending = true;
		conditionalAbort?.abort();
		dropDeviceKey();
		// FN-21: a device that can open an account key asks for the wrapped key after the password proof and
		// opens it here with the password still in this submission, into memory for this page session only.
		const password = String(formData.get('password') ?? '');
		if (await isAccountKeySupported()) formData.set('withKey', '1');
		return async ({ result, update }) => {
			if (result.type === 'success' && result.data?.signedIn) {
				const { next, accountKey } = result.data as { next: string; accountKey: KeyMaterial };
				const key = await openAccountKey(password, accountKey).catch(() => null);
				if (key) holdDeviceKey(key);
				else markOpenFailed();
				const opened = key !== null;
				// A key that does not open with this password (changed where it could not be re-wrapped) is
				// explained, with the way to re-lock it, on the account page.
				await goto(opened ? next : '/pengaturan/akun', { invalidateAll: true });
				return;
			}
			await update();
			// FN-50: a refused submit spent the Turnstile token; the widget issues a new one.
			if (result.type === 'failure') turnstileReset += 1;
			pending = false;
		};
	}}
>
	<FormBanner message={form?.error ? tr(form.error) : undefined} />
	<Field
		id="email"
		name="email"
		type="email"
		label={tr('E-mail')}
		autocomplete={conditional ? 'username webauthn' : 'email'}
		inputmode="email"
		required
		maxlength={254}
		defaultValue={form?.values?.email ?? ''}
	/>
	<div class="field">
		<label for="password">{tr('Kata sandi')}</label>
		<div class="secret">
			<input
				id="password"
				name="password"
				type={showPassword ? 'text' : 'password'}
				autocomplete="current-password"
				required
			/>
			{#if interactive}
				<button
					type="button"
					class="eye"
					aria-pressed={showPassword}
					aria-label={showPassword ? tr('Sembunyikan sandi') : tr('Tampilkan sandi')}
					onclick={() => (showPassword = !showPassword)}
				>
					<Icon name={showPassword ? 'eye-off' : 'eye'} size={20} />
				</button>
			{/if}
		</div>
	</div>
	{#if data.turnstile}
		<Turnstile siteKey={data.turnstile.siteKey} action="sign-in" resetKey={turnstileReset} />
	{/if}
	<Button type="submit" size="lg" full disabled={pending}>
		{pending ? tr('Memproses…') : tr('Masuk')}
	</Button>
</form>

{#if passkeySupported}
	<div class="passkey" data-testid="passkey-sign-in">
		<Button
			variant="secondary"
			size="lg"
			full
			icon="key"
			disabled={passkeyPending || pending}
			onclick={onPasskeyButton}
		>
			{passkeyPending ? tr('Memproses…') : tr('Masuk dengan passkey')}
		</Button>
		{#if passkeyNotice}<p class="passkey-note" role="alert">{tr(passkeyNotice)}</p>{/if}
	</div>
{/if}

<p class="alt">{tr('Belum punya akun?')} <a href={signUpHref}>{tr('Daftar')}</a></p>

<style>
	.hero-art {
		display: none;
	}
	@media (min-width: 768px) and (min-height: 720px) {
		.hero-art {
			display: flex;
			justify-content: center;
			margin: -8px 0 16px;
		}
	}
	/* § 3a type scale: H1 28 px phone / 34 px desktop, 800, with a 15 px grey subtitle. */
	h1 {
		margin: 0;
		font-size: 28px;
		line-height: 1.1;
		font-weight: 800;
		letter-spacing: -0.03em;
	}
	.subtitle {
		margin: 6px 0 24px;
		font-size: 15px;
		color: var(--muted);
	}
	@media (min-width: 1024px) {
		h1 {
			font-size: 34px;
		}
	}
	.form {
		display: grid;
		gap: 16px;
	}
	/* Same field as auth/Field (48 px, panel fill), with the 44 px eye button inside its right edge. */
	.field {
		display: grid;
		gap: 6px;
	}
	label {
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
	}
	.secret {
		position: relative;
		display: grid;
	}
	input {
		min-height: 48px;
		padding: 0 52px 0 14px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 17px;
	}
	input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 0;
	}
	.eye {
		position: absolute;
		top: 2px;
		right: 2px;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--muted);
	}
	.eye:hover {
		color: var(--ink);
	}
	.eye:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: -2px;
	}
	.passkey {
		display: grid;
		gap: 8px;
		margin-top: 12px;
	}
	.passkey-note {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-up);
		font-size: 15px;
	}
	.alt {
		margin: 24px 0 0;
		color: var(--muted);
		font-size: 15px;
	}
	.alt a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--brand);
		font-weight: 600;
	}
</style>
