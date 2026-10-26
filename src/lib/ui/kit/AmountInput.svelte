<script lang="ts">
	import { untrack } from 'svelte';
	import {
		amountCaret,
		amountFractionDigits,
		formatAmountText,
		minorToAmountText,
		readAmountText,
		switchAmountText,
		typedAmountMinor
	} from '#lib/shared/amount-input';
	import { moneyParts } from '#lib/shared/money-format';
	import { createClientTranslator } from '#lib/ui/client-i18n';
	import { useLocale } from '#lib/ui/i18n-context';

	let {
		label,
		valueMinor = $bindable(null),
		currency = 'IDR',
		name,
		typed
	}: {
		label: string;
		/** The amount in minor units of `currency` (cents typed for every currency but IDR and JPY, FN-47). */
		valueMinor?: number | null;
		currency?: string;
		/** Set to submit the field with a plain form (the server reads the text with the UI language's separators). */
		name?: string;
		/**
		 * The text a refused submit posted (QA FN-47 #3): shown exactly as typed, so `12,345` stays `12,345` next
		 * to its error instead of a reading the server never accepted (`12,34`). Undefined: the value's own text.
		 */
		typed?: string;
	} = $props();

	const id = $props.id();
	// The UI language decides the separators of a currency with cents; standalone (tests, previews) Indonesian.
	const locale = useLocale();
	const { tr } = createClientTranslator(locale);
	// Rendered on the server too, so a pre-filled field shows its value without JavaScript.
	let text = $state(
		untrack(() => typed ?? minorToAmountText(valueMinor ?? null, currency, locale))
	);
	let shownCurrency = untrack(() => currency);
	const symbol = $derived(moneyParts(0, currency).symbol);
	const cents = $derived(amountFractionDigits(currency) > 0);

	// A currency change keeps, clears or regroups the typed text (owner decision 4); otherwise follow changes
	// made by the parent (form reset, pre-filled edit) — our own typing already matches.
	$effect(() => {
		const next = currency;
		const external = valueMinor ?? null;
		untrack(() => {
			if (next !== shownCurrency) {
				text = switchAmountText(text, shownCurrency, next, locale);
				shownCurrency = next;
				valueMinor = typedAmountMinor(text, next, locale);
			} else if (external !== typedAmountMinor(text, next, locale))
				text = minorToAmountText(external, next, locale);
		});
	});

	function oninput(event: Event) {
		const ev = event as InputEvent;
		if (ev.isComposing) return;
		const input = event.currentTarget as HTMLInputElement;
		const caret = input.selectionStart ?? input.value.length;
		const parts = readAmountText(input.value, currency, locale);
		// A typed third fraction digit is refused, not rounded: the keystroke is dropped, the caret stays.
		if (parts.overflow && ev.inputType === 'insertText') {
			const back = Math.max(0, caret - (ev.data?.length ?? 1));
			input.value = text;
			input.setSelectionRange(back, back);
			return;
		}
		// A paste (or anything else) keeps the first fraction digits; the rest are cut, never rounded.
		const pos = amountCaret(input.value, caret, currency, locale);
		text = formatAmountText(parts, currency, locale);
		input.value = text;
		input.setSelectionRange(pos, pos);
		valueMinor = typedAmountMinor(text, currency, locale);
	}
</script>

<label class="amount" for={id}>
	<span class="label">{label}</span>
	<span class="row">
		<span class="cur">{symbol}</span>
		<input
			{id}
			{name}
			class="num"
			inputmode={cents ? 'decimal' : 'numeric'}
			autocomplete="off"
			value={text}
			{oninput}
			placeholder="0"
			aria-describedby={cents ? `${id}-hint` : undefined}
		/>
	</span>
	{#if cents}<span id="{id}-hint" class="hint">{tr('Pakai koma untuk sen: 12,50')}</span>{/if}
</label>

<style>
	.amount {
		display: grid;
		min-width: 0;
		gap: 6px;
	}
	.label {
		font-size: 14px;
		font-weight: 600;
		color: var(--muted);
	}
	.row {
		display: flex;
		min-width: 0;
		align-items: baseline;
		gap: 6px;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
	.cur {
		font-size: 22px;
		font-weight: 600;
		color: var(--muted);
	}
	input {
		width: 100%;
		min-width: 0;
		border: 0;
		background: transparent;
		box-shadow: none;
		color: var(--ink);
		font: inherit;
		font-size: 52px;
		line-height: 1.05;
		font-weight: 700;
		letter-spacing: -0.045em;
	}
	input:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: var(--r-xs);
	}
</style>
