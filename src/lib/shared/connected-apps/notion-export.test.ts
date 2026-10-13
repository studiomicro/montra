import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n.ts';
import { formatMoney } from '../money-format.ts';
import {
	buildNotionReportBlocks,
	NOTION_TOP_CATEGORIES_MAX,
	type NotionBlock
} from './notion-export.ts';

const id = createTranslator('id');
const en = createTranslator('en');

const summary = {
	monthLabel: 'Oktober 2026',
	totalInMinor: 1_250_000_000,
	totalOutMinor: 526_400_050,
	currency: 'IDR',
	topCategories: [
		{ name: 'Makan', amountMinor: 187_000_000 },
		{ name: 'Transportasi', amountMinor: 52_500_000 }
	]
};

const texts = (blocks: NotionBlock[]) =>
	blocks.map((b) => {
		const body = b[b.type] as { rich_text: { type: string; text: { content: string } }[] };
		return body.rich_text.map((t) => t.text.content).join('');
	});

describe('buildNotionReportBlocks', () => {
	it('builds Notion block objects: heading, income, spending, top categories, disclaimer', () => {
		const blocks = buildNotionReportBlocks(summary, id);
		expect(blocks.map((b) => b.type)).toEqual([
			'heading_2',
			'paragraph',
			'paragraph',
			'heading_3',
			'bulleted_list_item',
			'bulleted_list_item',
			'paragraph'
		]);
		expect(blocks.every((b) => b.object === 'block')).toBe(true);
		expect(blocks[0]).toEqual({
			object: 'block',
			type: 'heading_2',
			heading_2: { rich_text: [{ type: 'text', text: { content: 'Ringkasan Oktober 2026' } }] }
		});
	});

	it('every money figure is exactly the shared formatter’s output (AC8)', () => {
		const t = texts(buildNotionReportBlocks(summary, id));
		expect(t[1]).toBe(`Pemasukan: ${formatMoney(1_250_000_000, 'IDR')}`);
		expect(t[2]).toBe(`Pengeluaran: ${formatMoney(526_400_050, 'IDR')}`);
		expect(t[2]).toBe('Pengeluaran: Rp\u00a05.264.000,50');
		expect(t[4]).toBe(`Makan: ${formatMoney(187_000_000, 'IDR')}`);
		// No figure appears in any other spelling (no hand-built "Rp 12500000" or float).
		expect(t.join('\n')).not.toMatch(/Rp ?\d{4,}|\d\.\d{1,2}(?!\d)/);
	});

	it('uses the translator for labels (English) and formats other currencies with their own exponent', () => {
		const t = texts(
			buildNotionReportBlocks(
				{ ...summary, currency: 'USD', totalInMinor: 12_345, totalOutMinor: 0, topCategories: [] },
				en
			)
		);
		expect(t).toEqual([
			'Summary for Oktober 2026',
			`Income: ${formatMoney(12_345, 'USD')}`,
			`Spending: ${formatMoney(0, 'USD')}`,
			'From your own records. Information, not financial advice.'
		]);
	});

	it('caps the category list and cleans untrusted names', () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			name: `Kategori\u200b ${i}`,
			amountMinor: 100
		}));
		const blocks = buildNotionReportBlocks({ ...summary, topCategories: many }, id);
		const items = blocks.filter((b) => b.type === 'bulleted_list_item');
		expect(items).toHaveLength(NOTION_TOP_CATEGORIES_MAX);
		expect(texts(items)[0]).toBe('Kategori 0: Rp\u00a01');
		const long = texts(
			buildNotionReportBlocks(
				{
					...summary,
					monthLabel: 'x'.repeat(5000),
					topCategories: [{ name: 'y'.repeat(5000), amountMinor: 1 }]
				},
				id
			)
		);
		expect(Math.max(...long.map((s) => s.length))).toBeLessThan(200);
	});

	it('refuses an unsafe amount rather than printing a rounded figure', () => {
		expect(() => buildNotionReportBlocks({ ...summary, totalInMinor: 0.5 }, id)).toThrow(
			RangeError
		);
		expect(() =>
			buildNotionReportBlocks({ ...summary, totalOutMinor: Number.MAX_SAFE_INTEGER + 2 }, id)
		).toThrow(RangeError);
	});

	it('is pure and synchronous: takes no fetch or db, returns an array', () => {
		expect(buildNotionReportBlocks.length).toBe(2);
		const out = buildNotionReportBlocks(summary, id);
		expect(Array.isArray(out)).toBe(true);
		expect(JSON.stringify(out)).toBe(JSON.stringify(buildNotionReportBlocks(summary, id)));
	});
});
