import { describe, expect, it } from 'vitest';
import { actionsFitTitleRow } from './screen-title';

describe('actionsFitTitleRow', () => {
	it('fits when the title, the gap and the actions fill the row exactly', () => {
		expect(actionsFitTitleRow(200, 108, 320)).toBe(true);
	});

	it('does not fit when one pixel is missing (the actions stack under the subtitle)', () => {
		expect(actionsFitTitleRow(200, 109, 320)).toBe(false);
	});

	it('uses the given gap', () => {
		expect(actionsFitTitleRow(200, 116, 320, 4)).toBe(true);
		expect(actionsFitTitleRow(200, 117, 320, 4)).toBe(false);
	});

	it('tolerates sub-pixel rounding', () => {
		expect(actionsFitTitleRow(200.3, 108, 320)).toBe(true);
	});
});
