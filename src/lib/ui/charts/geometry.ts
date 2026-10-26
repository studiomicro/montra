// Pure geometry for the Laporan SVG charts (no chart library). Money values arrive as integer minor units and
// are only turned into floats here, for drawing; nothing drawn is summed back into a figure.

/** Monday-first column (0–6) of the WIB calendar date `YYYY-MM-DD`. */
export function mondayColumn(date: string): number {
	const [y, m, d] = date.split('-').map(Number) as [number, number, number];
	return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/**
 * `x,y` points of `values` on an axis of `axisLength` slots spread over `width` (slot 0 at x 0, the last slot
 * at x width), scaled so `max` touches the top. A series shorter than the axis simply stops early.
 */
export function axisPoints(
	values: readonly number[],
	axisLength: number,
	width: number,
	height: number,
	max: number
): string {
	const step = axisLength > 1 ? width / (axisLength - 1) : 0;
	return values
		.map((v, i) => {
			const y = max > 0 ? height - (Math.max(0, v) / max) * height : height;
			return `${round(i * step)},${round(y)}`;
		})
		.join(' ');
}

/** The x of slot `index` on the same axis as `axisPoints`. */
export function axisX(index: number, axisLength: number, width: number): number {
	return axisLength > 1 ? round((index * width) / (axisLength - 1)) : 0;
}

/**
 * Donut slices as stroke dash segments of a circle with circumference `circumference`: each slice's `length`
 * is its share of the sum, `offset` where it starts. Zero and negative values get no slice.
 */
export function donutSegments(
	values: readonly number[],
	circumference: number
): { length: number; offset: number }[] {
	const total = values.reduce((s, v) => s + Math.max(0, v), 0);
	let start = 0;
	return values.map((v) => {
		const length = total > 0 ? (Math.max(0, v) / total) * circumference : 0;
		const segment = { length: round(length), offset: round(start) };
		start += length;
		return segment;
	});
}

/**
 * Stacked bar segments bottom-up: each segment's `y` and `height` in a chart `height` tall where `max` is the
 * tallest stack. Heights are proportional; the stack's top is at height − total/max × height.
 */
export function stackRects(
	values: readonly number[],
	max: number,
	height: number
): { y: number; height: number }[] {
	let bottom = height;
	return values.map((v) => {
		const h = max > 0 ? (Math.max(0, v) / max) * height : 0;
		bottom -= h;
		return { y: round(bottom), height: round(h) };
	});
}

/** Tallest a flow column's money is drawn (before the minimum node height and gaps are added). */
export const FLOW_SCALE_HEIGHT = 240;
/** A flow node's slot (and tap area) is at least this tall: a 44 px touch target, a name and an amount. */
export const FLOW_MIN_NODE = 48;
/** The thinnest band drawn, so a small spend never becomes a hairline (its true amount is in the list). */
export const FLOW_MIN_BAND = 3;
/** Width of a node's colour bar. */
export const FLOW_BAR = 8;
const FLOW_GAP = 10;
/** Space between a bar and its label. */
const FLOW_LABEL_PAD = 6;
/** Below this width three columns are a phone layout (POLISH_AUDIT B1). */
const FLOW_PHONE_WIDTH = 480;
/** A phone's right-hand label column: room for "Tempat Tinggal" / "−Rp4,16 jt" at 12 px. */
const FLOW_PHONE_RIGHT_LABEL = 104;

interface FlowBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface FlowNode extends FlowBox {
	key: string;
	column: number;
	/** The compact colour bar the bands attach to, centred vertically in the node's slot. */
	bar: FlowBox;
	/**
	 * Where the name and amount are written: beside the bar, `width` px at most; on a phone the middle column's
	 * label is centred on its bar (`middle`), across the ribbons on both sides.
	 */
	label: { x: number; y: number; anchor: 'start' | 'end' | 'middle'; width: number };
}

export interface FlowBand {
	/** Index of the link in the input. */
	index: number;
	/** A closed ribbon: two cubic curves from the source bar's right edge to the target bar's left edge. */
	d: string;
	thickness: number;
}

/**
 * The money-flow diagram's geometry (FN-35, reworked in the UI polish pass): `columns` of nodes across `width`,
 * each node a narrow bar with its label beside it (the first column's on its left, the others' on its right), and
 * each link a filled ribbon whose thickness is its value on one money scale, at least FLOW_MIN_BAND. A bar is as
 * tall as its value or the ribbons it carries, whichever is more; its slot (the tap area) is at least
 * FLOW_MIN_NODE. Ribbons leave a bar's right side and enter a bar's left side stacked in the order of the other
 * end's node, centred on the bar; columns are centred on the tallest. Values are positive magnitudes.
 */
export function flowLayout(
	columns: readonly (readonly { key: string; value: number }[])[],
	links: readonly { from: string; to: string; value: number }[],
	width: number
): { nodes: FlowNode[]; bands: FlowBand[]; height: number; barX: number[] } {
	const n = Math.max(1, columns.length);
	// Two columns have room for longer names than three.
	const labelWidth = Math.min(200, Math.max(76, Math.round(width * (n === 2 ? 0.32 : 0.24))));
	// A phone's three columns: the expense names on the right get a fixed column, and the middle labels sit
	// centred on their bar (over the ribbons, with a halo) instead of squeezing between two bars.
	const phone = n === 3 && width < FLOW_PHONE_WIDTH;
	const rightLabel = phone ? Math.max(labelWidth, FLOW_PHONE_RIGHT_LABEL) : labelWidth;
	const first = n > 1 ? labelWidth : 0;
	const last = n > 1 ? width - rightLabel - FLOW_BAR : 0;
	const barX = Array.from({ length: n }, (_, i) =>
		round(n > 1 ? first + (i * (last - first)) / (n - 1) : 0)
	);

	const maxColumn = Math.max(
		0,
		...columns.map((c) => c.reduce((s, x) => s + Math.max(0, x.value), 0))
	);
	const k = maxColumn > 0 ? FLOW_SCALE_HEIGHT / maxColumn : 0;
	const order = new Map<string, { column: number; order: number }>();
	columns.forEach((column, ci) =>
		column.forEach((node, oi) => order.set(node.key, { column: ci, order: oi }))
	);

	const placed = links
		.map((l, index) => ({
			index,
			from: l.from,
			to: l.to,
			value: l.value,
			thickness: Math.max(FLOW_MIN_BAND, l.value * k),
			a: order.get(l.from),
			b: order.get(l.to)
		}))
		.filter((l) => l.a && l.b && l.value > 0) as {
		index: number;
		from: string;
		to: string;
		value: number;
		thickness: number;
		a: { column: number; order: number };
		b: { column: number; order: number };
	}[];
	const carried = (key: string, side: 'from' | 'to') =>
		placed.filter((l) => l[side] === key).reduce((s, l) => s + l.thickness, 0);

	// Slots stacked per column, then each column centred on the tallest.
	const nodes: FlowNode[] = [];
	const columnHeights: number[] = [];
	columns.forEach((column, ci) => {
		let y = 0;
		column.forEach((node) => {
			const barHeight = Math.max(
				FLOW_MIN_BAND,
				Math.max(0, node.value) * k,
				carried(node.key, 'from'),
				carried(node.key, 'to')
			);
			const slot = Math.max(FLOW_MIN_NODE, barHeight);
			const bx = barX[ci] ?? 0;
			const isFirst = ci === 0 && n > 1;
			const prev = barX[ci - 1];
			const next = barX[ci + 1];
			const centred = phone && prev !== undefined && next !== undefined;
			// Centred: half the label on each side of the bar, up to a pad before each neighbouring bar.
			const half = centred
				? Math.min(bx - (prev + FLOW_BAR) - FLOW_LABEL_PAD, next - (bx + FLOW_BAR) - FLOW_LABEL_PAD)
				: 0;
			const labelSpace = isFirst
				? labelWidth - FLOW_LABEL_PAD
				: centred
					? 2 * half + FLOW_BAR
					: next === undefined
						? width - bx - FLOW_BAR - FLOW_LABEL_PAD
						: Math.min(labelWidth, next - bx - FLOW_BAR - 2 * FLOW_LABEL_PAD);
			const x = isFirst ? 0 : centred ? bx - half : bx;
			nodes.push({
				key: node.key,
				column: ci,
				x,
				y,
				width:
					isFirst || centred
						? isFirst
							? bx + FLOW_BAR
							: labelSpace
						: FLOW_BAR + FLOW_LABEL_PAD + labelSpace,
				height: slot,
				bar: { x: bx, y: y + (slot - barHeight) / 2, width: FLOW_BAR, height: barHeight },
				label: {
					x: isFirst
						? bx - FLOW_LABEL_PAD
						: centred
							? bx + FLOW_BAR / 2
							: bx + FLOW_BAR + FLOW_LABEL_PAD,
					y: y + slot / 2,
					anchor: isFirst ? 'end' : centred ? 'middle' : 'start',
					width: Math.max(0, labelSpace)
				}
			});
			y += slot + FLOW_GAP;
		});
		columnHeights[ci] = column.length > 0 ? y - FLOW_GAP : 0;
	});
	const height = Math.max(0, ...columnHeights);
	for (const node of nodes) {
		const shift = (height - (columnHeights[node.column] ?? 0)) / 2;
		node.y = round(node.y + shift);
		node.bar.y = round(node.bar.y + shift);
		node.label.y = round(node.label.y + shift);
		node.height = round(node.height);
		node.bar.height = round(node.bar.height);
		node.label.width = round(node.label.width);
		node.width = round(node.width);
	}
	const byKey = new Map(nodes.map((node) => [node.key, node]));

	/** Each ribbon's top edge on one side of its bar: stacked by the other end's order, centred on the bar. */
	const tops = (side: 'from' | 'to') => {
		const other = side === 'from' ? 'b' : 'a';
		const out = new Map<number, number>();
		const byNode = new Map<string, typeof placed>();
		for (const l of placed) byNode.set(l[side], [...(byNode.get(l[side]) ?? []), l]);
		for (const [key, list] of byNode) {
			const bar = byKey.get(key)?.bar;
			if (!bar) continue;
			list.sort((x, y) => x[other].order - y[other].order || x.index - y.index);
			const total = list.reduce((s, l) => s + l.thickness, 0);
			let y = bar.y + (bar.height - total) / 2;
			for (const l of list) {
				out.set(l.index, y);
				y += l.thickness;
			}
		}
		return out;
	};
	const starts = tops('from');
	const ends = tops('to');
	const bands = placed.map((l) => {
		const a = byKey.get(l.from)!.bar;
		const b = byKey.get(l.to)!.bar;
		const x0 = round(a.x + a.width);
		const x1 = round(b.x);
		const mid = round((x0 + x1) / 2);
		const t = round(l.thickness);
		const y0 = round(starts.get(l.index) ?? 0);
		const y1 = round(ends.get(l.index) ?? 0);
		const y0b = round(y0 + t);
		const y1b = round(y1 + t);
		return {
			index: l.index,
			d:
				`M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} ` +
				`L${x1},${y1b} C${mid},${y1b} ${mid},${y0b} ${x0},${y0b} Z`,
			thickness: t
		};
	});
	return { nodes, bands, height: round(height), barX };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * The net-worth trend line (FN-25b): `x,y` of each value spread evenly over `width`, scaled between the
 * series' own minimum (bottom) and maximum (top), never forced to zero, so a negative net worth and a small
 * change both stay readable. A flat series sits in the middle. Fewer than two values draw nothing.
 */
export function trendPoints(
	values: readonly number[],
	width: number,
	height: number
): { x: number; y: number }[] {
	if (values.length < 2) return [];
	const min = Math.min(...values);
	const max = Math.max(...values);
	const step = width / (values.length - 1);
	return values.map((v, i) => ({
		x: round(i * step),
		y: round(max === min ? height / 2 : height - ((v - min) / (max - min)) * height)
	}));
}
