import { describe, expect, it } from 'vitest';
import type { RecognisedWord } from '#lib/shared/ocr/lines';
import type { OcrEngine } from './engine';
import type { PageCanvas } from './image';
import { OcrRunStopped, runOcr } from './pipeline';

/** Stubbed canvases and engine that record what the run did with them (criterion 19). */
function harness(opts: { slowPage?: number; pages?: number } = {}) {
	const calls: string[] = [];
	let engines = 0;
	const words: RecognisedWord[] = [
		{ text: 'Kopi', confidence: 95, x0: 0, y0: 0, x1: 40, y1: 20 },
		{ text: '-Rp25.000', confidence: 91, x0: 200, y0: 0, x1: 290, y1: 20 }
	];
	const pages = Array.from({ length: opts.pages ?? 3 }, (_, i) => async (): Promise<PageCanvas> => {
		calls.push(`prepare ${i}`);
		const canvas = { width: 100, height: 50 } as HTMLCanvasElement;
		return {
			canvas,
			release: () => {
				canvas.width = 0;
				canvas.height = 0;
				calls.push(`release ${i}`);
			}
		};
	});
	let page = 0;
	const start = async (): Promise<OcrEngine> => {
		engines++;
		calls.push('start');
		return {
			recognize: async () => {
				const n = page++;
				calls.push(`read ${n}`);
				if (n === opts.slowPage) await new Promise((r) => setTimeout(r, 200));
				return words;
			},
			terminate: async () => {
				calls.push('terminate');
			}
		};
	};
	return { calls, pages, start, engines: () => engines };
}

describe('runOcr', () => {
	it('reads pages one at a time with one engine, releasing each canvas before the next is prepared', async () => {
		const h = harness();
		const seen: string[] = [];
		const doc = await runOcr(h.pages, h.start, {
			signal: new AbortController().signal,
			onPage: (n, total) => seen.push(`${n}/${total}`)
		});
		expect(h.engines()).toBe(1);
		expect(seen).toEqual(['1/3', '2/3', '3/3']);
		expect(h.calls).toEqual([
			'start',
			'prepare 0',
			'read 0',
			'release 0',
			'prepare 1',
			'read 1',
			'release 1',
			'prepare 2',
			'read 2',
			'release 2',
			'terminate'
		]);
		expect(doc.pages).toHaveLength(3);
		expect(doc.pages[0]).toEqual({
			widthPx: 100,
			heightPx: 50,
			meanConf: 93,
			lines: [
				{
					y: 0,
					x: 0,
					text: expect.stringMatching(/^Kopi +-Rp25\.000$/),
					words: [
						{ t: 'Kopi', c: 95, x0: 0, x1: 40 },
						{ t: '-Rp25.000', c: 91, x0: 200, x1: 290 }
					]
				}
			]
		});
		// Only words and integer positions: nothing else from the page leaves the run.
		expect(Object.keys(doc.pages[0]!).sort()).toEqual(['heightPx', 'lines', 'meanConf', 'widthPx']);
	});

	it('Batal stops the run at once, terminates the engine and returns nothing', async () => {
		const h = harness({ slowPage: 1 });
		const controller = new AbortController();
		const run = runOcr(h.pages, h.start, {
			signal: controller.signal,
			onPage: (n) => n === 2 && setTimeout(() => controller.abort(), 20)
		});
		await expect(run).rejects.toEqual(new OcrRunStopped('cancelled'));
		expect(h.calls).toContain('terminate');
		expect(h.calls).toContain('release 1');
		expect(h.calls).not.toContain('prepare 2');
	});

	it('Batal while the engine is still starting: the engine that arrives later is terminated', async () => {
		const calls: string[] = [];
		let arrive: (e: OcrEngine) => void = () => {};
		const start = () => new Promise<OcrEngine>((r) => (arrive = r));
		const controller = new AbortController();
		const run = runOcr(harness().pages, start, { signal: controller.signal });
		controller.abort();
		await expect(run).rejects.toEqual(new OcrRunStopped('cancelled'));
		arrive({
			recognize: async () => [],
			terminate: async () => {
				calls.push('terminate');
			}
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toEqual(['terminate']);
	});

	it('a page over its time budget, or a run over the whole budget, is stopped', async () => {
		const slow = harness({ slowPage: 0 });
		await expect(
			runOcr(slow.pages, slow.start, { signal: new AbortController().signal, pageTimeoutMs: 50 })
		).rejects.toEqual(new OcrRunStopped('page_timeout'));
		expect(slow.calls.at(-1)).toBe('terminate');
		let t = 0;
		const clock = harness();
		await expect(
			runOcr(clock.pages, clock.start, {
				signal: new AbortController().signal,
				runTimeoutMs: 5 * 60_000,
				now: () => (t += 2 * 60_000)
			})
		).rejects.toBeInstanceOf(OcrRunStopped);
		expect(clock.calls.at(-1)).toBe('terminate');
	});
});
