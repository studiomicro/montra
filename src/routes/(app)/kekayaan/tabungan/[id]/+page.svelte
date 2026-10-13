<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import {
		amountDigits,
		digitsToMinor,
		groupDigits,
		minorToDigits
	} from '#lib/shared/amount-input';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import {
		CONTRIBUTION_NOTE_MAX_LENGTH,
		type ContributionFormValues,
		type GoalFormValues
	} from '#lib/shared/goals';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney, formatMoneyCompact } from '#lib/shared/money-format';
	import Field from '#lib/ui/auth/Field.svelte';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import GoalForm from '#lib/ui/goals/GoalForm.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	type Mode = 'edit' | 'contribute';

	const goal = $derived(data.goal);
	const editValues = (): GoalFormValues => ({
		name: goal?.name ?? '',
		target: goal ? groupDigits(minorToDigits(goal.targetAmountMinor, goal.currency)) : ''
	});
	const blankContribution = (): ContributionFormValues => ({ amount: '', note: '' });

	// With JavaScript the forms open in a sheet; without it, `?ubah=1` / `?tambah=1` (and a refused
	// submission) render the same form inline, so every action works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let mode = $state<Mode>('contribute');
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	function openSheet(next: Mode) {
		mode = next;
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	const intercept = (next: Mode) => (event: MouseEvent) => {
		event.preventDefault();
		openSheet(next);
	};

	onMount(() => {
		hydrated = true;
		if (data.open) openSheet(data.open);
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('ubah') || url.searchParams.has('tambah')) {
			url.searchParams.delete('ubah');
			url.searchParams.delete('tambah');
			replaceState(url, {});
		}
	}

	/** Shows success only once the server confirmed; the figures are reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
					busy = '';
					return;
				}
				await update();
				if (result.type === 'failure') {
					fieldErrors = (result.data?.errors as Partial<Record<string, string>>) ?? {};
					// Changed or gone meanwhile: show the goal as it is now (a fresh edit form included).
					if (result.status === 404 || result.status === 409) {
						await invalidateAll();
						formKey++;
					}
				} else if (result.type === 'success' && closeSheet) {
					sheetOpen = false;
				}
				busy = '';
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const savedText: Record<string, string> = {
		contributed: msg('Tabungan dicatat.'),
		deleted: msg('Catatan tabungan dihapus.'),
		updated: msg('Perubahan disimpan.'),
		archived: msg('Target diarsipkan.'),
		restored: msg('Target dipulihkan.')
	};
	const saved = $derived(
		form && 'saved' in form && form.saved && Object.hasOwn(savedText, form.saved)
			? tr(savedText[form.saved] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);

	/** The no-JavaScript form: a refused submission, or the form the URL asks for. */
	const inline = $derived.by(() => {
		if (form && 'action' in form && form.action) {
			if (form.action === 'update')
				return { mode: 'edit' as const, values: form.values, errors: form.errors };
			return { mode: 'contribute' as const, values: form.values, errors: form.errors };
		}
		if (data.open === 'edit') return { mode: 'edit' as const, values: editValues(), errors: {} };
		if (data.open === 'contribute')
			return { mode: 'contribute' as const, values: blankContribution(), errors: {} };
		return null;
	});

	const sheetTitle = $derived(mode === 'edit' ? tr('Ubah target') : tr('Tambah tabungan'));
	const olderHref = $derived.by(() => {
		const last = data.contributions.at(-1);
		return last ? `?sebelum=${last.createdAt}_${last.id}` : '';
	});
</script>

<svelte:head><title>{goal ? goal.name : tr('Tabungan')}</title></svelte:head>

<ScreenTitle
	back={{ href: '/dompet', label: tr('Kembali ke Dompet') }}
	title={goal ? goal.name : tr('Tabungan')}
/>

{#snippet contributionForm(values: ContributionFormValues, errors: Partial<Record<string, string>>)}
	<form
		method="POST"
		action="?/addContribution"
		use:enhance={track('contribute', true)}
		class="stack"
		novalidate
	>
		<div class="field">
			<AmountInput
				label={tr('Jumlah')}
				name="amount"
				valueMinor={digitsToMinor(amountDigits(values.amount), goal?.currency ?? 'IDR')}
			/>
			{#if errors.amountMinor}<p class="error">{tr(errors.amountMinor)}</p>{/if}
		</div>
		<Field
			id="{uid}-note"
			name="note"
			label={tr('Catatan (opsional)')}
			value={values.note}
			maxlength={CONTRIBUTION_NOTE_MAX_LENGTH}
			autocomplete="off"
			error={errors.note ? tr(errors.note) : undefined}
		/>
		<Button type="submit" size="lg" full disabled={busy !== ''}>
			{busy === 'contribute' ? tr('Menyimpan…') : tr('Tambah tabungan')}
		</Button>
	</form>
{/snippet}

{#snippet editForm(values: GoalFormValues, errors: Partial<Record<string, string>>)}
	{#if goal}
		<GoalForm
			action="?/updateGoal"
			goal={{ updatedAt: goal.updatedAt }}
			{values}
			{errors}
			busy={busy !== ''}
			submit={track('update', true)}
		/>
		<details class="confirm">
			<summary>{tr('Arsipkan target')}</summary>
			<form method="POST" action="?/archiveGoal" use:enhance={track('archive', true)}>
				<input type="hidden" name="updatedAt" value={goal.updatedAt} />
				<p>
					{tr(
						'Target yang diarsipkan tidak tampil di daftar. Riwayat tabungannya tetap tersimpan dan kembali saat dipulihkan.'
					)}
				</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'archive' ? tr('Memproses…') : tr('Ya, arsipkan')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#if saved}<p class="ok" role="status">{saved}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if refreshing}
	<Skeleton rows={3} />
{:else if !goal}
	<ErrorState text={tr(data.loadError ?? '')} onretry={retry} />
{:else}
	<section class="hero" aria-label={tr('Progres target')}>
		<p class="big num">{formatMoney(goal.savedMinor, goal.currency)}</p>
		<p class="figures">
			<span class="num">
				{formatMoneyCompact(goal.savedMinor, goal.currency)} / {formatMoneyCompact(
					goal.targetAmountMinor,
					goal.currency
				)}
			</span>
			<span class="pct num">{trf('{persen}%', { persen: goal.percent })}</span>
		</p>
		<ProgressBar percent={goal.percent} label={goal.name} />
		<p class="status">
			{#if goal.archived}
				<Badge>{tr('Diarsipkan')}</Badge>
			{:else if goal.percent >= 100}
				<Badge>{tr('Tercapai')}</Badge>
			{/if}
			<span class="meta">{tr('Hanya catatan: tidak memindahkan uang dari dompet mana pun.')}</span>
		</p>
	</section>

	{#if goal.archived}
		<div class="archived">
			<p>{tr('Target ini diarsipkan. Pulihkan untuk menambah tabungan lagi.')}</p>
			<form method="POST" action="?/restoreGoal" use:enhance={track('restore')}>
				<input type="hidden" name="updatedAt" value={goal.updatedAt} />
				<Button type="submit" variant="secondary" disabled={busy !== ''}>
					{busy === 'restore' ? tr('Memproses…') : tr('Pulihkan')}
				</Button>
			</form>
		</div>
	{:else}
		<div class="actions">
			<a class="primary" href="?tambah=1" onclick={intercept('contribute')}>
				<Icon name="plus" size={20} />
				<span>{tr('Tambah tabungan')}</span>
			</a>
			<a class="secondary" href="?ubah=1" onclick={intercept('edit')}>{tr('Ubah target')}</a>
		</div>
	{/if}

	{#if !hydrated && inline && !goal.archived}
		<section class="inline-goal-form" aria-labelledby="inline-title">
			<h2 id="inline-title">
				{inline.mode === 'edit' ? tr('Ubah target') : tr('Tambah tabungan')}
			</h2>
			{#if inline.mode === 'edit'}
				{@render editForm(inline.values as GoalFormValues, inline.errors)}
			{:else}
				{@render contributionForm(inline.values as ContributionFormValues, inline.errors)}
			{/if}
			<a class="cancel" href="?">{tr('Batal')}</a>
		</section>
	{/if}

	<section class="history" aria-labelledby="history-title">
		<h2 id="history-title">{tr('Riwayat tabungan')}</h2>
		{#if data.loadError}
			<ErrorState text={tr(data.loadError)} onretry={retry} />
		{:else if data.contributions.length === 0}
			<p class="meta">{tr('Belum ada tabungan untuk target ini.')}</p>
		{:else}
			<GroupList>
				{#each data.contributions as c (c.id)}
					<GroupRow>
						<span class="text">
							<span class="amount num">{formatMoney(c.amountMinor, goal.currency, 'signed')}</span>
							{#if c.note}<span class="note">{c.note}</span>{/if}
							<span class="meta">
								{c.author ?? tr('Akun yang sudah dihapus')} · {formatDateTimeWib(
									c.createdAt,
									locale
								)}
							</span>
						</span>
						{#if !goal.archived}
							<details class="confirm row-confirm">
								<summary>{tr('Hapus')}</summary>
								<form
									method="POST"
									action="?/deleteContribution"
									use:enhance={track(`delete-${c.id}`)}
								>
									<input type="hidden" name="contributionId" value={c.id} />
									<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
										{busy === `delete-${c.id}` ? tr('Memproses…') : tr('Ya, hapus')}
									</Button>
								</form>
							</details>
						{/if}
					</GroupRow>
				{/each}
			</GroupList>
			<p class="paging">
				{#if data.cursor}<a href="?">{tr('Kembali ke yang terbaru')}</a>{/if}
				{#if data.more}<a href={olderHref}>{tr('Lihat yang lebih lama')}</a>{/if}
			</p>
		{/if}
	</section>
{/if}

<Sheet bind:open={sheetOpen} title={sheetTitle} onclose={onSheetClose}>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			{#if mode === 'edit'}
				{@render editForm(editValues(), fieldErrors)}
			{:else}
				{@render contributionForm(blankContribution(), fieldErrors)}
			{/if}
		{/key}
	{/if}
</Sheet>

<style>
	.hero {
		display: grid;
		gap: 10px;
		margin: 8px 0 20px;
	}
	.big {
		margin: 0;
		font-size: 40px;
		font-weight: 700;
		line-height: 1.1;
		letter-spacing: -0.04em;
		overflow-wrap: anywhere;
	}
	.figures,
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
		margin: 0;
	}
	.status {
		justify-content: flex-start;
	}
	.pct {
		font-weight: 600;
	}
	.meta {
		font-size: 14px;
		color: var(--muted);
	}
	p.meta {
		margin: 0;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 24px;
	}
	.actions a {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		font-weight: 600;
		text-decoration: none;
	}
	.primary {
		background: var(--ink);
		color: var(--bg);
	}
	.secondary {
		background: var(--panel);
		color: var(--ink);
	}
	.archived {
		display: grid;
		gap: 12px;
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.archived p {
		margin: 0;
	}
	h2 {
		margin: 0 0 12px;
		font-size: 22px;
		font-weight: 700;
		letter-spacing: -0.02em;
	}
	.history {
		margin-top: 8px;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.amount {
		font-weight: 600;
		color: var(--money-in);
	}
	.note {
		overflow-wrap: anywhere;
	}
	.paging {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin: 12px 0 0;
	}
	.paging a,
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
	.inline-goal-form {
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--bg-soft);
	}
	.stack {
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
	.confirm {
		margin-top: 16px;
	}
	.row-confirm {
		flex: none;
		margin-top: 0;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
