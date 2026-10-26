import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio, readTokens } from '#lib/shared/contrast';
import { themeColors } from '#lib/server/prefs';
import { SIDEBAR_SECTIONS } from '#lib/ui/shell/nav';

const css = readFileSync('docs/design/tokens.css', 'utf8');
const LIGHT = ':root {';
const DARK_MEDIA = ":root:not([data-theme='light']) {";
const DARK = ":root[data-theme='dark'] {";
// Mono (FN-40): one cookie value; its light greys, and the dark greys in a prefers-color-scheme block that
// also takes the dark scheme's own block (money, brand, shadows) underneath.
const MONO = ":root[data-theme='mono'] {";
const MONO_DARK = "@media (prefers-color-scheme: dark) {\n\t:root[data-theme='mono'] {";

const light = readTokens(css, LIGHT);
const dark = { ...light, ...readTokens(css, DARK) };
const monoLight = { ...light, ...readTokens(css, MONO) };
const monoDark = {
	...light,
	...readTokens(css, DARK_MEDIA),
	...readTokens(css, MONO),
	...readTokens(css, MONO_DARK)
};
// FN-46 Pro themes: structured like mono (a light block, and a dark block in a prefers-color-scheme block).
const GOLD = ":root[data-theme='gold'] {";
const GOLD_DARK = "@media (prefers-color-scheme: dark) {\n\t:root[data-theme='gold'] {";
const EMERALD = ":root[data-theme='emerald'] {";
const EMERALD_DARK = "@media (prefers-color-scheme: dark) {\n\t:root[data-theme='emerald'] {";
const schemes = (lightBlock: string, darkBlock: string) => ({
	light: { ...light, ...readTokens(css, lightBlock) },
	dark: {
		...light,
		...readTokens(css, DARK_MEDIA),
		...readTokens(css, lightBlock),
		...readTokens(css, darkBlock)
	}
});
const gold = schemes(GOLD, GOLD_DARK);
const emerald = schemes(EMERALD, EMERALD_DARK);
const THEMES: [string, Record<string, string>][] = [
	['light', light],
	['dark', dark],
	['mono-light', monoLight],
	['mono-dark', monoDark],
	['gold', gold.light],
	['gold-dark', gold.dark],
	['emerald', emerald.light],
	['emerald-dark', emerald.dark]
];

const TEXT_PAIRS: [string, string][] = [
	['--ink', '--bg'],
	['--ink-2', '--bg'],
	['--muted', '--bg'],
	['--muted', '--panel'],
	['--money-in', '--bg'],
	['--money-in', '--panel'],
	['--money-up', '--bg'],
	['--money-up', '--panel'],
	['--same', '--bg'],
	['--brand', '--bg'],
	['--warn-text', '--bg'],
	['--warn-text', '--panel'],
	['--ink', '--raised'],
	['--on-dark', '--dark'],
	['--on-dark-muted', '--dark'],
	// UI polish: the "Segera" badge on Beranda's Struk button, the Langganan due chip (today/tomorrow inverted).
	['--ink-2', '--panel-2'],
	['--bg', '--ink'],
	// FN-40 glass: text on a glass surface is checked against its opaque fallback (reduced transparency, no
	// backdrop-filter, under a sheet); the soft glass falls back to --bg, covered above.
	['--ink', '--glass-solid'],
	['--ink-2', '--glass-solid'],
	['--muted', '--glass-solid'],
	// FN-46 Pro look: the badge's word; Beranda's hero frame and the Paket card (a gradient from --pro-soft to
	// --panel, so the figure, its "Rp", the context line and its money colours are checked on both ends).
	['--pro-text', '--pro-soft'],
	['--ink', '--pro-soft'],
	['--muted', '--pro-soft'],
	['--money-in', '--pro-soft'],
	['--money-up', '--pro-soft'],
	['--same', '--pro-soft'],
	// FN-56: the brightest glyph tier of the sign-in/sign-up ASCII field on its card (decorative, still AA).
	['--on-brand-surface', '--brand-surface']
];

describe('contrastRatio', () => {
	it('matches known values', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
		expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
	});
});

describe.each(THEMES)('AA text contrast (%s)', (_name, tokens) => {
	it.each(TEXT_PAIRS)('%s on %s ≥ 4.5', (fg, bg) => {
		const a = tokens[fg];
		const b = tokens[bg];
		expect(a, fg).toBeDefined();
		expect(b, bg).toBeDefined();
		expect(contrastRatio(a as string, b as string)).toBeGreaterThanOrEqual(4.5);
	});
});

/**
 * Non-text contrast (WCAG 1.4.11, 3:1): the ProgressBar fill against its track and the row behind it; the data
 * accent (today's bar, trend line) and the amber "ahead of pace" bar against the surfaces they sit on.
 */
