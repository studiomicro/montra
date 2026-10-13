export function barHeights(values: readonly number[], maxHeight: number, minVisible = 2): number[] {
	const clean = values.map((v) => Math.max(0, v));
	const max = Math.max(0, ...clean);
	if (max === 0) return clean.map(() => 0);
	return clean.map((v) => (v === 0 ? 0 : Math.max(minVisible, Math.round((v / max) * maxHeight))));
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
