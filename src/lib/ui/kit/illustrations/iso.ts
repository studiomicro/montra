/**
 * Isometric drawing (FN-40 Part 3): the 30° projection the hand-drawn scenes are built from. A point is
 * (x, y, z) on a 1 px grid with z up; the scene's <g> moves the origin. Paths only — every colour is a CSS class
 * (Illustration.svelte), so a scene repaints with the theme.
 */
const COS30 = Math.cos(Math.PI / 6);

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Screen position of a 3D point. */
export function pt(x: number, y: number, z: number): [number, number] {
	return [r1((x - y) * COS30), r1((x + y) / 2 - z)];
}

/** A closed path through 3D points. */
export function poly(points: [number, number, number][]): string {
	return `M${points.map(([x, y, z]) => pt(x, y, z).join(' ')).join('L')}Z`;
}

/** An open path (a line drawn on a face) through 3D points. */
export function line(points: [number, number, number][]): string {
	return `M${points.map(([x, y, z]) => pt(x, y, z).join(' ')).join('L')}`;
}

export interface Faces {
	top: string;
	/** The face toward the lower left (the y + d side). */
	left: string;
	/** The face toward the lower right (the x + w side). */
	right: string;
}

/** A box from corner (x, y, z), `w` along x, `d` along y, `h` up: the three faces the viewer sees. */
export function box(x: number, y: number, z: number, w: number, d: number, h: number): Faces {
	const t = z + h;
	return {
		top: poly([
			[x, y, t],
			[x + w, y, t],
			[x + w, y + d, t],
			[x, y + d, t]
		]),
		left: poly([
			[x, y + d, z],
			[x + w, y + d, z],
			[x + w, y + d, t],
			[x, y + d, t]
		]),
		right: poly([
			[x + w, y, z],
			[x + w, y + d, z],
			[x + w, y + d, t],
			[x + w, y, t]
		])
	};
}

export interface Disc extends Faces {
	/** The top ellipse's centre and radii, for rings drawn on it. */
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

/**
 * An upright cylinder (a coin, a body) of radius `r` standing on (x, y, z), `h` high: the top ellipse and the
 * two halves of the side (left lit, right shaded).
 */
export function disc(x: number, y: number, z: number, r: number, h: number): Disc {
	const [cx, base] = pt(x, y, z);
	const cy = r1(base - h);
	const rx = r1(r * COS30 * Math.SQRT2);
	const ry = r1((r / 2) * Math.SQRT2);
	const arc = `A${rx} ${ry} 0 0`;
	return {
		cx,
		cy,
		rx,
		ry,
		top: `M${r1(cx - rx)} ${cy}${arc} 1 ${r1(cx + rx)} ${cy}${arc} 1 ${r1(cx - rx)} ${cy}Z`,
		left: `M${r1(cx - rx)} ${cy}L${r1(cx - rx)} ${base}${arc} 0 ${cx} ${r1(base + ry)}L${cx} ${r1(cy + ry)}${arc} 1 ${r1(cx - rx)} ${cy}Z`,
		right: `M${cx} ${r1(cy + ry)}L${cx} ${r1(base + ry)}${arc} 0 ${r1(cx + rx)} ${base}L${r1(cx + rx)} ${cy}${arc} 1 ${cx} ${r1(cy + ry)}Z`
	};
}