const GRAPHIC_PAIRS: [string, string][] = [
	['--ink', '--chart-track'],
	['--ink', '--panel'],
	['--accent', '--bg'],
	['--accent', '--panel'],
	['--accent', '--chart-bar'],
	['--warn', '--bg'],
	['--warn', '--panel'],
	// FN-46: the crown (Koko on the page, the badge on its pill).
	['--pro', '--bg'],
	['--pro', '--panel'],
	['--pro', '--pro-soft'],
	// FN-25b: the net-worth class colours (allocation bar segments on the page, chip dots on their panel pill).
	...['wallets', 'cash', 'investment', 'crypto', 'gold', 'property'].flatMap(
		(cls): [string, string][] => [
			[`--nw-${cls}`, '--bg'],
			[`--nw-${cls}`, '--panel']
		]
	)
];

describe.each(THEMES)('AA graphics contrast (%s)', (_name, tokens) => {
	it.each(GRAPHIC_PAIRS)('%s on %s ≥ 3', (fg, bg) => {
		expect(contrastRatio(tokens[fg] as string, tokens[bg] as string)).toBeGreaterThanOrEqual(3);
	});
});

/** Every custom property declared in the first block starting with `selector`, raw value (any colour form). */
function declarations(selector: string): Record<string, string> {
	const start = css.indexOf(selector);
	if (start < 0) throw new Error(`selector not found: ${selector}`);
	const block = css.slice(start, css.indexOf('}', start));
	return Object.fromEntries(
		[...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? '').trim()])
	);
}

/** The rgb triplets of every #rrggbb and rgb()/rgba() literal in a value. */
function colours(value: string): [number, number, number][] {
	const hex = [...value.matchAll(/#([0-9a-f]{6})\b/gi)].map(
		(m) =>
			[0, 2, 4].map((i) => parseInt((m[1] ?? '').slice(i, i + 2), 16)) as [number, number, number]
	);
	const rgb = [...value.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)].map(
		(m) => [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]
	);
	return [...hex, ...rgb];
}

/** The meaning colours that keep their hue in mono (owner decisions 2 and 3, FN-40 PRD). */
const MONO_KEEPS_HUE = new Set([
	'--money-in',
	'--money-up',
	'--brand',
	'--brand-deep',
	'--brand-soft'
]);

describe('mono theme (FN-40)', () => {
	const raw = {
		light: declarations(LIGHT),
		darkMedia: declarations(DARK_MEDIA),
		mono: declarations(MONO),
		monoDark: declarations(MONO_DARK)
	};
	const effective = {
		'mono-light': { ...raw.light, ...raw.mono },
		'mono-dark': { ...raw.light, ...raw.darkMedia, ...raw.mono, ...raw.monoDark }
	};

	it.each(Object.entries(effective))(
		'%s: every colour but money and brand is achromatic (glass included)',
		(_name, tokens) => {
			const tinted = Object.entries(tokens)
				.filter(([name]) => !MONO_KEEPS_HUE.has(name))
				.filter(([, value]) => colours(value).some(([r, g, b]) => r !== g || g !== b));
			expect(tinted).toEqual([]);
			expect(colours(tokens['--glass-bg'] ?? '')).not.toEqual([]);
		}
	);

	it('money in/out keep their colour in mono, per scheme', () => {
		expect(monoLight['--money-in']).toBe(light['--money-in']);
		expect(monoLight['--money-up']).toBe(light['--money-up']);
		expect(monoDark['--money-in']).toBe(dark['--money-in']);
		expect(monoDark['--money-up']).toBe(dark['--money-up']);
		for (const hex of [monoLight['--money-in'], monoLight['--money-up'], monoDark['--money-up']]) {
			const [[r, g, b]] = colours(hex ?? '') as [[number, number, number]];
			expect(r === g && g === b).toBe(false);
		}
	});

	it('the dark half re-declares every mono token the dark scheme changes', () => {
		const changedByDark = Object.keys(raw.darkMedia).filter((name) => name in raw.mono);
		expect(changedByDark.length).toBeGreaterThan(0);
		expect(changedByDark.filter((name) => !(name in raw.monoDark))).toEqual([]);
	});

	it('both halves declare every glass token themselves, the dark half with dark values', () => {
		const glass = Object.keys(raw.light).filter((name) => name.startsWith('--glass-'));
		expect(glass).toEqual(expect.arrayContaining(['--glass-border', '--glass-shadow']));
		expect(glass.filter((name) => !(name in raw.mono))).toEqual([]);
		expect(glass.filter((name) => !(name in raw.monoDark) && name in raw.darkMedia)).toEqual([]);
		// Where the dark scheme differs from light, mono's dark half differs from mono's light half too.
		const leaked = glass.filter(
			(name) =>
				name in raw.darkMedia &&
				raw.darkMedia[name] !== raw.light[name] &&
				raw.monoDark[name] === raw.mono[name]
		);
		expect(leaked).toEqual([]);
	});

	it('mono greys differ from light and dark (the theme is not a no-op)', () => {
		expect(monoLight['--panel']).not.toBe(light['--panel']);
		expect(monoDark['--bg']).not.toBe(dark['--bg']);
	});
});

