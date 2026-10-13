import type { Translator } from '../i18n.ts';
import { formatMoney } from '../money-format.ts';
import { cleanText } from '../text.ts';

/**
 * A month's summary as Notion blocks for FN-29 (no network call here): the `children` of a Notion
 * "append block children" body. The figures are the ones Beranda/Laporan already compute (one currency, integer
 * minor units); every amount goes through the shared `formatMoney`, never a hand-built string. Labels go
 * through the caller's translator (the space owner's language). Names are untrusted text: invisible characters
 * stripped and capped well under Notion's 2000-character text limit.
 */

export interface NotionMonthSummary {
	monthLabel: string;
	totalInMinor: number;
	totalOutMinor: number;
	currency: string;
	topCategories: readonly { name: string; amountMinor: number }[];
}

/** Most categories listed (the report is a summary, not the ledger). */
export const NOTION_TOP_CATEGORIES_MAX = 10;
const LABEL_MAX_LENGTH = 80;

type BlockType = 'heading_2' | 'heading_3' | 'paragraph' | 'bulleted_list_item';

export interface NotionBlock {
	object: 'block';
	type: BlockType;
	[key: string]: unknown;
}

function block(type: BlockType, content: string): NotionBlock {
	return {
		object: 'block',
		type,
		[type]: { rich_text: [{ type: 'text', text: { content } }] }
	};
}

export function buildNotionReportBlocks(
	summary: NotionMonthSummary,
	{ tr, trf }: Pick<Translator, 'tr' | 'trf'>
): NotionBlock[] {
	const { currency } = summary;
	const blocks = [
		block(
			'heading_2',
			trf('Ringkasan {bulan}', { bulan: cleanText(summary.monthLabel, LABEL_MAX_LENGTH) })
		),
		block(
			'paragraph',
			trf('Pemasukan: {jumlah}', { jumlah: formatMoney(summary.totalInMinor, currency) })
		),
		block(
			'paragraph',
			trf('Pengeluaran: {jumlah}', { jumlah: formatMoney(summary.totalOutMinor, currency) })
		)
	];
	const categories = summary.topCategories.slice(0, NOTION_TOP_CATEGORIES_MAX);
	if (categories.length > 0) {
		blocks.push(block('heading_3', tr('Pengeluaran terbesar per kategori')));
		for (const category of categories)
			blocks.push(
				block(
					'bulleted_list_item',
					`${cleanText(category.name, LABEL_MAX_LENGTH)}: ${formatMoney(category.amountMinor, currency)}`
				)
			);
	}
	blocks.push(block('paragraph', tr('Dari catatanmu sendiri. Informasi, bukan saran keuangan.')));
	return blocks;
}
