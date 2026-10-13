import { AGENT_TYPE_LABELS } from '#lib/shared/agent';
import { csvLine, formatCsvAmount } from '#lib/shared/csv';
import { formatMonthLabel, formatShortDate } from '#lib/shared/dates';
import { createTranslator, type Locale, type Translator } from '#lib/shared/i18n';
import { formatMoney } from '#lib/shared/money-format';
import { NET_WORTH_KIND_LABELS, type NetWorthKind } from '#lib/shared/net-worth';
import { maskAccountNumbers } from '#lib/shared/text';
import type { AgentFacts, AssetFact, AssetGroup } from './facts';

/**
 * The two files of an Agen report (FN-23): a CSV and a self-contained printable HTML page. Pure and
 * deterministic: the same facts, narrative and locale always give the same bytes (no clock is read; the report's
 * date is in the facts). Every CSV cell goes through `csvLine` (formula guard, RFC 4180 quoting), amounts through
 * `formatCsvAmount` (exact, never a float); every HTML value through `esc`, with an inline stylesheet (print
 * included), no script, no external resource and no image. Names are user data: masked and capped again here,
 * never translated. The disclaimer is in both files.
 */

/** Longest text cell either file writes (names are capped earlier; this is the last line of defence). */
const CELL_MAX = 200;

function clip(text: string, max = CELL_MAX): string {
	return Array.from(maskAccountNumbers(text)).slice(0, max).join('');
}

/** HTML text and attribute escaping: the one function every interpolated value passes. */
export function esc(text: string): string {
	return text.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
	);
}

interface Labels {
	t: Translator;
	locale: Locale;
	title: string;
	period: string;
	disclaimer: string;
	made: string;
}

function labelsOf(facts: AgentFacts, locale: Locale): Labels {
	const t = createTranslator(locale);
	const base = facts.type === 'monthly' ? formatMonthLabel(facts.period, locale) : facts.period;
	let period = base;
	if (facts.type === 'spt_assets')
		period = t.trf('{periode}, per {tanggal}', {
			periode: base,
			tanggal: formatShortDate(facts.partial ? facts.generatedOn : `${facts.period}-12-31`, locale)
		});
	else if (facts.partial)
		period = t.trf('{periode}, sampai {tanggal}', {
			periode: base,
			tanggal: formatShortDate(facts.to, locale)
		});
	return {
		t,
		locale,
		title: t.tr(AGENT_TYPE_LABELS[facts.type]),
		period,
		disclaimer: t.tr(
			'Informasi dari catatanmu, bukan saran keuangan atau pajak. Daftar aset adalah informasi dari catatanmu, bukan pelaporan SPT.'
		),
		made: t.trf('Dibuat {tanggal} oleh Montra Agen (beta)', {
			tanggal: formatShortDate(facts.generatedOn, locale)
		})
	};
}

const kindLabel = (t: Translator, kind: string): string =>
	kind === 'belonging'
		? t.tr('Barang')
		: kind === 'collectible'
			? t.tr('Koleksi')
			: Object.hasOwn(NET_WORTH_KIND_LABELS, kind)
				? t.tr(NET_WORTH_KIND_LABELS[kind as NetWorthKind])
				: '';

const groupLabel = (t: Translator, g: AssetGroup): string =>
	g === 'items'
		? t.tr('Aset')
		: g === 'debts'
			? t.tr('Utang')
			: g === 'belongings'
				? t.tr('Barang')
				: t.tr('Koleksi');

/** What a row of the asset list says besides its figures. */
function assetNotes(l: Labels, a: AssetFact, valuedOn: string): string {
	const notes: string[] = [];
	if (a.unpriced) notes.push(l.t.tr('Belum ada harga'));
	else
		notes.push(
			l.t.trf('nilai terakhir per {tanggal}', { tanggal: formatShortDate(valuedOn, l.locale) })
		);
	if (a.estimated) notes.push(l.t.tr('Estimasi'));
	if (a.acquiredOn === null) notes.push(l.t.tr('tanggal perolehan tidak dicatat'));
	return notes.join('; ');
}

const percentText = (p: number | null | undefined) =>
	p === null || p === undefined ? '' : `${p}%`;

