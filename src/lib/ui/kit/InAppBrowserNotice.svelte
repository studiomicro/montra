<script lang="ts">
	/**
	 * Shown inside Instagram, TikTok and WhatsApp's own browsers (FN-13): they cannot install a web app, so the
	 * person is asked to open the page in Safari or Chrome. Dismissible for the browser session.
	 */
	import type { InAppBrowser, MobileOs } from '#lib/shared/user-agent';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';

	let { app, os, ondismiss }: { app: InAppBrowser; os: MobileOs; ondismiss: () => void } = $props();
	const { tr } = useI18n();

	const APP_NAMES: Record<InAppBrowser, string> = {
		instagram: 'Instagram',
		tiktok: 'TikTok',
		whatsapp: 'WhatsApp'
	};
	const title = $derived(
		os === 'ios'
			? tr('Buka di Safari untuk memasang aplikasi ini')
			: os === 'android'
				? tr('Buka di Chrome untuk memasang aplikasi ini')
				: tr('Buka di browser untuk memasang aplikasi ini')
	);
</script>

<aside class="notice" aria-labelledby="in-app-title">
	<div class="body">
		<p class="title" id="in-app-title">{title}</p>
		<p class="text">
			{APP_NAMES[app]} · {tr(
				'Ketuk menu ⋯ di pojok layar, lalu pilih “Buka di browser”. Browser di dalam aplikasi ini tidak bisa memasang aplikasi.'
			)}
		</p>
	</div>
	<button type="button" class="close" aria-label={tr('Tutup pemberitahuan')} onclick={ondismiss}>
		<Icon name="close" size={20} />
	</button>
</aside>

<style>
	.notice {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 12px max(16px, var(--sai-right)) 0 max(16px, var(--sai-left));
		padding: 12px 8px 12px 16px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	p {
		margin: 0;
	}
	.title {
		font-weight: 600;
	}
	.text {
		margin-top: 4px;
		font-size: 14px;
		color: var(--muted);
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
