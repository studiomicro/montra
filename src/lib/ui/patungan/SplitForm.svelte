<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { typedAmountMinor } from '#lib/shared/amount-input';
	import { formatMoney } from '#lib/shared/money-format';
	import {
		equalShares,
		FORM_MODES,
		MAX_PARTICIPANTS,
		MODE_LABELS,
		PERSON_NAME_MAX,
		SPLIT_NOTE_MAX,
		SPLIT_TITLE_MAX,
		sharesDifference,
		typedUnitMinor,
		type PatunganFormValues
	} from '#lib/shared/patungan';
	import Field from '#lib/ui/auth/Field.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';

	/**
	 * FN-49: the create and full-edit form of a split. Plain form fields, so it posts without JavaScript: the share
	 * fields of `exact` mode are hidden by CSS while `equal` is checked (they post either way and the server
	 * ignores them), and there are always a few empty guest rows. With JavaScript it also previews each equal
	 * share (the server's own rounding engine, remainder to the payer) and the gap of typed exact shares, and
	 * "Tambah teman" adds guest rows. The server decides every share; the preview never posts anything.
	 */
	let {
		action,
		values,
		errors = {},
		members,
		payerName,
		currency,
		fixedTotal,
		busy,
		submit,
		submitLabel,
		hidden
	}: {
		action: string;
		values: PatunganFormValues;
		errors?: Partial<Record<string, string>>;
		/** Live members of the space other than the payer. */
		members: { userId: string; name: string }[];
		payerName: string;
		currency: string;
		/** The total when a linked bill fixes it (shown, not editable). */
		fixedTotal: number | null;
		busy: boolean;
		submit: SubmitFunction;
		submitLabel: string;
		/** Hidden fields and extra controls of the page (the bill, the wallet and category, `updatedAt`). */
		hidden?: Snippet;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const uid = $props.id();
	const error = (field: string) => (errors[field] ? tr(errors[field]) : undefined);

	let mode = $state(untrack(() => values.mode || 'equal'));
	let picked = $state<string[]>(untrack(() => [...values.members]));
	/** Guest rows: the posted ones, then empty rows to fill (at least 3 shown, more with "Tambah teman"). */
	let guests = $state(
		untrack(() => {
			const rows = values.guests.map((g) => ({ ...g }));
			while (rows.length < Math.max(3, values.guests.length + 1))
				rows.push({ name: '', share: '' });
			return rows.slice(0, MAX_PARTICIPANTS - 1);
		})
	);
	let totalMinor = $state<number | null>(
		untrack(() => fixedTotal ?? typedAmountMinor(values.amount, currency, locale))
	);
	let payerMinor = $state<number | null>(
		untrack(() => typedAmountMinor(values.payerShare, currency, locale))
	);
	let memberMinor = $state<Record<string, number | null>>(
		untrack(() =>
			Object.fromEntries(
				members.map((m) => [
					m.userId,
					typedAmountMinor(values.memberShares[m.userId] ?? '', currency, locale)
				])
			)
		)
	);
	let guestMinor = $state<(number | null)[]>(
		untrack(() => guests.map((g) => typedAmountMinor(g.share, currency, locale)))
	);

	const namedGuests = $derived(
		guests.map((g, i) => ({ ...g, i })).filter((g) => g.name.trim() !== '')
	);
	const count = $derived(1 + picked.length + namedGuests.length);
	const preview = $derived(
		mode === 'equal' && totalMinor !== null && totalMinor > 0
			? equalShares(totalMinor, count, 0, typedUnitMinor(currency))
			: null
	);
	const money = (minor: number) => formatMoney(minor, currency, 'auto', locale);
	/** The equal share shown beside person `index` (0 = the payer), when the preview can be computed. */
	const equalOf = (index: number) =>
		preview?.ok ? money(preview.shares[index] as number) : undefined;
	const gap = $derived(
		mode === 'exact' && totalMinor !== null && totalMinor > 0
			? sharesDifference(totalMinor, [
					payerMinor,
					...picked.map((id) => memberMinor[id] ?? null),
					...namedGuests.map((g) => guestMinor[g.i] ?? null)
				])
			: null
	);
	const gapText = $derived(
		gap === null
			? ''
			: gap === 0n
				? tr('Pas dengan totalnya.')
				: gap < 0n
					? trf('Kurang {amount} lagi.', { amount: money(Number(-gap)) })
					: trf('Lebih {amount} dari totalnya.', { amount: money(Number(gap)) })
	);
	const memberIndex = (id: string) => 1 + picked.indexOf(id);
	const guestIndex = (i: number) => 1 + picked.length + namedGuests.findIndex((g) => g.i === i);

	function addGuest() {
		if (guests.length < MAX_PARTICIPANTS - 1) {
			guests.push({ name: '', share: '' });
			guestMinor.push(null);
		}
	}
</script>

<form method="POST" {action} use:enhance={submit} class="split-form" novalidate>
	{@render hidden?.()}

	<Field
		id="{uid}-title"
		name="title"
		label={tr('Nama patungan')}
		hint={tr('Contoh: Makan malam tim, Kado ulang tahun.')}
		value={values.title}
		maxlength={SPLIT_TITLE_MAX}
		autocomplete="off"
		required
		error={error('title')}
	/>

	<div class="field">
		{#if fixedTotal !== null}
			<p class="label">{tr('Total tagihan')}</p>
			<p class="num fixed">{money(fixedTotal)}</p>
			<p class="hint">{tr('Sama dengan transaksi yang ditautkan.')}</p>
		{:else}
			<AmountInput
				label={tr('Total tagihan')}
				name="amount"
				bind:valueMinor={totalMinor}
				{currency}
				typed={errors.amount ? values.amount : undefined}
			/>
		{/if}
		{#if error('amount')}<p class="error" role="alert">{error('amount')}</p>{/if}
	</div>

	<Field
		id="{uid}-date"
		name="occurredOn"
		type="date"
		label={tr('Tanggal')}
		value={values.occurredOn}
		required
		error={error('occurredOn')}
	/>

	<div class="field">
		<Segmented
			name="mode"
			label={tr('Cara membagi')}
			bind:value={mode}
			options={FORM_MODES.map((m) => ({ value: m, label: tr(MODE_LABELS[m]) }))}
		/>
		<p class="hint equal-only">{tr('Sisa pembulatan masuk ke bagianmu sebagai pembayar.')}</p>
		<p class="hint exact-only">
			{tr('Isi bagian setiap orang. Jumlahnya harus sama dengan totalnya.')}
		</p>
		{#if error('mode')}<p class="error">{error('mode')}</p>{/if}
	</div>

	<fieldset class="people">
		<legend>{tr('Siapa saja')}</legend>
		<div class="person">
			<span class="who">
				<span class="name">{payerName}</span>
				<span class="tag">{tr('Kamu, pembayar')}</span>
			</span>
			{#if equalOf(0)}<span class="equal-only share num">{equalOf(0)}</span>{/if}
			<div class="exact-only amount">
				<AmountInput
					label={trf('Bagian {name}', { name: payerName })}
					name="payerShare"
					bind:valueMinor={payerMinor}
					{currency}
					typed={errors.payerShare ? values.payerShare : undefined}
				/>
				{#if error('payerShare')}<p class="error">{error('payerShare')}</p>{/if}
			</div>
		</div>

		{#each members as member (member.userId)}
			<div class="person">
				<label class="who check">
					<input type="checkbox" name="member" value={member.userId} bind:group={picked} />
					<span class="name">{member.name}</span>
					<span class="tag">{tr('Anggota ruang')}</span>
				</label>
				{#if picked.includes(member.userId) && equalOf(memberIndex(member.userId))}
					<span class="equal-only share num">{equalOf(memberIndex(member.userId))}</span>
				{/if}
				<div class="exact-only amount">
					<AmountInput
						label={trf('Bagian {name}', { name: member.name })}
						name="memberShare.{member.userId}"
						bind:valueMinor={memberMinor[member.userId]}
						{currency}
						typed={errors[`memberShare.${member.userId}`]
							? values.memberShares[member.userId]
							: undefined}
					/>
					{#if error(`memberShare.${member.userId}`)}
						<p class="error">{error(`memberShare.${member.userId}`)}</p>
					{/if}
				</div>
			</div>
		{/each}

		{#each guests as guest, i (i)}
			<div class="person">
				<Field
					id="{uid}-guest-{i}"
					name="guestName"
					label={trf('Teman {n}', { n: i + 1 })}
					value={guest.name}
					oninput={(event: Event) => (guest.name = (event.currentTarget as HTMLInputElement).value)}
					maxlength={PERSON_NAME_MAX}
					autocomplete="off"
					error={error(`guest.${i}`)}
				/>
				{#if guest.name.trim() !== '' && equalOf(guestIndex(i))}
					<span class="equal-only share num">{equalOf(guestIndex(i))}</span>
				{/if}
				<div class="exact-only amount">
					<AmountInput
						label={trf('Bagian teman {n}', { n: i + 1 })}
						name="guestShare"
						bind:valueMinor={guestMinor[i]}
						{currency}
						typed={errors[`guest.${i}`] ? guest.share : undefined}
					/>
				</div>
			</div>
		{/each}
		{#if guests.length < MAX_PARTICIPANTS - 1}
			<Button variant="secondary" size="sm" icon="plus" onclick={addGuest}>
				{tr('Tambah teman')}
			</Button>
		{/if}
		{#if gapText}<p class="hint exact-only" aria-live="polite">{gapText}</p>{/if}
		{#if preview && !preview.ok && preview.reason === 'total_too_small'}
			<p class="hint equal-only">{tr('Total terlalu kecil untuk dibagi ke semua orang.')}</p>
		{/if}
		{#if error('people')}<p class="error" role="alert">{error('people')}</p>{/if}
		{#if error('shares')}<p class="error" role="alert">{error('shares')}</p>{/if}
	</fieldset>

	<Field
		id="{uid}-note"
		name="note"
		label={tr('Catatan (opsional)')}
		value={values.note}
		maxlength={SPLIT_NOTE_MAX}
		autocomplete="off"
		error={error('note')}
	/>

	<Button type="submit" size="lg" full disabled={busy}>
		{busy ? tr('Menyimpan…') : submitLabel}
	</Button>
</form>

<style>
	.split-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		padding-bottom: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
	}
	.label,
	legend {
		margin: 0 0 6px;
		padding: 0;
		font-size: 15px;
		font-weight: 600;
	}
	.fixed {
		margin: 0;
		font-size: 22px;
		font-weight: 700;
	}
	fieldset {
		display: grid;
		gap: 12px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.person {
		display: grid;
		gap: 8px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		min-height: 44px;
	}
	.check {
		cursor: pointer;
	}
	.check input {
		width: 22px;
		height: 22px;
		margin: 0;
	}
	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.tag {
		color: var(--muted);
		font-size: 13px;
	}
	.share {
		font-weight: 700;
	}
	/* The fields of the checked mode only (the radios and every field post either way). */
	.exact-only {
		display: none;
	}
	.split-form:has(:global(input[name='mode'][value='exact']:checked)) .exact-only {
		display: grid;
	}
	.split-form:has(:global(input[name='mode'][value='exact']:checked)) .equal-only {
		display: none;
	}
	.amount {
		gap: 6px;
	}
	.hint {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
