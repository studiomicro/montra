import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cssOf, declarations, type Declaration } from './helpers/css';

const NO_PREFERENCE = /prefers-reduced-motion:\s*no-preference/;
const gated = (d: Declaration) => d.context.some((c) => NO_PREFERENCE.test(c));
const inKeyframes = (d: Declaration) => d.context.some((c) => c.startsWith('@keyframes'));

const MOTION_FILES = [
	'src/lib/ui/kit/HeroAmount.svelte',
	'src/lib/ui/kit/BarChart.svelte',
	'src/lib/ui/kit/MonthLines.svelte',
	'src/lib/ui/charts/HeatCalendar.svelte',
	'src/lib/ui/charts/FlowChart.svelte',
	'src/lib/ui/kit/GroupList.svelte',
	'src/lib/ui/kit/GroupRow.svelte',
	'src/lib/ui/kit/Chip.svelte',
	'src/lib/ui/shell/Sheet.svelte',
	'src/lib/ui/kit/Illustration.svelte',
	'src/lib/ui/kit/Mascot.svelte',
	// FN-51
	'src/lib/ui/kit/DayHeader.svelte',
	'src/lib/ui/kit/Skeleton.svelte',
	'src/lib/ui/kit/ProgressBar.svelte',
	'src/lib/ui/kit/CategoryBar.svelte',
	'src/lib/ui/kit/MascotLoading.svelte',
	'src/lib/ui/charts/Donut.svelte',
	'src/lib/ui/charts/CumulativeChart.svelte',
	'src/lib/ui/charts/StackedBars.svelte',
	'src/lib/ui/net-worth/TrendChart.svelte',
	'src/lib/ui/net-worth/AllocationBar.svelte',
	'src/lib/ui/net-worth/CreditCardCard.svelte',
	'src/lib/ui/shell/TabBar.svelte',
	'src/lib/ui/shell/PullToRefresh.svelte',
	'src/lib/ui/pwa/InstallHint.svelte',
	'src/lib/ui/pwa/WhatsNew.svelte',
	'src/lib/ui/pwa/UpdateBanner.svelte',
	'src/lib/ui/offline-queue/OfflineQueueStatus.svelte',
	'src/routes/(app)/+page.svelte',
	'src/routes/(app)/dompet/+page.svelte',
	// FN-54: static by design (only Koko's finite blink and the existing count-up move on Beranda's hero).
	'src/lib/ui/home/GreetingHero.svelte',
	'src/lib/ui/home/HeroScene.svelte',
	'src/lib/ui/home/BudgetChip.svelte',
	'src/lib/ui/home/FeatureTiles.svelte',
	'src/lib/ui/home/DailyStory.svelte',
	'src/lib/ui/kit/CalendarBadge.svelte',
	'src/lib/ui/kit/FeatureChip.svelte',
	'src/routes/(app)/kalender/+page.svelte'
];

/** The files FN-51 added or changed: their durations are tokens (FN-40's illustrations and Koko's poses keep theirs). */
const FN51_FILES = MOTION_FILES.slice(
	MOTION_FILES.indexOf('src/lib/ui/kit/DayHeader.svelte')
).filter((f) => f !== 'src/lib/ui/kit/MascotLoading.svelte');

/** The only files allowed an `infinite` animation: both leave the DOM with the loading branch. */
const LOADING_ONLY = ['src/lib/ui/kit/Skeleton.svelte', 'src/lib/ui/kit/MascotLoading.svelte'];

