<script lang="ts">
	/**
	 * "Versi baru tersedia — Muat ulang" (FN-42): shown once a newer build finished installing and waits. The
	 * person applies it ("Muat ulang sekarang") or hides it for this page load (`ondismiss`, optional: the
	 * Tentang page shows it without the close button). Announced as a status; every button is 44 px.
	 */
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import { applyUpdate, pwaUpdate } from './update.svelte';

	let { ondismiss }: { ondismiss?: () => void } = $props();
	const { tr } = useI18n();
</script>

<aside class="update" role="status" aria-labelledby="update-title">
	<div class="body">
		<p class="title" id="update-title">{tr('Versi baru tersedia — Muat ulang')}</p>
		<p class="text">
			{tr('Catatan yang belum terkirim tetap aman dan dikirim setelah dimuat ulang.')}
		</p>
		<div class="action">
			<Button size="md" disabled={pwaUpdate.applying} onclick={applyUpdate}>
				{pwaUpdate.applying ? tr('Memuat ulang…') : tr('Muat ulang sekarang')}
			</Button>
		</div>
	</div>
	{#if ondismiss}
		<button type="button" class="close" aria-label={tr('Sembunyikan')} onclick={ondismiss}>
			<Icon name="close" size={20} />
		</button>
	{/if}
</aside>

<style>
	/* FN-51: appears once a newer build waits, so it slides in instead of popping (full height from the first frame). */
	@media (prefers-reduced-motion: no-preference) {
		.update {
			animation: banner-in var(--duration-base) var(--ease) backwards;
		}
	}
	@keyframes banner-in {
		from {
			opacity: 0;
			transform: translateY(-6px);
		}
	}
	.update {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px 8px 12px 16px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
	}
	.body {
		display: grid;
		flex: 1;
		gap: 4px;
		min-width: 0;
	}
	p {
		margin: 0;
	}
	.title {
		font-weight: 600;
	}
	.text {
		font-size: 14px;
		color: var(--muted);
	}
	.action {
		margin-top: 8px;
	}
	.close {
		display: grid;
		flex: none;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 0;
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--ink);
		cursor: pointer;
	}
	.close:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
</style>
