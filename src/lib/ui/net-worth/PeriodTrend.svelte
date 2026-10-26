<script lang="ts">
	import { formatShortDay, formatShortMonth } from '#lib/shared/dates';
	import { formatMoney } from '#lib/shared/money-format';
	import { useI18n } from '#lib/ui/i18n-context';
	import { amounts, shown } from '#lib/ui/kit/amounts.svelte';

	// FN-53: the net worth per month of a report period, a hand-drawn SVG (no chart library). One slot per point:
	// the opening ("Awal") then each month so far. A month without a snapshot is a gap: no dot, and the line is not
	// drawn across it (a value is never carried past its own date). A partial month (a price or rate missing that
	// day) is a hollow dot. While amounts are hidden the line, its area, its dots and its rising/falling colour are
	// not drawn (TrendChart's rule); the slot labels stay.
	let {
		points,
		label
	}: {
		points: { key: string; date: string | null; minor: number | null; partial: boolean }[];
		label: string;
	} = $props();

	const { tr, locale } = useI18n();
	const W = 320;
	const H = 120;
	const PAD = 10;

	const values = $derived(points.flatMap((p) => (p.minor === null ? [] : [p.minor])));
	const min = $derived(Math.min(...values));
	const max = $derived(Math.max(...values));
	const x = (i: number) =>
		points.length < 2 ? W / 2 : PAD + (i * (W - PAD * 2)) / (points.length - 1);
	const y = (v: number) => (max === min ? H / 2 : PAD + ((max - v) / (max - min)) * (H - PAD * 2));
	const xy = $derived(
		points.map((p, i) => (p.minor === null ? null : { x: x(i), y: y(p.minor), i }))
	);
	/** Runs of consecutive points with a value: each is drawn as its own line, so a gap is never bridged. */
	const runs = $derived.by(() => {
		const out: { x: number; y: number }[][] = [];
		let run: { x: number; y: number }[] = [];
		for (const p of xy) {
			if (p) run.push(p);
			else if (run.length) {
				out.push(run);
				run = [];
			}
		}
		if (run.length) out.push(run);
		return out;
	});
	const firstValue = $derived(points.find((p) => p.minor !== null)?.minor ?? 0);
	const lastValue = $derived(points.findLast((p) => p.minor !== null)?.minor ?? 0);
	const down = $derived(!amounts.hidden && lastValue < firstValue);

	const last = $derived(points.length - 1);
	let picked: number | null = $state(null);
	const selected = $derived(Math.min(picked ?? last, last));
	function step(event: KeyboardEvent) {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
		if (delta === 0) return;
		event.preventDefault();
		picked = Math.min(last, Math.max(0, selected + delta));
	}
	const slot = (i: number) => {
		const p = points[i];
		if (!p) return '';
		if (p.key !== 'awal') return formatShortMonth(p.key, locale);
		// An opening taken inside the period ("sejak …") is named by its date, never "Awal" (start of the period).
		const next = points[i + 1];
		return p.date && next && p.date.slice(0, 7) >= next.key
			? formatShortDay(p.date, locale)
			: tr('Awal');
	};
	const readout = (i: number) => {
		const p = points[i];
		if (!p || p.minor === null) return tr('Belum ada catatan');
		return `${p.date ? formatShortDay(p.date, locale) : ''} · ${shown(formatMoney(p.minor, 'IDR', 'auto', locale))}`;
	};
</script>

<figure class="trend" class:down>
	<figcaption class="pill num" aria-live="polite">
		<span class="slot">{slot(selected)}</span>
		<span>{readout(selected)}</span>
		{#if points[selected]?.partial}
			<span class="partial-note">{tr('Sebagian harga belum tersedia hari itu')}</span>
		{/if}
	</figcaption>
	<!-- A keyboard-steppable image: arrows move the read-out from slot to slot. -->
	<svg
		viewBox="0 0 {W} {H}"
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={0}
		aria-valuemax={last}
		aria-valuenow={selected}
		aria-valuetext="{slot(selected)}: {readout(selected)}"
		onkeydown={step}
	>
		{#each points as p, i (p.key)}
			<line
				class="slot-line"
				class:picked={i === selected}
				x1={x(i)}
				x2={x(i)}
				y1={PAD}
				y2={H - PAD}
			/>
		{/each}
		{#if !amounts.hidden}
			{#each runs as run, r (r)}
				{#if run.length > 1}
					<polyline class="line" points={run.map((p) => `${p.x},${p.y}`).join(' ')} />
				{/if}
			{/each}
			{#each xy as p, i (i)}
				{#if p}
					<circle
						class="dot"
						class:partial={points[i]?.partial}
						class:now={i === selected}
						cx={p.x}
						cy={p.y}
						r={i === selected ? 4.5 : 3.5}
						data-partial={points[i]?.partial ? '1' : undefined}
					/>
				{/if}
			{/each}
		{:else}
			<line class="masked" x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} />
		{/if}
	</svg>
	<p class="axis num" aria-hidden="true">
		<!-- A year's 13 slots do not fit as labels at 360 px: then only the first and last are named. -->
		{#each points as p, i (p.key)}
			{#if points.length <= 7 || i === 0 || i === last}
				<span class:gap={p.minor === null}>{slot(i)}</span>
			{/if}
		{/each}
	</p>
</figure>
<!-- Fewer than two recorded values draw no line, only a lone dot: say why the plot is still empty (POLISH_AUDIT
     B14). The slots stay, so the read-out still steps through the period. -->
{#if values.length < 2}
	<p class="empty">{tr('Grafik tampil setelah beberapa hari pencatatan.')}</p>
{/if}

<style>
	.empty {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.trend {
		display: grid;
		gap: 8px;
		margin: 0;
		--trend: var(--money-in);
	}
	.trend.down {
		--trend: var(--money-up);
	}
	.pill {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		justify-self: start;
		gap: 4px 10px;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		font-size: 13px;
	}
	.slot {
		font-weight: 700;
	}
	.partial-note {
		color: var(--muted);
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	svg:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: 8px;
	}
	.slot-line {
		stroke: var(--line);
		stroke-width: 1;
		stroke-dasharray: 2 4;
	}
	.slot-line.picked {
		stroke-dasharray: none;
	}
	.line {
		fill: none;
		stroke: var(--trend);
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.dot {
		fill: var(--trend);
	}
	/* A partial month: a hollow, lighter dot, so it is never mistaken for a complete figure. */
	.dot.partial {
		fill: var(--bg);
		stroke: var(--muted);
		stroke-width: 1.5;
	}
	.masked {
		stroke: var(--line);
		stroke-width: 2;
		stroke-dasharray: 4 4;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	.axis .gap {
		color: var(--faint);
	}
</style>
