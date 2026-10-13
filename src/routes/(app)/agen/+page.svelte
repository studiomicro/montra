<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import {
		AGENT_FAILURE_LABELS,
		AGENT_NARRATIVE_REASON_LABELS,
		AGENT_STATUS_LABELS,
		AGENT_STEP_LABELS,
		AGENT_TYPE_LABELS,
		AGENT_TYPES,
		stepsOf,
		type AgentStep,
		type AgentType
	} from '#lib/shared/agent';
	import { formatMonthLabel, formatShortDate, wibDateString } from '#lib/shared/dates';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-23 Agen (beta): pick a report, watch its steps, download the files. Every state comes from the server's
	 * `load` (D1), never from the browser: without JavaScript the forms are plain posts and a `<noscript>` refresh
	 * advances an active run; with it, the same posts run in place and the page polls `/agen/status` every 3 s while
	 * a run is active (for at most 10 minutes; "Muat ulang" always works).
	 */
	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();
	const uid = $props.id();

	const POLL_MS = 3000;
	const POLL_LIMIT_MS = 10 * 60 * 1000;

	let type = $state<AgentType>('monthly');
	let pending = $state<'' | 'buat' | 'hapus'>('');
	let clientError = $state('');
	let refreshing = $state(false);
	let listHeading = $state<HTMLElement>();

	const banner = $derived(
		clientError || (form && 'error' in form && form.error ? tr(form.error) : '') || undefined
	);

	type Runs = Extract<typeof data, { locked: false }>['runs'];
	/** The latest `/agen/status` answer for the `load` it was polled from (red team S4: polls never re-run `load`). */
	let polled = $state.raw<{ from: typeof data; runs: Runs; active: boolean } | null>(null);
	const runs = $derived(data.locked ? [] : polled?.from === data ? polled.runs : data.runs);
	const active = $derived(!data.locked && (polled?.from === data ? polled.active : data.active));

	$effect(() => {
		if (data.locked || !data.active) return;
		const from = data;
		const started = Date.now();
		let stopped = false;
		const stop = () => {
			stopped = true;
			clearInterval(timer);
		};
		const timer = setInterval(async () => {
			if (Date.now() - started > POLL_LIMIT_MS) return stop();
			try {
				const res = await fetch('/agen/status', { headers: { accept: 'application/json' } });
				if (stopped) return;
				if (!res.ok) {
					// Off the plan or signed out: the full `load` shows why.
					stop();
					void invalidateAll();
					return;
				}
				const next = (await res.json()) as { runs: Runs; active: boolean };
				if (stopped) return;
				polled = { from, runs: next.runs, active: next.active };
				// Finished: one full `load` brings the rest of the page up to date.
				if (!next.active) {
					stop();
					void invalidateAll();
				}
			} catch {
				// Offline for a moment: the next tick tries again.
			}
		}, POLL_MS);
		return stop;
	});

	const submit =
		(kind: 'buat' | 'hapus'): SubmitFunction =>
		({ cancel }) => {
			if (pending) {
				cancel();
				return;
			}
			pending = kind;
			clientError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					clientError = tr('Tidak bisa terhubung. Periksa koneksi lalu coba lagi.');
				else await update({ reset: false });
				pending = '';
				await tick();
				listHeading?.focus();
			};
		};

	async function reload() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const periodLabel = (t: AgentType, period: string) =>
		t === 'monthly' ? formatMonthLabel(period, locale) : period;
	const monthOption = (m: string) =>
		!data.locked && m === data.today.slice(0, 7)
			? trf('{periode}, sampai {tanggal}', {
					periode: formatMonthLabel(m, locale),
					tanggal: formatShortDate(data.today, locale)
				})
			: formatMonthLabel(m, locale);
	const yearOption = (y: string) =>
		!data.locked && y === data.today.slice(0, 4)
			? trf('{periode}, sampai {tanggal}', {
					periode: y,
					tanggal: formatShortDate(data.today, locale)
				})
			: y;
	const sizeOf = (bytes: number | null) =>
		trf('{n} KB', { n: Math.max(1, Math.ceil((bytes ?? 0) / 1024)) });

	type Run = Extract<typeof data, { locked: false }>['runs'][number];

	function stepState(run: Run, index: number): 'done' | 'current' | 'pending' {
		if (index < run.stepsDone) return 'done';
		return index === run.stepsDone ? 'current' : 'pending';
	}

	function stepText(run: Run, step: AgentStep): string {
		const c = run.counts;
		if (step === 'read' && c.transactions !== null)
			return trf('Membaca {n} transaksi', { n: c.transactions.toLocaleString(locale) });
		if (step === 'read' && c.wallets !== null && c.assets !== null)
			return trf('Membaca {n} dompet dan {m} aset', { n: c.wallets, m: c.assets });
		if (step === 'group' && c.categories !== null)
			return trf('Mengelompokkan {n} kategori', { n: c.categories });
		if (step === 'summary' && c.months !== null) return trf('Ringkasan {n} bulan', { n: c.months });
		return tr(AGENT_STEP_LABELS[step]);
	}