describe('Pro themes (FN-46)', () => {
	const raw = {
		light: declarations(LIGHT),
		darkMedia: declarations(DARK_MEDIA)
	};
	it.each([
		['gold', GOLD, GOLD_DARK, gold],
		['emerald', EMERALD, EMERALD_DARK, emerald]
	] as const)('%s: the dark half re-declares every token the light half sets', (_n, lo, hi, t) => {
		const lightHalf = declarations(lo);
		const darkHalf = declarations(hi);
		expect(Object.keys(lightHalf).filter((name) => !(name in darkHalf))).toEqual([]);
		// Where the dark scheme differs from light, the theme's dark half differs from its light half too. A var()
		// reference (FN-57 `--action: var(--ink)`) follows the half's own values, so the same text is no leak.
		const leaked = Object.keys(lightHalf).filter(
			(name) =>
				raw.darkMedia[name] !== raw.light[name] &&
				darkHalf[name] === lightHalf[name] &&
				!lightHalf[name]!.startsWith('var(')
		);
		expect(leaked).toEqual([]);
		expect(t.light['--bg']).not.toBe(light['--bg']);
		expect(t.dark['--bg']).not.toBe(dark['--bg']);
	});

	it.each([
		['gold', gold],
		['emerald', emerald]
	] as const)(
		'%s: money in/out, ink and the brand keep the base scheme’s colours (colour only for meaning)',
		(_n, t) => {
			for (const name of ['--money-in', '--money-up', '--brand', '--ink', '--warn-text']) {
				expect(t.light[name], name).toBe(light[name]);
				expect(t.dark[name], name).toBe(dark[name]);
			}
			// The data accent never takes a money hue.
			for (const scheme of [t.light, t.dark])
				expect([scheme['--money-in'], scheme['--money-up']]).not.toContain(scheme['--accent']);
		}
	);

	it('mono turns the Pro look grey: crown, badge and hero frame are achromatic in both halves', () => {
		for (const tokens of [monoLight, monoDark])
			for (const name of ['--pro', '--pro-text', '--pro-soft']) {
				const [[r, g, b]] = colours(tokens[name] ?? '') as [[number, number, number]];
				expect(r === g && g === b, name).toBe(true);
			}
	});
});

describe('theme-color meta (hooks.server.ts)', () => {
	it.each([
		['system', light, dark],
		['light', light, light],
		['dark', dark, dark],
		['mono', monoLight, monoDark],
		['gold', gold.light, gold.dark],
		['emerald', emerald.light, emerald.dark]
	] as const)('%s matches --bg of the scheme it shows', (theme, lightScheme, darkScheme) => {
		expect(themeColors(theme)).toEqual({ light: lightScheme['--bg'], dark: darkScheme['--bg'] });
	});
});

describe('dark theme blocks', () => {
	it('prefers-color-scheme block matches the data-theme dark block', () => {
		const media = readTokens(css, ":root:not([data-theme='light']) {");
		const explicit = readTokens(css, ":root[data-theme='dark'] {");
		expect(Object.keys(media).length).toBeGreaterThan(0);
		expect(media).toEqual(explicit);
	});
});

/**
 * The heatmap calendar's day numbers (HeatCalendar.svelte): the text and fill of every shade, read from the
 * component's own CSS so a hard-coded colour or a new pair cannot slip past. A level's text is its own `color`
 * or the cell's; level 4 may draw the number on its own `.l4 .day` dot instead of the darkest fill.
 */
const heatCss =
	readFileSync('src/lib/ui/charts/HeatCalendar.svelte', 'utf8').split('<style>')[1] ?? '';
function block(selector: string): string | undefined {
	const at = heatCss.indexOf(`\n\t${selector} {`);
	return at < 0 ? undefined : heatCss.slice(at, heatCss.indexOf('}', at));
}
const prop = (body: string | undefined, name: string) =>
	body ? new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() : undefined;
const token = (value: string | undefined) => /^var\((--[\w-]+)\)$/.exec(value ?? '')?.[1];

function heatTextPairs(): { level: number; fg: string | undefined; bg: string | undefined }[] {
	const cellText = prop(block('.cell'), 'color');
	return [0, 1, 2, 3, 4].map((level) => {
		const dot = level === 4 ? block('.l4 .day') : undefined;
		const own = block(`.l${level}`);
		return dot
			? { level, fg: prop(dot, 'color'), bg: prop(dot, 'background') }
			: { level, fg: prop(own, 'color') ?? cellText, bg: prop(own, 'background') };
	});
}

