<script lang="ts">
	import { onMount } from 'svelte';
	import type { SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import type { GoalFormValues } from '#lib/shared/goals';
	import { formatMoneyCompact } from '#lib/shared/money-format';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import { shown } from '#lib/ui/kit/amounts.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';
	import GoalForm from './GoalForm.svelte';

	interface Goal {
		id: string;
		name: string;
		targetAmountMinor: number;
		currency: string;
		savedMinor: number;
		percent: number;
		archived: boolean;
	}

	let {
		goals,
		loadError,
		showArchived,
		openAdd,
		result
	}: {
		goals: Goal[];
		loadError: string | null;
		showArchived: boolean;
		/** `?target=baru`: open the add form (inline without JavaScript, in the sheet with it). */
		openAdd: boolean;
		/** This section's part of the page's action result (createGoal). */
		result: {
			goalAction?: 'create';
			goalErrors?: Partial<Record<string, string>>;
			goalValues?: GoalFormValues;
			goalSaved?: 'created';
			goalError?: string;
		} | null;
	} = $props();

	const { tr, trf, locale } = useI18n();
	const active = $derived(goals.filter((g) => !g.archived));
	const archived = $derived(goals.filter((g) => g.archived));
	const blank = (): GoalFormValues => ({ name: '', target: '' });

	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let formKey = $state(0);
	let fieldErrors = $state<Partial<Record<string, string>>>({});
	let busy = $state(false);
	let actionError = $state('');
	let refreshing = $state(false);

	function openSheet() {
		fieldErrors = {};
		actionError = '';
		formKey++;
		sheetOpen = true;
	}
	const intercept = (event: MouseEvent) => {
		event.preventDefault();
		openSheet();
	};

	onMount(() => {
		hydrated = true;
		if (openAdd) openSheet();
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('target')) {
			url.searchParams.delete('target');
			replaceState(url, {});
		}
	}

	/** The sheet closes and the new goal shows only once the server confirmed the write. */
	const submit: SubmitFunction = () => {
		busy = true;
		actionError = '';
		return async ({ result: r, update }) => {
			if (r.type === 'error') {
				actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				busy = false;
				return;
			}
			await update();
			if (r.type === 'failure') {
				fieldErrors = (r.data?.goalErrors as Partial<Record<string, string>>) ?? {};
				if (r.status === 404 || r.status === 409) await invalidateAll();
			} else if (r.type === 'success') {
				sheetOpen = false;
			}
			busy = false;
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

	const saved = $derived(result?.goalSaved === 'created' ? tr('Target ditambahkan.') : '');
	const banner = $derived(
		actionError || (result?.goalError ? tr(result.goalError) : '') || undefined
	);

	/** The no-JavaScript form: a refused submission, or `?target=baru`. */
	const inline = $derived.by(() => {
		if (result?.goalAction === 'create')
			return { values: result.goalValues ?? blank(), errors: result.goalErrors ?? {} };
		return openAdd ? { values: blank(), errors: {} } : null;
	});

	const figures = (g: Goal) =>
		trf('{tersimpan} dari {target}', {
			tersimpan: shown(formatMoneyCompact(g.savedMinor, g.currency, locale)),
			target: shown(formatMoneyCompact(g.targetAmountMinor, g.currency, locale))
		});
</script>

{#snippet goalRow(goal: Goal)}
	<GroupRow href="/kekayaan/tabungan/{goal.id}">
		<span class="goal">
			<span class="top">
				<span class="name">{goal.name}</span>
				<span class="pct num">{trf('{persen}%', { persen: goal.percent })}</span>
			</span>
			<ProgressBar percent={goal.percent} label={goal.name} />
			<span class="bottom">
				<span class="meta num">{figures(goal)}</span>
				{#if goal.archived}
					<span class="meta">{tr('Diarsipkan')}</span>
				{:else if goal.percent >= 100}
					<Badge>{tr('Tercapai')}</Badge>
				{/if}
			</span>
		</span>
	</GroupRow>
{/snippet}

<section class="goals" aria-labelledby="goals-title">
	<h2 id="goals-title">{tr('Tujuan')}</h2>
	<p class="section-sub">{tr('Uang yang kamu sisihkan untuk target tertentu')}</p>

	{#if saved}<p class="ok" role="status">{saved}</p>{/if}
	{#if !sheetOpen}<FormBanner message={banner} />{/if}

	{#if !hydrated && inline}
		<section class="goal-inline" aria-labelledby="goal-inline-title">
			<h3 id="goal-inline-title">{tr('Tambah target')}</h3>
			<GoalForm
				action="?/createGoal"
				values={inline.values}
				errors={inline.errors}
				{busy}
				{submit}
			/>
			<a class="cancel" href="/dompet">{tr('Batal')}</a>
		</section>
	{/if}

	{#if refreshing}
		<Skeleton rows={2} />
	{:else if loadError}
		<ErrorState text={tr(loadError)} onretry={retry} />
	{:else if active.length === 0}
		<EmptyState
			illustration="goal"
			text={tr('Belum ada target tabungan.')}
			actionLabel={tr('Tambah target')}
			actionHref="/dompet?target=baru"
			onaction={openSheet}
		/>
	{:else}
		<GroupList>
			{#each active as goal (goal.id)}
				{@render goalRow(goal)}
			{/each}
			<GroupRow>
				<a class="add" href="/dompet?target=baru" onclick={intercept}>
					<Icon name="plus" size={20} />
					<span>{tr('Tambah target')}</span>
				</a>
			</GroupRow>
		</GroupList>
	{/if}

	{#if showArchived && !loadError}
		<h3 class="sub">{tr('Target diarsipkan')}</h3>
		{#if archived.length === 0}
			<p class="meta">{tr('Tidak ada target yang diarsipkan.')}</p>
		{:else}
			<GroupList>
				{#each archived as goal (goal.id)}
					{@render goalRow(goal)}
				{/each}
			</GroupList>
		{/if}
	{/if}
</section>

<Sheet bind:open={sheetOpen} title={tr('Tambah target')} onclose={onSheetClose}>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{#key formKey}
			<GoalForm action="?/createGoal" values={blank()} errors={fieldErrors} {busy} {submit} />
		{/key}
	{/if}
</Sheet>

<style>
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.section-sub {
		margin: 2px 0 12px;
		font-size: 13px;
		color: var(--muted);
	}
	h3 {
		margin: 0 0 12px;
		font-size: 19px;
		font-weight: 600;
	}
	.sub {
		margin-top: 24px;
	}
	.goal {
		display: grid;
		flex: 1;
		gap: 6px;
		min-width: 0;
		padding: 4px 0;
	}
	.top,
	.bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}
	.name {
		overflow: hidden;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.pct {
		flex: none;
		font-weight: 600;
	}
	.meta {
		font-size: 14px;
		color: var(--muted);
	}
	p.meta {
		margin: 0;
	}
	.add {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	.goal-inline {
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
</style>
