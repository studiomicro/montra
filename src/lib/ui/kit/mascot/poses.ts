/**
 * FN-44: Koko, Montra's mascot — a Formosan black bear drawn for this app on a 24×24 pixel grid (original art;
 * never another product's character). Every pose is a strip of frames; `Mascot.svelte` shows frame 0 at rest and cuts
 * between frames with `steps(1)` while it animates. Pure data, no imports: the icon script runs it under Node.
 *
 * v2 (2026-10-10, owner request "more cute"): a chubbier coin, round dark eyes with a glint, pink cheeks and a
 * shine on the top left.
 *
 * v3 (2026-10-28, owner request "make Koko a Formosan bear"): the coin became a Formosan black bear — black fur,
 * round ears, a tan muzzle and the cream V on its chest — on the same grid, in the same poses.
 *
 * Pixel letters: `.` transparent, `o` outline (--ink), `b` fur (--koko-fur), `l` the fur's sheen (fur mixed towards
 * the light), `c` the chest's V (--koko-chest), `m` muzzle and inner ears (--koko-muzzle), `s` legs, feet and the
 * sleeping z (--ink-2), `e` eyes, nose and mouth, `g` the glint in an eye (white), `p` cheeks (pink).
 */

export const GRID = 24;

export const MASCOT_POSES = [
	'idle',
	'wave',
	'hop',
	'celebrate',
	'sad',
	'sleep',
	'loading'
] as const;
export type MascotPose = (typeof MASCOT_POSES)[number];

export type Pixel = 'o' | 'b' | 'l' | 'c' | 'm' | 's' | 'e' | 'g' | 'p';
/** 24 rows of 24 letters. */
export type Frame = readonly string[];

/**
 * The bear at rest: a round black body (head and body in one, chibi style) with two round ears, each with a tan
 * inside, a sheen on the top left of the head, short legs and feet. The muzzle and the chest's V are painted on by
 * `face` below.
 */
const BEAR: Frame = [
	'........................',
	'...oooo..........oooo...',
	'..obbbbo........obbbbo..',
	'..obmmbo........obmmbo..',
	'..obmmbboooooooobbmmbo..',
	'...obbbbbbbbbbbbbbbbo...',
	'...obbllbbbbbbbbbbbbo...',
	'...oblbbbbbbbbbbbbbbo...',
	'...obbbbbbbbbbbbbbbbo...',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'..obbbbbbbbbbbbbbbbbbo..',
	'...obbbbbbbbbbbbbbbbo...',
	'...obbbbbbbbbbbbbbbbo...',
	'....oobbbbbbbbbbbboo....',
	'......oobbbbbbbboo......',
	'........oooooooo........',
	'........s......s........',
	'.......sss....sss.......'
];

type Paint = readonly (readonly [x: number, y: number, pixel: Pixel | '.'])[];

/** A copy of `frame` with the listed pixels replaced. */
function paint(frame: Frame, pixels: Paint): Frame {
	const rows = frame.map((row) => row.split(''));
	for (const [x, y, p] of pixels) rows[y]![x] = p;
	return rows.map((r) => r.join(''));
}

/** The pixels of a block from (x, y), `w` wide and `h` high. */
const block = (x: number, y: number, w: number, h: number, p: Pixel | '.'): Paint =>
	Array.from({ length: w * h }, (_, i) => [x + (i % w), y + Math.floor(i / w), p] as const);

/** Moves every row up (`dy` < 0) or down; rows that come in are empty. */
function shift(frame: Frame, dy: number): Frame {
	const empty = '.'.repeat(GRID);
	return frame.map((_, y) => frame[y - dy] ?? empty);
}

/**
 * Koko turned part-way (a frame of a spin): each row keeps its outline and the face, at `k` of its width around the
 * centre; the gap between the ears stays open.
 */
function squeeze(frame: Frame, k: number): Frame {
	const mid = (GRID - 1) / 2;
	return frame.map((row, y) => {
		const left = row.indexOf('o');
		if (y >= 22 || left < 0) return row;
		const right = row.lastIndexOf('o');
		const half = Math.max(1, Math.round(((right - left) / 2) * k));
		const [l, r] = [Math.round(mid - half), Math.round(mid + half)];
		if (row.slice(left, right + 1).replace(/o/g, '') === '')
			return '.'.repeat(l) + 'o'.repeat(r - l + 1) + '.'.repeat(GRID - r - 1);
		return Array.from({ length: GRID }, (_, x) => {
			if (x < l || x > r) return '.';
			if (x === l || x === r) return 'o';
			const p = row[Math.round(mid + (x - mid) / k)];
			return p === '.' ||
				p === 'o' ||
				p === 'e' ||
				p === 'g' ||
				p === 'p' ||
				p === 'l' ||
				p === 'c' ||
				p === 'm'
				? p
				: 'b';
		}).join('');
	});
}

