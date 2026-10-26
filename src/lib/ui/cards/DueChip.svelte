<script lang="ts">
	import type { DueChip } from '#lib/shared/cards';
	import { useI18n } from '#lib/ui/i18n-context';

	// FN-55a: a card's in-app due chip (computed by shared/cards.ts `dueChip`; never a push reminder). Late is the
	// only coloured state (meaning, not decoration).
	let { due }: { due: DueChip } = $props();
	const { tr, trf } = useI18n();

	const text = $derived(
		due.kind === 'today'
			? tr('Jatuh tempo hari ini')
			: due.kind === 'in'
				? due.days === 1
					? tr('Jatuh tempo besok')
					: trf('Jatuh tempo dalam {n} hari', { n: due.days })
				: due.days === 1
					? tr('Lewat 1 hari')
					: trf('Lewat {n} hari', { n: due.days })
	);
</script>

<span class="chip" class:late={due.kind === 'late'}>{text}</span>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 10px;
		border-radius: var(--r-pill);
		background: var(--panel-2);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
	}
	.late {
		color: var(--money-up);
	}
</style>
