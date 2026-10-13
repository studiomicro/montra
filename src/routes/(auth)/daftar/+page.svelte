<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import { isAccountKeySupported } from '#lib/shared/account-key';
	import {
		createAccountKey,
		dropDeviceKey,
		holdDeviceKey,
		setKeyFields,
		type DeviceKey
	} from '#lib/ui/account-key/device';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Turnstile from '#lib/ui/auth/Turnstile.svelte';
	import { TURNSTILE_SCRIPT_URL } from '#lib/shared/turnstile';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();
	let pending = $state(false);
	/** FN-50: bumped after a refused submit so the single-use Turnstile token is replaced without a reload. */
	let turnstileReset = $state(0);
	const errors = $derived<Record<string, string | undefined>>(form?.errors ?? {});
	const err = (key: string) => (errors[key] ? tr(errors[key]) : undefined);
	const next = $derived(page.url.searchParams.get('next'));
	const signInHref = $derived(next ? `/masuk?next=${encodeURIComponent(next)}` : '/masuk');
</script>

<svelte:head>
	<title>{tr('Daftar')}</title>
	{#if data.turnstile}
		<script
			src="{TURNSTILE_SCRIPT_URL}?render=explicit&onload=onloadTurnstileCallback"
			defer
		></script>
	{/if}
</svelte:head>

<!-- FN-40: decorative, wide screens only — at phone width the form stays at the top. -->
<div class="hero-art"><Mascot pose="wave" size={168} /></div>
<h1>{tr('Buat akun')}</h1>
<p class="subtitle">
	{tr('Satu akun untuk mencatat, berbagi ruang dan membuka di perangkat lain.')}
</p>

<form
	method="POST"
	class="form"
	use:enhance={async ({ formData }) => {
		pending = true;
		// FN-21: on a device with X25519 the account key is made and wrapped here, from the password still in
		// this submission; only the public key and the wrapped key are sent. Otherwise (or if it fails) the
		// account is created without a key, and results are then not stored at all.
		const created = (await isAccountKeySupported())
			? await createAccountKey(String(formData.get('password') ?? '')).catch(() => null)
			: null;
		if (created) setKeyFields(formData, created);
		const made: DeviceKey | null = created?.key ?? null;
		return async ({ result, update }) => {
			// Held only once the server confirmed the account (and the key with it) was written.
			if (result.type === 'redirect') holdDeviceKey(made);
			else dropDeviceKey();
			await update();
			// FN-50: a refused submit spent the Turnstile token; the widget issues a new one.
			if (result.type === 'failure') turnstileReset += 1;
			pending = false;
		};
	}}
>
	<FormBanner message={form?.error ? tr(form.error) : undefined} />
	<Field
		id="name"
		name="name"
		label={tr('Nama')}
		autocomplete="name"
		required
		maxlength={80}
		defaultValue={form?.values?.name ?? ''}
		error={err('name')}
	/>
	<Field
		id="email"
		name="email"
		type="email"
		label={tr('E-mail')}
		autocomplete="email"
		inputmode="email"
		required
		maxlength={254}
		defaultValue={form?.values?.email ?? ''}
		error={err('email')}
	/>
	<Field
		id="password"
		name="password"
		type="password"
		label={tr('Kata sandi')}
		autocomplete="new-password"
		required
		minlength={8}
		maxlength={200}
		hint={tr('Minimal 8 karakter.')}
		error={err('password')}
	/>
	<div class="check">
		<label>
			<input
				type="checkbox"
				name="adult"
				required
				defaultChecked={form?.values?.adult ?? false}
				aria-invalid={errors.adult ? 'true' : undefined}
				aria-describedby={errors.adult ? 'adult-error' : undefined}
			/>
			<span>{tr('Saya berusia 18 tahun ke atas, atau sudah mendapat izin wali.')}</span>
		</label>
		{#if errors.adult}<p id="adult-error" class="error">{err('adult')}</p>{/if}
	</div>
	<div class="check">
		<label>
			<input
				type="checkbox"
				name="consent"
				required
				defaultChecked={form?.values?.consent ?? false}
				aria-invalid={errors.consent ? 'true' : undefined}
				aria-describedby={errors.consent ? 'consent-error' : 'consent-note'}
			/>
			<span
				>{tr(
					'Saya menyetujui Ketentuan layanan dan Kebijakan privasi, termasuk pemrosesan data di luar Indonesia.'
				)}</span
			>
		</label>
		<div id="consent-note" class="note">
			{#if data.siteOrigin}
				<span class="links">
					<a href="{data.siteOrigin}/ketentuan">{tr('Ketentuan layanan')}</a>
					<a href="{data.siteOrigin}/privasi">{tr('Kebijakan privasi')}</a>
				</span>
			{/if}
			<p>{tr('Draf, menunggu tinjauan hukum.')}</p>
		</div>
		{#if errors.consent}<p id="consent-error" class="error">{err('consent')}</p>{/if}
	</div>
	{#if data.turnstile}
		<Turnstile siteKey={data.turnstile.siteKey} action="sign-up" resetKey={turnstileReset} />
	{/if}
	<Button type="submit" size="lg" full disabled={pending}>
		{pending ? tr('Memproses…') : tr('Daftar')}
	</Button>
</form>

<p class="alt">{tr('Sudah punya akun?')} <a href={signInHref}>{tr('Masuk')}</a></p>

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
	.check label {
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
	/* Under the checkbox label (22 px box + 12 px gap in). Links keep a 44 px row; the draft note sits tight under. */
	.note {
		margin: 0 0 0 34px;
		font-size: 13px;
		line-height: 1.35;
		color: var(--muted);
	}
	.note p {
		margin: 0;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		column-gap: 16px;
	}
	.note a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--brand);
	}
	.error {
		margin: 6px 0 0;
		font-size: 13px;
		color: var(--money-up);
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
