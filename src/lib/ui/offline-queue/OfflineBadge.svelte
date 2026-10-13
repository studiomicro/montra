<script lang="ts">
	import { QUEUE_WAITING } from '#lib/shared/offline-queue';
	import { useI18n } from '#lib/ui/i18n-context';
	import { QUEUE_SESSION_ENDED } from './view';

	/**
	 * FN-02 status pill above the page: what the device still holds, never more. Nothing at all while the queue
	 * is empty and nothing was just confirmed. Tapping it opens the pending-changes sheet.
	 */
	let {
		pending,
		failed,
		online,
		sessionEnded,
		confirmed = 0,
		onopen
	}: {
		pending: number;
		failed: number;
		online: boolean;
		sessionEnded: boolean;
		/** Items the server confirmed just now ("Tersimpan" only after the server's ok). */
		confirmed?: number;
		onopen: () => void;
	} = $props();
	const { tr, trf } = useI18n();

	const tone = $derived(failed > 0 || sessionEnded ? 'warn' : pending > 0 ? 'wait' : 'ok');
	const text = $derived(
		sessionEnded && pending > 0
			? tr(QUEUE_SESSION_ENDED)
			: failed > 0
				? trf('{n} perubahan gagal dikirim', { n: failed })
				: pending > 0
					? online
						? trf('Mengirim {n} perubahan…', { n: pending })
						: `${tr(QUEUE_WAITING)} · ${trf('{n} menunggu', { n: pending })}`
					: confirmed > 0
						? trf('{n} perubahan tersimpan.', { n: confirmed })
						: ''
	);
</script>

<div class="slot" role="status" aria-live="polite">
	{#if text}
		<button type="button" class="pill {tone}" onclick={onopen} aria-haspopup="dialog">
			<span class="dot" aria-hidden="true"></span>
			<span class="label">{text}</span>
		</button>
	{/if}
</div>

<style>
	.slot:empty {
		display: none;
	}
	.slot {
		display: flex;
		justify-content: center;
		padding-top: 8px;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		max-width: 100%;
		min-height: 44px;
		padding: 0 16px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}
	.label {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: var(--r-pill);
		background: var(--muted);
	}
	.warn {
		color: var(--warn-text);
	}
	.warn .dot {
		background: var(--warn);
	}
	.ok .dot {
		background: var(--money-in);
	}
</style>