/** Round eyes, three pixels high, each with a glint at its top left. */
const EYES_OPEN: Paint = [
	...block(7, 11, 2, 3, 'e'),
	[7, 11, 'g'],
	...block(14, 11, 2, 3, 'e'),
	[14, 11, 'g']
];
/** Shut: a soft curve each (blink, sleep). */
const EYES_SHUT: Paint = [
	[6, 12, 'e'],
	...block(7, 13, 2, 1, 'e'),
	[9, 12, 'e'],
	[13, 12, 'e'],
	...block(14, 13, 2, 1, 'e'),
	[16, 12, 'e']
];
/** Happy: upturned arcs (^ ^). */
const EYES_HAPPY: Paint = [
	...block(7, 11, 2, 1, 'e'),
	[6, 12, 'e'],
	[9, 12, 'e'],
	...block(14, 11, 2, 1, 'e'),
	[13, 12, 'e'],
	[16, 12, 'e']
];
/** Sad: eyes lower, a glint each, and a tear under the left one. */
const EYES_LOW: Paint = [
	...block(7, 12, 2, 2, 'e'),
	[8, 12, 'g'],
	...block(14, 12, 2, 2, 'e'),
	[15, 12, 'g'],
	[7, 14, 'g'],
	[7, 15, 'g']
];
/** Pink cheeks under the eyes. */
const CHEEKS: Paint = [...block(4, 14, 2, 1, 'p'), ...block(17, 14, 2, 1, 'p')];
const SMILE: Paint = [[10, 14, 'e'], [13, 14, 'e'], ...block(11, 15, 2, 1, 'e')];
/** An open smile: dark mouth, pink tongue. */
const GRIN: Paint = [...block(10, 14, 4, 1, 'e'), [11, 15, 'e'], [12, 15, 'p']];
const FROWN: Paint = [...block(11, 15, 2, 1, 'e'), [10, 16, 'e'], [13, 16, 'e']];
const HUSH: Paint = block(11, 15, 2, 1, 'e');
/** The tan muzzle, rounded, with the nose on top; the mouths above sit on it. */
const MUZZLE: Paint = [
	...block(10, 13, 4, 1, 'm'),
	...block(9, 14, 6, 2, 'm'),
	...block(10, 16, 4, 1, 'm'),
	...block(11, 13, 2, 1, 'e')
];
/** The Formosan bear's mark: a cream V across the chest. */
const CHEST: Paint = [
	...block(4, 17, 3, 1, 'c'),
	...block(17, 17, 3, 1, 'c'),
	...block(6, 18, 3, 1, 'c'),
	...block(15, 18, 3, 1, 'c'),
	...block(8, 19, 3, 1, 'c'),
	...block(13, 19, 3, 1, 'c'),
	...block(10, 20, 4, 1, 'c')
];

/** Sparkles around Koko (celebrate): cream and pink, in the corners. */
const SPARKLES: Paint = [
	[1, 3, 'p'],
	[0, 4, 'p'],
	[1, 4, 'c'],
	[2, 4, 'p'],
	[1, 5, 'p'],
	[22, 16, 'p'],
	[21, 17, 'p'],
	[22, 17, 'c'],
	[23, 17, 'p'],
	[22, 18, 'p'],
	[20, 1, 'p'],
	[3, 20, 'c']
];
/** Two z's drifting up from Koko's head (sleep): the near one first, then the far one. */
const NEAR_Z: Paint = [
	...block(20, 2, 3, 1, 's'),
	[21, 3, 's'],
	[20, 4, 's'],
	...block(20, 5, 3, 1, 's')
];
const FAR_Z: Paint = [
	[17, 0, 's'],
	[18, 0, 's'],
	[18, 1, 's'],
	[17, 2, 's'],
	[18, 2, 's']
];
/** The left arm, a little mitten: raised (wave frame 0) and swung in (frame 1). */
const ARM_OUT: Paint = [
	[2, 14, 'o'],
	[1, 13, 'o'],
	[1, 12, 'o'],
	[0, 11, 'o'],
	[0, 10, 'o'],
	[1, 9, 'o'],
	[2, 13, 'b'],
	[2, 12, 'b'],
	[1, 11, 'b'],
	[1, 10, 'b']
];
const ARM_IN: Paint = [
	[2, 14, 'o'],
	[1, 13, 'o'],
	[1, 12, 'o'],
	[1, 11, 'o'],
	[1, 10, 'o'],
	[2, 9, 'o'],
	[2, 13, 'b'],
	[2, 12, 'b'],
	[2, 11, 'b'],
	[2, 10, 'b']
];
/** One foot lifted (loading: a walk). */
const LEFT_UP: Paint = [...block(7, 23, 3, 1, '.'), ...block(7, 22, 3, 1, 's')];
const RIGHT_UP: Paint = [...block(14, 23, 3, 1, '.'), ...block(14, 22, 3, 1, 's')];
/** Crouching before a hop: the legs vanish under the body, the feet stay on the ground. */
const NO_LEGS: Paint = block(0, 22, GRID, 2, '.');
const FEET: Paint = [...block(7, 23, 3, 1, 's'), ...block(14, 23, 3, 1, 's')];

