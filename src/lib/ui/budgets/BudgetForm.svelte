<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	/**
	 * A monthly budget form (FN-07): the amount, Simpan and, for a set budget, Hapus anggaran. Used for the space's
	 * total budget (Beranda, Anggaran) and for one category's budget (Anggaran, `categoryId`). Plain form posts,
	 * so it works without JavaScript; `submit` is the page's enhance callback (busy and success handling).
	 */
	let {
		setAction,
		deleteAction,
		currency,
		budget,
		label,
		hint,
		categoryId,
		busy,
		submit,
		typed
	}: {
		setAction: string;
		deleteAction: string;
		currency: string;
		/** The budget as loaded (null: none set yet); its `updatedAt` guards against stale writes. */
		budget: { amountMinor: number; updatedAt: number } | null;
		label: string;
		hint: string;
		categoryId?: string;
		/** The action in flight ('' when none): 'set' or 'delete' shows progress on its button. */
		busy: string;
		submit: (name: 'set' | 'delete') => SubmitFunction;
		/** The amount text a refused submission posted: shown as typed, never the stored budget. */
		typed?: string;
	} = $props();
	const { tr } = useI18n();
</script>

<form method="POST" action={setAction} class="budget-form" use:enhance={submit('set')}>
	<input type="hidden" name="currency" value={currency} />
	<input type="hidden" name="updatedAt" value={budget?.updatedAt ?? ''} />
	{#if categoryId}<input type="hidden" name="categoryId" value={categoryId} />{/if}
	<p class="hint">{hint}</p>
	<AmountInput {label} name="amount" {currency} valueMinor={budget?.amountMinor ?? null} {typed} />
	<Button type="submit" size="lg" full disabled={busy !== ''}>
		{busy === 'set' ? tr('Menyimpan…') : tr('Simpan')}
	</Button>
</form>
{#if budget}
	<form method="POST" action={deleteAction} use:enhance={submit('delete')}>
		<input type="hidden" name="updatedAt" value={budget.updatedAt} />
		{#if categoryId}<input type="hidden" name="categoryId" value={categoryId} />{/if}
		<Button type="submit" variant="destructive" full disabled={busy !== ''}>
			{busy === 'delete' ? tr('Memproses…') : tr('Hapus anggaran')}
		</Button>
	</form>
{/if}

<style>
	.budget-form {
		display: grid;
		gap: 16px;
		margin-bottom: 12px;
	}
	.hint {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
</style>
