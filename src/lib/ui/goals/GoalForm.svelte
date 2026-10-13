<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { amountDigits, digitsToMinor } from '#lib/shared/amount-input';
	import { GOAL_NAME_MAX_LENGTH, type GoalFormValues } from '#lib/shared/goals';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';

	let {
		action,
		goal,
		values,
		errors = {},
		busy,
		submit
	}: {
		/** `?/createGoal` on /dompet, `?/updateGoal` on the goal's own page. */
		action: string;
		/** The goal being edited (absent when adding): its `updated_at` guards against a stale save. */
		goal?: { updatedAt: number };
		values: GoalFormValues;
		/** Field errors from the server (msg() phrases). */
		errors?: Partial<Record<string, string>>;
		busy: boolean;
		submit: SubmitFunction;
	} = $props();

	const { tr } = useI18n();
	const uid = $props.id();
	const initialMinor = $derived(digitsToMinor(amountDigits(values.target), 'IDR'));
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);
</script>

<form method="POST" {action} use:enhance={submit} class="goal-form" novalidate>
	{#if goal}
		<input type="hidden" name="updatedAt" value={goal.updatedAt} />
	{/if}

	<Field
		id="{uid}-name"
		name="name"
		label={tr('Nama target')}
		hint={tr('Contoh: Liburan Bali, Dana darurat.')}
		value={values.name}
		maxlength={GOAL_NAME_MAX_LENGTH}
		autocomplete="off"
		error={error('name')}
	/>

	<div class="field">
		<AmountInput label={tr('Jumlah target')} name="target" valueMinor={initialMinor} />
		{#if error('targetAmountMinor')}<p class="error">{error('targetAmountMinor')}</p>{/if}
	</div>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : goal ? tr('Simpan perubahan') : tr('Tambah target')}
	</Button>
</form>

<style>
	.goal-form {
		display: grid;
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
