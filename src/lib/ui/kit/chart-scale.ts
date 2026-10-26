/**
 * Daily bars whose scale one outlier cannot flatten (POLISH_AUDIT A6): the top of the scale is capped at
 * `outlierFactor` × the median of the non-zero days. A day above the cap is drawn full height and marked
 * `clipped` (the chart draws a break mark on it); its real figure is in the readout and its accessible name.
 * Every non-zero day stays at least `minVisible` px tall.
 */
export function cappedBars(
	values: readonly number[],
	maxHeight: number,
	{ minVisible = 6, outlierFactor = 2 }: { minVisible?: number; outlierFactor?: number } = {}
): { heights: number[]; clipped: boolean[] } {
	const clean = values.map((v) => Math.max(0, v));
	const max = Math.max(0, ...clean);
	if (max === 0) return { heights: clean.map(() => 0), clipped: clean.map(() => false) };
	const nonZero = clean.filter((v) => v > 0).sort((a, b) => a - b);
	const mid = Math.floor(nonZero.length / 2);
	const median =
		nonZero.length % 2 === 1
			? (nonZero[mid] as number)
			: ((nonZero[mid - 1] as number) + (nonZero[mid] as number)) / 2;
	const top = Math.min(max, median * outlierFactor);
	return {
		heights: clean.map((v) =>
			v === 0 ? 0 : Math.max(minVisible, Math.round((Math.min(v, top) / top) * maxHeight))
		),
		clipped: clean.map((v) => v > top)
	};
}

export function stackSegments(
	values: readonly number[],
	width: number
): { x: number; width: number }[] {
	const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
	if (total === 0) return [];
	let x = 0;
	return values.map((v) => {
		const w = (Math.max(0, v) / total) * width;
		const segment = { x, width: w };
		x += w;
		return segment;
	});
}

export function linePoints(
	values: readonly number[],
	width: number,
	height: number,
	max: number
): string {
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	return values
		.map((v, i) => {
			const y = max > 0 ? height - (Math.max(0, v) / max) * height : height;
			return `${Math.round(i * step * 100) / 100},${Math.round(y * 100) / 100}`;
		})
		.join(' ');
}