// ── CSV ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderCsv(facts: AgentFacts, narrative: string | null, locale: Locale): string {
	const l = labelsOf(facts, locale);
	const { t } = l;
	const amount = (minor: number | null, c: string) =>
		minor === null ? t.tr('terlalu besar') : formatCsvAmount(minor, c);
	const out: string[] = [
		csvLine([`Montra — ${l.title}`, clip(l.period)]),
		csvLine([t.tr('Dibuat'), facts.generatedOn]),
		csvLine([t.tr('Catatan'), l.disclaimer])
	];
	if (narrative) out.push(csvLine([t.tr('Ringkasan AI'), clip(narrative, 2000)]));
	out.push('\r\n');
	if (facts.type === 'spt_assets') {
		out.push(
			csvLine([
				t.tr('Bagian'),
				t.tr('Nama'),
				t.tr('Jenis'),
				t.tr('Mata uang'),
				t.tr('Nilai'),
				t.tr('Nilai per'),
				t.tr('Tanggal perolehan'),
				t.tr('Harga perolehan'),
				t.tr('Keterangan')
			])
		);
		const b = facts.balances;
		if (b) {
			const note = facts.partial ? t.tr('Saldo saat ini') : t.tr('Saldo akhir tahun');
			for (const w of b.wallets)
				out.push(
					csvLine([
						t.tr('Dompet'),
						clip(w.name),
						t.tr('Dompet'),
						w.currency,
						amount(w.balanceMinor, w.currency),
						b.asOf,
						'',
						'',
						note
					])
				);
			for (const tot of b.totals)
				out.push(
					csvLine([
						t.tr('Total dompet'),
						'',
						'',
						tot.currency,
						amount(tot.totalMinor, tot.currency),
						b.asOf,
						'',
						'',
						note
					])
				);
		}
		const a = facts.assets;
		if (a) {
			for (const group of ['items', 'debts', 'belongings', 'collectibles'] as const) {
				for (const row of a[group])
					out.push(
						csvLine([
							groupLabel(t, group),
							clip(row.name),
							kindLabel(t, row.kind),
							row.currency,
							row.unpriced ? '' : amount(row.valueMinor, row.currency),
							a.valuedOn,
							row.acquiredOn ?? '',
							row.acquisitionMinor === null ? '' : amount(row.acquisitionMinor, row.currency),
							assetNotes(l, row, a.valuedOn)
						])
					);
				for (const s of a.subtotals.filter((x) => x.group === group))
					out.push(
						csvLine([
							t.trf('Subtotal {bagian}', { bagian: groupLabel(t, group) }),
							'',
							'',
							s.currency,
							amount(s.totalMinor, s.currency),
							a.valuedOn,
							'',
							'',
							''
						])
					);
			}
		}
		return out.join('');
	}
	out.push(
		csvLine([t.tr('Bagian'), t.tr('Nama'), t.tr('Mata uang'), t.tr('Jumlah'), t.tr('Keterangan')])
	);
	if (facts.read)
		out.push(
			csvLine([t.tr('Ringkasan'), t.tr('Jumlah transaksi'), '', String(facts.read.count), ''])
		);
	for (const s of facts.summary?.currencies ?? []) {
		const c = s.currency;
		out.push(csvLine([t.tr('Ringkasan'), t.tr('Pemasukan'), c, amount(s.inMinor, c), '']));
		out.push(csvLine([t.tr('Ringkasan'), t.tr('Pengeluaran'), c, amount(s.outMinor, c), '']));
		out.push(csvLine([t.tr('Ringkasan'), t.tr('Selisih'), c, amount(s.netMinor, c), '']));
		if (s.previousOutMinor !== undefined && facts.summary?.previousPeriod) {
			out.push(
				csvLine([
					t.tr('Ringkasan'),
					t.tr('Pengeluaran bulan sebelumnya'),
					c,
					amount(s.previousOutMinor, c),
					formatMonthLabel(facts.summary.previousPeriod, locale)
				])
			);
			out.push(
				csvLine([
					t.tr('Ringkasan'),
					t.tr('Perubahan pengeluaran'),
					c,
					'',
					percentText(s.changePercent)
				])
			);
		}
		if (s.highestMonth)
			out.push(
				csvLine([
					t.tr('Ringkasan'),
					t.tr('Bulan pengeluaran tertinggi'),
					c,
					'',
					formatMonthLabel(s.highestMonth, locale)
				])
			);
		if (s.lowestMonth)
			out.push(
				csvLine([
					t.tr('Ringkasan'),
					t.tr('Bulan pengeluaran terendah'),
					c,
					'',
					formatMonthLabel(s.lowestMonth, locale)
				])
			);
		for (const m of s.months ?? [])
			out.push(
				csvLine([
					t.tr('Pengeluaran per bulan'),
					formatMonthLabel(m.month, locale),
					c,
					amount(m.outMinor, c),
					''
				])
			);
		for (const m of s.months ?? [])
			out.push(
				csvLine([
					t.tr('Pemasukan per bulan'),
					formatMonthLabel(m.month, locale),
					c,
					amount(m.inMinor, c),
					''
				])
			);
	}
	for (const g of facts.group?.currencies ?? []) {
		for (const row of g.categories)
			out.push(
				csvLine([
					t.tr('Kategori'),
					row.name === null ? t.tr('Tanpa kategori') : clip(row.name),
					g.currency,
					amount(row.outMinor, g.currency),
					''
				])
			);
		if (g.otherCount > 0)
			out.push(
				csvLine([
					t.tr('Kategori'),
					t.tr('Lainnya'),
					g.currency,
					amount(g.otherMinor, g.currency),
					t.trf('{n} kategori', { n: g.otherCount })
				])
			);
		for (const m of g.merchants)
			out.push(
				csvLine([
					t.tr('Tempat belanja'),
					m.title === null ? t.tr('Tanpa judul') : clip(m.title),
					g.currency,
					amount(m.amountMinor, g.currency),
					t.trf('{n} transaksi', { n: m.count })
				])
			);
	}
	return out.join('');
}

