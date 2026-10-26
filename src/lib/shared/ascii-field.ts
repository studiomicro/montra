/**
 * FN-56: the ASCII field drawn on /masuk and /daftar. A pure function of played time and grid size: seeded value
 * noise sampled in (x, y, time) decides where soft blobs of glyphs show; denser and in a brighter tier towards a
 * blob's core, blank outside. Deterministic on every engine: only + - * /, Math.floor and Math.imul in the noise
 * (no trigonometry, powers, random numbers or clock), so a frame is the same on the server, in the browser and in
 * tests. The digits are a fixed ramp and "Rp" is always followed by "M": no row can read as an amount.
 */

/** Each row repeats this string, shifted per row so the columns do not line up. */
export const ASCII_GLYPHS = 'MONTRA0123456789Rp';

/** The two grids (CSS fixes the boxes; text beyond them is clipped). */
export const ASCII_PHONE_GRID = { cols: 80, rows: 13 } as const;
export const ASCII_DESKTOP_GRID = { cols: 69, rows: 54 } as const;

/** Played time of the server-rendered still, which is also where the animation starts (no jump). */
export const ASCII_STATIC_T = 4_000;
const ASCII_DEFAULT_SEED = 0x4d4f4e;

/** Bounds on the work one call can do, whatever it is asked. */
export const ASCII_MAX_COLS = 160;
export const ASCII_MAX_ROWS = 120;
const ASCII_MAX_T = 3_600_000;

/**
 * Field values: every cell above EDGE carries a glyph (a solid lattice inside a blob); MID and CORE start the
 * brighter tiers, so brightness, not gaps, shows the core.
 */
const EDGE = 0.5;
const MID = 0.56;
const CORE = 0.62;
/**
 * The share of cells inside a blob. Each frame shifts the whole field so that this share sits above EDGE: blobs
 * keep their shape, drift, merge and split, but the panel is never blank and never full. The shift follows the
 * noise, so it moves as smoothly as the blobs.
 */
const SHARE = 0.52;

/** Lattice spacing in cells: a cell is about twice as tall as wide, so y steps twice as fast to keep blobs round. */
const X_SCALE = 1 / 26;
const Y_SCALE = 1 / 12;
/** One lattice step in time per 10 s (blobs morph), plus a slow drift to the left. */
const T_SCALE = 1 / 10_000;
const DRIFT = 1 / 40_000;

export interface AsciiFrame {
	/** `rows` strings of exactly `cols` characters, spaces kept. */
	rows: string[];
	/** The same cells split by brightness: edge, mid, core (each the full size, spaces elsewhere). */
	tiers: [string[], string[], string[]];
}

function hash(x: number, y: number, z: number, seed: number): number {
	let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ seed;
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

const smooth = (f: number) => f * f * (3 - 2 * f);
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function valueNoise(x: number, y: number, z: number, seed: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const z0 = Math.floor(z);
	const fx = smooth(x - x0);
	const fy = smooth(y - y0);
	const fz = smooth(z - z0);
	const c = (dx: number, dy: number, dz: number) => hash(x0 + dx, y0 + dy, z0 + dz, seed);
	const front = lerp(lerp(c(0, 0, 0), c(1, 0, 0), fx), lerp(c(0, 1, 0), c(1, 1, 0), fx), fy);
	const back = lerp(lerp(c(0, 0, 1), c(1, 0, 1), fx), lerp(c(0, 1, 1), c(1, 1, 1), fx), fy);
	return lerp(front, back, fz);
}

/** Two octaves of fractal noise, 0..1. */
function field(x: number, y: number, z: number, seed: number): number {
	return (
		(valueNoise(x, y, z, seed) * 2 + valueNoise(x * 2 + 17, y * 2 + 31, z * 2, seed ^ 0x5bd1e995)) /
		3
	);
}

function clampSize(value: number, max: number): number {
	if (!Number.isFinite(value)) return value === Infinity ? max : 1;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

function clampTime(t: number): number {
	if (Number.isNaN(t)) return 0;
	return Math.min(ASCII_MAX_T, Math.max(0, t));
}

/** One frame of the field at played time `t` (ms). Never throws; sizes and time are clamped. */
export function asciiFrame(
	t: number,
	cols: number,
	rows: number,
	seed: number = ASCII_DEFAULT_SEED
): AsciiFrame {
	const w = clampSize(cols, ASCII_MAX_COLS);
	const h = clampSize(rows, ASCII_MAX_ROWS);
	const time = clampTime(t);
	const s = Number.isFinite(seed) ? seed | 0 : ASCII_DEFAULT_SEED;
	const z = time * T_SCALE;
	const drift = time * DRIFT;
	const n = ASCII_GLYPHS.length;
	const values = new Float64Array(w * h);
	for (let r = 0; r < h; r++)
		for (let c = 0; c < w; c++) values[r * w + c] = field(c * X_SCALE + drift, r * Y_SCALE, z, s);
	const sorted = values.slice().sort();
	const lift = EDGE - (sorted[Math.floor(sorted.length * (1 - SHARE))] as number);
	const out: string[] = [];
	const tiers: [string[], string[], string[]] = [[], [], []];
	for (let r = 0; r < h; r++) {
		let line = '';
		let edge = '';
		let mid = '';
		let core = '';
		const shift = (r * 7) % n;
		for (let c = 0; c < w; c++) {
			const v = (values[r * w + c] as number) + lift;
			const tier = v < EDGE ? -1 : v < MID ? 0 : v < CORE ? 1 : 2;
			const lit = tier >= 0;
			const ch = lit ? (ASCII_GLYPHS[(c + shift) % n] as string) : ' ';
			line += ch;
			edge += lit && tier === 0 ? ch : ' ';
			mid += lit && tier === 1 ? ch : ' ';
			core += lit && tier === 2 ? ch : ' ';
		}
		out.push(line);
		tiers[0].push(edge);
		tiers[1].push(mid);
		tiers[2].push(core);
	}
	return { rows: out, tiers };
}