describe.each(THEMES)('AA heatmap day numbers (%s)', (_name, tokens) => {
	it.each(heatTextPairs())('level $level: $fg on $bg is a token pair ≥ 4.5', ({ fg, bg }) => {
		const a = token(fg);
		const b = token(bg);
		expect(a, `text ${fg}`).toBeDefined();
		expect(b, `fill ${bg}`).toBeDefined();
		expect(contrastRatio(tokens[a!] as string, tokens[b!] as string)).toBeGreaterThanOrEqual(4.5);
	});
});

/**
 * FN-54: the feature chips (the glyph in --ink-2 on `color-mix(--cat-<tone> 16%, --bg)`, FeatureChip.svelte) for every
 * hue the registry uses, and the calendar badge (the month in --bg on the --ink band, the day in --ink on --bg).
 */
const mix = (a: string, b: string, share: number) => {
	const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
	return (
		'#' +
		[0, 1, 2]
			.map((i) =>
				Math.round(ch(a, i) * share + ch(b, i) * (1 - share))
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
};
const CHIP_TONES = [
	...new Set(SIDEBAR_SECTIONS.flatMap((s) => s.items.map((i) => `--cat-${i.tone}`)))
];

describe.each(THEMES)('FN-54 feature chips and the calendar badge (%s)', (_name, tokens) => {
	it('the registry uses sixteen hues', () => {
		expect(CHIP_TONES).toHaveLength(16);
	});
	it.each(CHIP_TONES)(
		'--ink-2 glyph on the %s tint ≥ 3 (and ≥ 4.5, it is AA as text too)',
		(hue) => {
			const tint = mix(tokens[hue] as string, tokens['--bg'] as string, 0.16);
			expect(contrastRatio(tokens['--ink-2'] as string, tint)).toBeGreaterThanOrEqual(4.5);
		}
	);
	it('badge: --bg month on the --ink band and --ink day on --bg ≥ 4.5', () => {
		expect(
			contrastRatio(tokens['--bg'] as string, tokens['--ink'] as string)
		).toBeGreaterThanOrEqual(4.5);
		expect(
			contrastRatio(tokens['--ink'] as string, tokens['--bg'] as string)
		).toBeGreaterThanOrEqual(4.5);
	});
});

/**
 * FN-57: the action fill (`--action`, `--on-action`) refers to other tokens with `var()`, which readTokens skips, so
 * these layers are read with the references resolved against the theme's final values (all on :root, as in CSS).
 */
function resolvedTokens(selectors: string[]): Record<string, string> {
	const raw: Record<string, string> = {};
	for (const selector of selectors) {
		const start = css.indexOf(selector);
		const body = css.slice(start, css.indexOf('}', start));
		for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6}\b|var\(--[\w-]+\))/g))
			raw[m[1] as string] = (m[2] as string).toLowerCase();
	}
	const resolve = (value: string, depth = 0): string => {
		const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
		if (!ref || depth > 4) return value;
		return resolve(raw[ref] ?? value, depth + 1);
	};
	return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, resolve(v)]));
}
const ACTION_THEMES: [string, string[]][] = [
	['light', [LIGHT]],
	['dark', [LIGHT, DARK]],
	['dark-media', [LIGHT, DARK_MEDIA]],
	['mono-light', [LIGHT, MONO]],
	['mono-dark', [LIGHT, DARK_MEDIA, MONO, MONO_DARK]],
	['gold', [LIGHT, GOLD]],
	['gold-dark', [LIGHT, DARK_MEDIA, GOLD, GOLD_DARK]],
	['emerald', [LIGHT, EMERALD]],
	['emerald-dark', [LIGHT, DARK_MEDIA, EMERALD, EMERALD_DARK]]
];

describe.each(ACTION_THEMES)('FN-57 action fill (%s)', (name, selectors) => {
	const tokens = resolvedTokens(selectors);
	it('--on-action on --action ≥ 4.5, --action on --bg and --panel ≥ 3', () => {
		expect(contrastRatio(tokens['--on-action']!, tokens['--action']!)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(tokens['--action']!, tokens['--bg']!)).toBeGreaterThanOrEqual(3);
		expect(contrastRatio(tokens['--action']!, tokens['--panel']!)).toBeGreaterThanOrEqual(3);
	});
	it('electric blue only in the default light theme; ink with the page colour everywhere else', () => {
		if (name === 'light') {
			expect(tokens['--action']).toBe('#0b3df5');
			expect(tokens['--on-action']).toBe('#ffffff');
		} else {
			expect(tokens['--action']).toBe(tokens['--ink']);
			expect(tokens['--on-action']).toBe(tokens['--bg']);
		}
	});
});
