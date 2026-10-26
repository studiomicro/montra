/**
 * Whether a phone header's actions fit on the title row (APP_PARITY § 3b.1). `titleEnd` is the H1's right edge
 * measured from the header's left edge (the back chevron included), `actionsWidth` the actions' laid-out width.
 * When they do not fit, the header stacks: title, subtitle, then the actions on a line of their own, so the
 * actions never split the title from its subtitle.
 */
export function actionsFitTitleRow(
	titleEnd: number,
	actionsWidth: number,
	rowWidth: number,
	gap = 12
): boolean {
	return titleEnd + gap + actionsWidth <= rowWidth + 0.5;
}