const face = (eyes: Paint, mouth: Paint, ...extra: Paint[]) =>
	paint(BEAR, [...CHEEKS, ...MUZZLE, ...CHEST, ...eyes, ...mouth, ...extra.flat()]);

const IDLE = face(EYES_OPEN, SMILE);
const HAPPY = face(EYES_HAPPY, GRIN);
const SAD = face(EYES_LOW, FROWN);
const ASLEEP = face(EYES_SHUT, HUSH);
/** Frame 0 is the resting frame of every pose (and the only one under reduced motion). */
export const POSES: Record<MascotPose, readonly Frame[]> = {
	idle: [IDLE, face(EYES_SHUT, SMILE)],
	wave: [face(EYES_OPEN, GRIN, ARM_OUT), face(EYES_OPEN, GRIN, ARM_IN)],
	hop: [IDLE, paint(shift(paint(IDLE, NO_LEGS), 1), FEET), shift(HAPPY, -2)],
	celebrate: [paint(HAPPY, SPARKLES), HAPPY, squeeze(HAPPY, 0.7), squeeze(HAPPY, 0.4)],
	sad: [SAD, face(EYES_SHUT, FROWN)],
	sleep: [paint(ASLEEP, [...NEAR_Z, ...FAR_Z]), paint(ASLEEP, NEAR_Z), ASLEEP],
	loading: [paint(IDLE, LEFT_UP), paint(IDLE, RIGHT_UP)]
};

/** One horizontal run of same-coloured pixels: drawn as a single `<rect>`. */
export interface Run {
	x: number;
	y: number;
	w: number;
	pixel: Pixel;
}

/** The frame as runs, row by row, left to right (adjacent pixels of one colour share a rect). */
export function runs(frame: Frame): Run[] {
	const out: Run[] = [];
	frame.forEach((row, y) => {
		let x = 0;
		while (x < row.length) {
			const p = row[x]!;
			let w = 1;
			while (row[x + w] === p) w++;
			if (p !== '.') out.push({ x, y, w, pixel: p as Pixel });
			x += w;
		}
	});
	return out;
}

/**
 * FN-46: the crown of the Pro look, 8 × 3 pixels with three points (original art, like Koko). `k` is the crown,
 * coloured by the --pro token in the app and by the light --pro value in the home-screen icon.
 */
export const CROWN: readonly string[] = ['k..kk..k', 'kk.kk.kk', 'kkkkkkkk'];

/** One horizontal run of crown pixels. */
export type CrownRun = Omit<Run, 'pixel'>;

/**
 * The top of Koko's head: the first row with outline in the middle two columns (between the ears), or -1.
 */
export function headTop(frame: Frame): number {
	const mid = GRID / 2;
	return frame.findIndex((row) => row[mid - 1] === 'o' || row[mid] === 'o');
}

/** The crown's left column on `frame`: centred on the head's top row. */
function crownLeft(frame: Frame, head: number): number {
	const row = frame[head]!;
	return Math.round((row.indexOf('o') + row.lastIndexOf('o')) / 2 - (CROWN[0]!.length - 1) / 2);
}

/**
 * The row the crown rests on: the first drawn row under its columns (the head between the ears; in a spin's narrow
 * frames the ears close in, so it rests on them), or -1.
 */
export function crownRest(frame: Frame): number {
	const head = headTop(frame);
	if (head < 0) return -1;
	const left = crownLeft(frame, head);
	return frame.findIndex((row) => /[^.]/.test(row.slice(left, left + CROWN[0]!.length)));
}

/**
 * Where the crown sits on `frame`: right above `crownRest`, centred on the head, so it moves with Koko (the hop, the
 * crouch). Rows that would fall above the grid are cut.
 */
export function crown(frame: Frame): CrownRun[] {
	const head = headTop(frame);
	if (head < 0) return [];
	const top = crownRest(frame);
	const left = crownLeft(frame, head);
	const out: CrownRun[] = [];
	CROWN.forEach((row, i) => {
		const y = top - CROWN.length + i;
		if (y < 0) return;
		let x = 0;
		while (x < row.length) {
			if (row[x] !== 'k') {
				x++;
				continue;
			}
			let w = 1;
			while (row[x + w] === 'k') w++;
			out.push({ x: left + x, y, w });
			x += w;
		}
	});
	return out;
}

/** The smallest box around the drawn pixels of a frame. */
export function bounds(frame: Frame): { x: number; y: number; w: number; h: number } {
	let [x0, y0, x1, y1] = [GRID, GRID, -1, -1];
	frame.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			if (row[x] === '.') continue;
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
		}
	});
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
