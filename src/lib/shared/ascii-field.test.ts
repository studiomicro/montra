import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	ASCII_DESKTOP_GRID,
	ASCII_GLYPHS,
	ASCII_MAX_COLS,
	ASCII_MAX_ROWS,
	ASCII_PHONE_GRID,
	ASCII_STATIC_T,
	asciiFrame,
	type AsciiFrame
} from './ascii-field';

/** FN-56 AC 1-7: the auth ASCII field generator. */

const GRIDS = [
	['phone', ASCII_PHONE_GRID],
	['desktop', ASCII_DESKTOP_GRID]
] as const;
const SAMPLES = Array.from({ length: Math.floor(60_000 / 997) + 1 }, (_, i) => i * 997);

/** FNV-1a over the rows: a golden frame is stored as this hash. */
function fnv(rows: string[]): string {
	let h = 0x811c9dc5;
	for (const ch of rows.join('\n')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
	return (h >>> 0).toString(16);
}
const frameOf = (t: number, grid: { cols: number; rows: number }, seed?: number) =>
	asciiFrame(t, grid.cols, grid.rows, seed);
const lit = (rows: string[]) => rows.join('').replace(/ /g, '').length;
const share = (rows: string[]) => lit(rows) / rows.join('').length;

/** Size and alphabet: the rules every frame keeps (AC 2 and 3). */
function expectWellFormed(frame: AsciiFrame, cols: number, rows: number) {
	for (const layer of [frame.rows, ...frame.tiers]) {
		expect(layer).toHaveLength(rows);
		for (const row of layer) expect(row).toHaveLength(cols);
	}
	for (const row of frame.rows) {
		expect(row).toMatch(/^[ MONTRA0-9p]*$/);
		expect(row).not.toMatch(/Rp ?\d/);
		expect(row).not.toMatch(/[^\x20-\x7e]/);
	}
}

describe('asciiFrame', () => {
	it('is deterministic, and a fresh import draws the same frame (AC 1)', async () => {
		for (const [, grid] of GRIDS) {
			expect(frameOf(ASCII_STATIC_T, grid)).toEqual(frameOf(ASCII_STATIC_T, grid));
			expect(frameOf(12_345, grid, 7)).toEqual(frameOf(12_345, grid, 7));
		}
		vi.resetModules();
		const fresh = await import('./ascii-field');
		const grid = ASCII_DESKTOP_GRID;
		expect(fresh.asciiFrame(ASCII_STATIC_T, grid.cols, grid.rows)).toEqual(
			frameOf(ASCII_STATIC_T, grid)
		);
	});

	it('keeps one golden still frame per grid; another seed draws another frame (AC 1)', () => {
		expect(fnv(frameOf(ASCII_STATIC_T, ASCII_PHONE_GRID).rows)).toBe('9b4650e5');
		expect(fnv(frameOf(ASCII_STATIC_T, ASCII_DESKTOP_GRID).rows)).toBe('5f356b43');
		for (const [, grid] of GRIDS)
			expect(frameOf(ASCII_STATIC_T, grid, 99).rows).not.toEqual(
				frameOf(ASCII_STATIC_T, grid).rows
			);
	});

	it('has exactly rows x cols in every layer over a minute of play, letters only, never an amount (AC 2, 3)', () => {
		for (const [, grid] of GRIDS)
			for (const t of SAMPLES) expectWellFormed(frameOf(t, grid), grid.cols, grid.rows);
	});

	it('the three tier layers together are the frame, without overlap (AC 3)', () => {
		for (const [, grid] of GRIDS)
			for (const t of SAMPLES.filter((_, i) => i % 5 === 0)) {
				const { rows, tiers } = frameOf(t, grid);
				rows.forEach((row, r) => {
					for (let c = 0; c < row.length; c++) {
						const inTiers = tiers.map((layer) => layer[r]![c]).filter((ch) => ch !== ' ');
						expect(inTiers.length).toBeLessThanOrEqual(1);
						expect(inTiers[0] ?? ' ').toBe(row[c]);
					}
				});
			}
	});

	it('every glyph is the glyph string at its column, shifted per row (AC 3)', () => {
		const { rows } = frameOf(ASCII_STATIC_T, ASCII_DESKTOP_GRID);
		rows.forEach((row, r) => {
			for (let c = 0; c < row.length; c++)
				if (row[c] !== ' ')
					expect(row[c]).toBe(
						ASCII_GLYPHS[(c + ((r * 7) % ASCII_GLYPHS.length)) % ASCII_GLYPHS.length]
					);
		});
	});

	it('never throws on odd input: sizes clamp to 1 .. the cap, time to a finite range (AC 2)', () => {
		const cases: [number, number, number][] = [
			[0, 0, 0],
			[0, 1, 1],
			[0, -5, -3],
			[0, 2.9, 3.7],
			[0, Number.NaN, Number.NaN],
			[0, 10_000, 10_000],
			[0, Infinity, -Infinity],
			[-500, 4, 4],
			[Number.NaN, 4, 4],
			[Infinity, 4, 4],
			[-Infinity, 4, 4]
		];
		const expected = (v: number, cap: number) =>
			Number.isNaN(v) || v === -Infinity
				? 1
				: v === Infinity
					? cap
					: Math.min(cap, Math.max(1, Math.floor(v)));
		for (const [t, cols, rows] of cases) {
			const frame = asciiFrame(t, cols, rows);
			expectWellFormed(frame, expected(cols, ASCII_MAX_COLS), expected(rows, ASCII_MAX_ROWS));
		}
		expect(asciiFrame(Number.NaN, 20, 8)).toEqual(asciiFrame(0, 20, 8));
		expect(asciiFrame(-1, 20, 8)).toEqual(asciiFrame(0, 20, 8));
		expect(asciiFrame(Infinity, 20, 8)).toEqual(asciiFrame(Number.MAX_VALUE, 20, 8));
		expect(asciiFrame(0, 20, 8, Number.NaN)).toEqual(asciiFrame(0, 20, 8));
	});

	it('blobs cover 45-60 % of the panel in every frame, never blank or full (AC 4)', () => {
		for (const [, grid] of GRIDS)
			for (const t of [ASCII_STATIC_T, ...SAMPLES]) {
				const s = share(frameOf(t, grid).rows);
				expect(s, `t=${t}`).toBeGreaterThanOrEqual(0.45);
				expect(s, `t=${t}`).toBeLessThanOrEqual(0.6);
			}
	});

	it('is denser towards the core: edge < mid < core neighbourhood fill (AC 5)', () => {
		const grid = ASCII_DESKTOP_GRID;
		const sums = [0, 0, 0];
		const counts = [0, 0, 0];
		for (const t of SAMPLES.filter((_, i) => i % 4 === 0)) {
			const { rows, tiers } = frameOf(t, grid);
			tiers.forEach((layer, k) => {
				for (let r = 1; r < grid.rows - 1; r++)
					for (let c = 1; c < grid.cols - 1; c++) {
						if (layer[r]![c] === ' ') continue;
						let filled = 0;
						for (let dr = -1; dr <= 1; dr++)
							for (let dc = -1; dc <= 1; dc++)
								if ((dr || dc) && rows[r + dr]![c + dc] !== ' ') filled += 1;
						sums[k]! += filled / 8;
						counts[k]! += 1;
					}
			});
		}
		const [edge, mid, core] = sums.map((s, k) => s / counts[k]!) as [number, number, number];
		expect(edge).toBeLessThan(mid);
		expect(mid).toBeLessThan(core);
		// Inside a blob every cell carries a glyph: a core cell is surrounded by glyphs, never by dithered holes.
		expect(core).toBeGreaterThan(0.97);
	});

	it('drifts without flicker: under 3 % of cells change in 66 ms, over 15 % in 10 s (AC 6)', () => {
		const changed = (a: string[], b: string[]) => {
			const x = a.join('');
			const y = b.join('');
			let n = 0;
			for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n += 1;
			return n / x.length;
		};
		for (const [, grid] of GRIDS)
			for (const t of SAMPLES.filter((t) => t <= 50_000)) {
				expect(changed(frameOf(t, grid).rows, frameOf(t + 66, grid).rows)).toBeLessThan(0.03);
				expect(changed(frameOf(t, grid).rows, frameOf(t + 10_000, grid).rows)).toBeGreaterThan(
					0.15
				);
			}
	});

	it('uses no engine-dependent maths, clock or randomness and imports nothing (AC 7)', () => {
		const src = readFileSync('src/lib/shared/ascii-field.ts', 'utf8').replace(
			/\/\*[\s\S]*?\*\/|\/\/.*$/gm,
			''
		);
		expect(src).not.toMatch(
			/Math\.(sin|cos|tan|pow|exp|log|sqrt|random)|\*\*|\bDate\b|performance/
		);
		expect(src).not.toMatch(/^\s*import\s/m);
		expect(src).not.toMatch(/\b(window|document|globalThis)\b/);
	});
});