// ── HTML ───────────────────────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
:root{color-scheme:light;--ink:#111;--muted:#555;--line:#ddd;--panel:#f5f5f5}
*{box-sizing:border-box}
body{margin:0 auto;max-width:880px;padding:24px 16px;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:18px;margin:28px 0 8px}
p{margin:0 0 8px}
.muted{color:var(--muted);font-size:13px}
.narrative{background:var(--panel);border-radius:12px;padding:12px 16px;margin:16px 0;white-space:pre-line}
.narrative strong{display:block;font-size:13px;margin-bottom:4px}
table{width:100%;border-collapse:collapse;margin:0 0 8px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{font-size:13px;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;white-space:nowrap}
tr.total td{font-weight:700}
.disclaimer{margin-top:28px;font-size:13px;color:var(--muted)}
@media print{body{max-width:none;padding:0;font-size:11pt}h2{break-after:avoid}tr{break-inside:avoid}.narrative{border:1px solid var(--line)}}
`;
/**
 * The CSP a saved file carries itself (red team S5): the download's header no longer applies once the file is opened
 * from disk. Only this exact style block may apply (its SHA-256, never `'unsafe-inline'`); render.test.ts recomputes
 * the hash, so a STYLE edit fails there until this is updated.
 */
const FILE_CSP =
	"default-src 'none'; style-src 'sha256-Qkrct/pQbl6OLHV3kLi52iT86B21oJRm7wy+iO5M8vY='";

function table(
	head: readonly { text: string; num?: boolean }[],
	rows: readonly string[][],
	total = 0
) {
	const th = head.map((h) => `<th${h.num ? ' class="num"' : ''}>${esc(h.text)}</th>`).join('');
	const body = rows
		.map((r, i) => {
			const cls = i >= rows.length - total ? ' class="total"' : '';
			const tds = r
				.map((cell, j) => `<td${head[j]?.num ? ' class="num"' : ''}>${esc(cell)}</td>`)
				.join('');
			return `<tr${cls}>${tds}</tr>`;
		})
		.join('');
	return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderHtml(facts: AgentFacts, narrative: string | null, locale: Locale): string {
	const l = labelsOf(facts, locale);
	const { t } = l;
	const money = (minor: number | null, c: string) =>
		minor === null ? t.tr('terlalu besar') : formatMoney(minor, c, 'auto', locale);
	const parts: string[] = [];
	parts.push(`<h1>${esc(l.title)}</h1>`);
	parts.push(`<p>${esc(clip(l.period))}</p>`);
	parts.push(`<p class="muted">${esc(l.made)}</p>`);
	if (narrative)
		parts.push(
			`<div class="narrative"><strong>${esc(t.tr('Ringkasan AI'))}</strong>${esc(clip(narrative, 2000))}</div>`
		);
	if (facts.type === 'spt_assets') {
		const b = facts.balances;
		if (b) {
			parts.push(
				`<h2>${esc(facts.partial ? t.tr('Saldo dompet saat ini') : t.tr('Saldo dompet akhir tahun'))}</h2>`
			);
			parts.push(
				table(
					[
						{ text: t.tr('Dompet') },
						{ text: t.tr('Mata uang') },
						{ text: t.tr('Saldo'), num: true }
					],
					[
						...b.wallets.map((w) => [clip(w.name), w.currency, money(w.balanceMinor, w.currency)]),
						...b.totals.map((x) => [
							t.tr('Total dompet'),
							x.currency,
							money(x.totalMinor, x.currency)
						])
					],
					b.totals.length
				)
			);
		}
		const a = facts.assets;
		if (a) {
			for (const group of ['items', 'debts', 'belongings', 'collectibles'] as const) {
				const rows = a[group];
				if (rows.length === 0) continue;
				const subtotals = a.subtotals.filter((x) => x.group === group);
				parts.push(`<h2>${esc(groupLabel(t, group))}</h2>`);
				parts.push(
					table(
						[
							{ text: t.tr('Nama') },
							{ text: t.tr('Jenis') },
							{ text: t.tr('Nilai'), num: true },
							{ text: t.tr('Tanggal perolehan') },
							{ text: t.tr('Harga perolehan'), num: true },
							{ text: t.tr('Keterangan') }
						],
						[
							...rows.map((r) => [
								clip(r.name),
								kindLabel(t, r.kind),
								r.unpriced ? '' : money(r.valueMinor, r.currency),
								r.acquiredOn ? formatShortDate(r.acquiredOn, locale) : '',
								r.acquisitionMinor === null ? '' : money(r.acquisitionMinor, r.currency),
								assetNotes(l, r, a.valuedOn)
							]),
							...subtotals.map((s) => [
								t.trf('Subtotal {bagian}', { bagian: groupLabel(t, group) }),
								s.currency,
								money(s.totalMinor, s.currency),
								'',
								'',
								''
							])
						],
						subtotals.length
					)
				);
			}
		}
	} else {
		if (facts.read)
			parts.push(
				`<p>${esc(t.trf('{n} transaksi di periode ini', { n: groupedCount(facts.read.count, locale) }))}</p>`
			);
		for (const s of facts.summary?.currencies ?? []) {
			const c = s.currency;
			parts.push(`<h2>${esc(t.trf('Ringkasan {mataUang}', { mataUang: c }))}</h2>`);
			const rows = [
				[t.tr('Pemasukan'), money(s.inMinor, c)],
				[t.tr('Pengeluaran'), money(s.outMinor, c)],
				[t.tr('Selisih'), money(s.netMinor, c)]
			];
			if (s.previousOutMinor !== undefined && facts.summary?.previousPeriod) {
				rows.push([
					t.trf('Pengeluaran {bulan}', {
						bulan: formatMonthLabel(facts.summary.previousPeriod, locale)
					}),
					money(s.previousOutMinor, c)
				]);
				rows.push([t.tr('Perubahan pengeluaran'), percentText(s.changePercent)]);
			}
			if (s.highestMonth)
				rows.push([t.tr('Bulan pengeluaran tertinggi'), formatMonthLabel(s.highestMonth, locale)]);
			if (s.lowestMonth)
				rows.push([t.tr('Bulan pengeluaran terendah'), formatMonthLabel(s.lowestMonth, locale)]);
			parts.push(table([{ text: '' }, { text: t.tr('Jumlah'), num: true }], rows));
			if (s.months)
				parts.push(
					table(
						[
							{ text: t.tr('Bulan') },
							{ text: t.tr('Pemasukan'), num: true },
							{ text: t.tr('Pengeluaran'), num: true }
						],
						s.months.map((m) => [
							formatMonthLabel(m.month, locale),
							money(m.inMinor, c),
							money(m.outMinor, c)
						])
					)
				);
			const g = facts.group?.currencies.find((x) => x.currency === c);
			if (g && (g.categories.length > 0 || g.otherCount > 0)) {
				parts.push(
					`<h2>${esc(t.trf('Pengeluaran per kategori ({mataUang})', { mataUang: c }))}</h2>`
				);
				parts.push(
					table(
						[{ text: t.tr('Kategori') }, { text: t.tr('Jumlah'), num: true }],
						[
							...g.categories.map((r) => [
								r.name === null ? t.tr('Tanpa kategori') : clip(r.name),
								money(r.outMinor, c)
							]),
							...(g.otherCount > 0
								? [
										[
											`${t.tr('Lainnya')} (${t.trf('{n} kategori', { n: g.otherCount })})`,
											money(g.otherMinor, c)
										]
									]
								: [])
						]
					)
				);
			}
			if (g && g.merchants.length > 0) {
				parts.push(
					`<h2>${esc(t.trf('Tempat belanja teratas ({mataUang})', { mataUang: c }))}</h2>`
				);
				parts.push(
					table(
						[
							{ text: t.tr('Tempat belanja') },
							{ text: t.tr('Transaksi'), num: true },
							{ text: t.tr('Jumlah'), num: true }
						],
						g.merchants.map((m) => [
							m.title === null ? t.tr('Tanpa judul') : clip(m.title),
							groupedCount(m.count, locale),
							money(m.amountMinor, c)
						])
					)
				);
			}
		}
	}
	parts.push(`<p class="disclaimer">${esc(l.disclaimer)}</p>`);
	return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'id'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FILE_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Montra — ${l.title} — ${clip(l.period)}`)}</title>
<style>${STYLE}</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>
`;
}

function groupedCount(n: number, locale: Locale): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, locale === 'en' ? ',' : '.');
}