</script>

<svelte:head>
	<title>{tr('Agen')}</title>
	{#if !data.locked && active}
		<noscript><meta http-equiv="refresh" content="5" /></noscript>
	{/if}
</svelte:head>

<ScreenTitle title={tr('Agen')} subtitle={tr('Minta laporan, Agen yang menyiapkannya.')} />
<!-- Left edge of the title block, right under it: the header's action slot would float it to the far right. -->
<p class="beta"><Badge>{tr('Beta')}</Badge></p>

{#if data.locked}
	<section class="locked" aria-labelledby="{uid}-locked">
		<Mascot pose="sleep" size={120} />
		<p class="lead" id="{uid}-locked">{tr('Tersedia di paket Agen')}</p>
		<ul class="perks">
			<li>
				<Icon name="check" size={18} />{tr('Laporan bulanan dan rekap tahunan dari catatanmu.')}
			</li>
			<li>
				<Icon name="check" size={18} />{tr('Daftar aset untuk bahan SPT, bukan pelaporan pajak.')}
			</li>
			<li>
				<Icon name="check" size={18} />{tr('Unduh CSV atau HTML siap cetak, tersimpan 30 hari.')}
			</li>
		</ul>
		<a class="action" href="/pengaturan/paket">{tr('Lihat paket')}</a>
	</section>
{:else if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={reload} />
{:else}
	<div class="page">
		<FormBanner message={banner} />

		<form method="POST" action="?/buat" use:enhance={submit('buat')} class="create">
			<input type="hidden" name="requestId" value={data.requestId} />
			<fieldset>
				<legend>{tr('Jenis laporan')}</legend>
				<GroupList>
					{#each AGENT_TYPES as t (t)}
						<GroupRow
							radio
							name="type"
							value={t}
							selected={type === t}
							onToggle={(on) => {
								if (on) type = t;
							}}
						>
							<span>{tr(AGENT_TYPE_LABELS[t])}</span>
						</GroupRow>
					{/each}
				</GroupList>
			</fieldset>

			<div class="fields">
				<label for="{uid}-month" class:other={type !== 'monthly'}
					>{tr('Bulan (laporan bulanan)')}</label
				>
				<select id="{uid}-month" name="month">
					{#each data.periods.months as m (m)}
						<option value={m}>{monthOption(m)}</option>
					{/each}
				</select>
				<label for="{uid}-year" class:other={type === 'monthly'}
					>{tr('Tahun (rekap tahunan dan daftar aset)')}</label
				>
				<select id="{uid}-year" name="year">
					{#each data.periods.years as y (y)}
						<option value={y}>{yearOption(y)}</option>
					{/each}
				</select>
			</div>

			<label class="check">
				<input
					type="checkbox"
					name="narrative"
					checked={data.narrative === 'ok'}
					disabled={data.narrative !== 'ok'}
					aria-describedby="{uid}-ai"
				/>
				<span>{tr('Tulis ringkasan dengan AI')}</span>
			</label>
			<p class="note" id="{uid}-ai">
				{#if data.narrative === 'no_gateway'}
					{tr('Belum dikonfigurasi')}
				{:else if data.narrative === 'no_key'}
					<a href="/pengaturan/integrasi"
						>{tr('Tambahkan kunci Anthropic di Pengaturan › Integrasi')}</a
					>
				{:else}
					{tr('Ringkasan AI mengirim angka dan nama kategori ke Anthropic memakai kuncimu.')}
				{/if}
				{tr('Daftar aset tidak memakai AI.')}
			</p>

			<Button type="submit" disabled={pending !== ''}>
				{pending === 'buat' ? tr('Membuat…') : tr('Buat laporan')}
			</Button>
			<p class="note">
				{tr(
					'Informasi dari catatanmu, bukan saran keuangan atau pajak. Daftar aset adalah informasi dari catatanmu, bukan pelaporan SPT.'
				)}
			</p>
		</form>

		<section aria-labelledby="{uid}-list" class="list">
			<div class="list-head">
				<h2 id="{uid}-list" tabindex="-1" bind:this={listHeading}>{tr('Laporanmu')}</h2>
				<Button href="/agen" variant="secondary" size="sm">{tr('Muat ulang')}</Button>
			</div>
			<div aria-live="polite">
				{#if runs.length === 0}
					<p class="note">{tr('Belum ada laporan. Laporan siap disimpan 30 hari.')}</p>
				{:else}
					<GroupList label={tr('Laporanmu')}>
						{#each runs as run (run.id)}
							<GroupRow>
								<div class="run">
									<div class="run-head">
										<strong
											>{tr(AGENT_TYPE_LABELS[run.type])} · {periodLabel(
												run.type,
												run.period
											)}</strong
										>
										{#if run.status === 'ready'}
											<StatusTag>{tr(AGENT_STATUS_LABELS.ready)}</StatusTag>
										{:else}
											<Badge>{tr(AGENT_STATUS_LABELS[run.status])}</Badge>
										{/if}
									</div>
									{#if run.status === 'queued' || run.status === 'running'}
										{@const steps = stepsOf(run.type)}
										<ol class="steps">
											{#each steps as step, i (i)}
												<li class={stepState(run, i)}>
													<span class="sr-only"
														>{stepState(run, i) === 'done'
															? tr('Selesai')
															: stepState(run, i) === 'current'
																? tr('Sedang berjalan')
																: tr('Menunggu')}:</span
													>
													{stepText(run, step)}
												</li>
											{/each}
										</ol>
										<ProgressBar
											percent={Math.floor((run.stepsDone * 100) / steps.length)}
											label={trf('Langkah {n} dari {m}', { n: run.stepsDone, m: steps.length })}
										/>
									{:else if run.status === 'ready'}
										<p class="links">
											<a href="/agen/{run.id}/unduh?format=csv" download
												>{tr('Unduh CSV')} ({sizeOf(run.csvBytes)})</a
											>
											<a href="/agen/{run.id}/unduh?format=html" download
												>{tr('Unduh HTML')} ({sizeOf(run.htmlBytes)})</a
											>
										</p>
										<p class="note">
											{trf('Berlaku sampai {tanggal}', {
												tanggal: formatShortDate(wibDateString(run.expiresAt), locale)
											})}
											·
											{#if run.narrativeState === 'ai'}
												{tr('Ringkasan AI')}
											{:else if run.type !== 'spt_assets'}
												{trf('Tanpa ringkasan AI: {alasan}', {
													alasan: tr(AGENT_NARRATIVE_REASON_LABELS[run.narrativeReason ?? 'off'])
												})}
											{:else}
												{tr('Tanpa AI')}
											{/if}
										</p>
									{:else if run.status === 'failed'}
										<p class="note">{tr(AGENT_FAILURE_LABELS[run.failure ?? 'internal'])}</p>
										<form method="POST" action="?/buat" use:enhance={submit('buat')}>
											<input type="hidden" name="requestId" value={data.requestId} />
											<input type="hidden" name="type" value={run.type} />
											<input
												type="hidden"
												name={run.type === 'monthly' ? 'month' : 'year'}
												value={run.period}
											/>
											{#if run.withNarrative}<input
													type="hidden"
													name="narrative"
													value="on"
												/>{/if}
											<Button type="submit" variant="secondary" size="sm" disabled={pending !== ''}>
												{tr('Coba lagi')}
											</Button>
										</form>
									{/if}
									{#if run.status === 'ready' || run.status === 'failed'}
										<form method="POST" action="?/hapus" use:enhance={submit('hapus')}>
											<input type="hidden" name="id" value={run.id} />
											<Button type="submit" variant="ghost" size="sm" disabled={pending !== ''}>
												{pending === 'hapus' ? tr('Menghapus…') : tr('Hapus')}
											</Button>
										</form>
									{/if}
								</div>
							</GroupRow>
						{/each}
					</GroupList>
				{/if}
			</div>
		</section>
	</div>
{/if}

<style>
	.beta {
		margin: 0 0 8px;
	}
	.locked {
		display: grid;
		justify-items: center;
		gap: 16px;
		padding: 24px 0 48px;
	}
	.lead {
		margin: 0;
		font-size: 17px;
		font-weight: 600;
	}
	.perks {
		display: grid;
		gap: 10px;
		max-width: 36ch;
		margin: 0;
		padding: 0;
		color: var(--muted);
		list-style: none;
	}
	.perks li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.perks :global(svg) {
		flex: none;
		margin-top: 2px;
		color: var(--ink);
	}
	.action {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 20px;
		border-radius: var(--r-pill);
		background: var(--ink);
		color: var(--bg);
		font-weight: 600;
		text-decoration: none;
	}
	.page {
		display: grid;
		gap: 24px;
		margin-top: 8px;
		min-width: 0;
	}
	.create,
	.fields,
	.list,
	.run {
		display: grid;
		gap: 8px;
		min-width: 0;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	legend,
	label {
		font-size: 14px;
		font-weight: 600;
	}
	.other {
		color: var(--muted);
	}
	select {
		min-height: 44px;
		font: inherit;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 44px;
	}
	.check input {
		width: 20px;
		height: 20px;
	}
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.list-head,
	.run-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	h2 {
		margin: 0;
		font-size: 17px;
	}
	.run {
		width: 100%;
		padding: 4px 0;
	}
	.steps {
		margin: 0;
		padding-left: 20px;
		font-size: 14px;
	}
	.steps .pending {
		color: var(--muted);
	}
	.steps .current {
		font-weight: 600;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
		margin: 0;
	}
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--ink);
		font-weight: 600;
	}
</style>
