<script lang="ts">
	import { decodeSealed, encodeSealed, sealToPublicKey, unseal } from '#lib/shared/account-key';
	import { base64urlDecode, base64urlEncode } from '#lib/shared/base64url';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import TextInput from '#lib/ui/kit/TextInput.svelte';
	import { deviceKey } from './device';

	/**
	 * Dev-only round trip of the account key (FN-21; /dev/ui is absent unless dev routes are on): seals text to
	 * the signed-in user's own public key and opens it with the key this page session holds. No producer
	 * stores sealed results yet (FN-15/16 will).
	 */
	let { publicKey }: { publicKey: string | null } = $props();
	const { tr } = useI18n();
	let text = $state('');
	let sealed = $state('');
	let opened = $state<string | null>(null);
	let problem = $state<string | null>(null);
	/** FN-50: the key is not open in this page session (e.g. after a passkey sign-in): link to where it opens. */
	let keyClosed = $state(false);

	async function seal() {
		problem = null;
		opened = null;
		const recipient = publicKey ? base64urlDecode(publicKey) : null;
		if (!recipient) {
			problem = tr('Kunci akun belum aktif.');
			return;
		}
		const blob = await sealToPublicKey(new TextEncoder().encode(text), recipient);
		sealed = base64urlEncode(encodeSealed(blob));
	}

	async function open() {
		problem = null;
		keyClosed = false;
		opened = null;
		const key = deviceKey();
		const recipient = publicKey ? base64urlDecode(publicKey) : null;
		const bytes = base64urlDecode(sealed);
		if (!key || !recipient || key.publicKey !== publicKey) {
			problem = tr('Kunci akun belum dibuka di sesi ini. Buka dengan kata sandi di halaman Akun.');
			keyClosed = true;
			return;
		}
		try {
			if (!bytes) throw new Error('not base64url');
			opened = new TextDecoder().decode(
				await unseal(decodeSealed(bytes), key.privateKey, recipient)
			);
		} catch {
			problem = tr('Hasil terkunci tidak bisa dibuka.');
		}
	}
</script>

<section aria-labelledby="seal-demo-title">
	<h2 id="seal-demo-title">Account key · seal / unseal</h2>
	<TextInput label="Plaintext" bind:value={text} />
	<div class="row">
		<Button onclick={seal}>Seal</Button>
		<Button variant="secondary" onclick={open} disabled={!sealed}>Unseal</Button>
	</div>
	{#if sealed}<p class="mono" data-testid="sealed">{sealed}</p>{/if}
	{#if opened !== null}<p class="ok" role="status" data-testid="unsealed">{opened}</p>{/if}
	{#if problem}<p class="error" role="alert">{problem}</p>{/if}
	{#if keyClosed}<a href="/pengaturan/akun" data-testid="open-key-link">{tr('Buka kunci akun')}</a
		>{/if}
</section>

<style>
	section {
		display: grid;
		gap: 12px;
		padding: 16px 0;
		border-bottom: 1px solid var(--line);
	}
	h2 {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	.mono {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 12px;
		overflow-wrap: anywhere;
		color: var(--muted);
	}
	.ok {
		margin: 0;
		color: var(--money-in);
	}
	.error {
		margin: 0;
		color: var(--money-up);
	}
</style>