/** What a keyframe may change: compositor-only properties, and the SVG draw. */
const KEYFRAME_PROPERTIES = new Set([
	'transform',
	'opacity',
	'stroke-dashoffset',
	// Svelte scopes nothing inside @keyframes; the shimmer and Koko's strips use these two shorthands too.
	'animation-timing-function'
]);
/** The durations a motion may take: a token, or 0s/none. */
const DURATION_TOKEN =
	/var\(--duration-(fast|base|slow|loop)\)|\b0s\b|\bnone\b|\bsteps\(|^(idle|wave|hop|celebrate|sleep|walk|appear|float|shadow|drift)/;

describe('FN-40/FN-51 motion is off under prefers-reduced-motion: reduce', () => {
	it('the scanner finds declarations and their at-rules', () => {
		const found = declarations(
			'@media (prefers-reduced-motion: no-preference) { .a { animation: x 1s } } .b { color: red; }'
		);
		expect(found).toEqual([
			{
				property: 'animation',
				value: 'x 1s',
				context: ['@media (prefers-reduced-motion: no-preference)', '.a']
			},
			{ property: 'color', value: 'red', context: ['.b'] }
		]);
	});

	it.each(MOTION_FILES)('%s: every animation runs only when motion is allowed', (file) => {
		const animations = declarations(cssOf(file)).filter((d) => d.property.startsWith('animation'));
		for (const d of animations) expect(gated(d), `${d.property}: ${d.value}`).toBe(true);
	});

	it.each(MOTION_FILES)('%s: nothing animates forever unless it is a loading indicator', (file) => {
		const animations = declarations(cssOf(file)).filter((d) => d.property.startsWith('animation'));
		for (const d of animations) {
			if (LOADING_ONLY.includes(file)) continue;
			expect(d.value, `${file} ${d.value}`).not.toMatch(/infinite/);
		}
	});

	it('an infinite animation anywhere under src/lib/ui sits in a loading-only file', () => {
		const files = readdirSync('src/lib/ui', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.svelte'))
			.map((d) => join(d.parentPath, d.name));
		const looping = files.filter((file) =>
			declarations(cssOf(file)).some(
				(d) => d.property.startsWith('animation') && /infinite/.test(d.value)
			)
		);
		expect(looping.sort()).toEqual([...LOADING_ONLY].sort());
	});

	it('every <Skeleton> under src/routes sits in a loading branch ({#if …loading…} or aria-busy)', () => {
		const files = readdirSync('src/routes', { recursive: true, withFileTypes: true })
			.filter((d) => d.isFile() && d.name.endsWith('.svelte'))
			.map((d) => join(d.parentPath, d.name));
		const bare: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			for (const match of text.matchAll(/<Skeleton\b/g)) {
				const before = text.slice(0, match.index);
				// The branch the call sits in: walking back, the first {#if …} or {:else if …} at depth 0.
				const tokens = [...before.matchAll(/\{#if\s+([^}]*)\}|\{:else if\s+([^}]*)\}|\{\/if\}/g)];
				let depth = 0;
				let branch: string | undefined;
				for (const token of tokens.reverse()) {
					if (token[0] === '{/if}') depth++;
					else if (token[0].startsWith('{#if')) {
						if (depth === 0) {
							branch = token[1];
							break;
						}
						depth--;
					} else if (depth === 0) {
						branch = token[2];
						break;
					}
				}
				const busyWrapper = /aria-busy="true"[^<]*>\s*$/.test(before);
				const loading =
					(branch !== undefined && /loading|navigating|refreshing|reading|busy/i.test(branch)) ||
					busyWrapper;
				if (!loading) bare.push(`${file} (${branch ?? 'no if'})`);
			}
		}
		expect(bare).toEqual([]);
	});

	it.each(MOTION_FILES)(
		'%s: keyframes change transform, opacity or stroke-dashoffset only',
		(file) => {
			const frames = declarations(cssOf(file)).filter(inKeyframes);
			for (const d of frames)
				expect(
					KEYFRAME_PROPERTIES.has(d.property),
					`${file} @keyframes ${d.property}: ${d.value}`
				).toBe(true);
		}
	);

	it('the keyframe-property rule fails when a width keyframe is planted', () => {
		const planted = declarations(
			'@keyframes grow { from { width: 0; opacity: 0 } } @media (prefers-reduced-motion: no-preference) { .a { animation: grow 200ms } }'
		).filter(inKeyframes);
		expect(planted.map((d) => d.property)).toEqual(['width', 'opacity']);
		expect(planted.every((d) => KEYFRAME_PROPERTIES.has(d.property))).toBe(false);
	});

	it.each(FN51_FILES)(
		'%s: every animation duration is a --duration token (≤ 300 ms, or the loop)',
		(file) => {
			const durations = declarations(cssOf(file)).filter(
				(d) => d.property === 'animation' || d.property === 'animation-duration'
			);
			for (const d of durations)
				expect(d.value, `${file} ${d.property}: ${d.value}`).toMatch(DURATION_TOKEN);
		}
	);

	it('the sheet opens and closes with transitions only when motion is allowed', () => {
		const all = declarations(cssOf('src/lib/ui/shell/Sheet.svelte'));
		const transitions = all.filter((d) => d.property.startsWith('transition'));
		expect(transitions.length).toBeGreaterThan(0);
		for (const d of transitions) expect(gated(d), d.value).toBe(true);
		// The open state starts from below (@starting-style) and the closing state sinks back.
		expect(all.some((d) => d.context.some((c) => c.startsWith('@starting-style')))).toBe(true);
		expect(
			all.some(
				(d) => d.property === 'transform' && d.context.some((c) => c.includes(':not([open])'))
			)
		).toBe(true);
	});

	it('FN-51: the desktop dialog scales in from 0.96 (gated, ≥ 1024 px) and the body fades in after the sheet', () => {
		const all = declarations(cssOf('src/lib/ui/shell/Sheet.svelte'));
		const scales = all.filter((d) => d.property === 'transform' && /scale\(0\.96\)/.test(d.value));
		expect(scales.length).toBe(2);
		for (const d of scales) {
			expect(gated(d)).toBe(true);
			expect(d.context.some((c) => /min-width:\s*1024px/.test(c))).toBe(true);
		}
		expect(scales.some((d) => d.context.some((c) => c.startsWith('@starting-style')))).toBe(true);
		const body = all.find(
			(d) => d.property === 'animation' && d.context.at(-1)?.includes('sheet-body')
		);
		expect(body?.value).toMatch(/var\(--duration-base\) var\(--ease\) 40ms backwards/);
		expect(gated(body!)).toBe(true);
	});

	it('FN-51: the Tambah "+" turns 45° as state; only the turn (the transition) is gated', () => {
		const all = declarations(cssOf('src/lib/ui/shell/TabBar.svelte'));
		const turned = all.find((d) => d.property === 'transform' && /rotate\(45deg\)/.test(d.value));
		expect(turned?.context.at(-1)).toMatch(/\[aria-expanded='true'\]/);
		const turn = all.filter(
			(d) => d.property === 'transition' && d.context.at(-1)?.match(/\.plus/)
		);
		expect(turn.length).toBe(1);
		expect(gated(turn[0]!)).toBe(true);
	});

	it('the chip and checkbox-row press scale are gated too', () => {
		for (const file of ['src/lib/ui/kit/Chip.svelte']) {
			const transforms = declarations(cssOf(file)).filter(
				(d) => d.property === 'transform' && !inKeyframes(d)
			);
			expect(transforms.length).toBeGreaterThan(0);
			for (const d of transforms) expect(gated(d), `${file} ${d.value}`).toBe(true);
		}
		const row = declarations(cssOf('src/lib/ui/kit/GroupRow.svelte')).filter(
			(d) =>
				d.property === 'transform' &&
				d.context.some((c) => /\.selectable(\.svelte-\w+)?:active/.test(c))
		);
		expect(row.length).toBe(1);
		expect(gated(row[0]!)).toBe(true);
	});

	it('the global reduce rule turns the pre-existing press and hover transitions off', () => {
		const app = readFileSync('src/app.css', 'utf8');
		// 0s, not 0.01 ms: a tiny transition still starts and shows the old value for a frame.
		expect(app).toMatch(
			/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 0s !important;\s*transition-delay: 0s !important/
		);
	});
});

describe('FN-51 desktop hover/focus lift', () => {
	const LIFT_FILES = [
		'src/lib/ui/kit/GroupRow.svelte',
		'src/lib/ui/net-worth/CreditCardCard.svelte',
		'src/routes/(app)/dompet/+page.svelte'
	];
	const DESKTOP_FINE = (c: string) =>
		/min-width:\s*1024px/.test(c) && /hover:\s*hover/.test(c) && /pointer:\s*fine/.test(c);

	it.each(LIFT_FILES)(
		'%s: the 1 px rise needs a wide screen, a fine pointer and motion; colour alone otherwise',
		(file) => {
			const all = declarations(cssOf(file));
			const lifts = all.filter(
				(d) => d.property === 'transform' && /translateY\(-1px\)/.test(d.value)
			);
			expect(lifts.length).toBeGreaterThan(0);
			for (const d of lifts) {
				expect(d.context.some(DESKTOP_FINE), d.context.join(' > ')).toBe(true);
				expect(gated(d), d.context.join(' > ')).toBe(true);
				expect(d.context.at(-1)).toMatch(/:hover|:focus/);
			}
			// The hover colour sits in the desktop query but outside the motion one (reduce still shows it).
			const colours = all.filter(
				(d) =>
					d.property === 'background' &&
					d.value === 'var(--panel-2)' &&
					d.context.some(DESKTOP_FINE) &&
					/:hover/.test(d.context.at(-1) ?? '')
			);
			expect(colours.length).toBeGreaterThan(0);
			for (const d of colours) expect(gated(d)).toBe(false);
			// No shadow joins the lift (principle 5).
			for (const d of all.filter((d) => d.context.some(DESKTOP_FINE)))
				expect(d.property, `${file} ${d.property}`).not.toBe('box-shadow');
		}
	);

	it('GroupRow keeps its focus ring rules and the press scale', () => {
		const text = readFileSync('src/lib/ui/kit/GroupRow.svelte', 'utf8');
		expect(text).toMatch(/\.tappable:active\s*\{\s*transform: scale\(var\(--press-scale\)\)/);
		expect(text).toMatch(/\.selectable:active\s*\{\s*transform: scale\(var\(--press-scale\)\)/);
	});
});

describe('FN-51 charts and bars draw in on mount, end on the final geometry', () => {
	it('ProgressBar: aria-valuenow and the fill width are the final value from the first frame', async () => {
		const ProgressBar = (await import('../src/lib/ui/kit/ProgressBar.svelte')).default;
		const { body } = render(ProgressBar, { props: { percent: 62, label: 'Anggaran terpakai' } });
		expect(body).toContain('aria-valuenow="62"');
		expect(body).toContain('aria-valuetext="62%"');
		expect(body).toMatch(/<rect class="fill ink[^"]*" x="0" y="0" width="62"/);
		const fill = declarations(cssOf('src/lib/ui/kit/ProgressBar.svelte')).filter(
			(d) => d.context.at(-1)?.includes('.fill') && !inKeyframes(d)
		);
		expect(fill.find((d) => d.property === 'transform-origin')?.value).toBe('0 50%');
		expect(fill.find((d) => d.property === 'transform-box')?.value).toBe('fill-box');
		expect(fill.find((d) => d.property === 'animation')?.value).toMatch(
			/fill-in var\(--duration-slow\) var\(--ease\) backwards/
		);
	});

	it('Skeleton: at most 8 bars, each with the shimmer band only when motion is allowed', async () => {
		const Skeleton = (await import('../src/lib/ui/kit/Skeleton.svelte')).default;
		const { body } = render(Skeleton, { props: { rows: 20 } });
		expect(body.match(/class="bar/g)?.length).toBe(8);
		expect(render(Skeleton, { props: { rows: 3 } }).body.match(/class="bar/g)?.length).toBe(3);
		const all = declarations(cssOf('src/lib/ui/kit/Skeleton.svelte'));
		const band = all.filter((d) => d.context.at(-1)?.includes('::after'));
		expect(band.length).toBeGreaterThan(0);
		for (const d of band) expect(gated(d)).toBe(true);
		expect(band.find((d) => d.property === 'animation')?.value).toMatch(
			/shimmer var\(--duration-loop\) var\(--ease-in-out\) infinite/
		);
		// The old opacity pulse and its `reduce` override are gone: reduce means flat --panel-2 bars.
		expect(all.some((d) => d.context.some((c) => /prefers-reduced-motion:\s*reduce/.test(c)))).toBe(
			false
		);
	});

	it('Donut turns its slice group about the centre; the dash lengths are not animated', () => {
		const all = declarations(cssOf('src/lib/ui/charts/Donut.svelte'));
		const group = all.filter((d) => d.context.at(-1)?.includes('.slices'));
		expect(group.find((d) => d.property === 'transform-origin')?.value).toBe('21px 21px');
		expect(group.find((d) => d.property === 'animation')?.value).toMatch(
			/slices-in var\(--duration-slow\)/
		);
		expect(all.some((d) => inKeyframes(d) && d.property.startsWith('stroke-dash'))).toBe(false);
	});

	it.each([
		['src/lib/ui/charts/CumulativeChart.svelte', 'polyline'],
		['src/lib/ui/net-worth/TrendChart.svelte', '.line']
	])('%s: the line draws with pathLength="1" and stroke-dashoffset 1 → 0', (file, selector) => {
		expect(readFileSync(file, 'utf8')).toContain('pathLength="1"');
		const all = declarations(cssOf(file));
		const line = all.filter((d) => d.context.at(-1)?.includes(selector) && gated(d));
		expect(line.find((d) => d.property === 'stroke-dasharray')?.value).toBe('1');
		expect(line.find((d) => d.property === 'animation')?.value).toMatch(
			/draw var\(--duration-slow\)/
		);
		expect(all.find((d) => inKeyframes(d) && d.property === 'stroke-dashoffset')?.value).toBe('1');
	});

	it('StackedBars grows each bar from its baseline', () => {
		const seg = declarations(cssOf('src/lib/ui/charts/StackedBars.svelte')).filter(
			(d) => d.context.at(-1)?.includes('.seg') && gated(d)
		);
		expect(seg.find((d) => d.property === 'transform-origin')?.value).toBe('50% 100%');
		expect(seg.find((d) => d.property === 'transform-box')?.value).toBe('fill-box');
		expect(seg.find((d) => d.property === 'animation')?.value).toMatch(
			/bar-grow var\(--duration-base\)/
		);
	});

	it.each(['src/lib/ui/kit/CategoryBar.svelte', 'src/lib/ui/net-worth/AllocationBar.svelte'])(
		'%s: segments fade in 30 ms apart, the first 8 only, with no width keyframe',
		(file) => {
			const rules = declarations(cssOf(file));
			const animated = rules.filter((d) => d.property === 'animation');
			expect(animated).toHaveLength(1);
			expect(animated[0]!.context.at(-1)?.replace(/\s/g, '')).toMatch(
				/rect[^:]*:nth-child\(-n\+8\)/
			);
			const delays = rules.filter((d) => d.property === 'animation-delay');
			expect(delays.map((d) => Number.parseInt(d.value, 10))).toEqual([
				30, 60, 90, 120, 150, 180, 210
			]);
			expect(rules.filter(inKeyframes).map((d) => d.property)).toEqual(['opacity']);
		}
	);

	it('charts keep their {#each} keys, so a filter re-render never replays the draw-in', () => {
		for (const file of [
			'src/lib/ui/charts/Donut.svelte',
			'src/lib/ui/charts/StackedBars.svelte',
			'src/lib/ui/kit/CategoryBar.svelte',
			'src/lib/ui/net-worth/AllocationBar.svelte'
		]) {
			const text = readFileSync(file, 'utf8');
			const eachBlocks = text.match(/\{#each [^}]*\}/g) ?? [];
			expect(eachBlocks.length).toBeGreaterThan(0);
			for (const block of eachBlocks) expect(block, `${file} ${block}`).toMatch(/\([^)]+\)\}$/);
		}
	});
});

describe('FN-51 banners, chip and pull-to-refresh', () => {
	it.each([
		['src/lib/ui/pwa/InstallHint.svelte', '.hint'],
		['src/lib/ui/pwa/WhatsNew.svelte', '.whats-new'],
		['src/lib/ui/pwa/UpdateBanner.svelte', '.update'],
		['src/lib/ui/offline-queue/OfflineQueueStatus.svelte', '.notice']
	])('%s: enters with a 6 px slide and fade, gated; no height keyframe', (file, selector) => {
		const rules = declarations(cssOf(file));
		const enter = rules.find(
			(d) => d.property === 'animation' && d.context.at(-1)?.includes(selector)
		);
		expect(enter?.value).toMatch(/banner-in var\(--duration-base\) var\(--ease\) backwards/);
		expect(gated(enter!)).toBe(true);
		const frames = rules.filter(inKeyframes);
		expect(frames.map((d) => d.property).sort()).toEqual(['opacity', 'transform']);
		expect(frames.find((d) => d.property === 'transform')?.value).toBe('translateY(-6px)');
	});

	it('Beranda: the streak chip hop is a gated --spring hop; Koko’s welcome wave runs one cycle', () => {
		const rules = declarations(cssOf('src/routes/(app)/+page.svelte'));
		const hop = rules.find((d) => d.property === 'animation' && d.context.at(-1)?.includes('.hop'));
		expect(hop?.value).toMatch(/chip-hop var\(--duration-slow\) var\(--spring\)/);
		expect(gated(hop!)).toBe(true);
		const once = rules.find((d) => d.property === 'animation-iteration-count');
		expect(once?.value).toBe('1');
		expect(gated(once!)).toBe(true);
		expect(rules.filter(inKeyframes).map((d) => d.property)).toEqual(['transform']);
	});

	it('PullToRefresh: parked above the edge by transform/opacity; only its transition is gated', () => {
		const rules = declarations(cssOf('src/lib/ui/shell/PullToRefresh.svelte'));
		const base = rules.filter((d) => d.context.at(-1)?.match(/\.pull(?!\.on)/) && !gated(d));
		expect(base.find((d) => d.property === 'transform')?.value).toBe('translate(-50%, -48px)');
		expect(base.find((d) => d.property === 'opacity')?.value).toBe('0');
		const on = rules.filter((d) => d.context.at(-1)?.includes('.pull.on'));
		expect(on.map((d) => d.property).sort()).toEqual(['opacity', 'transform']);
		const transitions = rules.filter((d) => d.property.startsWith('transition'));
		expect(transitions.length).toBe(1);
		for (const d of transitions) {
			expect(gated(d)).toBe(true);
			// Only transform and opacity move; the finger-follow is a paused Web Animation, not a CSS animation.
			expect(
				d.value.match(/\b(transform|opacity|top|height|margin|background)\b/g)?.sort()
			).toEqual(['opacity', 'transform']);
		}
		for (const d of rules) expect(d.property).not.toMatch(/^animation/);
	});
});

describe('FN-40 list stagger is capped', () => {
	const rules = declarations(cssOf('src/lib/ui/kit/GroupList.svelte'));
	const childOf = (d: Declaration) => d.context.at(-1)?.match(/li:nth-child\(([^)]*)\)/)?.[1];

	it('only the first 8 rows animate, whatever the list length', () => {
		const animated = rules.filter((d) => d.property === 'animation');
		expect(animated).toHaveLength(1);
		expect(childOf(animated[0]!)?.replace(/\s/g, '')).toBe('-n+8');
	});

	it('the per-row delay stops at row 8 (≤ 210 ms): a 500-row day adds no delay past it', () => {
		const delays = rules.filter((d) => d.property === 'animation-delay');
		const rows = delays.map((d) => Number(childOf(d)));
		expect(rows).toEqual([2, 3, 4, 5, 6, 7, 8]);
		const ms = delays.map((d) => Number.parseInt(d.value, 10));
		expect(Math.max(...ms)).toBeLessThanOrEqual(210);
		// Row 9 and later match neither the animation (li:nth-child(-n+8) means rows 1–8) nor a delay.
		const cap = Number(
			childOf(rules.find((d) => d.property === 'animation')!)?.match(/-n\s*\+\s*(\d+)/)?.[1]
		);
		for (const n of [9, 10, 100, 500]) {
			expect(n <= cap).toBe(false);
			expect(rows).not.toContain(n);
		}
	});
});
